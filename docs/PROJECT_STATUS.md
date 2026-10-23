# FORGE — Master Project Status

> Single source of truth for the FORGE control-platform project.
> Keep this document updated whenever a major engineering area changes.
> Last updated: 2026-10-21 (Day 14 complete — health checks, runtime status,
> observability, failure handling, and recovery live)

---

## 1. What FORGE Is

FORGE is a full-stack + infrastructure control-plane platform.

It is **not** a simple CRUD application. FORGE's core idea is that a developer
**declares the desired state** of an application or infrastructure environment,
and FORGE manages the complete lifecycle required to take that declaration and
**build, deploy, observe, detect drift, reconcile, scale, update, and
eventually retire** the workload.

The platform closes the loop between *desired state* and *actual state*:

```
Developer declares desired state
        ↓
FORGE builds, deploys, and schedules the workload
        ↓
FORGE observes the actual state
        ↓
If actual ≠ desired (drift) → FORGE reconciles
```

---

## 2. Problem It Solves

- Manually operating application environments produces **drift**, config
  gaps, and duplicated effort.
- FORGE automates the lifecycle so infrastructure keeps matching what the
  developer asked for.
- Developers get a single control surface (web console + API) instead of a
  chain of disconnected tools.

## 3. Who Uses It

| Audience | What they get |
|---|---|
| **Developer** | Declares desired state, deploys, updates, scales, and retires workloads from the Web Console. |
| **Platform operator / owner** | Manages nodes, observes workloads, audits state, and handles reconciliation/health. |
| **Portfolio audience** | The project itself is the developer's flagship portfolio piece demonstrating full-stack + infrastructure engineering. |

---

## 4. How It Works (Current + Intended)

### Currently implemented path

```
Next.js Web Console (React / Tailwind)
        ↓  fetch()  { success, data }
API Routes
  /api/projects                                  (GET, POST)          ← Project API (Day 8)
  /api/projects/{projectId}/desired-state        (POST, GET, PUT)     ← Desired State API (Day 10)
  /api/projects/{projectId}/desired-state/{version}  (GET)            ← Desired State API (Day 10)
  /api/projects/{projectId}/actual-state/observations  (POST)         ← Actual State Ingestion API (Day 12)
        ↓
Service layer (apps/web/lib/services/desired-state.ts, actual-state.ts,
               drift.ts, runtime-status.ts)
        ↓  validation gate (Work 52 / Work 70 / Work 76) before any write
Persistence layer (apps/web/lib/persistence/desired-state.ts, actual-state.ts)
        ↓  driver adapter (@prisma/adapter-pg)
PostgreSQL "forge"
  (Project + DesiredState tables — declared state)
  (ActualStateObservation table — observed state, Day 11 + runtime reports, Day 14)
```

The Project API route still talks to Prisma directly (legacy path, unchanged).
All Desired State and Actual State State traffic goes through the thin route →
service → persistence layering; route handlers never touch Prisma.

### Health check and runtime status path (Day 14, service-level — no HTTP route)

```
runHealthCheck(probe, context, options)             (lib/health-check/evaluate.ts)
        ↓
HealthProbe abstraction                             (lib/health-check/probe.ts)
  — HttpHealthProbe (real fetch probe against declared health path/port)
  — StaticHealthProbe / never-resolving probes for tests
        ↓  bounded by an independent runner timeout (misbehaving probes cut off)
HealthCheckResult                                   (types/health-check.ts)
  — status `healthy` | `unhealthy` | `unknown` (+ `checking` is in-flight only)
  — startedAt / checkedAt / durationMs, outcome, failure { kind, message, statusCode }
        ↓  structured log events health-check.started / health-check.completed
  (optional) reportRuntimeStatus folds the outcome into an Actual State observation

reportRuntimeStatus(report, { logger })             (lib/services/runtime-status.ts)
        ↓  validateRuntimeStatusReport (lib/validation/runtime-status.ts)
        ↓  detectStatusTransition (previous vs new status/health) → log event
        ↓  ingestObservation (existing duplicate/stale contract, unchanged)
getRuntimeStatus(projectId, workloadId, { now, staleAfterMs })
  — latest = max(observedAt); returns availability `unknown` | `known`
    (+ stale flag, ageMs, observation refs, snapshot incl. diagnostics)
```

Cross-cutting:

```
withRetry(operation, options)                       (lib/resilience/retry.ts)
  → classifyFailure: retryable | permanent | invalid   (lib/resilience/classify.ts)
  → bounded attempts + exponential backoff + optional deadline
  → RetryExhaustedError preserves last error / attempts / disposition

createLogger({ sink, level })                       (lib/observability/logger.ts)
  → JSON-line records { timestamp, level, event, context }
  → child contexts, correlation ids, secret-key redaction
  → write failures never propagate to the caller
```

### Drift comparison path (Day 13, verified by tests — read-only, no HTTP route)

```
compareProjectState(projectId, workloadId)   (apps/web/lib/services/drift.ts)
        ↓
getCurrentDesiredState(projectId)            — current (highest) Desired State version
getLatestObservation(projectId, workloadId)  — max(observedAt) observation for that workload
        ↓  read-only; nothing is written or mutated
compareDesiredAndActual(desired, observation)  (apps/web/lib/drift/comparison.ts)
  — pure, deterministic, project-mismatch → DriftComparisonError
        ↓
DriftComparisonResult  (apps/web/types/drift.ts)
  — outcome `match` | `drift` | `insufficient-data`
  — findings[] with the six documented categories, explanations,
    desired/observed values (omitted where unsafe), plus
    comparedProperties[] / unknownProperties[]
```

### Desired State foundation pipeline (Day 9, verified end-to-end)

```
Desired State domain types  (apps/web/types/desired-state.ts)
        ↓
Validation                  (apps/web/lib/validation/desired-state.ts) — gate before persistence
        ↓
Persistence layer           (apps/web/lib/persistence/desired-state.ts)
        ↓
Prisma 7                    (apps/web/lib/prisma.ts)
        ↓
PostgreSQL "forge"          (DesiredState table, JSONB payload)
        ↓
read back through the same persistence layer into a Desired State domain object
```

### Desired State API path (Day 10, verified end-to-end)

```
HTTP request (POST / GET / PUT / GET {version})
        ↓
Route handler (app/api/projects/[projectId]/desired-state/…/route.ts)
  — parses JSON safely, injects projectId from the path,
    validates the {version} path parameter
        ↓
Service layer (lib/services/desired-state.ts)
  — Work 52 validation gate, version computation, conflict rules,
    error taxonomy (VALIDATION_FAILED / NOT_FOUND / CONFLICT / PERSISTENCE_FAILED)
        ↓
Persistence layer (lib/persistence/desired-state.ts)
  — Prisma error mapping (P2002/P2003 → domain errors)
        ↓
Prisma 7 → PostgreSQL "forge"
        ↓
HTTP response envelope (lib/api/desired-state-http.ts)
  — 201/200 success, 400 validation, 404 not-found, 409 conflict, 500 safe generic
```

### Intended full architecture (target, not yet built)

```
Developer
   ↓
Web Console
   ↓
API
   ↓
Control Plane
   ↓
Scheduler / Reconciliation / Workflow
   ↓
Queue
   ↓
Workers
   ↓
Node Agent
   ↓
Node / Runtime
   ↓
Workload
```

### Feedback path (target)

```
Workload
   ↓
Observability
   ↓
Actual State
   ↓
Drift Detection
   ↓
Reconciliation
   ↓
Desired State
```

---

## 5. Current Development Stage

**Stage: "Health, runtime visibility, and resilience foundations complete —
the control loop can now observe health, report runtime status, diagnose
failures, and recover predictably"**

- The web + database foundation is working (Project API, PostgreSQL
  persistence, verified across restarts).
- Day 8 (Works 44–49) completed the **conceptual Desired State design
  phase**: concept (44), data model (45), desired vs actual / drift (46),
  API contract (47), architecture review (48), and persistence strategy (49).
- Day 9 (Works 51–58) implemented the **Desired State foundation** in code:
  TypeScript domain types (51), validation (52), persistence implementation
  boundary notes (53), Prisma model + migration (54–55), persistence
  verification (56), and the domain ↔ persistence repository layer (57),
  closed by the final Day 9 end-to-end integration verification + cleanup
  (58).
- Day 10 (Works 59–69) implemented the **Desired State service layer and
  public API**: service layer with validation gate and error taxonomy
  (59–60, 62), update/new-version flow (63), non-destructive retirement
  semantics (64), documented REST routes (65), request validation at the API
  boundary (66), consistent 400/404/409/500 error handling (67), end-to-end
  API→PostgreSQL verification including process-restart survival (68), and
  final integration + documentation (69).
- Day 11 (Works 70–74) implemented the **Actual State observation
  foundation**: domain types with explicit unknown semantics (70), storage
  design (`docs/actual-state-persistence.md`, 71), Prisma
  `ActualStateObservation` model + migration (72), persistence + service
  layer (`recordObservation` / `getLatestObservation` / `listObservations`)
  with validation gate and error taxonomy (73), and integration verification
  incl. restart survival + cleanup + documentation (74).
- Day 12 (Works 75–80) implemented the **Actual State observation ingestion
  path**: ingestion contract (`docs/actual-state-ingestion.md`, 75),
  HTTP-shape ingestion validation (76), `ingestObservation` service flow
  with duplicate/staleness behavior (77), public `POST …/actual-state/
  observations` route with 400/404/409/500 error mapping (78), end-to-end
  verification incl. live HTTP smoke test and restart survival (79), and
  final integration + documentation (80). The endpoint is currently
  **unauthenticated** (local development / trusted environments only).
- Day 13 (Works 81–85) implemented the **drift comparison foundation**: a
  pure comparison function (81), classification of the six documented drift
  categories (82), the structured `DriftComparisonResult` with deterministic
  ordering and explanations (83), a read-only comparison service that loads
  the current Desired State and latest observation (`compareProjectState`,
  84), and end-to-end flow tests + cleanup + documentation (85). Results are
  produced on demand; **nothing is persisted** and **no HTTP endpoint
  exposes drift**.
- Day 14 (Works 87–92) implemented the **health and runtime resilience
  foundation**: a probe-based health-check foundation with timeouts and
  failure classification (87), runtime status reporting over the existing
  Actual State store with staleness and transition detection (88),
  structured observability with secret redaction (89), classified failure
  handling with bounded retries and idempotent duplicate behavior (90),
  restart/connectivity recovery guarantees (91), and a Day 14 integration
  suite verifying the full observation → health → status → drift path plus
  regression of existing workflows (92). All Day 14 capabilities are
  **service-level** — **no new HTTP endpoints, no schema changes, no
  scheduled probe loop, no automatic restart/reconcile**.
- **Not implemented:** Control Plane, scheduler/workflow, Node Agent,
  drift persistence, public drift/health/runtime APIs, reconciliation,
  deployment, authentication, metrics/tracing stacks. Note for accuracy:
  Days 11–13 delivered the Actual State and drift foundations **inside the
  Next.js app**; the Control Plane, scheduler/workflow, and Node Agent
  remain empty placeholder directories — Day 14 built against the real
  existing interfaces (Actual State store, service layer, validation,
  probes) rather than assuming those components exist.

---

## 6. Repository Structure

