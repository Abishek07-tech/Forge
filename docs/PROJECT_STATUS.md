# FORGE — Master Project Status

> Single source of truth for the FORGE control-platform project.
> Keep this document updated whenever a major engineering area changes.
> Last updated: 2026-10-17 (Day 11 complete — Actual State observation foundation live)

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
        ↓
Service layer (apps/web/lib/services/desired-state.ts, actual-state.ts)
        ↓  validation gate (Work 52 / Work 70) before any write
Persistence layer (apps/web/lib/persistence/desired-state.ts, actual-state.ts)
        ↓  driver adapter (@prisma/adapter-pg)
PostgreSQL "forge"
  (Project + DesiredState tables — declared state)
  (ActualStateObservation table — observed state, Day 11)
```

The Project API route still talks to Prisma directly (legacy path, unchanged).
All Desired State traffic goes through the thin route → service → persistence
layering; route handlers never touch Prisma. Actual State observations enter
through the service layer only (no public HTTP route yet; the future node
agent or an ingestion API will call it).

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

**Stage: "Actual State observation foundation complete — both halves of the loop now have storage"**

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
  incl. restart survival + cleanup + documentation (74). Observations enter
  the system through the service layer (test harness); **no public HTTP
  ingestion route yet**.
- **Not implemented:** Control Plane, drift detection, reconciliation,
  scheduler, node agent, deployment, Actual State public API. The Desired
  State API is the declaration ingress and the Actual State service is the
  observation ingress; everything downstream (comparison, action) remains
  later engineering areas.

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
│   │   │       └── projects/[projectId]/desired-state/
│   │   │             ├── route.ts          (POST, GET, PUT — Work 65)
│   │   │             ├── route.test.ts     (route + validation + error tests — Works 65–67)
│   │   │             ├── e2e.test.ts       (end-to-end suite — Work 68)
│   │   │             └── [version]/route.ts
│   │   │                   (GET …/desired-state/{version} — Work 65)
│   │   ├── components/              (CreateProject, ProjectCard, ProjectDashboard)
│   │   ├── types/
│   │   │   ├── project.ts           (Project TypeScript type)
│   │   │   ├── desired-state.ts     (Desired State domain types, Work 51)
│   │   │   └── actual-state.ts      (Actual State domain types, Work 70)
│   │   ├── lib/
│   │   │   ├── prisma.ts            (reusable Prisma client)
│   │   │   ├── validation/desired-state.ts       (Work 52, + .test.ts)
│   │   │   ├── validation/actual-state.ts        (Work 70, + .test.ts)
│   │   │   ├── persistence/desired-state.ts      (Work 57, + .test.ts)
│   │   │   ├── persistence/actual-state.ts       (Work 73, + service tests)
│   │   │   ├── services/desired-state.ts         (Works 59–64, + .test.ts)
│   │   │   ├── services/actual-state.ts          (Work 73, + .test.ts)
│   │   │   └── api/desired-state-http.ts         (Works 65–67 response/error mapping)
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
│   └── actual-state-persistence.md    (Work 71, Actual State storage design)
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
| Service layer | `lib/services/desired-state.ts` — create, update (next-version), read current, read by version, list versions, retire; validation gate + error taxonomy (`VALIDATION_FAILED` / `NOT_FOUND` / `CONFLICT` / `PERSISTENCE_FAILED`). `lib/services/actual-state.ts` (Day 11) — record observation, read latest, list history; validation gate + error taxonomy (`VALIDATION_FAILED` / `NOT_FOUND` / `PERSISTENCE_FAILED`); missing latest → `null`, no error |
| Actual State ingestion | Service layer only (no public HTTP route); test harness records observations today; future node agent / ingestion API will call the same service |
| HTTP mapping | `lib/api/desired-state-http.ts` — response envelope (metadata + nested `desiredState`) and status mapping (400/404/409/500) |
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

### Database flow

```
Next.js API route → lib/prisma.ts (cached PrismaClient) → PostgreSQL "forge"

