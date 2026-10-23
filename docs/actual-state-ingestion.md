# Actual State Observation Ingestion Contract

> Design document (Work 75) defining how FORGE receives an Actual State
> observation from an observation source (test harness today, node agent
> later). This is a **contract**, not yet an implemented HTTP route. The
> route is implemented in Work 78, following this document.
>
> Consistent with `docs/actual-state-persistence.md` (Work 71) and
> `docs/desired-vs-actual.md` (Work 46).

---

## 1. Purpose

FORGE stores Desired State (what should exist) and Actual State (what was
observed to exist). The Actual State persistence and service layers
(Works 71–74) can record observations programmatically, but there is no
HTTP path for an external observation source to submit a report.

This contract defines that ingestion path: how an observation source (test
harness, future node agent, manual report) submits one observation snapshot
to a Project, what fields it supplies, what FORGE assigns, and how the
system behaves on invalid, missing, duplicate, and stale reports.

## 2. Scope and Non-Goals

This contract covers:

- The single observation ingestion endpoint.
- Request body fields and their validation requirements.
- Which fields the observation source supplies vs which FORGE assigns.
- Stale and duplicate observation behavior.
- Error taxonomy and HTTP status mapping.
- Validation and persistence boundaries.

This contract does **not** define:

- An agent protocol or node-agent communication design.
- Authentication or authorization infrastructure.
- Drift detection or reconciliation.
- Desired State mutation — ingestion never touches Desired State.
- Any claim that observations are authentic or authorized (no mechanism
  exists for that today).

## 3. Endpoint

```
POST /api/projects/{projectId}/actual-state/observations
```

- **Method:** `POST` only. Observations are append-only; there is no PUT,
  PATCH, or DELETE in this contract.
- **Path parameter:** `{projectId}` — the owning Project. Always taken from
  the path; any `projectId` in the request body is ignored.
- **Request body:** a JSON object representing one observation snapshot
  (section 5).
- **Response:** success envelope with the stored observation (section 7);
  error envelope with appropriate status (section 8).

The path is project-scoped exactly like the Desired State API
(`docs/desired-state-api.md`), keeping one Project's observations separate
from another's.

## 4. Field Ownership

| Field | Supplied by | Assigned by FORGE | Notes |
|---|---|---|---|
| `projectId` | — (ignored if present in body) | Path parameter | Always overridden from `{projectId}` in the path |
| `observationId` | Observation source | — | Client-declared string primary key; must be unique across all observations |
| `workloadId` | Observation source | — | Which workload within the Project was observed |
| `source` | Observation source | — | e.g. `test-harness`, `node-agent`, `manual` |
| `observedAt` | Observation source | — | When reality was sampled, as an ISO 8601 timestamp string |
| `status` | Observation source | — | Observed lifecycle status enum |
| `application` | Observation source | — | Observed application group |
| `runtime` | Observation source | — | Observed runtime group |
| `resources` | Observation source | — | Observed resources group |
| `health` | Observation source | — | Observed health group |
| `environment` | Observation source (optional) | — | Omitted = not part of this observation |
| `deployment` | Observation source (optional) | — | Omitted = not part of this observation |
| `createdAt` | — | Database | Storage timestamp, `@default(now())` |

### 4.1 Observation source identity

`source` is a free-form non-empty string identifying the reporter. Today the
only real value used in tests is `test-harness`. A future node agent would
use a value like `node-agent` or a node-specific identifier. This contract
does not define how sources are authenticated; `source` is metadata, not an
authorization mechanism.

## 5. Request Body Shape

The body is a JSON object. Required top-level fields:

```json
{
  "observationId": "obs_001",
  "workloadId": "default",
  "source": "test-harness",
  "observedAt": "2026-10-18T10:00:00Z",
  "status": "running",
  "application": {
    "image": "forge-api:v1",
    "port": 8080,
    "version": "1.0.0"
  },
  "runtime": {
    "replicas": 2
  },
  "resources": {
    "cpu": "250m",
    "memory": "256Mi"
  },
  "health": {
    "status": "healthy"
  }
}
```

Optional top-level groups:

```json
{
  "environment": { "NODE_ENV": "production" },
  "deployment": { "version": 1 }
}
```

### 5.1 Field requirements

| Field | Required | Type / Constraint |
|---|---|---|
| `observationId` | yes | non-empty string |
| `workloadId` | yes | non-empty string |
| `source` | yes | non-empty string |
| `observedAt` | yes | ISO 8601 date-time string, parseable to a valid date |
| `status` | yes | one of: `running`, `stopped`, `failed`, `unknown` |
| `application` | yes | object |
| `application.image` | yes | non-empty string or `null` (unknown) |
| `application.port` | yes | integer 1–65535 or `null` (unknown) |
| `application.version` | no | string (if present) |
| `runtime` | yes | object |
| `runtime.replicas` | yes | integer ≥ 0 or `null` (unknown); `0` = observed zero |
| `resources` | yes | object |
| `resources.cpu` | yes | non-empty string or `null` (unknown) |
| `resources.memory` | yes | non-empty string or `null` (unknown) |
| `health` | yes | object |
| `health.status` | yes | one of: `healthy`, `unhealthy`, `unknown` |
| `environment` | no | object of string → string |
| `deployment` | no | object |
| `deployment.version` | yes (within group) | integer ≥ 0 or `null` (unknown) |

`projectId` is **not read** from the body; it is always the path parameter.
Any `projectId` key in the body is ignored (the path value wins), consistent
with the Desired State API convention.

### 5.2 Unknown vs absent semantics

The null-vs-omitted rule from `docs/actual-state-persistence.md` §2 applies
unchanged:

