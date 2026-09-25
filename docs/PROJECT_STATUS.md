# FORGE — Master Project Status

> Single source of truth for the FORGE control-platform project.
> Keep this document updated whenever a major engineering area changes.
> Last updated: 2026-09-25

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
API Route  /api/projects  (GET, POST)         ← Project API (Day 8)
        ↓
Reusable Prisma client (apps/web/lib/prisma.ts)
        ↓  driver adapter (@prisma/adapter-pg)
PostgreSQL database "forge"  (Project table + DesiredState table)
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

**Stage: "Foundation + Desired State Implementation"**

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
- **Not implemented:** Desired State API, Control Plane, Actual State
  collection, drift detection, reconciliation. Those remain later
  engineering areas; Day 9 ends with a stable Desired State foundation.

---

## 6. Repository Structure

```
control-platform/  (repo root = Forge/control-panel)
├── apps/
│   ├── web/                  ← Next.js app (active implementation)
│   │   ├── app/
│   │   │   ├── page.tsx             (dashboard page)
│   │   │   └── api/projects/route.ts   (GET + POST /api/projects)
│   │   ├── components/              (CreateProject, ProjectCard, ProjectDashboard)
│   │   ├── types/
│   │   │   ├── project.ts           (Project TypeScript type)
│   │   │   └── desired-state.ts     (Desired State domain types, Work 51)
│   │   ├── lib/
│   │   │   ├── prisma.ts            (reusable Prisma client)
│   │   │   ├── validation/desired-state.ts       (Work 52, + .test.ts)
│   │   │   └── persistence/desired-state.ts      (Work 57, + .test.ts)
│   │   ├── generated/prisma/        (generated Prisma client incl. DesiredState)
│   │   ├── prisma/schema.prisma     (Project model + ProjectStatus enum + DesiredState model)
│   │   ├── prisma/migrations/       (initial_project, 20260925060845_add_desired_state)
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
│   └── desired-state-persistence-implementation.md   (Work 53, boundary notes)
└── README.md
```

Note: `apps/api`, `services/control-plane`, `agent/node-agent`, and
`packages/` exist as empty scaffolding only — **no implementation yet**.

---

## 7. Current Implementation (Implemented Facts)

| Layer | Details |
|---|---|
| Framework | Next.js (App Router), React, TypeScript, Tailwind CSS |
| Database | PostgreSQL, local `forge` database |
| ORM | Prisma 7 (`prisma` + `@prisma/client` 7.10.0), `prisma.config.ts` |
| Schema | `apps/web/prisma/schema.prisma` — `Project` model, `ProjectStatus` enum, `DesiredState` model |
| Prisma client | `apps/web/lib/prisma.ts` — cached singleton (safe for Next.js hot reload), uses `PrismaPg` driver adapter |
| Migrations | `initial_project` + `20260925060845_add_desired_state` — applied; `prisma migrate status` = "Database schema is up to date!" |
| API | `GET /api/projects` (read from PostgreSQL), `POST /api/projects` (create in PostgreSQL) |
| Response shape | `{ success: boolean, data: ... }`; errors return `{ success: false, error: string }` |
| Validation | POST requires a non-empty string `name` (trimmed); HTTP 400 on invalid input |
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

## 10. 120-Day Roadmap

One continuous 120-day journey — **no artificial V1/V2/V3/V4 phases.** Work is
organized by engineering area. Progress is driven by real product/architecture
requirements.

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
- **API Layer (2)** — `[~]` `GET`/`POST /api/projects` exist and persist.
  Broader API layer (auth, project detail/update/delete, control-plane-facing
  APIs) remains.
- **Documentation (27)** — `[~]` Architecture, desired-state, and this master
  status document exist. Ongoing.
- **Desired State System (4)** — `[~]` Foundation implemented (Works 51–58:
  domain types, validation, Prisma model + migration, domain↔persistence
  layer, verified end-to-end). Desired State API and Control Plane
  integration remain.
- **Testing (23)** — `[~]` `node --test` suites exist for Desired State
  validation (13 tests) and persistence (9 integration tests). Unit/API/e2e
  test coverage for the wider platform remains.

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
- **Status:** Conceptual design phase complete (Works 44–49); implementation
  **foundation** complete (Works 51–58): domain types, validation, Prisma
  model + migration, verified domain↔persistence layer. Desired State API is
  the next phase (not started).
- **Major work:** Desired-state schema/type; storage; validation; "desired vs.
  actual" comparison source.

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
- **Major work:** Foundation in place: `node --test` suites for Desired State
  validation (13 tests) and persistence (9 integration tests incl. restart
  persistence and error mapping). Unit tests; API/integration tests; migration
  testing; e2e for critical flows remain.

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
  persistence strategy. **Design only — not implemented.**
- Desired State **implementation foundation** completed (Works 51–58): domain
  types (51), validation (52), persistence boundary notes (53), Prisma model
  (54), migration (55), persistence verification (56), domain ↔ persistence
  layer (57), final end-to-end verification + cleanup (58). Verified:
  `npx tsc --noEmit` clean, validation 13/13, persistence 9/9, 13-check
  full-stack flow passed, test data removed.

### What is currently in progress
- No work block is currently active. The last completed block closed Day 9
  (Work 58): the Desired State foundation is complete and stable.

### What comes next
- Implement the **Desired State API** (`/api/projects/{projectId}/desired-state`)
  per the documented contract (`docs/desired-state-api.md`), gated by Work 52
  validation and backed by the Work 57 persistence layer. Control Plane
  integration remains a later engineering area.