```
control-platform/  (repo root = Forge/control-panel)
├── apps/
│   ├── web/                  ← Next.js app (active implementation)
│   │   ├── app/
│   │   │   ├── page.tsx             (dashboard page)
│   │   │   └── api/
│   │   │       ├── projects/route.ts
│   │   │       │     (GET + POST /api/projects)
│   │   │       └── projects/[projectId]/
│   │   │           ├── desired-state/
│   │   │           │     ├── route.ts          (POST, GET, PUT — Work 65)
│   │   │           │     ├── route.test.ts     (route + validation + error tests — Works 65–67)
│   │   │           │     ├── e2e.test.ts       (end-to-end suite — Work 68)
│   │   │           │     └── [version]/route.ts
│   │   │           │           (GET …/desired-state/{version} — Work 65)
│   │   │           └── actual-state/
│   │   │               └── observations/
│   │   │                     ├── route.ts      (POST ingestion — Work 78)
│   │   │                     ├── route.test.ts (route tests — Work 78)
│   │   │                     └── e2e.test.ts   (end-to-end suite — Work 79)
│   │   ├── components/              (CreateProject, ProjectCard, ProjectDashboard)
│   │   ├── types/
│   │   │   ├── project.ts           (Project TypeScript type)
│   │   │   ├── desired-state.ts     (Desired State domain types, Work 51)
│   │   │   ├── actual-state.ts      (Actual State domain types, Work 70 + diagnostics/createdAt, Day 14)
│   │   │   ├── drift.ts             (Drift result types, Work 83)
│   │   │   ├── health-check.ts      (Health check types, Work 87)
│   │   │   └── runtime-status.ts    (Runtime status report/view types, Work 88)
│   │   ├── lib/
│   │   │   ├── prisma.ts            (reusable Prisma client)
│   │   │   ├── validation/desired-state.ts       (Work 52, + .test.ts)
│   │   │   ├── validation/actual-state.ts        (Work 70, + .test.ts)
│   │   │   ├── validation/actual-state-ingestion.ts (Work 76, + .test.ts)
│   │   │   ├── validation/runtime-status.ts      (Work 88)
│   │   │   ├── persistence/desired-state.ts      (Work 57, + .test.ts)
│   │   │   ├── persistence/actual-state.ts       (Work 73, + service tests)
│   │   │   ├── services/desired-state.ts         (Works 59–64, + .test.ts)
│   │   │   ├── services/actual-state.ts          (Work 73 + 77, + .test.ts)
│   │   │   ├── services/drift.ts                 (Work 84, + .test.ts + drift-integration.test.ts)
│   │   │   ├── services/runtime-status.ts        (Work 88, + runtime-status.test.ts)
│   │   │   ├── services/runtime-status-recovery.test.ts (Work 91)
│   │   │   ├── services/day14-integration.test.ts       (Work 92)
│   │   │   ├── drift/comparison.ts               (Works 81–83, + .test.ts)
│   │   │   ├── health-check/probe.ts             (Work 87 — HTTP + static probes)
│   │   │   ├── health-check/evaluate.ts          (Work 87 — runHealthCheck + classification)
│   │   │   ├── health-check/health-check.test.ts (Work 87, 14 tests)
│   │   │   ├── observability/logger.ts           (Work 89 — structured logger + redaction)
│   │   │   ├── observability/logger.test.ts      (Work 89, 10 tests)
│   │   │   ├── resilience/classify.ts            (Work 90 — failure classification)
│   │   │   ├── resilience/retry.ts               (Work 90 — bounded withRetry)
│   │   │   ├── resilience/retry.test.ts          (Work 90, 16 tests)
│   │   │   ├── api/desired-state-http.ts         (Works 65–67 response/error mapping)
│   │   │   └── api/actual-state-http.ts          (Work 78 response/error mapping)
│   │   ├── generated/prisma/        (generated Prisma client incl. DesiredState + ActualStateObservation)
│   │   ├── prisma/schema.prisma     (Project model + ProjectStatus enum + DesiredState model + ObservedStatus enum + ActualStateObservation model)
│   │   ├── prisma/migrations/       (initial_project, 20260925060845_add_desired_state, 20261017084744_add_actual_state)
│   │   └── prisma.config.ts         (Prisma config, reads DATABASE_URL)
│   └── api/                 ← placeholder (empty)
├── services/
│   └── control-plane/       ← placeholder (empty)
├── agent/
│   └── node-agent/          ← placeholder (empty)
├── packages/                ← placeholder (empty)
├── docs/
│   ├── PROJECT_STATUS.md              ← this document
│   ├── architecture.md
│   ├── desired-state.md               (Work 44, concept)
│   ├── desired-vs-actual.md           (Work 46, comparison + drift)
│   ├── desired-state-api.md           (Work 47, API contract)
│   ├── desired-state-persistence.md   (Work 49, storage strategy)
│   ├── desired-state-persistence-implementation.md   (Work 53, boundary notes)
│   ├── actual-state-persistence.md    (Work 71, Actual State storage design)
│   └── actual-state-ingestion.md      (Work 75, ingestion contract)
└── README.md
```

Note: `apps/api`, `services/control-plane`, `agent/node-agent`, and
`packages/` exist as empty scaffolding only — **no implementation yet**.

---

## 7. Current Implementation (Implemented Facts)

| Layer | Details |
|---|---|
| Framework | Next.js 16.3.5 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS |
| Database | PostgreSQL, local `forge` database |
| ORM | Prisma 7 (`prisma` + `@prisma/client` 7.10.0), `prisma.config.ts` |
| Schema | `apps/web/prisma/schema.prisma` — `Project` model, `ProjectStatus` enum, `DesiredState` model, `ObservedStatus` enum, `ActualStateObservation` model |
| Prisma client | `apps/web/lib/prisma.ts` — cached singleton (safe for Next.js hot reload), uses `PrismaPg` driver adapter |
| Migrations | `initial_project` + `20260925060845_add_desired_state` + `20261017084744_add_actual_state` — applied; `prisma migrate status` = "Database schema is up to date!" |
| Project API | `GET /api/projects` (read from PostgreSQL), `POST /api/projects` (create in PostgreSQL) |
| Desired State API | `POST`/`GET`/`PUT /api/projects/{projectId}/desired-state`, `GET /api/projects/{projectId}/desired-state/{version}` (Day 10, thin route handlers) |
| Actual State Ingestion API | `POST /api/projects/{projectId}/actual-state/observations` (Day 12, thin route handler over `ingestObservation`; **unauthenticated** — local development / trusted environments only) |
| Service layer | `lib/services/desired-state.ts` — create, update (next-version), read current, read by version, list versions, retire; validation gate + error taxonomy (`VALIDATION_FAILED` / `NOT_FOUND` / `CONFLICT` / `PERSISTENCE_FAILED`). `lib/services/actual-state.ts` (Day 11 + 12) — `recordObservation`, `ingestObservation` (duplicate → `CONFLICT`, stale accepted), read latest, list history; validation gate + error taxonomy (`VALIDATION_FAILED` / `NOT_FOUND` / `CONFLICT` / `PERSISTENCE_FAILED`); missing latest → `null`, no error |
| Actual State ingestion | HTTP route → ingestion validation → `ingestObservation` service → persistence; invalid input rejected before persistence; duplicate `observationId` → 409; stale (older `observedAt`) observations accepted and stored, never replacing newer |
| Drift comparison | `lib/services/drift.ts` — `compareProjectState(projectId, workloadId = "default")` reads the current Desired State + latest observation (both read-only) and calls `lib/drift/comparison.ts` — pure `compareDesiredAndActual(desired, observation)`. Returns `no-desired-state` / `no-observation` / `compared` (+ `DriftComparisonResult`). **No HTTP endpoint; results are not persisted** (Day 13) |
| Health checks | `lib/health-check/probe.ts` (`HealthProbe` + `HttpHealthProbe` + static/stub probes) + `lib/health-check/evaluate.ts` (`runHealthCheck` with runner-level timeout, outcome classification, `HealthCheckResult`). Statuses `healthy`/`unhealthy`/`unknown` (completed checks); `checking` exists as an in-flight status only. **Service-level; no endpoint, no scheduler, results not stored as history** (Day 14) |
| Runtime status reporting | `lib/services/runtime-status.ts` — `reportRuntimeStatus` (validation → transition detection → `ingestObservation`) and `getRuntimeStatus` (latest by `max(observedAt)`, staleness via `now`/`staleAfterMs`, default 5 min). Reuses the `ActualStateObservation` table; reports carry optional `diagnostics`. **Service-level; no endpoint** (Day 14) |
| Observability | `lib/observability/logger.ts` — JSON-line logger (`debug`/`info`/`warn`/`error`, level threshold), child context, correlation ids, **key-based secret redaction** (`password`/`secret`/`token`/`credential`/`authorization`/`api-key`/… → `[REDACTED]`), write failures swallowed. Wired into health checks, runtime status, and retries. **No metrics/tracing stack introduced** (Day 14) |
| Failure handling | `lib/resilience/classify.ts` — `retryable` / `permanent` / `invalid` by error name/code (validation → invalid; conflict/not-found/duplicate → permanent; persistence/network/timeout → retryable; unknown → retryable). `lib/resilience/retry.ts` — `withRetry` bounded attempts + exponential backoff + optional deadline; `RetryExhaustedError` preserves cause/attempts/disposition. Duplicate reports stay idempotent-by-conflict. **No auto-restart/redeploy** (Day 14) |
| Recovery | Runtime observations survive simulated restarts (fresh client reads); monitoring recovers after temporary target outage without duplicating reports; stale-after-restart reported stale; unreachable-after-recovery stays unhealthy with diagnostics. **No automatic reconciliation** (Day 14) |
| HTTP mapping | `lib/api/desired-state-http.ts` and `lib/api/actual-state-http.ts` — response envelopes (metadata + nested payload) and status mapping (400/404/409/500) |
| Response shape | `{ success: boolean, data: ... }`; errors return `{ success: false, error: string, errors?: [...] }` |
| Validation | Work 52 validator gates every service write; routes additionally reject malformed JSON, non-object bodies, and invalid `{version}` path params (400) |
| Error mapping | 400 validation · 404 project/Desired State/version not found · 409 duplicate version or duplicate `desiredStateId` · 500 generic "Internal server error." (no Prisma/stack/credential leakage; 500s logged server-side) |
| Versioning | Per-version immutable snapshots; client declares each version's `desiredStateId`; `version = current + 1` computed server-side; `(projectId, version)` unique in DB |
| Retirement | Service-level `retireDesiredState` — non-destructive decision record; **no public HTTP endpoint** (the Work 47 contract defines none; documented gap) |
| Data file | Old in-memory `data/projects.ts` **removed** (Work 41) |

### Project model

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | primary key, `@default(cuid())` |
| `name` | `String` | required |
| `status` | `ProjectStatus` enum | required |
| `deployments` | `Int` | required |

### ProjectStatus enum values

`running` · `stopped` · `failed` · `deploying`

### DesiredState model

| Field | Type | Notes |
|---|---|---|
| `desiredStateId` | `String` | primary key, `@default(cuid())` |
| `projectId` | `String` | FK to `Project.id` (`ON DELETE RESTRICT`, `ON UPDATE CASCADE`); back-relation `Project.desiredStates` |
| `version` | `Int` | unique per Project via `@@unique([projectId, version])` |
| `createdAt` | `DateTime` | `@default(now())` — DB-owned |
| `updatedAt` | `DateTime` | `@updatedAt` — DB-owned |
| `data` | `Json` | JSONB payload: `applications`, `runtime`, `resources`, `environment`, `deployment`, `health` |

Hybrid persistence: relational metadata header + JSONB declaration payload
(`docs/desired-state-persistence.md` §8). One row = one immutable version.

### ActualStateObservation model (Day 11)

| Field | Type | Notes |
|---|---|---|
| `observationId` | `String` | primary key, `@default(cuid())` |
| `projectId` | `String` | FK to `Project.id` (`ON DELETE RESTRICT`, `ON UPDATE CASCADE`); back-relation `Project.observations` |
| `workloadId` | `String` | which workload within the Project was observed (first implementation: `default`) |
| `source` | `String` | e.g. `test-harness` today, `node-agent` later |
| `observedAt` | `DateTime` | caller-supplied sampling time; **this**, not `createdAt`, orders latest |
| `status` | `ObservedStatus` enum | `running` · `stopped` · `failed` · `unknown` |
| `createdAt` | `DateTime` | `@default(now())` — DB-owned storage time |
| `data` | `Json` | JSONB payload: `application`, `runtime`, `resources`, `health`, optional `environment`/`deployment` |

Index `(projectId, workloadId, observedAt)` serves latest-lookup and history.
Latest observation = highest `observedAt` per `(projectId, workloadId)`,
tie-broken by `createdAt DESC`. Rows are immutable; history is never
overwritten. Null observed values mean *observed but unknown* — never
treated as proof of absence (`docs/actual-state-persistence.md` §2).

**Day 14 extensions (same table, additive only):** the JSONB `data` payload
may now carry an optional `diagnostics` object (`message?`, `reason?`,
string-valued `details?`) for runtime reports and failed health checks, and
the domain object now surfaces the DB-owned `createdAt` (storage time)
alongside the caller-supplied `observedAt` (sampling time) — letting
consumers distinguish *when reality was sampled* from *when it was stored*.
No migration was required (JSONB + additive optional field).

### Desired State API endpoints (implemented, Day 10)

| Method + path | Behavior | Success | Errors |
|---|---|---|---|
| `POST /api/projects/{projectId}/desired-state` | Create a version. Body = full declaration (`desiredStateId`, `version`, `applications`, `runtime`, `resources`, `health`, optional `environment`/`deployment`). `projectId` always taken from the path. | 201 | 400, 404, 409, 500 |
| `GET /api/projects/{projectId}/desired-state` | Read the current (highest) version. | 200 | 404, 500 |
| `PUT /api/projects/{projectId}/desired-state` | Update: appends `current.version + 1` as a new immutable row. Body must declare a `desiredStateId` distinct from the current version's (each version row has its own id — the DB primary key). | 200 | 400, 404, 409, 500 |
| `GET /api/projects/{projectId}/desired-state/{version}` | Read one historical version. `{version}` must be a positive integer. | 200 | 400, 404, 500 |

