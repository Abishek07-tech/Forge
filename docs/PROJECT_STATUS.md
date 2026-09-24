# FORGE — Master Project Status

> Single source of truth for the FORGE control-platform project.
> Keep this document updated whenever a major engineering area changes.
> Last updated: 2026-09-24

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
API Route  /api/projects  (GET, POST)
        ↓
Reusable Prisma client (apps/web/lib/prisma.ts)
        ↓  driver adapter (@prisma/adapter-pg)
PostgreSQL database "forge"  (Project table)
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

**Stage: "Foundation + Desired State Design"**

- The web + database foundation is working (Project API, PostgreSQL
  persistence, verified across restarts).
- Day 8 (Works 44–49) completed the **conceptual Desired State design
  phase**: concept (44), data model (45), desired vs actual / drift (46),
  API contract (47), architecture review (48), and persistence strategy (49).
- These are **designs only**. No Desired State system is implemented: no
  storage, no API, no validation code, no Actual State collection, no drift
  detection, no reconciliation.
- The next phase moves from **design to implementation** — starting from the
  foundation already built, not by redoing the database layer.

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
│   │   ├── types/project.ts         (Project TypeScript type)
│   │   ├── lib/prisma.ts            (reusable Prisma client)
│   │   ├── prisma/schema.prisma     (Project model + ProjectStatus enum)
│   │   ├── prisma/migrations/       (initial_project migration)
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
│   └── desired-state-persistence.md   (Work 49, storage strategy)
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
| Schema | `apps/web/prisma/schema.prisma` — `Project` model, `ProjectStatus` enum |
| Prisma client | `apps/web/lib/prisma.ts` — cached singleton (safe for Next.js hot reload), uses `PrismaPg` driver adapter |
| Migration | `initial_project` — applied; `prisma migrate status` = "Database schema is up to date!" |
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

### Database flow

```
Next.js API route → lib/prisma.ts (cached PrismaClient) → PostgreSQL "forge"
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
| 23 | Testing | [ ] |
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
- **Desired State System (4)** — `[~]` Conceptual design complete (Works
  44–49: concept, data model, desired vs actual / drift, API contract,
  persistence strategy, architecture review). Implementation not started.

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
- **Status:** Conceptual design phase complete (Works 44–49). Implementation
  not started.
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

#### 23. Testing — `[ ] Not started`
- **Goal:** Confidence through automated verification.
- **Major work:** Unit tests; API/integration tests; migration testing;
  e2e for critical flows.

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
- Final verification passed: TypeScript clean, `prisma migrate status`
  up-to-date, GET/POST returning persisted data.
- Desired State design phase completed (Works 44–49): concept, data model,
  desired vs actual + drift, API contract, architecture review,
  persistence strategy. **Design only — not implemented.**

### What is currently in progress
- No work block is currently active. The last completed block closed Day 8:
  the Desired State design phase. No code changes accompanied it.

### What comes next
- Move the Desired State design into **implementation** — starting with
  Desired State database persistence and the Desired State API, per the
  documented implementation paths.

---

## 12. Next Immediate Work

**Begin implementing the Desired State system** — moving from design to
implementation.

Day 8 produced the full conceptual Desired State design (Works 44–49). The
immediate next phase is to make it real, following the documented path in
`docs/desired-state-persistence.md` §15 and `docs/desired-state-api.md` §14:

```
Persistence Design
    ↓
Prisma Domain Model
    ↓
Migration
    ↓
PostgreSQL Persistence
    ↓
API Integration
    ↓
Control Plane Integration
```

Planned order of the first implementation work:

1. **Prisma domain model + migration** — persist Desired State versions
   (relational metadata header + structured payload), scoped to `Project`,
   without changing the existing `Project` table.
2. **Desired State API** — implement the documented contract
   (`/api/projects/{projectId}/desired-state`) behind validation.
3. **Control Plane integration** — hand stored Desired State to the control
   plane (that component itself remains a later engineering area).

> The Desired State systems (storage, API, validation, Actual State, drift
> detection, reconciliation) are **not implemented yet**. This section
> describes the *next* phase, not completed work. The earlier project
> management completion items (project detail/update/delete) remain noted
> under the Web Console and API Layer roadmap areas.

---

## 13. Deadline

| Item | Value |
|---|---|
| Total target | **120 days** |
| Start date | **2026-09-12** (derived from the first Git commit: `c21e802 day 1 complete to define platform architecture`) |
| Target completion date | **2027-01-10** (2026-09-12 + 120 days) |
| Current day / stage | **Day 8 of 120** (as of 2026-09-24) — Foundation complete; Desired State design phase complete (Works 44–49) |

---

## 14. Progress Tracking

| Item | Value |
|---|---|
| Overall project status | Foundation complete; Desired State design phase complete; Desired State implementation not started |
| Completed engineering areas | Database/ORM foundation; project API GET/POST; persistence; Desired State System conceptual design (area 4, design portion); documentation (27) |
| Active engineering area | Desired State System — design phase complete; implementation pending |
| Next engineering area | Desired State System implementation (persistence → API → control-plane hand-off) |
| Blockers | None currently |
| Technical debt | Test rows from verification remained in `forge` DB; placeholder directories empty but intentional; `desired-state-model.md` (Work 45) absent as a standalone file — model captured in `desired-state.md` §4 |
| Important decisions | See Decision Log below |
| Last verified state | 2026-09-24 — Works 44–49 design verified against FORGE architecture (Work 48 review, no contradictions); DB/API foundation still: TypeScript clean, migration up-to-date, GET/POST persisted correctly |

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

Checked 2026-09-24. The repository has **6 commits**; the latest committed
state is `f0a8529 feat: add PostgreSQL persistence and project status docs`.
There are **uncommitted changes** — all documentation from the Day 8 design
works (Works 44–49), intentional and not yet committed:

```
 M docs/desired-state.md                 Desired State concept (Work 44)
?? docs/desired-vs-actual.md             Desired vs Actual + Drift (Work 46)
?? docs/desired-state-api.md             Desired State API contract (Work 47)
?? docs/desired-state-persistence.md     Persistence strategy (Work 49)
```

Per working rules, these will be committed with a clear conventional message
when the next work block begins — **nothing has been committed or pushed for
the Works 44–49 design work yet.**

---

## 19. How To Continue

1. **Read this document** — understand where FORGE is and what the target architecture is.
2. **Check current Git status** — see if the database/API work was committed since this doc was written.
3. **Verify the current implementation** — run:
   - `cd apps/web`
   - `npx tsc --noEmit`
   - `npx prisma migrate status`
   - start the app and confirm `GET` / `POST /api/projects` behave against PostgreSQL.
4. **Continue from the next phase** — begin implementing the Desired State
   system (persistence → API → control-plane hand-off), moving the Day 8
   design into real code.
5. **Update `PROJECT_STATUS.md`** after major milestones (new engineering area
   started/completed, architecture changes, deadline/schedule changes).
6. **Commit meaningful completed work** — with clear, conventional messages;
   never commit the `.env` or any secrets.

---

*This document distinguishes **implemented** from **planned**. Checkbox marks
reflect work actually done in the repository as of 2026-09-24.*