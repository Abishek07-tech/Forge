# FORGE — Desired-State-Driven Infrastructure Control Platform

FORGE is a full-stack control-plane platform in which a developer **declares
the desired state** of an application environment, and the platform manages
the lifecycle required to build, deploy, observe, detect drift, reconcile,
scale, update, and eventually retire that workload.

The repository is under active incremental development (Day 14 of the plan
complete as of 2026-10-21). The **declared-state half of the control loop is
implemented and verified**, the **Actual State observation ingestion path is
implemented and verified**, the **drift comparison foundation (Desired vs
Actual) is implemented and verified**, and Day 14 added a **health-check
foundation, runtime status reporting, structured observability, bounded
failure handling, and recovery/resilience behavior — all service-level and
test-verified**. Reconciliation, deployment, and the node agent are designed
but not yet built.

## The Problem FORGE Solves

Manually operating application environments produces configuration drift,
gaps, and duplicated effort. FORGE closes the loop between *desired state*
and *actual state*:

```
Developer declares desired state
        ↓
FORGE stores, versions, and validates the declaration   ← implemented (Days 8–10)
        ↓
FORGE builds, schedules, and deploys the workload       ← not yet implemented
        ↓
Observation source reports the actual state             ← ingestion API implemented (Day 12)
        ↓
FORGE probes health and reports runtime status          ← health check + runtime status services (Day 14)
        ↓
FORGE compares actual vs desired (drift)                 ← comparison service implemented (Day 13)
        ↓
FORGE reconciles the difference                          ← not yet implemented
```

A single control surface (Web Console + REST API) replaces a chain of
disconnected tools.

## Current Implementation Status

**Implemented and verified:**

- Next.js web console foundation (dashboard, project creation).
- Project API (`GET`/`POST /api/projects`) backed by PostgreSQL.
- Desired State domain model, validation, versioned persistence (Prisma 7 +
  PostgreSQL, immutable JSONB snapshots).
- **Desired State REST API** — create, read, update (new version), and read
  historical versions, with request validation and consistent error handling.
- Desired State service layer (validation gate, versioning rules, conflict
  handling, non-destructive retirement semantics).
- Actual State domain model, validation, persistence, service layer
  (immutable timestamped observations with explicit unknown semantics).
- **Actual State Ingestion REST API** — `POST
  /api/projects/{projectId}/actual-state/observations`, validated end-to-end
  (HTTP → route → validation → service → persistence → PostgreSQL), with
  duplicate → 409 and stale-observation handling. **Currently unauthenticated
  (local development / trusted environments only).**
- **Drift comparison (service-level)** — `compareProjectState` reads a
  Project's current Desired State and its latest Actual State observation,
  then a pure function classifies differences into the six documented drift
  categories (`missing`, `extra`, `changed`, `unhealthy`,
  `configuration-mismatch`, `version-mismatch`) and reports
  `match` / `drift` / `insufficient-data`. **No public endpoint and no
  persistence — results are computed on demand.**
- **Health-check foundation (service-level, Day 14)** — `runHealthCheck`
  probes a target HTTP health endpoint through a `HealthProbe` abstraction and
  returns a structured `HealthCheckResult` (`healthy` | `unhealthy` |
  `unknown`) with timestamps, duration, and failure diagnostics. Bounded by a
  configurable timeout; timeouts, connection failures, and 5xx responses are
  unhealthy; incomplete results are `unknown` — **a running process alone is
  never reported as healthy**.
- **Runtime status reporting (service-level, Day 14)** —
  `reportRuntimeStatus` validates a runtime report, maps it onto the existing
  Actual State observation store (immutable rows, duplicate `reportId` →
  conflict, stale/out-of-order reports accepted but never displacing newer
  data), and `getRuntimeStatus` returns the latest status with staleness
  (`stale`, `ageMs`) and optional diagnostics.
- **Structured observability (Day 14)** — a JSON-line logger with severity
  levels, child contexts, correlation ids, and **automatic secret redaction**;
  health-check outcomes, runtime status reports, and status transitions emit
  traceable events. Logging failures never propagate to callers. No metrics
  stack was introduced.