Response envelope (metadata + declaration split, per contract §5–6):

```json
{
  "success": true,
  "data": {
    "desiredStateId": "ds_1",
    "projectId": "prj_1",
    "version": 2,
    "createdAt": "…",
    "updatedAt": "…",
    "desiredState": {
      "applications": { "image": "…", "port": 8080 },
      "runtime": { "replicas": 3 },
      "resources": { "cpu": "500m", "memory": "512Mi" },
      "health": { "path": "/health" }
    }
  }
}
```

**Documented gap — no retirement endpoint.** The Work 47 contract
(`docs/desired-state-api.md` §4) defines no DELETE/retire route, and the
persistence design defines no retention/deletion policy
(`docs/desired-state-persistence.md` §10 — explicitly a future decision).
Work 64 therefore implemented retirement as a **non-destructive service-level
operation** (`retireDesiredState` in `lib/services/desired-state.ts`) that
returns the retirement decision (project, current id/version, retained
version count) while preserving all historical rows and never touching the
Project. A public retirement endpoint should only be added when the contract
is extended.

### Actual State Ingestion API endpoint (implemented, Day 12)

| Method + path | Behavior | Success | Errors |
|---|---|---|---|
| `POST /api/projects/{projectId}/actual-state/observations` | Ingest one observation. Body = observation snapshot (`observationId`, `workloadId`, `source`, `observedAt` ISO string, `status`, `application`, `runtime`, `resources`, `health`, optional `environment`/`deployment`). `projectId` taken from the path (ignored in body). **Unauthenticated.** | 201 | 400, 404, 409, 500 |

Response envelope (metadata + observed payload split, per
`docs/actual-state-ingestion.md` §7):

```json
{
  "success": true,
  "data": {
    "observationId": "obs_1",
    "projectId": "prj_1",
    "workloadId": "default",
    "source": "test-harness",
    "observedAt": "2026-10-18T10:00:00Z",
    "status": "running",
    "createdAt": "…",
    "observation": {
      "application": { "image": "…", "port": 8080 },
      "runtime": { "replicas": 2 },
      "resources": { "cpu": "250m", "memory": "256Mi" },
      "health": { "status": "healthy" }
    }
  }
}
```

Behavior notes:

- **Duplicate `observationId`** → 409 (existing row untouched).
- **Stale observation** (older `observedAt` than current latest) → accepted
  and stored; never replaces newer data; latest remains `max(observedAt)`.
- **Invalid input** → 400 with field-level `errors[]`; never reaches
  persistence.
- **Missing project** → 404.
- **Security limitation:** the endpoint is currently **unauthenticated** —
  suitable only for local development / trusted environments; not a
  production-secure ingestion interface.

### Drift comparison (implemented, Day 13 — service-level, no endpoint)

| Piece | Location | Behavior |
|---|---|---|
| Pure comparison | `lib/drift/comparison.ts` → `compareDesiredAndActual(desired, observation)` | Deterministic, side-effect free: no DB/network access, no mutation, no writes to either state. Throws `DriftComparisonError` if `projectId`s differ (comparison scope is one Project + one workload observation). |
| Structured result | `types/drift.ts` → `DriftComparisonResult` | `{ projectId, workloadId, outcome, findings[], unknownProperties[], comparedProperties[] }`; each finding = `{ property, category, explanation, desiredValue?, observedValue? }`. |
| Service entry point | `lib/services/drift.ts` → `compareProjectState(projectId, workloadId?)` | Loads the **current** (highest) Desired State version and the **latest** observation (`max(observedAt)` per `(projectId, workloadId)`), then invokes the pure function. Returns a discriminated status: `no-desired-state`, `no-observation`, or `compared` (+ desired/observation summaries + comparison). Input ids validated (`VALIDATION_FAILED`); missing data is reported as data, never as drift. |

The six documented categories (`docs/desired-vs-actual.md` §5) — no seventh
category exists:

| Category | When it is produced |
|---|---|
| `missing` | Observed replica count is **known** and lower than declared (observed `0` counts; `null` never does). |
| `extra` | Observed replica count is known and higher than declared (undeclared environment keys are not "extra" — they are outside the declared scope). |
| `changed` | A comparable value differs (e.g. `application.image`). |
| `unhealthy` | Observed health status is `unhealthy` (unknown health is never classified as unhealthy). |
| `configuration-mismatch` | Comparable configuration differs (`application.port`, `resources.cpu`, `resources.memory`, declared `environment` keys — environment **values are never included** in results). |
| `version-mismatch` | Declared vs observed `application.version` or `deployment.version` differ (only compared when the declaration declares one). |

Safety semantics:

- **Unknown ≠ absent.** `null`/omitted observed values and `status: unknown`
  go to `unknownProperties` and never become a finding.
- **Outcome is explicit.** `drift` (confirmed findings) · `match` (compared
  with no findings, unknowns disclosed) · `insufficient-data` (nothing could
  be compared).
- **Deterministic ordering.** Findings, `comparedProperties`, and
  `unknownProperties` follow the same fixed property order, so equivalent
  inputs give equivalent results.
- **Read-only.** Neither Desired State nor observation rows are modified;
  no drift record is stored.

### Health check + runtime status + observability + resilience (implemented, Day 14 — service-level, no endpoints)

| Piece | Location | Behavior |
|---|---|---|
| Health probe | `lib/health-check/probe.ts` | `HealthProbe` interface; `HttpHealthProbe` performs a real `fetch` against `{scheme}://{host}:{port}{path}` with its own abort timeout, classifying 2xx / non-2xx / timeout / refused / network errors; static and never-resolving probes exist for tests. |
| Health evaluation | `lib/health-check/evaluate.ts` → `runHealthCheck(probe, context, options)` | Validates context (fail-fast, no probe runs on invalid input), runs the probe under an independent runner timeout (default 5000 ms, configurable), classifies the outcome, and returns a `HealthCheckResult` with `checkId`, `startedAt`/`checkedAt`/`durationMs`, `outcome`, and `failure { kind, message, statusCode }`. Emits `health-check.started` (debug) and `health-check.completed` (`info` healthy / `warn` otherwise). |
| Health semantics | — | `healthy` only on a successful 2xx response from the declared endpoint; `unhealthy` for non-2xx, refused/unreachable, timeouts, and thrown probes; `unknown` only for incomplete/unclassifiable probe output. A process or container merely existing is never healthy evidence. Completed results never carry `checking`. |
| Runtime status report | `lib/services/runtime-status.ts` → `reportRuntimeStatus(report, { logger })` | Validates via `lib/validation/runtime-status.ts` (delegating to the domain observation validator), detects status/health transitions against the previous latest (logged as `runtime-status.transition`), then reuses `ingestObservation` — so duplicate `reportId` → `CONFLICT`, stale reports accepted but never displacing, missing project → `InvalidProjectError`, invalid → `VALIDATION_FAILED` before any write. |
| Runtime status read | `lib/services/runtime-status.ts` → `getRuntimeStatus(projectId, workloadId, { now?, staleAfterMs? })` | Validates identifiers; no observations → `{ availability: "unknown", reason: "no-observations" }`; otherwise `{ availability: "known", stale, ageMs, observation refs (observedAt + recordedAt), snapshot }`. `stale = ageMs > staleAfterMs` (default 5 min). Read-only. |
| Structured logging | `lib/observability/logger.ts` | JSON-line `LogRecord { timestamp, level, event, context }`; level threshold (default `info`); `child()` merges context; secret-pattern keys redacted (nested, arrays, depth-capped); sink exceptions caught and never thrown to the caller (fallback line, then swallow). Default sink = console JSON lines. |
| Failure classification | `lib/resilience/classify.ts` | Structural (error `name`/`code`, cause code) so it works without importing DB-bound modules. `invalid` (validation errors) and `permanent` (conflict, unknown project, duplicate) are never retried; `PERSISTENCE_FAILED`, network/timeout codes, and unknown failures are `retryable`. |
| Bounded retry | `lib/resilience/retry.ts` → `withRetry` | Up to `maxAttempts` (default 3), exponential backoff `baseDelayMs·2^n` capped at `maxDelayMs`, optional `deadlineMs` (injected clock supported), per-attempt `onRetry` hook + `resilience.retry.scheduled` / `resilience.retry.exhausted` events. Exhaustion → `RetryExhaustedError { attempts, lastError, lastDisposition, timedOut, totalDelayMs }`. Non-retryable → original error rethrown immediately. |

Safety semantics:

- **Idempotency by conflict.** Repeating a report with the same `reportId`
  returns `CONFLICT` and leaves exactly one row — retries after a partial
  failure cannot duplicate side effects.
- **No automatic remediation.** Nothing in Day 14 restarts, redeploys,
  reconciles, or mutates Desired State in reaction to a failure or an
  unhealthy result; failures are classified, bounded, logged, and surfaced.
- **No secret leakage.** Logger redaction covers credential-shaped keys at
  any nesting depth; health/log events carry identifiers and failure kinds,
  never response bodies or headers.
- **Observability is best-effort.** A failing sink degrades to a fallback
  line and never interrupts the health/runtime/retry flow.

### Database flow

```
Next.js API route → lib/prisma.ts (cached PrismaClient) → PostgreSQL "forge"

Desired State flow (Day 9):
domain types → validation → persistence layer → Prisma → PostgreSQL "forge"

Actual State ingestion flow (Day 12):
HTTP request → ingestion validation → ingestObservation service → persistence → Prisma → PostgreSQL "forge"

Runtime status flow (Day 14):
reportRuntimeStatus → report validation → transition detection → ingestObservation → PostgreSQL "forge"
getRuntimeStatus → getLatestObservation (max observedAt) → freshness computed against the clock (read-only)
```

---

## 8. Completed Work

Checklist of work actually completed in the repository:

