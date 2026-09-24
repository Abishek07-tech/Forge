# FORGE Desired State

> Conceptual contract for FORGE's Desired State.
> This document describes **what Desired State means** for FORGE. It is a
> design contract, **not an implemented feature**. None of the Desired State
> persistence, validation, API, drift detection, or reconciliation described
> here exists in code yet.

---

## 1. What is FORGE Desired State?

Desired State is **what a developer declares they want their application or
environment to look like.**

Instead of manually running containers, setting replica counts, editing
config files, or watching dashboards, a developer writes down the target
end state once:

- the image and version to run,
- how many copies (replicas) should exist,
- how much CPU and memory each copy gets,
- what ports it listens on,
- which environment variables it needs,
- how health should be verified.

FORGE will eventually read that declaration and **work to make the real,
running environment match it**. If the actual environment differs from the
declaration, FORGE (in future) takes action to bring them back together.

The declaration itself is the **Desired State**. What is actually running
right now is the **Actual State**. Moving Actual State toward Desired State is
the long-term purpose of the platform.

---

## 2. Desired State vs Actual State

| | Desired State | Actual State |
|---|---|---|
| **What it is** | What the developer declares should be true | What is actually true running today |
| **Who defines it** | The developer | The running system |
| **When it changes** | Only when the developer changes the declaration | Whenever anything drifts, restarts, fails, or is scaled |
| **Role in FORGE** | The target to converge toward (future) | The source of truth for comparison (future) |

Simple example:

**Desired State:**

```
application: payments-api
image:       payments-api:1.2
replicas:    3
port:        8080
```

**Actual State:**

```
application: payments-api
image:       payments-api:1.1
replicas:    2
port:        8080
```

The two differ in two places:

- image is `payments-api:1.1` instead of `payments-api:1.2` — an old version is running.
- replicas is `2` instead of `3` — one instance is missing.

These differences are **drift**. Drift is the gap between what the developer
asked for and what the system actually has. In the future, FORGE should detect
that gap and close it automatically.

> Drift detection and reconciliation are **future functionality**. They are
> **not implemented today.**

---

## 3. Core FORGE idea

The central loop of FORGE, stated simply:

```
Developer
    ↓  declares
Desired State
    ↓  consumed by
FORGE
    ↓  realizes
Actual State
```

Eventually this becomes a closed, continuously-running loop:

```
Desired State
    ↓
Observe Actual State
    ↓
Compare
    ↓
Detect Drift
    ↓
Reconcile
    ↓
Actual State matches Desired State
        ↓    (loop continues — the world can change again)
```

Read as: FORGE observes what is running, compares it to what the developer
declared, notices any difference, and — in future — repairs the difference so
the running system converges back to the declaration.

**Status note:** Only the top-most relationship is real today in the
conceptual sense (FORGE manages *projects*). Drift detection, reconciliation,
and even storing a Desired State are **planned, not implemented**.

---

## 4. Desired State components

These are the conceptual building blocks of a Desired State. Their exact
schema is undefined for now. They are intentionally **not** database models
yet.

### Project

- **Represents:** A named, owned unit of work in FORGE (the developer's
  application as a managed entity).
- **Why FORGE needs it:** It is the container everything else hangs off of —
  the entry point for the whole platform. A Desired State is always for some
  Project.
- **Example:** `payments-api` — a project that owns the payments service.

### Application

- **Represents:** The actual software to run — its image, version, and how it
  accepts traffic (port, protocol).
- **Why FORGE needs it:** FORGE must know *what* to run before it can run it.
  Application describes the artifact, not the infrastructure around it.
- **Example:** `payments-api:1.2` exposed on port `8080`.

### Runtime

- **Represents:** How the application is executed — how many replicas, restart
  behavior, scheduling constraints.
- **Why FORGE needs it:** It captures the execution shape so FORGE (in future)
  knows how many instances to place and keep alive.
- **Example:** run exactly `3` replicas.

### Resources

- **Represents:** The CPU and memory budget each instance is entitled (and
  limited) to.
- **Why FORGE needs it:** Without resource bounds a scheduler cannot place
  workloads intelligently or protect instances from each other.
- **Example:** `500m` CPU and `512Mi` memory per replica.

### Environment

- **Represents:** Configuration injected into the application at runtime —
  environment variables, presets, and (eventually) secrets.
- **Why FORGE needs it:** Two deployments of the same image are different only
  by their environment; environment makes an application behave differently
  without rebuilding it.
- **Example:** `NODE_ENV=production`.

### Deployment

- **Represents:** A versioned, realized attempt to take a Desired State and
  make it real (the link between "declared" and "running").
- **Why FORGE needs it:** FORGE must track which target, image, and settings
  were last applied, so updates and rollbacks are possible.
- **Example:** deployment #7 of `payments-api:1.2` with 3 replicas.

### Health

- **Represents:** The rule that decides whether an instance is alive and
  usable — the probe path, port, and interval.
- **Why FORGE needs it:** "Running" is not the same as "working." Health tells
  FORGE whether a converged state is actually serving.
- **Example:** HTTP GET `/health` on port `8080` must return 200 OK.

> These components are conceptual only. No database tables, TypeScript
> interfaces, API fields, or YAML parser exist for them yet.

---

## 5. Conceptual example

A Desired State expressed as YAML. **This is a conceptual illustration, not an
implemented FORGE configuration format.**