- **Failure handling (Day 14)** — failures are classified as retryable /
  permanent / invalid; `withRetry` provides bounded retries with exponential
  backoff and an optional deadline. Duplicate reports are idempotent-by-
  conflict (one row, no duplicate side effects). No automatic restart or
  redeploy exists or was added.
- **Recovery/resilience (Day 14)** — runtime status survives simulated
  process restarts (fresh client reads the persisted rows); monitoring
  recovers after temporary target connectivity loss without duplicating
  reports; stale information after a restart is reported as stale; still-
  unreachable applications stay accurately unhealthy.
- Test suites for validation, persistence, the service layers, drift
  comparison (pure + full flow), health checks, observability, resilience,
  recovery, the Day 14 integration flow, and both APIs (including end-to-end
  and process-restart survival checks).

**Designed but not implemented:** Control Plane service, Scheduler, Node
Agent, container/workload management, deployment lifecycle, scheduled/agent-
driven health checks (the Day 14 foundation probes on demand from code),
drift result API/persistence, reconciliation, scaling, rollback, metrics/
tracing stacks, authentication, secrets management, CI/CD, cloud deployment.

See [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) for the authoritative
per-area status and the full engineering roadmap.

## Architecture (current)

```
Web Console (Next.js / React / Tailwind)
        ↓ fetch()
API Routes
  /api/projects                                      (GET, POST)
  /api/projects/{projectId}/desired-state            (POST, GET, PUT)
  /api/projects/{projectId}/desired-state/{version}  (GET)
  /api/projects/{projectId}/actual-state/observations (POST, unauthenticated)
        ↓
Service layer        apps/web/lib/services/{desired-state,actual-state}.ts
  (validation gate, versioning/duplicate rules, error taxonomy)
        ↓
Persistence layer    apps/web/lib/persistence/{desired-state,actual-state}.ts
  (Prisma error mapping, domain ↔ row conversion)
        ↓
Prisma 7 + @prisma/adapter-pg
        ↓
PostgreSQL  "forge"
```

Route handlers stay thin (parse request → call service → map response);
domain types are independent of Prisma; validation runs before any write.

Drift comparison is a **read-only service path with no HTTP route**:

```
compareProjectState (apps/web/lib/services/drift.ts)
   → current Desired State + latest observation (read-only)
   → compareDesiredAndActual (apps/web/lib/drift/comparison.ts, pure)
   → DriftComparisonResult (apps/web/types/drift.ts)
```

Health checks and runtime status reporting are **service paths with no HTTP
route** (Day 14):

```
runHealthCheck (apps/web/lib/health-check/evaluate.ts)
   → HealthProbe (HTTP probe against the declared health path/port)
   → HealthCheckResult (status + timestamps + duration + failure diagnostics)
   → optional structured log event (health-check.started / health-check.completed)

reportRuntimeStatus (apps/web/lib/services/runtime-status.ts)
   → report validation → ingestObservation (existing Actual State store)
   → RuntimeStatusView (latest status + stale flag + age + diagnostics)

getRuntimeStatus (apps/web/lib/services/runtime-status.ts)
   → latest observation by max(observedAt) → freshness computed against a clock

withRetry (apps/web/lib/resilience/retry.ts)
   → classifyFailure (retryable / permanent / invalid)
   → bounded attempts + exponential backoff + optional deadline
```

All of these layers share the structured logger
(`apps/web/lib/observability/logger.ts`), which redacts secret-looking keys
and never throws.

## Technology Stack (confirmed in this repository)

| Technology | Used for |
|---|---|
| Next.js 16 (App Router, Turbopack) | Web application + API route handlers |
| React 19 | UI components |
| TypeScript 5 | Type-safe application, API, and test code |
| Tailwind CSS 4 | Styling |
| Node.js 24 | Runtime (also runs `node --test` TypeScript suites directly) |
| PostgreSQL | Persistent database (`forge`) |
| Prisma 7 (+ `@prisma/adapter-pg`, `pg`) | ORM, schema, migrations, generated client |
| `node:test` | Test runner for all suites (no external test framework) |

