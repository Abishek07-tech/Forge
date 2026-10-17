# FORGE — Desired-State-Driven Infrastructure Control Platform

FORGE is a full-stack control-plane platform in which a developer **declares
the desired state** of an application environment, and the platform manages
the lifecycle required to build, deploy, observe, detect drift, reconcile,
scale, update, and eventually retire that workload.

The repository is under active incremental development (Day 10 of the plan
complete as of 2026-10-17). The **declared-state half of the control loop is
implemented and verified**; the executed-state half (Actual State, drift
detection, reconciliation) is designed but not yet built.

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
FORGE observes the actual state                         ← not yet implemented
        ↓
If actual ≠ desired (drift) → FORGE reconciles         ← not yet implemented
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
- Test suites for validation, persistence, the service layer, and the API
  (including end-to-end and process-restart survival checks).

**Designed but not implemented:** Control Plane service, Scheduler, Node
Agent, container/workload management, deployment lifecycle, health checks,
Actual State collection, drift detection, reconciliation, scaling, rollback,
observability, authentication, secrets management, CI/CD, cloud deployment.

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
        ↓
Service layer        apps/web/lib/services/desired-state.ts
  (validation gate, versioning, error taxonomy)
        ↓
Persistence layer    apps/web/lib/persistence/desired-state.ts
  (Prisma error mapping, domain ↔ row conversion)
        ↓
Prisma 7 + @prisma/adapter-pg
        ↓
PostgreSQL  "forge"
```

Route handlers stay thin (parse request → call service → map response);
domain types are independent of Prisma; validation runs before any write.

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
│       │       └── projects/[projectId]/desired-state/
│       │           ├── route.ts            POST, GET, PUT
│       │           ├── route.test.ts       route + validation + error tests
│       │           ├── e2e.test.ts         end-to-end suite
│       │           └── [version]/route.ts  GET specific version
│       ├── components/             CreateProject, ProjectCard, ProjectDashboard
│       ├── types/                  Project + Desired State domain types
│       ├── lib/
│       │   ├── prisma.ts           reusable Prisma client singleton
│       │   ├── validation/         Desired State validator + tests
│       │   ├── persistence/        Desired State persistence + tests
│       │   ├── services/           Desired State service layer + tests
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

# apply migrations (Project + DesiredState tables)
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

npm test                        # Desired State validation (13 tests, no DB)
npm run test:persistence        # persistence layer (9 integration tests)
npm run test:services           # service layer (32 tests)
npm run test:api                # API routes + end-to-end (28 tests)
```

## API

All responses use the platform envelope: `{ "success": true, "data": … }` on
success, `{ "success": false, "error": "…", "errors": […] }` on failure.

Errors: `400` invalid request · `404` project/Desired State/version not
found · `409` duplicate version or `desiredStateId` · `500` unexpected
(internal details are never leaked).

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

## Known Limitations

- **No executed-state half yet** — nothing observes running workloads, so
  drift detection, reconciliation, scaling, and rollback do not exist.
- **No Control Plane / Scheduler / Node Agent** — stored Desired State is
  not yet consumed by any deployer; there is no Docker/container integration.
- **No authentication or authorization** — the API is open on localhost.
- **No retirement endpoint** — the API contract defines no delete/retire
  route and the persistence design defines no retention policy; retirement
  exists only as a non-destructive service-level operation
  (`retireDesiredState`).
- **Web Console is a foundation only** — it manages projects; it does not yet
  surface Desired State.
- **`npm run build` prerender caveat** — the dashboard page fetches the API
  at build time, so a production build needs the dev server/database
  reachable, or that page made dynamic (pre-existing, unrelated to the
  Desired State API; `npm run dev` is unaffected).
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

## Roadmap to the December 10, 2026 Target

The full 31-area engineering roadmap lives in
[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) §10. The critical path
toward a working end-to-end control loop:

1. **Actual State** — domain model, storage, observation ingestion (Day 11+)
2. **Drift detection** — compare declared vs observed per the six documented
   drift categories
3. **Control Plane + Scheduler + Node Agent** — consume Desired State and
   execute deployments on real nodes
4. **Reconciliation loop** — converge actual state toward desired state
5. **Observability, auth, CI/CD, cloud deployment, portfolio demo**

Completing the Desired State API (Day 10) does not mean FORGE as a whole is
finished — it means the platform can now reliably answer *"what should
exist?"* The remaining work makes it answer *"does it exist, and if not, fix
it."*