Desired State flow (Day 9):
domain types → validation → persistence layer → Prisma → PostgreSQL "forge"
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
| 11 | Health Checks | [ ] |
| 12 | Drift Detection | [ ] |
| 13 | Reconciliation | [ ] |
| 14 | Scaling | [ ] |
| 15 | Rollback | [ ] |
| 16 | Observability | [ ] |
| 17 | Logging | [ ] |
| 18 | Metrics | [ ] |
| 19 | Tracing | [ ] |
| 20 | Authentication and Authorization | [ ] |
| 21 | Secrets / Configuration Management | [ ] |
| 22 | Infrastructure Integration | [ ] |
| 23 | Testing | [~] |
| 24 | Security Hardening | [ ] |
| 25 | Performance | [ ] |
| 26 | Reliability | [ ] |
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
  declare → validate → version → store → read — is complete. Control Plane
  integration, Actual State collection, drift detection, and reconciliation
  remain (the executed-state half of the loop).
- **Testing (23)** — `[~]` Four `node --test` suites: Desired State
  validation (13), persistence (9 integration incl. restart), service layer
  (32), and Desired State API + e2e (28, incl. cross-process restart
  survival). Coverage for the wider platform (console, Project API, future
  control plane) remains.

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
  semantics, routes, request validation, error handling, e2e). The
  **executed-state half is not started**: Actual State collection, drift
  detection, and reconciliation (which consume this declared state).
- **Major work remaining:** Actual State as the comparison source; handing
  stored declarations to the Control Plane.

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

#### 11. Health Checks — `[ ] Not started`
- **Goal:** Know whether a workload is actually healthy.
- **Major work:** Configurable health checks; probes; reporting.

#### 12. Drift Detection — `[ ] Not started`
- **Goal:** Detect when actual state no longer matches desired state.
- **Major work:** Comparison of desired vs. actual; thresholds; drift events.

#### 13. Reconciliation — `[ ] Not started`
- **Goal:** Repair drift automatically.
- **Major work:** Reconciliation loop; reaction to drift events; converge check.

#### 14. Scaling — `[ ] Not started`
- **Goal:** Change capacity toward desired/required levels.
- **Major work:** Manual scaling; replicas; later automated/autoscaling hooks.

#### 15. Rollback — `[ ] Not started`
- **Goal:** Recover workloads to a known-good state.
- **Major work:** Version/pinned state; rollback procedure; validation.

#### 16. Observability — `[ ] Not started`
- **Goal:** See what the system is doing end-to-end.
- **Major work:** Metrics, logs, and traces surfaced in one place.

#### 17. Logging — `[ ] Not started`
- **Goal:** Structured, queryable logs from all components.
- **Major work:** Log pipeline; correlation IDs; retention.

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
- **Major work:** Four `node --test` suites covering the Desired State path
  end to end: validation (13), persistence (9, incl. restart + error
  mapping), service layer (32, incl. update/retire/conflict), and the public
  API + e2e (28, incl. malformed JSON, isolation, cross-process restart
  survival). Remaining: Project API tests, console tests, migration testing,
  and tests for future control-plane components.

#### 24. Security Hardening — `[ ] Not started`
- **Goal:** Safe default posture throughout.
- **Major work:** Authn/z; secure comms; audit; dependency hygiene;
  least-privilege workloads.

#### 25. Performance — `[ ] Not started`
- **Goal:** Reasonable latency/throughput for the platform's operations.
- **Major work:** Query/timing discipline; pagination; caching; load checks.

#### 26. Reliability — `[ ] Not started`
- **Goal:** Recover from failures gracefully.
- **Major work:** Retries/backoff; idempotency; circuit behavior; recovery
  drills.

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

### What is currently in progress
- Nothing. **Day 11 (Works 70–74) is complete.** No work block is active.

### What comes next
- **Day 12** should build the comparison half: drift classification as a
  pure function plus an observation ingestion path. See §12.