---

## 12. Next Immediate Work

**Implement the Desired State API** — the foundation needed for it already
exists and is verified.

Day 9 (Works 51–58) completed the Desired State foundation: domain types,
validation, Prisma model + migration, and a verified domain ↔ persistence
layer. The documented implementation path (`docs/desired-state-api.md` §14)
now has its first three steps done:

```
TypeScript Domain Types          (done — Work 51)
Request Validation              (done — Work 52)
PostgreSQL Persistence          (done — Works 54–57)
API Route                       ← NEXT
Control Plane Integration       (later)
```

Planned order of the next implementation work:

1. **Desired State API routes** — implement the documented contract
   (`docs/desired-state-api.md` §4): `POST`/`GET`/`PUT`
   `/api/projects/{projectId}/desired-state`, scoped by `projectId`, gated by
   Work 52 validation, stored via the Work 57 persistence layer.
2. **Control Plane integration** — hand stored Desired State to the control
   plane (that component itself remains a later engineering area).

> The Desired State API, Actual State, drift detection, and reconciliation
> are **not implemented yet**. This section describes the *next* phase, not
> completed work.

---

## 13. Deadline

| Item | Value |
|---|---|
| Total target | **120 days** |
| Start date | **2026-09-12** (derived from the first Git commit: `c21e802 day 1 complete to define platform architecture`) |
| Target completion date | **2027-01-10** (2026-09-12 + 120 days) |
| Current day / stage | **Day 9 of 120** (as of 2026-09-25) — Foundation complete; Desired State design (Day 8) + implementation foundation (Works 51–58) complete |

---

## 14. Progress Tracking

| Item | Value |
|---|---|
| Overall project status | Foundation complete; Desired State design (Day 8) + implementation foundation (Day 9) complete; Desired State API not started |
| Completed engineering areas | Database/ORM foundation; project API GET/POST; persistence; Desired State System foundation (types, validation, storage, domain↔persistence); Testing foundation (validation + persistence suites); documentation (27) |
| Active engineering area | Desired State System — foundation complete; API implementation pending |
| Next engineering area | Desired State API (validation + persistence already in place) |
| Blockers | None currently |
| Technical debt | Day 8 portfolio verification projects remain in `forge` DB (`Prisma Test App`, `Persistence Check 2026`, `Post Cleanup Check`, `Final Verification 2026`) — treated as real data, kept by design; placeholder directories empty but intentional; `desired-state-model.md` (Work 45) absent as a standalone file — model captured in `desired-state.md` §4 |
| Important decisions | See Decision Log below |
| Last verified state | 2026-09-25 — Day 9 closed by Work 58: `npx tsc --noEmit` clean; validation 13/13; persistence 9/9 (incl. restart persistence); end-to-end flow 13 checks passed; temporary test code removed; DB clean (4 projects / 0 DesiredState rows) |

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

Checked 2026-09-25. The repository has **7 commits**; the latest committed
state is `7b8f05a docs: complete desired state design` (committed the Day 8
design documentation for Works 44, 46, 47, 49). There are **uncommitted
changes** — all Day 9 Desired State implementation work (Works 51–58),
intentional and not yet committed:

```
 M apps/web/lib/prisma.ts                      .ts-suffixed Prisma import (Work 57)
 M apps/web/package.json                       test script (Work 52)
 M apps/web/prisma/schema.prisma               DesiredState model (Work 54)
 M apps/web/tsconfig.json                      allowImportingTsExtensions (Work 52)
 M apps/web/generated/prisma/                  regenerated client incl. DesiredState (Work 54)
?? apps/web/types/desired-state.ts             domain types (Work 51)
?? apps/web/lib/validation/                    validation + tests (Work 52)
?? apps/web/lib/persistence/                   persistence layer + tests (Work 57)
?? apps/web/generated/prisma/models/DesiredState.ts       generated model (Work 54)
?? apps/web/prisma/migrations/20260925060845_add_desired_state/   migration (Work 55)
?? docs/desired-state-persistence-implementation.md      boundary notes (Work 53)
```

Per working rules, these will be committed with a clear conventional message
when the next work block begins — **nothing has been committed or pushed for
the Day 9 implementation work yet.**

---

## 19. How To Continue

1. **Read this document** — understand where FORGE is and what the target architecture is.
2. **Check current Git status** — see if the Day 9 Desired State work was committed since this doc was written.
3. **Verify the current implementation** — run:
   - `cd apps/web`
   - `npx tsc --noEmit`
   - `npx prisma migrate status`
   - `npm test` (Desired State validation suite)
   - `node --env-file=.env --test lib/persistence/desired-state.test.ts` (integration; leaves no data)
   - start the app and confirm `GET` / `POST /api/projects` behave against PostgreSQL.
4. **Continue from the next phase** — implement the Desired State API
   (`/api/projects/{projectId}/desired-state`), wiring the existing Work 52
   validation and Work 57 persistence layer into real route handlers.
5. **Update `PROJECT_STATUS.md`** after major milestones (new engineering area
   started/completed, architecture changes, deadline/schedule changes).
6. **Commit meaningful completed work** — with clear, conventional messages;
   never commit the `.env` or any secrets.

---

*This document distinguishes **implemented** from **planned**. Checkbox marks
reflect work actually done in the repository as of 2026-09-25.*