- [x] Project architecture and purpose defined (`docs/architecture.md`, `README.md`, first commit 2026-09-12)
- [x] Desired-state concept documented (`docs/desired-state.md`)
- [x] Next.js web application created
- [x] Project dashboard foundation created (ProjectDashboard, ProjectCard, CreateProject)
- [x] Project TypeScript type created (`types/project.ts`)
- [x] Project API route created (`app/api/projects/route.ts`)
- [x] `GET /api/projects` implemented
- [x] `POST /api/projects` implemented
- [x] API validation implemented (name required, string, trimmed)
- [x] API error handling implemented (400 / 500 responses)
- [x] PostgreSQL installed and configured locally (Fedora)
- [x] `forge` PostgreSQL database created
- [x] PostgreSQL authentication configured (password auth over TCP/localhost)
- [x] Prisma installed
- [x] Prisma PostgreSQL configuration created (`prisma.config.ts`, datasource)
- [x] `Project` model created
- [x] `ProjectStatus` enum created
- [x] Initial Prisma migration created and applied (`initial_project`)
- [x] Database schema verified (Project table + enum present)
- [x] Reusable Prisma client created (`lib/prisma.ts`)
- [x] Generated Prisma client produced (`generated/prisma/`)
- [x] `GET /api/projects` connected to PostgreSQL
- [x] `POST /api/projects` connected to PostgreSQL
- [x] Database persistence verified across server restart
- [x] Old in-memory project storage removed (`data/projects.ts`)
- [x] Final TypeScript / API / database verification completed (Work 42)
- [x] Desired State concept defined (`docs/desired-state.md`) — Work 44
- [x] Desired State conceptual data model designed (Project → Application / Runtime / Resources / Environment / Deployment / Health) — Work 45
- [x] Desired State vs Actual State and Drift design defined (`docs/desired-vs-actual.md`; drift categories: Missing, Extra, Changed, Unhealthy, Configuration mismatch, Version mismatch) — Work 46
- [x] Desired State API contract designed (`docs/desired-state-api.md`) — Work 47, **designed only, NOT implemented**
- [x] Desired State design reviewed against the FORGE architecture — Work 48, no contradictions found
- [x] Desired State persistence strategy designed (`docs/desired-state-persistence.md`; hybrid relational metadata + JSONB payload) — Work 49, **designed only, Prisma/PostgreSQL NOT changed**
- [x] Desired State TypeScript domain types created (`apps/web/types/desired-state.ts`) — Work 51
- [x] Desired State validation implemented (`apps/web/lib/validation/desired-state.ts`, 13/13 tests) — Work 52
- [x] Desired State persistence implementation boundary documented (`docs/desired-state-persistence-implementation.md`) — Work 53, preparation only
- [x] Prisma `DesiredState` model added (`schema.prisma`: relational header + JSONB `data`, `Project.desiredStates` back-relation, `@@unique([projectId, version])`) — Work 54
- [x] Database migration `20260925060845_add_desired_state` created and applied to PostgreSQL — Work 55
- [x] Persistence properties verified against PostgreSQL (create/read/versioning/isolation/restart, P2002/P2003 handling) — Work 56
- [x] Domain ↔ persistence repository layer implemented (`apps/web/lib/persistence/desired-state.ts`, 9/9 integration tests incl. restart persistence) — Work 57
- [x] Final Day 9 end-to-end verification (domain → validation → persistence → Prisma → PostgreSQL → read-back → domain; 13 checks) + temporary test code cleaned up — Work 58
- [x] Desired State service layer created (`apps/web/lib/services/desired-state.ts`): CREATE gated by Work 52 validation, error taxonomy (`DesiredStateServiceError` + `VALIDATION_FAILED`/`NOT_FOUND`/`CONFLICT`/`PERSISTENCE_FAILED`) — Work 59
- [x] Service-level READ flow (current Desired State as domain object; not-found → `null`) — Work 60
- [x] Work 61 — no separate artifact recorded in the repository or prior status notes (service CREATE/READ covered by Works 59–60); noted honestly rather than reconstructed
- [x] Service-level VERSION retrieval (by version, list in ascending order, current = highest) — Work 62
- [x] UPDATE / NEW VERSION flow (`updateDesiredState`): validates, computes `current.version + 1`, keeps history immutable, scopes `projectId` from the path, client declares each version's `desiredStateId`; id/version conflicts → `DesiredStateConflictError` (CONFLICT) — Work 63
- [x] Desired State retirement (`retireDesiredState`): non-destructive decision record per documented design (no retention/deletion policy exists; history preserved; Project never deleted); missing → NOT_FOUND; repeated retirement idempotent — Work 64
- [x] Desired State API routes (`POST`/`GET`/`PUT /api/projects/{projectId}/desired-state`, `GET …/{version}`) — thin handlers over the service layer; Next.js 16 async `params` — Work 65
- [x] API request validation: malformed JSON, non-object bodies, missing fields, invalid nested values, invalid `{version}` params all rejected with 400 + field errors; invalid requests proven not to touch persistence — Work 66
- [x] Consistent API error handling: 400/404/409/500 mapping, generic safe 500 (no Prisma/stack/credential leakage), server-side logging of unexpected errors — Work 67
- [x] End-to-end API suite (`e2e.test.ts`): full declare→read→version→update→history flow, stored-vs-returned equality, project isolation, not-found/conflict, retirement-endpoint gap assertion, cross-process restart survival — Work 68
- [x] Day 10 final integration: all suites green (validation 13/13, persistence 9/9, services 32/32, API+e2e 28/28), `tsc --noEmit` clean, `eslint` clean, migrations up to date, live HTTP smoke test performed, README + this document updated — Work 69
- [x] Actual State TypeScript domain types created (`apps/web/types/actual-state.ts`): `ActualStateObservation` + `ObservedStatus`/`ObservedHealthStatus` + observed component groups mirroring the Desired State vocabulary; explicit unknown semantics (`null` = observed-but-unknown, `replicas: 0` = genuinely observed zero) — Work 70
- [x] Actual State validation implemented (`apps/web/lib/validation/actual-state.ts`, 15/15 tests incl. fully-unknown observation, zero-vs-null replicas, nullable fields, omitted optional groups) — Work 70
- [x] Actual State persistence design documented (`docs/actual-state-persistence.md`): immutable observation rows, `observedAt`-ordered latest selection, hybrid header+JSONB, drift-comparison readiness — Work 71, **design only, no schema changes in this work**
- [x] Prisma `ActualStateObservation` model + `ObservedStatus` enum added (`schema.prisma`: header + JSONB `data`, `Project.observations` back-relation, `@@index([projectId, workloadId, observedAt])`) — Work 72
- [x] Database migration `20261017084744_add_actual_state` created (inspected via `--create-only`, purely additive), applied, client regenerated; existing Project + DesiredState rows verified intact — Work 72
- [x] Domain ↔ persistence repository layer implemented (`apps/web/lib/persistence/actual-state.ts`): create / latest / history / cleanup, P2003 → `InvalidProjectError` — Work 73
- [x] Actual State service layer created (`apps/web/lib/services/actual-state.ts`): `recordObservation` gated by Work 70 validation, `getLatestObservation` (null when missing), `listObservations`; error taxonomy (`ActualStateServiceError` + `VALIDATION_FAILED`/`NOT_FOUND`/`PERSISTENCE_FAILED`) — Work 73
- [x] Service integration suite (`lib/services/actual-state.test.ts`, 14/14): record + read-back, domain round trip, unknown/null round trip, zero-vs-null, validation-gate-before-persistence, missing project → `InvalidProjectError`, latest-by-`observedAt` (not storage order), history order, workload isolation, Desired/Actual State separation, cleanup — Work 73
- [x] Day 11 final integration: restart-survival check (record → disconnect → reconnect → read-back with nulls intact → cleanup), DB hygiene verified (4 baseline projects, 0 DesiredState, 0 observations), all suites green (validation 28/28, persistence 9/9, services 46/46, API+e2e 28/28), `tsc --noEmit` clean, `eslint` clean, migrations up to date, test data cleaned, this document updated — Work 74
- [x] Actual State observation ingestion contract defined (`docs/actual-state-ingestion.md`): endpoint, field ownership (source-supplied vs FORGE-assigned), request/response shapes, stale/duplicate behavior, error taxonomy, validation/persistence boundaries, security limitation — Work 75, **design only, no route in this work**
- [x] Actual State ingestion validation implemented (`apps/web/lib/validation/actual-state-ingestion.ts`, 16/16 tests): validates HTTP-shape observations (observedAt as ISO 8601 string with time component), required fields, enum statuses, nested structures, projectId-from-path convention, delegates field-level checks to the domain validator, no DB writes — Work 76
- [x] Persistence layer extended (`apps/web/lib/persistence/actual-state.ts`): `DuplicateObservationError` + P2002 → duplicate mapping, `getObservationById` lookup — Work 77
- [x] Ingestion service flow implemented (`ingestObservation` in `lib/services/actual-state.ts`): validation gate → duplicate pre-check → persistence; duplicate → `ActualStateConflictError` (CONFLICT), stale (older observedAt) accepted and stored, missing Project → `InvalidProjectError`; error taxonomy extended with `CONFLICT` — Work 77
- [x] Service ingestion tests (`lib/services/actual-state.test.ts`, now 52/52 total): valid ingestion, duplicate conflict, invalid-before-persistence, missing project, stale accepted + not latest, history preserved — Work 77
- [x] Actual State HTTP mapping module (`apps/web/lib/api/actual-state-http.ts`): response envelope (metadata + nested `observation`), error mapping (400/404/409/500), malformed-JSON/non-object helpers — Work 78
- [x] Ingestion API route (`POST /api/projects/{projectId}/actual-state/observations`): thin handler — parse JSON → ingestion validation → `ingestObservation` → response envelope; `projectId` from path overrides body; **unauthenticated** (documented) — Work 78
- [x] Route tests (`route.test.ts`, 14/14): 201 success, projectId override, 409 duplicate, 400 invalid payload, 400 missing fields, 404 missing project, 400 malformed JSON, 400 non-object, 400 empty body, optional groups, unknown/null values, stale accepted, persistence boundary verified, Desired State untouched — Work 78
- [x] End-to-end ingestion suite (`e2e.test.ts`, 15/15): full flow HTTP→route→validation→service→persistence→PostgreSQL, project association, identity, status/timestamp, optional groups, invalid-before-persistence, 404, 409 duplicate without overwrite, stale accepted + latest unchanged, service read-back, history preserved, Desired State API unchanged, cross-process restart survival, no-real-agent assertion, live HTTP smoke test (`next dev`: POST 201, duplicate 409, invalid 400, missing project 404) — Work 79
- [x] Day 12 final integration: cleanup (unused import removed), `git diff` reviewed (4 modified + 5 new files, all related), all suites green (validation 44/44, persistence 9/9, services 52/52, desired-state API 28/28, actual-state API 29/29), `tsc --noEmit` clean, `eslint` clean, migrations up to date, README + this document updated — Work 80
- [x] Pure drift comparison function implemented (`apps/web/lib/drift/comparison.ts`, `compareDesiredAndActual`): deterministic, side-effect free (no DB/network, no mutation of either state), project-mismatch rejected with `DriftComparisonError`, outcome = `match` / `drift` / `insufficient-data` — Work 81
- [x] Six documented drift categories classified (`missing`, `extra`, `changed`, `unhealthy`, `configuration-mismatch`, `version-mismatch`) using the existing domain types and comparison scope (one Project + one workload observation); unknown/absent data never classified as a category, unknown health never `unhealthy`, unobserved replicas never `missing` — Work 82
- [x] Structured drift result defined (`apps/web/types/drift.ts`): finding = property + category + explanation + safe desired/observed values (environment values withheld), confirmed differences separated from `unknownProperties`, deterministic fixed property ordering — Work 83, **no database table and no public API endpoint added**
- [x] Comparison service implemented (`compareProjectState` in `apps/web/lib/services/drift.ts`): reads current Desired State version + latest observation (`max(observedAt)`) through the existing service layer, invokes the pure function, returns `no-desired-state` / `no-observation` / `compared`; read-only — Work 84
- [x] Drift service tests (`lib/services/drift.test.ts`, 10 tests): match, drift, missing Desired State, missing observation, default workload id, latest-by-`observedAt` selection, unknown-only observation → insufficient data, project isolation, identifier validation, current-version (not previous) selection — Work 84
- [x] Full-flow integration suite (`lib/services/drift-integration.test.ts`, 13 tests): all six categories through the service, match, missing/stale observations never fabricate drift, stale observation age disclosed, both records unmutated by comparison, repeated comparisons stable, project isolation, current Desired State version drives the comparison — Work 85
- [x] Day 13 final integration: cleanup (dead `PROPERTY_ORDER` export removed), all suites green (validation + drift comparison 74/74, persistence 9/9, services 75/75, desired-state API 28/28, actual-state API 29/29), `tsc --noEmit` clean, `eslint` clean, migrations up to date, README + this document updated — Work 85
- [x] Health-check domain types created (`apps/web/types/health-check.ts`): `HealthCheckStatus` (`healthy`/`unhealthy`/`unknown` + in-flight `checking`), probe target/outcome, `HealthCheckFailure`, `HealthCheckResult` with timestamps — Work 87
- [x] Probe abstraction implemented (`apps/web/lib/health-check/probe.ts`): `HealthProbe` interface, `HttpHealthProbe` (real `fetch` with abort timeout, 2xx/non-2xx/refused/timeout/network classification, URL builder), static and never-resolving probes for tests — Work 87
- [x] Health evaluation implemented (`runHealthCheck` in `apps/web/lib/health-check/evaluate.ts`): context validation (fail-fast), independent runner timeout bounding even misbehaving probes, outcome classification, `checkId`/`startedAt`/`checkedAt`/`durationMs`, `failure { kind, message, statusCode }` — Work 87
- [x] Health-check tests (`lib/health-check/health-check.test.ts`, 14): healthy 2xx, unhealthy 5xx with diagnostics, connection-refused failure, timeout (stub + real slow endpoint), thrown probe, unknown/incomplete outcomes, process-exists-but-unreachable never healthy, timestamp/duration correctness, no `checking` in completed results, invalid context rejected, deterministic classification — Work 87
- [x] Runtime status report/view types created (`apps/web/types/runtime-status.ts`): `RuntimeStatusReport`, `RuntimeStatusView` (`unknown`/`known` + stale + age + snapshot), `toRuntimeStatusSnapshot` — Work 88
- [x] Runtime report validation (`apps/web/lib/validation/runtime-status.ts`): required ids/source/reportedAt-as-Date, delegates nested field checks to the domain observation validator, error paths remapped (`observationId`→`reportId`, `observedAt`→`reportedAt`) — Work 88
- [x] Runtime status service implemented (`apps/web/lib/services/runtime-status.ts`): `reportRuntimeStatus` (validate → transition detection → `ingestObservation`, reusing duplicate/stale/unknown-project contracts), `getRuntimeStatus` (latest by `max(observedAt)`, staleness against injected clock, default 5 min, identifier validation) — Work 88
- [x] Observation model extended additively: optional `diagnostics` (`message`/`reason`/string `details`) persisted in the JSONB payload + validated in domain and ingestion validators; domain object now surfaces DB-owned `createdAt` — Work 88, **no migration needed**
- [x] Runtime status tests (`lib/services/runtime-status.test.ts`, 11+): valid report persisted/retrieved, invalid rejected before write, unknown project, repeated report conflict without duplication, stale accepted without displacing newer, project isolation, unknown-availability workload, staleness vs clock, identifier validation, diagnostics round trip, transition-log tracing, rejected/conflict log records, transition detection purity — Work 88 + 89
- [x] Structured logger implemented (`apps/web/lib/observability/logger.ts`): JSON-line records, level threshold, `child()` contexts, correlation ids, key-based secret redaction (nested/arrays/depth-capped), console + in-memory + silent sinks, write failures swallowed (fallback line, then never thrown) — Work 89
- [x] Logger tests (`lib/observability/logger.test.ts`, 10): event context, child merge, failure diagnostics, top-level + nested secret redaction (incl. whole-`credentials` object), level filtering, throwing sink never propagates, correlation ids, JSON-line shape — Work 89
- [x] Observability wired into workflows: `runHealthCheck` emits `health-check.started`/`health-check.completed` (with status, duration, httpStatus, failure kind/message); runtime status emits `runtime-status.report.recorded`/`.rejected`/`.conflict`/`.failed` and `runtime-status.transition`; retry emits `resilience.retry.scheduled`/`.exhausted`; health-check test asserts traced outcomes with no secret leakage — Work 89
- [x] Failure classification implemented (`apps/web/lib/resilience/classify.ts`): structural `retryable`/`permanent`/`invalid` by error name/code/cause-code, safe for DB-free imports — Work 90
- [x] Bounded retry implemented (`withRetry` in `apps/web/lib/resilience/retry.ts`): max attempts, exponential backoff capped, optional deadline with injectable clock, `onRetry` hook, structured log events, `RetryExhaustedError` preserving last error/attempts/disposition/timedOut/totalDelayMs; non-retryable errors rethrown immediately — Work 90
- [x] Resilience tests (`lib/resilience/retry.test.ts`, 16): classification of transient/permanent/invalid, recovery after transient, conflicts/validation never retried, bounded repeated failure with preserved cause, exact maxAttempts, exponential+ capped backoff with awaited delays, deadline stop with injected clock, idempotent-store duplicate safety, partial-failure no-duplicate-side-effects, retry observability, non-Error throwables — Work 90
- [x] Real-error classification verified against live service errors (invalid report → invalid, duplicate report → permanent, unknown project → permanent, `PERSISTENCE_FAILED` → retryable) and `withRetry(reportRuntimeStatus)` conflict stops at attempt 1 with exactly one row — Work 90 (DB)
- [x] Recovery tests (`lib/services/runtime-status-recovery.test.ts`, 6): runtime status written before restart readable by a fresh Prisma client and after reconnect; stale-after-restart reported stale (never fresh); temporary target connectivity loss recovered with exactly 2 rows and latest = recovered; retry loop spanning an outage succeeds (and exhaustion still bounded); interrupted-report resume → conflict with single row; still-unreachable application stays unhealthy with persisted check diagnostics — Work 91
- [x] Day 14 integration suite (`lib/services/day14-integration.test.ts`, 8): healthy runtime → accurate report → drift `match`; unhealthy runtime → report + drift `unhealthy` finding; failed health check → persisted diagnostics; stale reports per contract (newest wins, both retained, `stale` flag flips); status survives restart; duplicate-safe recovery (1 row); project/resource isolation incl. drift outcomes; Desired State workflow regression (create → update → v2 drives drift `match`) — Work 92
- [x] Day 14 final verification (Work 92): `npm test` **114/114**, `test:persistence` **9/9**, `test:services` **105/105**, `test:api` **28/28**, `test:api:actual` **29/29**, `tsc --noEmit` clean, `eslint` clean, no schema change (migrations untouched), `npm run build` compile+typeScript stages pass but prerender of `/` fails with `ECONNREFUSED` — **verified pre-existing** by building a pristine HEAD worktree (same failure; `app/page.tsx` fetches the API at build time), `git status`/diff reviewed (Day 12/13 changes preserved; Day 14 adds only health-check/observability/resilience/runtime-status files + doc updates), README + this document updated