---

## 12. Next Immediate Work

**Day 12: build the comparison half of the control loop.**

Both halves now have storage: Desired State (declaration, versioned) and
Actual State (observations, timestamped). What is missing is the piece that
makes them useful together — comparing current Desired State against the
latest observation — plus a public path for observations to enter the system
today.

Planned order for Day 12 (engineering area: Drift / Control Plane
foundation):

1. **Comparison primitive** — a pure function that takes a Project's current
   Desired State and its latest Actual State observation and classifies the
   six documented drift categories (`docs/desired-vs-actual.md`),
   respecting the null-vs-observed unknown semantics (unknown is never
   reported as absent). Verified by tests only, no storage changes.
2. **Observation ingestion API** — a thin public HTTP route over the
   existing `recordObservation` service so external callers (test harness
   today, node agent later) can record observations without importing the
   service directly; same route → service → persistence layering and error
   mapping conventions as the Desired State API.
3. **Desired State console surface (optional parallel track)** — expose the
   now-live Desired State API in the Web Console (declare/view/update from
   the dashboard) so the portfolio story has a UI.

> Drift detection results, reconciliation, and the node agent are **not
> implemented yet**. This section describes the *next* phase, not completed
> work. The Control Plane as a standalone service (Go/Redis, etc.) remains a
> later engineering area; Day 12 keeps the loop inside the existing
> Next.js + PostgreSQL stack, consistent with the incremental implementation
> principle.

---

## 13. Deadline

| Item | Value |
|---|---|
| Overall completion target | **December 10, 2026** — fixed 90-day target set by the project owner (supersedes the original 120-day figure below) |
| Start date | **2026-09-12** (derived from the first Git commit: `c21e802 day 1 complete to define platform architecture`) |
| Current day / stage | **Day 11 complete** (as of 2026-10-17) — both halves of the loop have storage: Desired State service + REST API (Day 10) and Actual State observation foundation (Day 11); drift comparison and reconciliation not started |
| Remaining runway | ~64 days to the December 10 target (accounting for elapsed calendar days) |

> The original working note recorded a 120-day target (→ 2027-01-10). The
> project owner has since fixed the completion target at **December 10,
> 2026**. This document treats December 10, 2026 as authoritative.

---

## 14. Progress Tracking

| Item | Value |
|---|---|
| Overall project status | Both halves of the control loop have storage (Day 11): Desired State service layer + validated, versioned REST API on PostgreSQL; Actual State observation foundation (domain types, validation, storage, service layer). Drift detection and reconciliation not started. |
| Completed engineering areas | Database/ORM foundation; project API GET/POST; persistence; Desired State System declared-state (types, validation, storage, domain↔persistence, service layer, REST API, error handling); Actual State observation foundation (types, validation, storage design, Prisma model + migration, domain↔persistence, service layer); Testing (validation 28 + persistence 9 + service 46 + API/e2e 28); documentation (27, 70–71) |
| Active engineering area | None — Day 11 closed |
| Next engineering area | Drift comparison primitive + Actual State ingestion API (Day 12); optional Desired State console UI in parallel |
| Blockers | None currently |
| Technical debt | Day 8 portfolio verification projects remain in `forge` DB (`Prisma Test App`, `Persistence Check 2026`, `Post Cleanup Check`, `Final Verification 2026`) — treated as real data, kept by design; placeholder directories empty but intentional; `desired-state-model.md` (Work 45) absent as a standalone file — model captured in `desired-state.md` §4; Project API route still accesses Prisma directly (legacy path predating the service layer — adopting the service pattern there is low-priority future cleanup); `next build` fails prerendering the dashboard page because it fetches the API at build time (pre-existing, unrelated to Day 10/11; dev server unaffected); retirement has no public HTTP endpoint (contract gap, see §7); Actual State observation has no public HTTP ingestion route yet (Day 12 scope) |
| Important decisions | See Decision Log below |
| Last verified state | 2026-10-17 — Day 11 closed by Work 74: typecheck clean; eslint clean; validation 28/28; persistence 9/9; services 46/46; API+e2e 28/28; migrations up to date; restart-survival passed; DB hygiene verified (4 baseline projects, 0 DesiredState, 0 observations) |

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
| Actual State has no public HTTP route yet (Work 73/74) | The Day 11 scope is the observation foundation (domain → validation → storage → service); exposing ingestion is scheduled for Day 12 so the route can reuse the proven thin-route conventions and the drift comparator exists to consume the data |

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

