# Desired State API Contract

> Conceptual contract for the future FORGE Desired State API.
> This is a design document, **not an implemented feature**. No API routes,
> validation code, storage, or database changes exist for Desired State. The
> design below is consistent with `docs/desired-state.md` and
> `docs/desired-vs-actual.md`.

---

## 1. Purpose

FORGE needs a Desired State API so that the **Web Console** and other clients
can communicate the developer's intended state to FORGE.

Without it a developer could not tell FORGE *what* they want to run — there
would be no way to declare the target, no way to record it, and no reference
for any later comparison against the running system.

The API is focused on **Desired State only**: declaring, reading, and updating
what should exist. It is explicitly **not** about how to build a container,
how to place a workload, or how to execute a deployment. Those are separate,
later concerns.

---

## 2. API Responsibility

This API is conceptually responsible for:

- **creating** Desired State,
- **reading** the current Desired State,
- **retrieving** a specific Desired State **version**,
- **updating** Desired State,
- **validating** the request conceptually,
- **maintaining the relationship** between Project and Desired State.

This API is **NOT** responsible for:

- directly deploying applications,
- directly controlling nodes,
- directly performing reconciliation,
- directly modifying Actual State.

Those responsibilities belong to later FORGE components — the scheduler,
workflow, and node agent — not to the Desired State API. The API's only job
is to receive and serve the declaration.

---

## 3. Project Relationship

```text
Project
  ↓
Desired State
  ↓
Applications / Runtime / Resources / Environment / Deployment / Health
```

Desired State **belongs to a Project**. A Project is the named unit of work
defined in `docs/desired-state.md`; a Desired State is always held by exactly
one Project, and a Project has at most one current Desired State (with a
history of versions).

The API must therefore **always know which Project a Desired State belongs
to**. Every endpoint in this contract is scoped under a `projectId`. An
unambiguous project reference is what keeps one project's declared state
separate from another's.

---

## 4. Conceptual Endpoints

The following endpoints form the future Desired State API surface. They are
described conceptually only — **none are implemented**.

### POST `/api/projects/{projectId}/desired-state`

- **Purpose:** Create the first Desired State for a Project, or replace the
  current one with an initial declaration.
- **Creates, reads, or updates:** **create** (establishes the initial
  declared state; represents the CONFIGURE step of the FORGE lifecycle).
- **Request:** `projectId` in the path; a Desired State payload in the body
  (see section 5).
- **Response:** success envelope with the created Desired State, its ID, and
  its version.
- **Important fields:** `desiredStateId`, `projectId`, `version`.
- **Possible errors:** 400 (invalid Desired State), 404 (project not found),
  500 (server error).

### GET `/api/projects/{projectId}/desired-state`

- **Purpose:** Read the current Desired State of a Project.
- **Creates, reads, or updates:** **read**.
- **Request:** `projectId` in the path; no body.
- **Response:** success envelope with the current Desired State, its ID,
  project, and latest version.
- **Important fields:** `desiredStateId`, `projectId`, `version`,
  the Desired State payload.
- **Possible errors:** 404 (project or Desired State not found), 500 (server
  error).

### GET `/api/projects/{projectId}/desired-state/{version}`

- **Purpose:** Retrieve a specific historical version of the Desired State.
- **Creates, reads, or updates:** **read**.
- **Request:** `projectId` and `version` in the path; no body.
- **Response:** success envelope with the requested Desired State as it was
  at that version.
- **Important fields:** `desiredStateId`, `projectId`, `version`.
- **Possible errors:** 400 (invalid version value), 404 (project, Desired
  State, or version not found), 500 (server error).

### PUT `/api/projects/{projectId}/desired-state`

- **Purpose:** Update the current Desired State of a Project, producing a new
  version.
- **Creates, reads, or updates:** **update**.
- **Request:** `projectId` in the path; the full Desired State payload in the
  body. (A `PATCH` variant could update only changed fields — either is a
  later implementation decision; `PUT` with the full declaration is shown.)
- **Response:** success envelope with the updated Desired State and its new
  version.
- **Important fields:** `desiredStateId`, `projectId`, `new version`.
- **Possible errors:** 400 (invalid Desired State), 404 (project or Desired
  State not found), 409 (version/conflict problem), 500 (server error).