### Note: desired-state-model.md (Work 45)

The standalone `docs/desired-state-model.md` file is **not present in the
repository**. The conceptual data structure it was meant to record is captured
in `docs/desired-state.md` §4 (Project, Application, Runtime, Resources,
Environment, Deployment, Health) and referenced consistently by the other
Desired State design documents.

### Note: PostgreSQL authentication issue (resolved)

During setup, password authentication to the `forge` database failed
(`password authentication failed for user "postgres"`) until the `postgres`
role password was aligned with the value referenced in the application's
environment configuration and the local `pg_hba.conf` was set to use
`scram-sha-256` for TCP/localhost connections. **No password or secret is
recorded in this document.** The connection now works; the reusable Prisma
client connects successfully.

---

## 9. Technology Stack

### Current (implemented)

| Technology | Used for |
|---|---|
| Next.js (App Router) | Web application |
| React | UI components |
| TypeScript | Type-safe application + API code |
| Tailwind CSS | Styling |
| Node.js | Runtime for the web app / API routes |
| PostgreSQL | Persistent database (`forge`) |
| Prisma 7 (+ `@prisma/adapter-pg`) | ORM, schema, migrations, client |
| Git / GitHub | Version control / repository (local repo; no remote assumed) |

### Planned / candidate (NOT yet implemented)

| Technology | Intended role |
|---|---|
| Go | Control-plane services (candidate) |
| Redis | Queue / coordination / caching |
| gRPC | Control plane ↔ node agent communication (candidate) |
| Docker | Container / workload runtime |
| Kubernetes or container orchestration | Where appropriate (future option) |
| Prometheus | Metrics |
| OpenTelemetry | Distributed tracing / observability |
| Cloud infrastructure | Deployment target and portfolio story |

> Planned technologies are **not claimed as implemented**. They become part
> of the stack only when a real engineering need requires them.

---

## 10. Engineering Roadmap (to December 10, 2026)

One continuous journey — **no artificial V1/V2/V3/V4 phases.** Work is
organized by engineering area. Progress is driven by real product/architecture
requirements. The overall completion target is **December 10, 2026** (see §13;
this supersedes the original 120-day working note).

Checkbox legend: `[ ] Not started` · `[~] In progress` · `[x] Completed`

| # | Engineering area | Status |
|---|---|---|
| 1 | Web Console | [~] |
| 2 | API Layer | [~] |
| 3 | Control Plane | [ ] |
| 4 | Desired State System | [~] |
| 5 | Reconciliation Engine | [ ] |
| 6 | Node Agent | [ ] |
| 7 | Scheduler | [ ] |
| 8 | Job / Workflow System | [ ] |
| 9 | Container / Workload Management | [ ] |
| 10 | Deployment Lifecycle | [ ] |
| 11 | Health Checks | [~] |
| 12 | Drift Detection | [~] |
| 13 | Reconciliation | [ ] |
| 14 | Scaling | [ ] |
| 15 | Rollback | [ ] |
| 16 | Observability | [~] |
| 17 | Logging | [~] |
| 18 | Metrics | [ ] |
| 19 | Tracing | [ ] |
| 20 | Authentication and Authorization | [ ] |
| 21 | Secrets / Configuration Management | [ ] |
| 22 | Infrastructure Integration | [ ] |
| 23 | Testing | [~] |
| 24 | Security Hardening | [ ] |
| 25 | Performance | [ ] |
| 26 | Reliability | [~] |
| 27 | Documentation | [~] |
| 28 | CI/CD | [ ] |
| 29 | Cloud Deployment | [ ] |
| 30 | Production Readiness | [ ] |
| 31 | Portfolio / Demo Preparation | [ ] |

### Notes on in-progress areas

- **Web Console (1)** — `[~]` Foundation exists (dashboard, create, live
  update after create, verification). Full console (detail views, status
  management, observability screens) remains.
- **API Layer (2)** — `[~]` `GET`/`POST /api/projects` plus the full Desired
  State API (`POST`/`GET`/`PUT …/desired-state`, `GET …/{version}`) exist,
  validated, and persist to PostgreSQL (Day 10). Broader API layer (auth,
  project detail/update/delete, control-plane-facing APIs) remains.
- **Documentation (27)** — `[~]` Architecture, desired-state, this master
  status document, and the root README exist and are current as of Day 10.
  Ongoing.
- **Desired State System (4)** — `[~]` Foundation (Works 51–58) plus the
  service layer and public REST API (Works 59–69) are implemented and
  verified end-to-end. The declared-state half of the control loop —
  declare → validate → version → store → read — is complete. Actual State
  collection now exists too (Days 11–12), and Day 13 added service-level
  drift comparison. Control Plane integration and reconciliation remain.
- **Drift Detection (12)** — `[~]` Day 13 (Works 81–85) implemented the
  comparison foundation: pure comparison function, the six documented
  categories, structured results, and a read-only comparison service —
  all verified by tests. Remaining: a public drift endpoint (if the
  contract defines one), persisting/exposing drift over time, drift
  events/thresholds, and the console/observability surfaces.
- **Health Checks (11)** — `[~]` Day 14 (Work 87) implemented the probe-based
  foundation: `HealthProbe`/`HttpHealthProbe`, `runHealthCheck` with
  runner-level timeout and `healthy`/`unhealthy`/`unknown` classification,
  structured `HealthCheckResult` with failure diagnostics — verified against
  a real local HTTP server. Remaining: scheduling/agent-driven probe loops,
  checks declared by Desired State being executed automatically, check-history
  persistence, and an API/console surface.
- **Observability (16)** — `[~]` Day 14 (Work 89) added the structured
  logging foundation (JSON lines, levels, child context, correlation ids,
  secret redaction) wired into health, runtime status, and retry flows, with
  operational outcomes reachable through the existing service interfaces.
  Remaining: metrics, tracing, a log pipeline, dashboards — deliberately not
  started (no suitable in-repo approach exists yet; no stack introduced).
- **Logging (17)** — `[~]` Structured, redaction-safe JSON logging exists in
  process (`lib/observability/logger.ts`). Remaining: shipping/retention,
  centralized query, and any non-service components (control plane, agent).
- **Reliability (26)** — `[~]` Day 14 (Works 90–91) added failure
  classification, bounded retries with backoff/deadline, idempotent duplicate
  handling, restart durability, outage recovery, and staleness-after-restart
  semantics — all test-verified. Remaining: circuit breaking, recovery
  drills against real infrastructure, and integration with a future control
  plane loop.
- **Testing (23)** — `[~]` Five `node --test` commands: `npm test`
  (Desired State validation 13 + Actual State validation 15 + Actual State
  ingestion validation 16 + drift comparison pure 30 + health check 14 +
  observability logger 10 + resilience 16 = **114**, no DB), persistence (9
  integration incl. restart), service layers (**105**: Desired State 32 +
  Actual State 20 + runtime status 14 + recovery 6 + drift service 10 +
  drift integration 13 + Day 14 integration 10), Desired State API + e2e (28,
  incl. cross-process restart survival), and Actual State ingestion API +
  e2e (29, incl. live HTTP smoke test). Coverage for the wider platform
  (console, Project API, future control plane) remains.

---

### Area detail (goal / major engineering work)

#### 1. Web Console — `[~] In progress`
- **Goal:** A usable console where developers manage workloads.
- **Major work:** Project list/detail screens; create/update/status controls;
  wiring to the API; later, deploy/scale/reconcile actions and observability
  views.

#### 2. API Layer — `[~] In progress`
- **Goal:** A stable, validated API that the console and control plane use.
- **Major work:** Full project CRUD; error model; auth; rate limiting;
  versioning; control-plane-facing endpoints.

#### 3. Control Plane — `[ ] Not started`
- **Goal:** The coordinating "brain" that holds desired state and drives
  lifecycle work.
- **Major work:** Core service design; state store; job orchestration;
  communication with the API, scheduler, queue, and agents.

#### 4. Desired State System — `[~] In progress`
- **Goal:** Let a developer declare an environment (replicas, resources,
  images, health rules) that FORGE must realize.
- **Status:** The **declared-state half is complete and verified** —
  conceptual design (Works 44–49), foundation (Works 51–58: domain types,
  validation, Prisma model + migration, domain↔persistence), service layer
  and public REST API (Works 59–69: create/update/read/version/retire
  semantics, routes, request validation, error handling, e2e). Actual State
  collection (Days 11–12) and service-level drift comparison (Day 13) now
  consume that declared state; **reconciliation remains unstarted**.
- **Major work remaining:** handing stored declarations to a future Control
  Plane and reconciling observed drift.

#### 5. Reconciliation Engine — `[ ] Not started`
- **Goal:** Bring actual state toward desired state.
- **Major work:** Diff logic; corrective actions; idempotency; retry and
  backoff; conflict handling.

#### 6. Node Agent — `[ ] Not started`
- **Goal:** A component on each infrastructure node that executes workload
  operations.
- **Major work:** Registration, heartbeat, command/execution protocol, local
  state reporting.

#### 7. Scheduler — `[ ] Not started`
- **Goal:** Decide which node runs which workload.
- **Major work:** Placement logic; resource-aware scheduling; constraints.

#### 8. Job / Workflow System — `[ ] Not started`
- **Goal:** Sequence deploy/build/rollback steps reliably.
- **Major work:** Job model; queued execution; progress and failure handling.