Checked 2026-10-17 (end of Day 11). Latest commit is `4223cbc feat: implement
desired state persistence` (the Day 9 foundation, Works 51–58, has since been
committed). There are **uncommitted changes** — all Day 10 Desired State
service + API work (Works 59–69) *and* all Day 11 Actual State observation
foundation work (Works 70–74), intentional and left for review:

```
 M README.md                                  Day 10 documentation update (Work 69)
 M apps/web/package.json                      test scripts incl. new suites (Works 68, 74)
 M apps/web/prisma/schema.prisma              ActualStateObservation model + ObservedStatus enum (Work 72)
 M apps/web/lib/persistence/desired-state.ts  DuplicateDesiredStateIdError + P2002 id-violation mapping (Work 63)
 M apps/web/generated/prisma/**               regenerated client incl. ActualStateObservation (Work 72)
 M docs/PROJECT_STATUS.md                     Day 10 + Day 11 status updates (Works 69, 74)
?? apps/web/types/actual-state.ts             Actual State domain types (Work 70)
?? apps/web/lib/validation/actual-state.ts    validator + 15 tests (Work 70)
?? apps/web/lib/persistence/actual-state.ts   repository layer (Work 73)
?? apps/web/lib/services/                     Desired State (Works 59–64) + Actual State service + tests (Work 73)
?? apps/web/lib/api/                          HTTP response/error mapping (Works 65–67)
?? apps/web/app/api/projects/[projectId]/     Desired State API routes + tests (Works 65–68)
?? apps/web/prisma/migrations/20261017084744_add_actual_state/   migration (Work 72)
?? docs/actual-state-persistence.md           storage design (Work 71)
```

Per working rules, **nothing has been committed or pushed for the Day 10 or
Day 11 implementation work** — the changes are left for the project owner's
final review. No `.env` or secret files are staged or untracked in the diff.

---

## 19. How To Continue

1. **Read this document** — understand where FORGE is and what the target architecture is.
2. **Check current Git status** — see if the Day 10 (Works 59–69) and
   Day 11 (Works 70–74) work was committed since this doc was written.
3. **Verify the current implementation** — run from `apps/web`:
   - `npm run typecheck` (`tsc --noEmit`)
   - `npm run lint`
   - `npm test` (validation suites, no DB needed)
   - `npm run test:persistence` (integration; leaves no data)
   - `npm run test:services` (service layers; leaves no data)
   - `npm run test:api` (route + e2e suites; leaves no data)
   - `npx prisma migrate status` ("Database schema is up to date!")
   - `npm run dev` then exercise the API, e.g.
     `POST/GET/PUT /api/projects/{projectId}/desired-state` and
     `GET /api/projects/{projectId}/desired-state/{version}`.
4. **Continue from the next phase (Day 12)** — build the comparison half of
   the loop per §12: drift classification as a pure function over current
   Desired State vs latest Actual State, plus a public observation
   ingestion route over the existing service.
5. **Update `PROJECT_STATUS.md`** after major milestones (new engineering area
   started/completed, architecture changes, deadline/schedule changes).
6. **Commit meaningful completed work** — with clear, conventional messages;
   never commit the `.env` or any secrets.

---

*This document distinguishes **implemented** from **planned**. Checkbox marks
reflect work actually done in the repository as of 2026-10-17 (Day 11).*