Planned/candidate (not implemented): Go, Redis, gRPC, Docker, Prometheus,
OpenTelemetry, cloud infrastructure.

## Repository Structure

```
control-panel/                      ← repository root
├── apps/
│   └── web/                        ← Next.js application (active implementation)
│       ├── app/
│       │   ├── page.tsx            dashboard page
│       │   └── api/
│       │       ├── projects/route.ts
│       │       ├── projects/[projectId]/desired-state/
│       │       │   ├── route.ts            POST, GET, PUT
│       │       │   ├── route.test.ts       route + validation + error tests
│       │       │   ├── e2e.test.ts         end-to-end suite
│       │       │   └── [version]/route.ts  GET specific version
│       │       └── projects/[projectId]/actual-state/observations/
│       │           ├── route.ts            POST (ingestion)
│       │           ├── route.test.ts       route tests
│       │           └── e2e.test.ts         end-to-end suite
│       ├── components/             CreateProject, ProjectCard, ProjectDashboard
│       ├── types/                  Project + Desired State + Actual State + Drift + health-check + runtime-status types
│       ├── lib/
│       │   ├── prisma.ts           reusable Prisma client singleton
│       │   ├── validation/         Desired State + Actual State + ingestion + runtime-status validators + tests
│       │   ├── persistence/        Desired State + Actual State persistence + tests
│       │   ├── services/           Desired State + Actual State + drift + runtime-status service layers + tests
│       │   │                        (incl. recovery + Day 14 integration suites)
│       │   ├── drift/              pure Desired-vs-Actual comparison + tests
│       │   ├── health-check/       probe + evaluation + tests (Work 87)
│       │   ├── observability/      structured logger with redaction + tests (Work 89)
│       │   ├── resilience/         failure classification + bounded retry + tests (Work 90)
│       │   └── api/                HTTP response/error mapping
│       ├── prisma/                 schema.prisma + migrations
│       └── generated/prisma/       generated Prisma client
├── apps/api/                       placeholder (empty)
├── services/control-plane/         placeholder (empty)
├── agent/node-agent/               placeholder (empty)
├── packages/                       placeholder (empty)
├── docs/                           architecture + design documents
└── README.md                       ← this file
```

## Setup

### Prerequisites

- **Node.js 24+** (the test suites rely on Node's native TypeScript
  type-stripping)
- **PostgreSQL 14+** running locally (or reachable instance)
- npm (comes with Node)

### Installation

```bash
cd apps/web
npm install
```

### Environment variables

Create `apps/web/.env` (gitignored — never commit it):

```
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/forge
```

Only `DATABASE_URL` is required. Substitute your own local credentials; do
not commit real values.

### Database setup

```bash
cd apps/web

# one-time: create the database
psql -U postgres -c 'CREATE DATABASE forge;'

# apply migrations (Project + DesiredState + ActualStateObservation tables)
npx prisma migrate deploy

# confirm
npx prisma migrate status
```

### Development

```bash
cd apps/web
npm run dev          # start the app (http://localhost:3000)
```

Other scripts (all verified against `apps/web/package.json`):

```bash
npm run build        # production build
npm run start        # run the production build
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
```

## Running Tests

All suites use Node's built-in test runner and leave no data behind.
Suites that touch the database require `apps/web/.env` with `DATABASE_URL`.

```bash
cd apps/web

npm test                        # validation + drift pure + health check + observability + resilience (114 tests, no DB)
npm run test:persistence        # persistence layer (9 integration tests)
npm run test:services           # service layers incl. drift, runtime status, recovery, Day 14 flow (105 tests)
npm run test:api                # Desired State API routes + e2e (28 tests)
npm run test:api:actual         # Actual State ingestion routes + e2e (29 tests)
```

## API

All responses use the platform envelope: `{ "success": true, "data": … }` on
success, `{ "success": false, "error": "…", "errors": […] }` on failure.

Errors: `400` invalid request · `404` project/Desired State/version not
found · `409` duplicate version, `desiredStateId`, or `observationId` ·
`500` unexpected (internal details are never leaked).

### Projects