#### 9. Container / Workload Management — `[ ] Not started`
- **Goal:** Create and manage containers/workloads on nodes.
- **Major work:** Runtime abstraction (Docker first); image handling; process
  supervision.

#### 10. Deployment Lifecycle — `[ ] Not started`
- **Goal:** Reliable create → build → schedule → deploy → run flows.
- **Major work:** Lifecycle state machine; deploy steps; completion criteria.

#### 11. Health Checks — `[~] In progress`
- **Goal:** Know whether a workload is actually healthy.
- **Status:** **Foundation implemented and verified (Day 14, Work 87)** —
  `HealthProbe` abstraction with a real HTTP probe, `runHealthCheck` with an
  independent timeout, `healthy`/`unhealthy`/`unknown` classification that
  never infers health from mere process existence, and structured results
  with timestamps + failure diagnostics. Missing: scheduled/agent-driven
  probes, execution driven by the Desired State `health` declaration,
  check-history persistence, API/console exposure.
- **Major work remaining:** probes on a schedule, wiring declared health
  rules to actual probes, reporting results to consumers.

#### 12. Drift Detection — `[~] In progress`
- **Goal:** Detect when actual state no longer matches desired state.
- **Status:** **Comparison foundation implemented and verified (Day 13,
  Works 81–85)** — pure `compareDesiredAndActual`, the six documented
  categories, structured `DriftComparisonResult`, and the read-only
  `compareProjectState` service. Missing: public endpoint, persisted/exposed
  drift results, drift events/thresholds, console surfaces.
- **Major work remaining:** expose results (API/console), drift events and
  thresholds, then hand results to Reconciliation.

#### 13. Reconciliation — `[ ] Not started`
- **Goal:** Repair drift automatically.
- **Major work:** Reconciliation loop; reaction to drift events; converge check.

#### 14. Scaling — `[ ] Not started`
- **Goal:** Change capacity toward desired/required levels.
- **Major work:** Manual scaling; replicas; later automated/autoscaling hooks.

#### 15. Rollback — `[ ] Not started`
- **Goal:** Recover workloads to a known-good state.
- **Major work:** Version/pinned state; rollback procedure; validation.

#### 16. Observability — `[~] In progress`
- **Goal:** See what the system is doing end-to-end.
- **Status:** Structured logging foundation live (Day 14, Work 89); health
  and runtime workflows emit traceable, redaction-safe events through the
  existing service interfaces. No metrics or tracing exist yet.
- **Major work remaining:** metrics, traces, dashboards, alerting — only when
  a suitable in-repo approach is justified.

#### 17. Logging — `[~] In progress`
- **Goal:** Structured, queryable logs from all components.
- **Status:** JSON-line logger with levels, child context, correlation ids,
  and automatic secret redaction (Day 14, Work 89), used by health checks,
  runtime status, and retries; logging failures never crash callers.
- **Major work remaining:** log shipping/retention/central query; coverage
  for future control-plane and agent components.

#### 18. Metrics — `[ ] Not started`
- **Goal:** Quantitative signal for health and performance.
- **Major work:** Metric collection (Prometheus candidate); dashboards; alerts.

#### 19. Tracing — `[ ] Not started`
- **Goal:** Trace a request/job across services and nodes.
- **Major work:** OpenTelemetry instrumentation; trace export.

#### 20. Authentication and Authorization — `[ ] Not started`
- **Goal:** Secure the console and API.
- **Major work:** Identity; sessions/tokens; role-based access; least privilege.

#### 21. Secrets / Configuration Management — `[ ] Not started`
- **Goal:** Manage credentials and app configuration securely.
- **Major work:** Secret storage; injection into workloads; rotation.

#### 22. Infrastructure Integration — `[ ] Not started`
- **Goal:** Manage nodes and environments.
- **Major work:** Node registration; environment definitions; (candidate) cloud
  infrastructure integration.

#### 23. Testing — `[~] In progress`
- **Goal:** Confidence through automated verification.
- **Major work:** Five `node --test` commands covering the Desired State,
  Actual State, and drift comparison paths end to end: Desired State
  validation (13), Actual State validation (15), Actual State ingestion
  validation (16), drift comparison pure tests (30), health-check tests (14),
  observability logger tests (10), resilience tests (16) — **114 total in
  `npm test` (no DB)**; persistence (9, incl. restart + error mapping);
  service layers (**105**: Desired State 32, Actual State 20, runtime status
  14, recovery 6, drift service 10, drift integration 13, Day 14 integration
  10), Desired State API + e2e (28, incl. malformed JSON, isolation,
  cross-process restart survival), and Actual State ingestion API + e2e (29,
  incl. malformed JSON, duplicate 409, stale acceptance, live
  HTTP smoke test). Remaining: Project API tests, console tests, migration
  testing, and tests for future control-plane components.

#### 24. Security Hardening — `[ ] Not started`
- **Goal:** Safe default posture throughout.
- **Major work:** Authn/z; secure comms; audit; dependency hygiene;
  least-privilege workloads.

#### 25. Performance — `[ ] Not started`
- **Goal:** Reasonable latency/throughput for the platform's operations.
- **Major work:** Query/timing discipline; pagination; caching; load checks.

#### 26. Reliability — `[~] In progress`
- **Goal:** Recover from failures gracefully.
- **Status:** Failure classification (retryable/permanent/invalid), bounded
  retries with exponential backoff + deadline, idempotent duplicate handling,
  restart durability, outage recovery, and staleness-after-restart semantics
  implemented and verified (Day 14, Works 90–91). No automatic restart/
  redeploy/reconcile exists — by design at this stage.
- **Major work remaining:** circuit behavior, recovery drills on real
  infrastructure, control-plane-driven retry policies.

#### 27. Documentation — `[~] In progress`
- **Goal:** Maintainable understanding for the next developer.
- **Major work:** This document, architecture, desired-state — plus
  component-specific docs as systems land.

#### 28. CI/CD — `[ ] Not started`
- **Goal:** Automatic build, test, and delivery of the platform itself.
- **Major work:** CI pipeline; lint/type/test gates; artifact publishing;
  CD for the platform services.

#### 29. Cloud Deployment — `[ ] Not started`
- **Goal:** Run FORGE on real infrastructure for the portfolio.
- **Major work:** Cloud account/resource setup; deployed nodes; database and
  service hosting.

#### 30. Production Readiness — `[ ] Not started`
- **Goal:** Operate it for real, safely.
- **Major work:** Secrets in prod; backups; upgrades; runbooks; monitoring
  for the platform itself.

#### 31. Portfolio / Demo Preparation — `[ ] Not started`
- **Goal:** A compelling, honest demo.
- **Major work:** Demo scenario (declare → deploy → drift → reconcile);
  README/docs polish; recorded walkthrough.

---

## 11. Current Status

### What is completed
- Web + database foundation (dashboard, Project type, API GET/POST,
  validation, error handling).
- PostgreSQL persistence with Prisma 7 — migrated, verified across restarts.
- In-memory storage fully removed; API is database-backed end-to-end.
- Desired State design phase completed (Works 44–49): concept, data model,
  desired vs actual + drift, API contract, architecture review,
  persistence strategy.
- Desired State **implementation foundation** completed (Works 51–58): domain
  types (51), validation (52), persistence boundary notes (53), Prisma model
  (54), migration (55), persistence verification (56), domain ↔ persistence
  layer (57), final end-to-end verification + cleanup (58).
- Desired State **service layer and public API** completed (Works 59–69):
  service layer with validation gate and error taxonomy (59–60, 62),
  update/new-version flow (63), non-destructive retirement (64), REST routes
  (65), API request validation (66), consistent 400/404/409/500 error
  handling (67), end-to-end suite with cross-process restart survival (68),
  final integration + documentation (69).
- Actual State **observation foundation** completed (Works 70–74): domain
  types with unknown semantics (70), storage design (71), Prisma model +
  migration (72), persistence + service layer (73), integration verification
  + documentation (74).
- Actual State **observation ingestion path** completed (Works 75–80):
  ingestion contract (75), ingestion validation (76), `ingestObservation`
  service with duplicate/staleness behavior (77), public `POST
  …/actual-state/observations` route (78), end-to-end verification incl.
  live HTTP smoke test (79), final integration + documentation (80).
- **Drift comparison foundation** completed (Works 81–85): pure comparison
  function (81), six-category classification (82), structured result type
  with deterministic ordering (83), read-only `compareProjectState`
  service (84), full-flow integration tests + cleanup + documentation
  (85). Comparison results are computed on demand — **not persisted, no
  public endpoint, no reconciliation**.
- **Health + runtime visibility + resilience foundation** completed
  (Works 87–92): health-check probe/evaluation foundation with timeouts
  and failure diagnostics (87), runtime status reporting over the existing
  Actual State store with staleness + transition detection (88),
  structured observability with secret redaction (89), classified failures
  with bounded retries and idempotent duplicates (90), restart/outage
  recovery guarantees (91), and the Day 14 integration suite + full
  verification (92). All service-level — **no new endpoints, no schema
  changes, no scheduled probes, no automatic restart/reconcile**.

**Day 14 verification evidence (2026-10-21):**
- `npm run typecheck` (`tsc --noEmit`) — clean.
- `npm run lint` (eslint) — clean.
- `npm test` (validation + drift pure + health check + observability +
  resilience; no DB) — **114/114 pass** (74 pre-Day-14 + 14 health-check +
  10 logger + 16 resilience).
- `npm run test:persistence` — **9/9 pass**.
- `npm run test:services` (Desired/Actual State, runtime status, recovery,
  drift, Day 14 integration) — **105/105 pass**.
- `npm run test:api` (desired-state routes + e2e) — **28/28 pass** (no
  regression).
- `npm run test:api:actual` (actual-state ingestion routes + e2e) —
  **29/29 pass** (no regression).
- `npx prisma migrate status` — "Database schema is up to date!" (Day 14
  made **no schema change** — diagnostics live in existing JSONB).
- `npm run build` — compile + TypeScript stages pass; prerender of `/`
  fails with `ECONNREFUSED` (`app/page.tsx` fetches the API at build time).
  **Confirmed pre-existing**: a pristine `HEAD` worktree build fails
  identically; unrelated to Days 12–14. Documented as a known limitation.
- `git status` / `git diff` reviewed: Day 12 + Day 13 changes preserved
  uncommitted; Day 14 adds only `lib/health-check/`, `lib/observability/`,
  `lib/resilience/`, runtime-status files, `types/health-check.ts`,
  `types/runtime-status.ts`, package.json test-script lines, and docs.
  Nothing committed or pushed.

**Day 10 verification evidence (2026-10-17):**
- `npm run typecheck` (`tsc --noEmit`) — clean.
- `npm run lint` (eslint) — clean.
- `npm test` (validation) — 13/13 pass.
- `npm run test:persistence` — 9/9 pass.
- `npm run test:services` — 32/32 pass.
- `npm run test:api` (routes + e2e) — 28/28 pass.
- `npx prisma migrate status` — "Database schema is up to date!".
- Live HTTP smoke test against `next dev` + PostgreSQL: POST 201,
  GET current 200, PUT 200 (next version), GET version 200, missing version
  404, bad version 400, invalid body 400, malformed JSON 400. Smoke-test
  data removed afterwards.

**Day 11 verification evidence (2026-10-17):**
- `npm run typecheck` (`tsc --noEmit`) — clean.
- `npm run lint` (eslint) — clean.
- `npm test` (validation suites) — 28/28 pass (Desired State 13 + Actual State 15).
- `npm run test:persistence` — 9/9 pass.
- `npm run test:services` — 46/46 pass (Desired State 32 + Actual State 14).
- `npm run test:api` (routes + e2e) — 28/28 pass.
- `npx prisma migrate status` — "Database schema is up to date!".
- Restart-survival check: record observation → disconnect Prisma → reconnect
  → read back latest (nulls intact) → cleanup.
- DB hygiene: 4 baseline projects intact, 0 DesiredState rows, 0 observation
  rows after cleanup (no test data leaked).

**Day 12 verification evidence (2026-10-19):**
- `npm run typecheck` (`tsc --noEmit`) — clean.
- `npm run lint` (eslint) — clean.
- `npm test` (validation suites) — 44/44 pass (Desired State 13 + Actual
  State 15 + Actual State Ingestion 16).
- `npm run test:persistence` — 9/9 pass.
- `npm run test:services` — 52/52 pass (Desired State 32 + Actual State 20).
- `npm run test:api` (desired-state routes + e2e) — 28/28 pass.
- `npm run test:api:actual` (actual-state routes + e2e) — 29/29 pass
  (14 route + 15 e2e).
- `npx prisma migrate status` — "Database schema is up to date!".
- Cross-process restart survival: ingest observation → disconnect Prisma →
  new client → read back → verified.