- `null` on an observed field = **observed but unknown**.
- `replicas: 0` = **genuinely observed zero** (absence proven by observation).
- An **omitted optional group** (`environment`, `deployment`) = not part of
  this observation; it is never treated as proof that the group is absent
  from reality.

Ingestion validation must never convert a missing required field into
`null`; a missing required field is a validation error.

## 6. Stale and Duplicate Behavior

### 6.1 Stale observations (older `observedAt`)

An observation whose `observedAt` is **older** than the current latest
observation for the same `(projectId, workloadId)` is **accepted and
stored**.

Rationale:

- History is immutable and append-only (Work 71 design).
- Latest observation is determined by `max(observedAt)`, not by insertion
  order; a late-reporting agent cannot silently replace newer data.
- A late report is still a valid point-in-time observation and must not be
  discarded without justification (Work 77 restriction).
- The persistence layer already orders latest by `observedAt DESC`, tie-broken
  by `createdAt DESC` (`docs/actual-state-persistence.md` §4).

Therefore:

- Stale observations are **not** an error.
- Stale observations do **not** overwrite or hide newer observations.
- `getLatestObservation` continues to return the observation with the highest
  `observedAt`.

### 6.2 Duplicate `observationId`

`observationId` is the primary key. Submitting an `observationId` that
already exists is a **conflict**, not a silent success and not a silent
overwrite.

- HTTP status: **409 Conflict**.
- Error message: a safe generic conflict message (no raw Prisma errors).
- The existing row is **not** modified; the new report is rejected.

This mirrors the Desired State API's 409 mapping for duplicate
`desiredStateId` (`docs/desired-state-api.md`).

### 6.3 Duplicate logical reports (same content, different id)

If an observation source accidentally reports the same snapshot twice with
**different** `observationId` values, both rows are stored. Deduplication by
content is **out of scope** for this contract; the persistence model keys on
`observationId`, not on content hash. This is acceptable because history is
append-only and the latest-observation logic is unaffected.

## 7. Response Shape

### 7.1 Success (201 Created)

```json
{
  "success": true,
  "data": {
    "observationId": "obs_001",
    "projectId": "prj_001",
    "workloadId": "default",
    "source": "test-harness",
    "observedAt": "2026-10-18T10:00:00Z",
    "status": "running",
    "createdAt": "2026-10-18T10:00:05Z",
    "observation": {
      "application": { "image": "forge-api:v1", "port": 8080, "version": "1.0.0" },
      "runtime": { "replicas": 2 },
      "resources": { "cpu": "250m", "memory": "256Mi" },
      "health": { "status": "healthy" },
      "environment": { "NODE_ENV": "production" },
      "deployment": { "version": 1 }
    }
  }
}
```

The envelope splits API metadata (`observationId`, `projectId`, `workloadId`,
`source`, `observedAt`, `status`, `createdAt`) from the nested observed
payload (`observation`), mirroring the Desired State API's metadata +
nested-declaration envelope (`docs/desired-state-api.md` §5–6).

### 7.2 Error envelope

```json
{
  "success": false,
  "error": "Human-readable message.",
  "errors": [ { "path": "field.path", "message": "…" } ]
}
```

`errors` is present only for validation failures (400). Other errors omit it.

## 8. Error Taxonomy and HTTP Status Mapping

| Condition | HTTP status | Error code / message | Notes |
|---|---|---|---|
| Malformed JSON body | 400 | `Request body must be valid JSON.` | Same as Desired State API |
| Non-object JSON body | 400 | `Request body must be a JSON object.` | Same as Desired State API |
| Missing / invalid required fields | 400 | `Actual State observation failed validation.` + `errors[]` | Field-level paths and messages |
| Project not found | 404 | `Project not found.` | FK `P2003` mapped at persistence boundary |
| Duplicate `observationId` | 409 | Conflict message (safe, generic) | PK unique violation mapped at persistence boundary |
| Unexpected internal error | 500 | `Internal server error.` | Logged server-side; no Prisma/stack/credential leakage |

## 9. Validation and Persistence Boundaries

```
HTTP request (POST …/actual-state/observations)
        ↓
Route handler (app/api/projects/[projectId]/actual-state/observations/route.ts)
  — parses JSON safely, injects projectId from the path,
    converts observedAt string to Date
        ↓
Ingestion validation (lib/validation/actual-state-ingestion.ts, Work 76)
  — validates the incoming observation shape; rejects invalid input
        ↓
Ingestion service (lib/services/actual-state.ts, Work 77 — ingestObservation)
  — reuses validation gate, confirms Project exists,
    applies duplicate detection, calls persistence
        ↓
Persistence layer (lib/persistence/actual-state.ts, unchanged)
  — Prisma error mapping (P2003 → InvalidProjectError, P2002 → duplicate)
        ↓
Prisma 7 → PostgreSQL "forge" (ActualStateObservation table)
```

- **Validation boundary:** invalid observations are rejected before any
  persistence call. The route never talks to Prisma.
- **Persistence boundary:** Prisma and raw database errors never escape the
  persistence module; the service and route only see domain-level errors.
- **Actual State / Desired State separation:** ingestion reads/writes only
  the `ActualStateObservation` table; it never creates or mutates a
  `DesiredState` row.

## 10. Security Limitation

**This endpoint is currently unauthenticated.** There is no token, session,
or agent-identity verification. It is suitable only for local development and
trusted environments. It must not be exposed publicly as a trusted production
ingestion interface without an appropriate authorization design. This
limitation is documented in the route code and README, not hidden.

## 11. Out of Scope (unchanged by this contract)

- Authentication / authorization (future engineering area).
- Node Agent protocol (future engineering area).
- Drift detection and classification (future engineering area).
- Reconciliation (future engineering area).
- Observation retention / pruning (future decision, same as Desired State).
- Content-based deduplication (out of scope; key is `observationId`).