```bash
# list projects
curl http://localhost:3000/api/projects

# create a project
curl -X POST http://localhost:3000/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-service"}'
```

### Desired State

`projectId` in the path is always authoritative. `version` on create/update
is the version you are declaring; on **update** the server appends
`current + 1` regardless of the body's `version`. Each version must declare
its own `desiredStateId` (every version is an immutable snapshot with a
distinct id).

```bash
PID=<project id>

# create version 1
curl -X POST "http://localhost:3000/api/projects/$PID/desired-state" \
  -H 'Content-Type: application/json' \
  -d '{
    "desiredStateId": "ds_1",
    "version": 1,
    "applications": { "image": "forge-api:v1", "port": 8080 },
    "runtime": { "replicas": 2 },
    "resources": { "cpu": "250m", "memory": "256Mi" },
    "health": { "path": "/health" }
  }'

# read the current (latest) Desired State
curl "http://localhost:3000/api/projects/$PID/desired-state"

# update — appends version 2 as a new immutable snapshot
curl -X PUT "http://localhost:3000/api/projects/$PID/desired-state" \
  -H 'Content-Type: application/json' \
  -d '{
    "desiredStateId": "ds_2",
    "version": 1,
    "applications": { "image": "forge-api:v2", "port": 8080 },
    "runtime": { "replicas": 3 },
    "resources": { "cpu": "500m", "memory": "512Mi" },
    "health": { "path": "/health" }
  }'

# read a specific historical version
curl "http://localhost:3000/api/projects/$PID/desired-state/1"
```

Successful responses split API metadata from the declaration:

```json
{
  "success": true,
  "data": {
    "desiredStateId": "ds_2",
    "projectId": "…",
    "version": 2,
    "createdAt": "…",
    "updatedAt": "…",
    "desiredState": {
      "applications": { "image": "forge-api:v2", "port": 8080 },
      "runtime": { "replicas": 3 },
      "resources": { "cpu": "500m", "memory": "512Mi" },
      "health": { "path": "/health" }
    }
  }
}
```

### Actual State Ingestion

`POST /api/projects/{projectId}/actual-state/observations` records one
observation snapshot. `projectId` in the path is authoritative (any
`projectId` in the body is ignored).

**Required body fields:** `observationId` (unique, non-empty string),
`workloadId`, `source`, `observedAt` (ISO 8601 date-time string with time
component), `status` (`running` | `stopped` | `failed` | `unknown`),
`application` (`image` string|null, `port` int 1–65535|null), `runtime`
(`replicas` int ≥0|null), `resources` (`cpu`/`memory` string|null),
`health` (`status`: `healthy` | `unhealthy` | `unknown`). Optional:
`environment` (string map), `deployment` (`version` int ≥0|null).

`null` means **observed but unknown**; `replicas: 0` means genuinely
observed zero. Omitted optional groups are not part of the observation.

```bash
PID=<project id>

# ingest an observation
curl -X POST "http://localhost:3000/api/projects/$PID/actual-state/observations" \
  -H 'Content-Type: application/json' \
  -d '{
    "observationId": "obs_1",
    "workloadId": "default",
    "source": "test-harness",
    "observedAt": "2026-10-19T10:00:00Z",
    "status": "running",
    "application": { "image": "forge-api:v1", "port": 8080 },
    "runtime": { "replicas": 2 },
    "resources": { "cpu": "250m", "memory": "256Mi" },
    "health": { "status": "healthy" }
  }'
```

Successful response (201) splits metadata from the observed payload:

```json
{
  "success": true,
  "data": {
    "observationId": "obs_1",
    "projectId": "…",
    "workloadId": "default",
    "source": "test-harness",
    "observedAt": "2026-10-19T10:00:00Z",
    "status": "running",
    "createdAt": "…",
    "observation": {
      "application": { "image": "forge-api:v1", "port": 8080 },
      "runtime": { "replicas": 2 },
      "resources": { "cpu": "250m", "memory": "256Mi" },
      "health": { "status": "healthy" }
    }
  }
}
```

**Behavior:**

- Duplicate `observationId` → **409 Conflict** (existing row untouched).
- Stale observation (older `observedAt` than current latest) → **accepted and
  stored**; never replaces newer data (latest = highest `observedAt`).