- Live HTTP smoke test against `next dev` + PostgreSQL: POST 201,
  duplicate POST 409, invalid body 400, missing project 404. Smoke-test
  data removed afterwards.
- `git diff` reviewed: 4 modified + 5 new files, all Day-12-related; no
  unrelated changes.

**Day 13 verification evidence (2026-10-19):**
- `npx tsc --noEmit` — clean.
- `npm run lint` (eslint) — clean.
- `npm test` (validation + pure drift comparison) — 74/74 pass (Desired
  State 13 + Actual State 15 + Ingestion 16 + drift comparison 30).
- `npm run test:persistence` — 9/9 pass.
- `npm run test:services` — 75/75 pass (Desired State 32 + Actual State 20
  + drift service 10 + drift integration 13).
- `npm run test:api` (desired-state routes + e2e) — 28/28 pass.
- `npm run test:api:actual` (actual-state routes + e2e) — 29/29 pass.
- `npx prisma migrate status` — "Database schema is up to date!" (no
  schema change was needed for Day 13).
- `git status` / `git diff` reviewed: Day 12 changes preserved; Day 13
  adds only drift comparison files, one test script line, and docs.

### What is currently in progress
- Nothing. **Day 14 (Works 87–92) is complete.** No work block is active.

### What comes next
- **Day 15** — make the observation/health/status work reachable and
  actionable: a documented drift endpoint over the existing service (if the
  API contract is extended) and/or the Desired State console surface, then
  the Control Plane foundations. See §12.

---

## 12. Next Immediate Work

**Day 15: expose the work to consumers, then start the Control Plane.**

Day 14 (Works 87–92) delivered health probing, runtime status reporting,
structured observability, classified/bounded failure handling, and
restart/outage recovery — all service-level and test-verified, with no new
HTTP surfaces and no schema changes.

Planned order for Day 15 (engineering areas: Drift Detection / API Layer /
Control Plane):

1. **Comparison API (if the API contract is extended)** — a documented,
   read-only endpoint (`GET …/drift` or similar) over
   `compareProjectState`, with the platform response envelope and the
   existing 400/404/500 mapping; no writes, no remediation. Requires first
   defining/attaching the contract (`docs/desired-vs-actual.md` §6 output,
   `docs/desired-state-api.md` style), otherwise skip.
2. **Runtime status / health exposure (if justified by the same contract
   extension)** — a documented read-only endpoint over `getRuntimeStatus`
   (and optionally the latest health outcome) so the console and future
   agents can read status; still no remediation.
3. **Desired State console surface (parallel track)** — expose the now-live
   Desired State API in the Web Console (declare/view/update from the
   dashboard) so the portfolio story has a UI.
4. **Control Plane foundation (start)** — the first engineering-area work
   for the coordinating service: state hand-off from Desired State +
   observation reads, a job/operation model with idempotent execution
   (reusing `lib/resilience` concepts), and the boundary where a future
   scheduler and Node Agent attach.

> **Reconciliation, automatic remediation, deployment, and rollback are NOT
> implemented and are out of scope** until the Control Plane and Node Agent
> exist. Drift results are still not persisted anywhere, health checks are
> still not scheduled, and runtime status has no public endpoint. The
> Control Plane as a standalone service (Go/Redis, etc.) remains a later
> engineering area; Day 15 keeps new work inside the existing Next.js +
> PostgreSQL stack unless a real need forces the boundary, consistent with
> the incremental implementation principle.

---

## 13. Deadline

| Item | Value |
|---|---|
| Overall completion target | **December 10, 2026** — fixed 90-day target set by the project owner (supersedes the original 120-day figure below) |
| Start date | **2026-09-12** (derived from the first Git commit: `c21e802 day 1 complete to define platform architecture`) |
| Current day / stage | **Day 14 complete** (as of 2026-10-21) — Desired State service + REST API (Day 10), Actual State ingestion REST API (Day 12), drift comparison foundation (Day 13), and health/runtime/observability/resilience foundation (Day 14: probe-based health checks, runtime status reporting, structured logging, bounded retries, restart/outage recovery); reconciliation and Control Plane not started |
| Remaining runway | ~50 days to the December 10 target (2026-10-21 → 2026-12-10) |

> The original working note recorded a 120-day target (→ 2027-01-10). The
> project owner has since fixed the completion target at **December 10,
> 2026**. This document treats December 10, 2026 as authoritative.

---

## 14. Progress Tracking

| Item | Value |
|---|---|
| Overall project status | Both halves of the control loop have storage and ingress (Days 10–12), drift comparison (Day 13), and Day 14 added the health/runtime/resilience layer: Desired State service layer + validated, versioned REST API; Actual State observation foundation + ingestion REST API; drift comparison (pure function + six categories + read-only `compareProjectState` service); health-check probing with timeout/failure classification; runtime status reporting with staleness + transition logging; structured redacting logger; classified failures + bounded retries + restart/outage recovery. Reconciliation not started. |
| Completed engineering areas | Database/ORM foundation; project API GET/POST; persistence; Desired State System declared-state (types, validation, storage, domain↔persistence, service layer, REST API, error handling); Actual State observation foundation (types, validation, storage design, Prisma model + migration, domain↔persistence, service layer); Actual State ingestion (contract, validation, service flow, REST API); Drift comparison foundation (pure comparison, six categories, structured result, comparison service); Health Checks foundation (probe + evaluation + tests, [~] partial); Observability/Logging foundation (structured redacting logger, [~] partial); Reliability foundation (failure classification + bounded retry + recovery, [~] partial); Testing (validation + drift + health + logger + resilience 114 + persistence 9 + services 105 + desired-state API/e2e 28 + actual-state API/e2e 29); documentation (27, 70–71, 75, Day 14 updates) |
| Active engineering area | None — Day 14 closed |
| Next engineering area | Day 15: drift/status exposure (documented read-only endpoints if the contract is extended) and/or Desired State console UI; start of Control Plane foundation (§12) |
| Blockers | None currently |
| Technical debt | Day 8 portfolio verification projects remain in `forge` DB (`Prisma Test App`, `Persistence Check 2026`, `Post Cleanup Check`, `Final Verification 2026`) — treated as real data, kept by design; placeholder directories empty but intentional; `desired-state-model.md` (Work 45) absent as a standalone file — model captured in `desired-state.md` §4; Project API route still accesses Prisma directly (legacy path predating the service layer — adopting the service pattern there is low-priority future cleanup); `next build` fails prerendering the dashboard page because it fetches the API at build time (**pre-existing, confirmed against a pristine HEAD build; unrelated to Days 10–14; dev server unaffected**); retirement has no public HTTP endpoint (contract gap, see §7); Actual State ingestion endpoint is **unauthenticated** (documented limitation, see §7 and `docs/actual-state-ingestion.md` §10); drift comparison has **no HTTP endpoint and no persistence** (Day 13 scope); health checks / runtime status have **no HTTP endpoints and no scheduled probe loop** (Day 14 scope, service-level only); observability is **structured logging only** — no metrics/tracing pipeline (deliberately not introduced) |
| Important decisions | See Decision Log below |
| Last verified state | 2026-10-21 — Day 14 closed by Work 92: typecheck clean; eslint clean; unit (validation+drift+health+logger+resilience) 114/114; persistence 9/9; services 105/105; desired-state API+e2e 28/28; actual-state API+e2e 29/29; migrations up to date (no schema change in Day 14); `next build` prerender failure confirmed pre-existing via pristine HEAD worktree build |

---

## 15. Decision Log