---

## 5. Request Contract

A request is split into two clearly distinct parts:

- **API metadata** — how the request is addressed (the `projectId` in the
  path, the `version` where relevant). Metadata describes the *request*, not
  the system being requested.
- **Desired State data** — the actual declaration payload that must be
  validated and stored.

Conceptual request layout:

```text
Request
├── projectId           (API metadata — path)
├── version             (API metadata — only where a version is being selected)
└── desiredState        (Desired State data — the declaration)
    ├── applications
    ├── runtime
    ├── resources
    ├── environment
    ├── deployment
    └── health
```

The Desired State payload should conceptually contain, matching the
component vocabulary in `docs/desired-state.md`:

- **applications** — image, port, version to run;
- **runtime** — replicas and execution shape;
- **resources** — CPU and memory budgets;
- **environment** — configuration injected at runtime;
- **deployment** — versioned realization information;
- **health** — the health rule the workload must satisfy.

No unnecessary fields are invented beyond these. The payload is declared
configuration only — it must never contain infrastructure-specific execution
details (see section 15).

---

## 6. Response Contract

Every response follows one consistent conceptual envelope so that the Web
Console and other clients can rely on a single shape. This matches the
existing FORGE API convention documented in `PROJECT_STATUS.md`
(`{ success, data }` for success, `{ success, error }` for failure).

Common concepts:

- `success` — whether the operation succeeded;
- `data` — the payload on success;
- `error` — a description of the failure;
- `desiredStateId` — identifier of the Desired State;
- `projectId` — the owning Project;
- `version` — the version of the Desired State affected.

### Conceptual successful response

```json
{
  "success": true,
  "data": {
    "desiredStateId": "ds_01",
    "projectId": "prj_42",
    "version": 2,
    "desiredState": {
      "applications": { "image": "forge-api:v2", "port": 8080 },
      "runtime": { "replicas": 3 },
      "resources": { "cpu": 2, "memory": "1GB" },
      "environment": { "NODE_ENV": "production" },
      "deployment": { "version": 2 },
      "health": { "path": "/health" }
    }
  }
}
```

### Conceptual error response

```json
{
  "success": false,
  "error": "Desired State failed validation: replicas must be at least 1"
}
```

Both are **documentation examples only**, not implemented formats.

---

## 7. Versioning

Every accepted Desired State receives a version:

```text
version 1  →  initial create
version 2  →  first update
version 3  →  second update
...
```

Versioning matters for FORGE because:

- **History** — FORGE can see how a declaration evolved over time;
- **Comparison** — a current Actual State can be compared against a known
  declared version;
- **Rollback** — a previous version can be re-applied to return to a
  known-good declaration;
- **Auditability** — it is always clear what was declared when.

The API must support retrieving a specific version
(`GET /api/projects/{projectId}/desired-state/{version}`). The exact version
scheme — monotonic integers as shown here — is a future implementation detail.
**No versioning is implemented.**

---

## 8. Validation

Conceptually, the API should validate a request **before** accepting the
Desired State:

- **project exists** — the referenced Project must be real;
- **required Desired State information exists** — the payload is present and
  non-empty;
- **structure is valid** — the payload follows the expected component shape
  (applications, runtime, resources, environment, deployment, health);
- **values follow the expected contract** — semantic checks such as a sane
  replica count, valid port, well-formed resource sizes, and a reachable
  health path;
- **version information is valid where required** — a requested version is a
  real, existing version of that Project's Desired State.

Validation is described conceptually here. **No validation code is written.**

---

## 9. Error Contract

The future API should report failures with clear HTTP status codes:

| Status | Meaning |
|---|---|
| **400 — Invalid Desired State** | The request payload failed validation: missing, malformed, or out-of-contract values. The client should fix the request and retry. |
| **404 — Project or Desired State not found** | The referenced Project, Desired State, or version does not exist. The client addressed something unknown. |
| **409 — Version / conflict problem** | The update conflicts with the current state (for example, an attempted concurrent or stale version update). |
| **500 — Internal server error** | FORGE failed unexpectedly while processing a valid request. The client may retry later; the platform must investigate. |