```yaml
project:
  name: payments-api

application:
  image: payments-api:1.2
  port: 8080

runtime:
  replicas: 3

resources:
  cpu: "500m"
  memory: "512Mi"

environment:
  NODE_ENV: production

health:
  path: /health
```

Reads as: "the `payments-api` project should run `payments-api:1.2` on port
`8080`, with 3 replicas, each limited to 500m CPU and 512Mi memory, in
production mode, healthy at `/health`."

This format is **not** wired to any system. FORGE does not yet parse, store,
validate, or act on YAML like this. It exists only to make the concept
concrete.

---

## 6. Desired State principles

Any future Desired State contract should honor these principles.

- **Declarative** — The developer says *what* the end state should be, never
  *how* to reach it. Steps belong to FORGE, not to the declaration.
- **Explicit** — Everything that must be true is written down. Nothing is
  silently assumed or defaulted in a way that surprises the developer.
- **Idempotent** — Applying the same Desired State twice must be safe and
  produce the same outcome. No duplicate instances, no failing retries.
- **Observable** — The declared state and the current actual state must be
  inspectable, so anyone can see the gap between them at any time.
- **Reconciliatory** — Desired State is the target of a converge loop: actual
  state is continuously compared and (in future) repaired toward it.
- **Versionable** — A Desired State can be stored, compared, and reverted like
  any other versioned artifact, enabling history and rollback.
- **Validatable** — A Desired State must be checkable before use: valid image,
  sane resource sizes, reachable port, well-formed health rule.
- **Safe to update** — Changing a Desired State must never take the system
  down abruptly; updates move carefully from the current state toward the new
  target.

---

## 7. Relationship to FORGE lifecycle

Desired State is the thing that anchors the whole lifecycle. The lifecycle
below is the intended arc of a workload under FORGE. Desired State is the
reference every stage converges on.

```
CREATE
→ CONFIGURE
→ VALIDATE
→ BUILD
→ TEST
→ PACKAGE
→ SCHEDULE
→ DEPLOY
→ HEALTH CHECK
→ RUN
→ OBSERVE
→ DRIFT
→ RECONCILE
→ SCALE
→ UPDATE
→ ROLLBACK
→ RETIRE
```

### Implemented now

Only the first step exists, and only in a basic project-management form:

- **CREATE** — a project can be created and read via the Project API
  (`POST` / `GET /api/projects`). This is project creation, **not** a Desired
  State yet.

### Planned (not implemented)

Everything else is **planned**. In future these stages will consume Desired
State:

- **CONFIGURE** — associate a Desired State with a project.
- **VALIDATE** — check the Desired State is well-formed before use.
- **BUILD / TEST / PACKAGE** — turn source into a deployable artifact and
  verify it.
- **SCHEDULE** — decide which nodes run the replicas.
- **DEPLOY / HEALTH CHECK / RUN** — realize the Desired State and prove it is
  alive.
- **OBSERVE / DRIFT** — watch actual state and compare it to Desired State.
- **RECONCILE** — repair drift so actual converges on desired.
- **SCALE / UPDATE / ROLLBACK** — change capacity or versions from a new or
  previous Desired State.
- **RETIRE** — remove the workload when it is no longer declared.

> None of the planned stages are built. They are listed to show how Desired
> State will eventually participate in the platform, not to claim they work.

---

## 8. Current implementation status

### IMPLEMENTED

- Project entity (schema, PostgreSQL `Project` table)
- PostgreSQL persistence (`@prisma/adapter-pg`, Prisma 7)
- Prisma database access (reusable singleton client in `lib/prisma.ts`)
- Project GET API (`GET /api/projects`)
- Project POST API (`POST /api/projects`)

### NOT IMPLEMENTED

- Desired State persistence
- Desired State validation
- Desired State API
- Actual State collection
- Drift detection
- Reconciliation engine
- Scheduler
- Node agent
- Deployment engine

The implemented items are the **foundation the project entity is managed
with**. They do not yet implement any part of the Desired State system.

---

## 9. Future direction

The intended progression — each step builds on the previous one. **None of
these are built today; this is a roadmap, not a changelog.**

```
Desired State contract            ← this document
→ API representation              ← how Desired State is sent/read
→ validation                      ← sanity checks before acceptance
→ database representation         ← persisted, versionable Desired State
→ control-plane processing        ← FORGE acts on the declaration
→ actual-state observation        ← discovering what is actually running
→ drift detection                 ← comparing actual to desired
→ reconciliation                  ← converging actual onto desired
```

Each step should only be started when the previous one is genuinely useful in
real code, following FORGE's incremental, verifiable working style.

---

## 10. Design boundary

FORGE is **not** a CRUD project-management application.

The Project entity — and the API that creates and lists projects — is only the
**entry point**. It exists to give the platform an owned, nameable unit to
manage.

The long-term purpose of FORGE is to **manage Desired State** and continuously
**move actual infrastructure toward that declared state**. Everything built so
far is a prerequisite for that idea: a persistent, identifiable thing (the
Project) that a Desired State can be attached to in the future.

Keeping this boundary explicit prevents Drift of its own — the accidental kind
where the project grows into a generic todo app instead of the control plane
it is meant to be. The current implementation is deliberately small; its only
job is to be a correct, verified foundation for the Desired State system that
comes later.

---

*This document distinguishes **implemented** from **planned**. Future
functionality is described as a contract and roadmap only and should never be
read as a claim that it exists in code.*