| Decision | Rationale |
|---|---|
| PostgreSQL instead of in-memory storage | Persistence must survive restarts and scale to real workloads; replaced the original `data/projects.ts` array |
| Prisma as ORM | Type-safe schema, migrations, generated client, and clean SQL generation with PostgreSQL |
| Next.js App Router | Server-side API routes, modern React patterns, and a single codebase for the console + API |
| Reusable singleton Prisma client in `lib/prisma.ts` | Avoids duplicate client instances across Next.js dev hot reload |
| Prisma 7 requires a driver adapter (`@prisma/adapter-pg`) | Prisma 7's generated client connects via driver adapters; the adapter is the required DB connection layer |
| Continuous single 120-day journey (no V1/V2/V3/V4) | Product evolution should be driven by real requirements, not artificial version phases |
| Declarative desired-state model as the platform's core | Distinguishes FORGE from a CRUD app; reconciliation needs a declared target state |
| Hybrid persistence for Desired State (relational metadata header + JSONB payload) | Maps the API contract's metadata/content split exactly; immutable versioned snapshots; keeps validation at the API boundary (Work 49 design, implemented in Work 54) |
| Desired State stored as immutable, version-scoped JSONB snapshots (`(projectId, version)` unique) | Update = append a new version; history preserved for audit, comparison, and future rollback |
| Validation lives on the domain layer, gated before persistence | Invalid Desired State must never reach storage (`desired-state-persistence.md` §11) |
| `node --test` runs TypeScript tests directly | Node 24 type-stripping executes `.ts` without a build step; `.ts`-suffixed relative imports required (`allowImportingTsExtensions`) and used consistently |
| Each Desired State version row carries its own client-declared `desiredStateId` (Work 63 correction) | The migrated schema (Work 54) makes `desiredStateId` the row primary key with one row per immutable version, so a new version cannot reuse the current row's id; the update flow therefore takes the id from the request and only computes `version = current + 1` server-side. This matches the per-version-id convention already proven in Works 56/57/62 |
| `desiredStateId` / version conflicts map to HTTP 409 (CONFLICT) | Distinct from validation (400) and not-found (404); mirrors the contract's 409 "version/conflict problem" and the persistence layer's P2002 mapping |
| Retirement is a non-destructive service-level decision, with **no public HTTP endpoint** (Work 64) | The documented design defines RETIRE as removing the workload (needs later deployment machinery) and defines **no retention/deletion policy** (explicitly a future decision, `desired-state-persistence.md` §10); the Work 47 contract defines no delete route. `retireDesiredState` therefore verifies the declaration, returns the retirement decision (project, current id/version, retained version count), and mutates nothing — a public endpoint should only be added when the contract is extended |
| Desired State API responses use the contract's metadata + nested `desiredState` envelope | Matches `docs/desired-state-api.md` §5–6 request/response split (API metadata vs declaration payload) while reusing the platform-wide `{ success, data }` / `{ success, error }` envelope |
| Route handlers stay thin; all domain logic lives in the service layer | Routes parse JSON safely, read path params, inject `projectId` from the path, and map service errors to HTTP; they never import Prisma |
| `projectId` in the request body is always overridden by the path parameter | Every contract endpoint is project-scoped by the path (contract §3); the path is authoritative, which also keeps one project's state from being written under another's id |
| Actual State observations are immutable rows ordered by caller-supplied `observedAt` (Work 71 design, Work 72 implementation) | Latest observation = max `observedAt` per `(projectId, workloadId)`, tie-broken by `createdAt DESC`; `observedAt` reflects when reality was sampled (an agent may report late), while `createdAt` is storage time; history is preserved for point-in-time comparison and auditing |
| Null vs omitted encodes unknown in stored observations (Work 70/71) | `null` on an observed field = observed-but-unknown; omitted optional group = not part of the observation; `replicas: 0` = genuinely observed zero. This prevents a future drift comparator from misreading "unknown" as "absent" — a core correctness requirement for the documented drift categories |
| Actual State stored in a separate table from Desired State, linked only through `projectId` | The two record types have different lifecycles (one current declaration + versions vs many timestamped observations); keeping them apart preserves both models' invariants and lets the future drift detector read each independently (`docs/actual-state-persistence.md` §7) |
| `ObservedStatus` is a first-class relational enum (`running`/`stopped`/`failed`/`unknown`) | Lifecycle status is a queryable attribute of every observation (filtering, ordering); the rest of the observed payload stays in JSONB, mirroring the Desired State header+payload split |
| Actual State ingestion route is `POST /api/projects/{projectId}/actual-state/observations` (Work 78) | Follows the project-scoped path convention proven by the Desired State API; POST-only (append-only observations); `projectId` from path overrides body; thin route → ingestion validation → `ingestObservation` service → persistence, never touching Prisma directly |
| Duplicate `observationId` maps to HTTP 409 CONFLICT (Work 77/78) | `observationId` is the primary key; a second insert with the same id is a conflict, not a silent success or overwrite; mirrors the Desired State duplicate-id 409 mapping; existing row untouched |
| Stale observations (older `observedAt`) are accepted, not rejected (Work 75/77) | History is immutable and append-only; latest = `max(observedAt)` regardless of insertion order; a late-reporting agent must not be silently dropped, and must never replace newer data; the stale report remains a valid point-in-time observation |
| `observedAt` must be an ISO 8601 date-time string in the HTTP body (Work 76) | JSON has no Date type; the route/ingestion validation parses the string to a Date before the domain validator (which requires a Date); date-only strings without a time component are rejected (loss of ordering precision) |
| Actual State ingestion endpoint is currently **unauthenticated** (Work 78) | No auth infrastructure exists yet (auth is a future engineering area); the limitation is documented in the route code, contract §10, README, and this document — the endpoint is for local development / trusted environments only and must not be presented as production-secure |
| Drift comparison is a pure function with no I/O (`lib/drift/comparison.ts`, Work 81) | Comparison must be deterministic, unit-testable, and provably side-effect free (no DB/network, no mutation of either state); keeping it separate from the service layer lets future API, observability, and reconciliation layers reuse exactly the same logic |
| Comparison scope is one Project + one workload observation (Work 81/82) | The two `projectId`s must match or the call throws `DriftComparisonError`; a difference is never classified against another Project's declaration, and undeclared environment keys / undeclared optional sections are outside the declared scope (not "extra") |
| Only the six documented drift categories exist (Work 82) | `docs/desired-vs-actual.md` §5 defines Missing, Extra, Changed, Unhealthy, Configuration mismatch, Version mismatch — adding a seventh would create a competing classification system for future reconciliation to interpret |
| Unknown/absent observations are never classified as drift (Work 81/82) | `null`, omitted groups, `health: unknown`, and unreported optional sections go to `unknownProperties`; `outcome: insufficient-data` distinguishes "nothing comparable" from "confirmed match", so missing data cannot manufacture a false drift conclusion |
| Drift findings omit environment values (Work 83) | Environment maps commonly hold secrets; results expose only the differing keys, keeping comparison output safe to log, return from an API, or store later |
| Deterministic property ordering in results (Work 83) | Equivalent inputs must produce equivalent outputs; a fixed order makes results diffable, snapshot-testable, and stable for future API/observability consumers |
| No drift persistence table and no drift API endpoint yet (Works 83/84) | Drift results are derived data reproducible from the two existing records; storing them or exposing them requires an architecture/contract decision (§12 Day 14 item 1) that has not been made |
| Comparison service reports missing data as a status, not an error (`compareProjectState`, Work 84) | `no-desired-state` / `no-observation` are truthful outcomes distinct from `compared`; only invalid identifiers raise `VALIDATION_FAILED`. A stale observation is still compared, with `observedAt` surfaced so consumers can judge its age |
| Health checks probe a declared HTTP endpoint; process/container existence is never health evidence (Work 87) | The platform has no Docker/agent runtime yet, but it does have real HTTP-capable Node; a 2xx from the declared health path is the only positive proof. Inferring health from "a process exists" would silently report crashed-but-running containers as healthy |
| Health evaluation is pure and framework/DB-independent, separate from the probe transport (Work 87) | `runHealthCheck` + classification contain no Prisma/Next.js imports, so the same logic can later run inside a Node Agent, a worker, or the control plane; probes are injected behind the `HealthProbe` interface for testability |
| Runner-level timeout independent of the probe's own timeout (Work 87) | A misbehaving or custom probe must never hang the caller; the bounded race guarantees `runHealthCheck` always settles with a result instead of an exception |
| `checking` exists only as an in-flight status; completed results are `healthy`/`unhealthy`/`unknown` (Work 87) | Partial results must not masquerade as final ones; `unknown` truthfully means "could not determine" (incomplete probe output) and is distinct from a negative health signal |
| Runtime status reuses the `ActualStateObservation` table instead of a new model (Work 88) | A runtime status report *is* an observation (same fields, same identity, same duplicate/stale/isolation contracts); a second table would create divergent copies of the same fact and duplicate the persistence/validation layers |
| Optional `diagnostics` (`message`/`reason`/string `details`) stored inside the existing JSONB payload (Work 88) | JSONB absorbs additive optional structure without a migration; string-only values keep the shape log-safe; diagnostics ride with the observation so they survive restarts with the status they explain |
| Domain observations now surface DB-owned `createdAt` alongside `observedAt` (Work 88) | Consumers need to distinguish sampling time (ordering, staleness) from storage time (audit/recovery); conflating them (the pre-Day-14 workaround) hides ingestion lag |
| `getRuntimeStatus` staleness is computed against an injectable clock (Work 88/91) | Freshness must be testable deterministically and must not depend on wall-clock inside the persisted data; stale-after-restart is then simply "old `observedAt` vs now" |
| Structured logging is in-process JSON lines, not a monitoring stack (Work 89) | The repository has no metrics/tracing/log-shipping approach to integrate with; introducing Prometheus/OTel for a service-level foundation would be unused machinery. A redaction-safe logger covers the actual need now and can be backed by a pipeline later |
| Logger must never throw (Work 89) | Observability is best-effort; a broken sink or oversized payload must not fail health checks, status reports, or retries. Write failures degrade to a fallback line, then to silence |
| Key-based secret redaction before any sink write (Work 89) | Credential-shaped keys (`password`, `token`, `authorization`, `api-key`, …) are redacted at any depth — including whole `credentials` objects — so accidental payload logging cannot leak secrets; request bodies/headers are never logged by the wired events |
| Failure classification is structural (error `name`/`code`), not `instanceof` (Work 90) | Structural checks let pure retry tests run without importing Prisma-bound service modules, and keep classification working across module instances/processes |
| Validation/invalid failures are never retried; conflicts/not-found are permanent (Work 90) | Retrying an invalid report or a duplicate `reportId` cannot succeed and would amplify load; only transient persistence/network/timeout failures justify bounded retry |
| Bounded retries with exponential backoff, a cap, and an optional deadline (Work 90) | Prevents tight retry loops and uncontrolled resource consumption while still absorbing transient outages; `RetryExhaustedError` preserves the original cause for diagnosis |
| Duplicate reports are idempotent-by-conflict rather than last-write-wins (Work 88/90) | `reportId` is identity; a resumed/interrupted operation re-issuing the same report must not create a second row or overwrite — one row, deterministic CONFLICT |
| No automatic restart/redeploy/reconcile in Day 14 (Work 90/91) | The verified architecture has no Control Plane authorization for remediation; acting on failures without that boundary would be fabricated capability. Unhealthy states are reported, bounded, and logged — not "fixed" |
| Recovery durability is verified with a fresh Prisma client, not just re-reads (Work 91) | A fresh client proves the state lives in PostgreSQL, not in process memory; reconnect reads additionally cover the service path the app actually uses after a restart |

---

## 16. Engineering Principles

- **Desired state over manual operations** — developers declare intent; FORGE realizes it.
- **Declarative infrastructure** — prefer describing *what*, not *how*.
- **Reconciliation** — continuously converge actual state toward desired state.
- **Idempotency** — repeating an operation must be safe and produce the same outcome.
- **Observability** — measure, log, and trace; never operate blind.
- **Failure recovery** — assume failures; design retries, backoff, and resilience.
- **Separation of control plane and execution** — coordinators never live on worker nodes.
- **API-first design** — every capability is reachable through a well-formed API.
- **Testability** — verify each work block; build toward automated tests.
- **Production-oriented engineering** — security, reliability, and performance are default requirements.
- **Security by default** — least privilege, no secrets in source, secure communication.
- **Incremental real implementation** — small, working, verifiable steps.
- **Avoid unnecessary features** — no scope creep; build only what the product needs.

---

## 17. Development Rules for Future Work

1. One meaningful work block at a time.
2. Learn only the concept required for the current work.
3. Implement directly in the real project (no throwaway scaffolding).
4. Understand generated / AI-assisted code before accepting it.
5. Test every completed work block.
6. Keep Git history meaningful.
7. Do not add unrelated features.
8. Do not repeat already-completed work.
9. Update this document when a major engineering area changes.

---

## 18. Current Git State

Checked 2026-10-21 (end of Day 14). Latest commit is `5b1382d feat: implement
actual state observation foundation (Day 11)` (Day 10 = `16458f7`, Day 11 =
`5b1382d`). There are **uncommitted changes** — Day 12 (Works 75–80), Day 13
(Works 81–85), **and** Day 14 (Works 87–92) work, intentional and left for
review:

```
 M README.md                                  Day 12 + 13 + 14 documentation updates
 M docs/PROJECT_STATUS.md                     Day 12 + 13 + 14 status updates
 M apps/web/package.json                      test scripts incl. new suites (Works 76, 78–79, 85, 87–92)
 M apps/web/types/actual-state.ts             optional RuntimeDiagnostics + createdAt (Work 88)
 M apps/web/lib/validation/actual-state.ts    diagnostics passthrough (Work 88)
 M apps/web/lib/persistence/actual-state.ts   DuplicateObservationError + P2002 mapping + getObservationById (Work 77)
 M apps/web/lib/services/actual-state.ts      ingestObservation + CONFLICT error (Work 77)
 M apps/web/lib/services/actual-state.test.ts ingestion service tests + Day 14 key-set assertion (Works 77, 88)
?? apps/web/lib/drift/                        pure comparison + tests (Works 81–83)
?? apps/web/types/drift.ts                    structured drift result types (Work 83)
?? apps/web/lib/services/drift.ts             compareProjectState service (Work 84)
?? apps/web/lib/services/drift.test.ts        drift service tests (Work 84)
?? apps/web/lib/services/drift-integration.test.ts  full-flow integration tests (Work 85)
?? apps/web/lib/validation/actual-state-ingestion.ts       ingestion validator (Work 76)
?? apps/web/lib/validation/actual-state-ingestion.test.ts  16 tests (Work 76)
?? apps/web/lib/api/actual-state-http.ts       HTTP response/error mapping (Work 78)
?? apps/web/app/api/projects/[projectId]/actual-state/     route + route tests + e2e (Works 78–79)
?? docs/actual-state-ingestion.md              ingestion contract (Work 75)
?? apps/web/types/health-check.ts              health-check domain types (Work 87)
?? apps/web/lib/health-check/                  probe + evaluate + 14 tests (Work 87)
?? apps/web/types/runtime-status.ts            runtime report/view types (Work 88)
?? apps/web/lib/validation/runtime-status.ts   report validator (Work 88)
?? apps/web/lib/services/runtime-status.ts     report + read services (Work 88)
?? apps/web/lib/services/runtime-status.test.ts 14 tests (Works 88–90)
?? apps/web/lib/observability/                 structured logger + 10 tests (Work 89)
?? apps/web/lib/resilience/                    classify + withRetry + 16 tests (Work 90)
?? apps/web/lib/services/runtime-status-recovery.test.ts  6 recovery tests (Work 91)
?? apps/web/lib/services/day14-integration.test.ts  8 integration tests (Work 92)
```

Per working rules, **nothing has been committed or pushed for the Day 12,
Day 13, or Day 14 implementation work** — the changes are left for the
project owner's final review. No `.env` or secret files are staged or
untracked in the diff.

---

## 19. How To Continue

1. **Read this document** — understand where FORGE is and what the target architecture is.
2. **Check current Git status** — see if the Day 10 (Works 59–69),
   Day 11 (Works 70–74), Day 12 (Works 75–80), Day 13 (Works 81–85),
   and Day 14 (Works 87–92) work was committed since this doc was written.
3. **Verify the current implementation** — run from `apps/web`:
   - `npm run typecheck` (`tsc --noEmit`)
   - `npm run lint`
   - `npm test` (validation + pure drift comparison + health check +
     observability + resilience suites, no DB needed — 114 tests)
   - `npm run test:persistence` (integration; leaves no data)
   - `npm run test:services` (service layers incl. runtime status,
     recovery, Day 14 integration; leaves no data)
   - `npm run test:api` (desired-state route + e2e suites; leaves no data)
   - `npm run test:api:actual` (actual-state ingestion route + e2e suites; leaves no data)
   - `npx prisma migrate status` ("Database schema is up to date!")
   - `npm run dev` then exercise the API, e.g.
     `POST/GET/PUT /api/projects/{projectId}/desired-state`,
     `GET /api/projects/{projectId}/desired-state/{version}`, and
     `POST /api/projects/{projectId}/actual-state/observations`.
   - Note: `npm run build` currently fails prerendering the dashboard page
     (`ECONNREFUSED`, pre-existing — see §14); use `npm run dev` for manual
     checks.
4. **Continue from the next phase (Day 15)** — expose the comparison and
   runtime status to consumers per §12 (documented read-only drift/status
   endpoints if the API contract is extended, and/or the Desired State
   console surface), then start the Control Plane foundation.
   Reconciliation remains a future phase.
5. **Update `PROJECT_STATUS.md`** after major milestones (new engineering area
   started/completed, architecture changes, deadline/schedule changes).
6. **Commit meaningful completed work** — with clear, conventional messages;
   never commit the `.env` or any secrets.

---

*This document distinguishes **implemented** from **planned**. Checkbox marks
reflect work actually done in the repository as of 2026-10-21 (Day 14).*