These codes are a conceptual contract. **No error handling is implemented.**

---

## 10. API → FORGE Architecture

The future flow this API participates in:

```text
Web Console
    ↓
Desired State API
    ↓
Validation
    ↓
Desired State Storage
    ↓
Control Plane
    ↓
Scheduler / Workflow
    ↓
Node Agent
    ↓
Actual State
```

The **Desired State API** is the ingress: it takes the developer's declaration
from the Web Console, validates it, and stores it. The **Control Plane** then
holds that stored Desired State as its target. Later the **Scheduler** and
**Workflow** act on it, the **Node Agent** executes on infrastructure, and the
**Actual State** that results can one day be compared back against the
declaration (per `docs/desired-vs-actual.md`).

This work **only defines the API contract**. None of the flow beyond it is
implemented.

---

## 11. Desired State vs Actual State

This API accepts **Desired State only**.

It does **not** accept Actual State as a developer's desired configuration.
Actual State is observed reality collected from the infrastructure/runtime
side later — it arrives through a different, future channel (agents,
collectors, infrastructure state reporting), never as a declaration.

Keeping the two paths separate preserves the comparison model in
`docs/desired-vs-actual.md`:

- Desired State = target (produced here, through this API);
- Actual State = current reality (produced later, from the runtime side);
- Drift = difference between them (detected by a future system).

If the API mixed Actual State into the declaration path, the comparison would
lose its meaning — there would be no independent target left. The API contract
is therefore designed to stay compatible with that drift model.

---

## 12. Security and Safety Boundaries

Conceptual guidance for the future implementation:

- **authentication** — clients must be identified;
- **authorization** — clients may only act where they are permitted;
- **project ownership / access** — a client must only read or update Desired
  State for Projects they are allowed to see or manage;
- **input validation** — every payload is checked before acceptance;
- **safe state updates** — an update must never abruptly break a running
  system; state changes move carefully toward the new target.

These are boundary statements only. **No authentication or authorization is
implemented.**

---

## 13. Current Implementation Status

- The **Desired State API is currently NOT implemented**.
- This document **defines the future API contract**.
- The existing Project API and database implementation
  (`GET` / `POST /api/projects`, Postgres via Prisma) is **separate** and
  unchanged by this design.
- **No API code is being added in Work 47.**

This is the same boundary stated in `docs/desired-state.md`: Desired State
persistence, validation, and API are all listed as NOT IMPLEMENTED there, and
this document does not claim otherwise.

---

## 14. Future Implementation Path

The intended progression, each step built on the previous one. **None of these
are implemented in Work 47.**

```text
API Contract
→ TypeScript Domain Types
→ Request Validation
→ API Route
→ PostgreSQL Persistence
→ Control Plane Integration
→ Actual State
→ Drift Detection
→ Reconciliation
```

- **API Contract** — this document;
- **TypeScript Domain Types** — typed representations of the request/response
  shapes;
- **Request Validation** — the checks from section 8;
- **API Route** — the actual Next.js API route;
- **PostgreSQL Persistence** — storing Desired State and versions;
- **Control Plane Integration** — handing the stored declaration to the
  control plane;
- **Actual State, Drift Detection, Reconciliation** — the downstream systems
  from `docs/desired-vs-actual.md`.

Every step after the contract is **FUTURE / NOT IMPLEMENTED**.

---

## 15. Design Rules

The API contract must remain:

- **declarative** — it states what should exist, not how to build it;
- **provider-independent** — no infrastructure-specific execution fields;
- **versionable** — every accepted state is versioned and retrievable;
- **validatable** — requests are checked before acceptance;
- **comparable with Actual State** — the payload shapes align with the
  comparison model in `docs/desired-vs-actual.md`;
- **safe to update** — changes move toward the new target without abrupt
  disruption;
- **focused on WHAT the user wants** — the declaration, not the procedure;
- **independent from HOW infrastructure is executed** — deployment mechanics
  live in later components, never in this contract.

---

*This document defines a future contract. It may not be read as a claim that
a Desired State API exists, that Desired State is persisted, or that any
validation, storage, or control-plane wiring is implemented.*