- Invalid payload → **400** with field-level `errors[]`; never persisted.
- Missing project → **404**.

**Authentication limitation:** this endpoint is currently **unauthenticated**
— suitable only for local development and trusted environments. It must not
be exposed publicly as a production ingestion interface without an
authorization design.

### Drift Comparison (service layer — no HTTP endpoint)

There is **no public drift API**. Comparison is available in-process through
`compareProjectState(projectId, workloadId = "default")`
(`apps/web/lib/services/drift.ts`), which returns one of:

- `no-desired-state` — the Project has no declaration to compare against;
- `no-observation` — no observation exists for that workload (this is *not*
  reported as drift);
- `compared` — the current Desired State version vs the latest observation,
  with a `DriftComparisonResult`: `outcome` (`match` | `drift` |
  `insufficient-data`), `findings[]` (property, documented category,
  explanation, safe desired/observed values), plus `comparedProperties[]`
  and `unknownProperties[]`.

Unknown/absent observations (`null`, omitted groups, `health: unknown`) are
never classified as a difference; stale observations are still compared with
their `observedAt` disclosed. Nothing is persisted and nothing is corrected.

### Health Checks and Runtime Status (service layer — no HTTP endpoint)

There is **no health or runtime-status public API**. Both are available
in-process only.

**Health check** — `runHealthCheck(probe, context, options)`
(`apps/web/lib/health-check/evaluate.ts`):

```ts
const check = await runHealthCheck(
  createHttpHealthProbe(),
  {
    projectId,
    workloadId,
    target: { scheme: "http", host: "127.0.0.1", port: 8080, path: "/health" },
  },
  { config: { timeoutMs: 5_000 } }
);
// check.status: "healthy" | "unhealthy" | "unknown"
// check.checkedAt / check.durationMs / check.failure { kind, message, statusCode }
```

- HTTP probe with independent runner timeout — a hung probe is cut off and
  reported `unhealthy` (`kind: "timeout"`).
- 2xx → `healthy`; non-2xx, refused/unreachable, or probe errors →
  `unhealthy` with a `failure` describing the kind; incomplete probe output
  → `unknown`. Existence of a process or container is **not** evidence of
  health and is never treated as such.
- `checkId`, `projectId`, `workloadId`, and target context are attached to
  structured log events (`health-check.started`, `health-check.completed`).

**Runtime status reporting** — `reportRuntimeStatus(report, options?)` and
`getRuntimeStatus(projectId, workloadId, options?)`
(`apps/web/lib/services/runtime-status.ts`):

- Reports validate before touching persistence; a repeated `reportId`
  returns a `CONFLICT` error and never duplicates the row.
- Stale/out-of-order reports (`reportedAt` older than the current latest)
  are stored but never displace newer data (same contract as observation
  ingestion).
- `getRuntimeStatus` returns `availability: "unknown"` when nothing has been
  reported, or `availability: "known"` with `stale`, `ageMs`, the source
  `observedAt`/`recordedAt`, and the stored snapshot including optional
  `diagnostics` (`message`, `reason`, string `details`).
- Status transitions (previous vs new status/health) are emitted as
  `runtime-status.transition` log events.

**Retry** — `withRetry(operation, options)` (`apps/web/lib/resilience/`):
classifies failures first (validation/invalid and conflict/not-found errors
are never retried), then retries only retryable failures with exponential
backoff (`baseDelayMs` → `maxDelayMs`) up to `maxAttempts`, optionally under
a `deadlineMs` budget. Exhaustion throws `RetryExhaustedError` preserving the
last error, attempt count, and disposition.

## Known Limitations

- **Comparison exists only as a service operation** — Desired State can be
  compared against the latest Actual State observation in-process (pure
  function + `compareProjectState`), but there is **no drift endpoint, no
  persisted drift history, and no reconciliation**: FORGE does not act on
  differences.
- **Health checks are on-demand, not scheduled** — the Day 14 foundation
  probes a target when code calls `runHealthCheck`; there is no scheduler,
  no agent-driven probe loop, and no HTTP endpoint exposing check results.
  Check results are logged and can be folded into runtime reports, but they
  are not stored as their own history.
- **Runtime status has no public endpoint** — reports are submitted
  through the service layer (the existing ingestion HTTP API covers the
  same observation payload); there is no dedicated status API or console
  view.
- **Observability is structured logging only** — JSON-line events with
  redaction and correlation ids; **no metrics, tracing, or log pipeline
  exists**, and no monitoring stack was introduced.
- **No automatic recovery or restart** — bounded retries exist for transient
  failures, but FORGE never automatically restarts, redeploys, or reconciles
  a workload; unhealthy states are reported, not acted upon.
- **No Control Plane / Scheduler / Node Agent** — stored Desired State is
  not yet consumed by any deployer; there is no Docker/container integration
  and no real node reports observations.
- **Ingestion endpoint is unauthenticated** — the Actual State ingestion API
  is open on localhost with no token/session verification; suitable only for
  local development and trusted environments.
- **No authentication or authorization** — the API is open on localhost.
- **No retirement endpoint** — the API contract defines no delete/retire
  route and the persistence design defines no retention policy; retirement
  exists only as a non-destructive service-level operation
  (`retireDesiredState`).
- **Web Console is a foundation only** — it manages projects; it does not yet
  surface Desired State, Actual State, health, or runtime status.
- **`npm run build` prerender caveat** — the dashboard page fetches the API
  at build time, so a production build needs the dev server/database
  reachable, or that page made dynamic (pre-existing, confirmed against a
  pristine HEAD baseline build; unrelated to Days 12–14; `npm run dev` is
  unaffected).
- The Project API route still accesses Prisma directly (legacy path from
  before the service layer existed).

## Documentation

- [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) — master status,
  roadmap, decision log, deadline tracking (start here)
- [`docs/architecture.md`](docs/architecture.md) — platform architecture
- [`docs/desired-state.md`](docs/desired-state.md) — Desired State concept
- [`docs/desired-vs-actual.md`](docs/desired-vs-actual.md) — comparison model
  and drift categories
- [`docs/desired-state-api.md`](docs/desired-state-api.md) — API contract
  (the implemented routes follow this contract)
- [`docs/desired-state-persistence.md`](docs/desired-state-persistence.md) —
  storage strategy
- [`docs/desired-state-persistence-implementation.md`](docs/desired-state-persistence-implementation.md) —
  persistence implementation boundary
- [`docs/actual-state-persistence.md`](docs/actual-state-persistence.md) —
  Actual State storage design
- [`docs/actual-state-ingestion.md`](docs/actual-state-ingestion.md) —
  observation ingestion contract (endpoint, field ownership, stale/duplicate
  behavior, security limitation)

## Roadmap to the December 10, 2026 Target

The full 31-area engineering roadmap lives in
[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) §10. The critical path
toward a working end-to-end control loop:

1. **Actual State foundation + ingestion** — domain model, storage,
   observation ingestion API (Day 11–12) ✓ implemented
2. **Drift comparison foundation** — pure comparison + six documented
   categories + read-only service (Day 13) ✓ implemented
3. **Health, runtime visibility, resilience** — health-check foundation,
   runtime status reporting, structured logging, bounded retries,
   restart/outage recovery (Day 14) ✓ implemented (service-level)
4. **Drift exposure** — documented read-only drift endpoint / console view
   (next)
5. **Control Plane + Scheduler + Node Agent** — consume Desired State and
   execute deployments on real nodes; scheduled health probes and real
   runtime reports from agents
6. **Reconciliation loop** — converge actual state toward desired state
7. **Metrics/tracing, auth, CI/CD, cloud deployment, portfolio demo**

Completion of Days 11–14 means FORGE can now reliably answer *"what should
exist?"* (Desired State), *"what was reported to exist?"* (Actual State),
*"are they the same, and if not what differs?"* (drift), and *"is the
runtime healthy right now, and can failures be retried and recovered from
safely?"* (health/runtime status/resilience). The remaining work makes it
answer *"fix it."*

The fixed project completion deadline is **December 10, 2026**.
