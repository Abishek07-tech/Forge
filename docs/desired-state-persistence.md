# Desired State Persistence

> Conceptual design for persisting FORGE Desired State in PostgreSQL.
> This is a database design document, **not an implementation**. No Prisma
> models, tables, or migrations are created. The design below is consistent
> with `docs/desired-state.md`, `docs/desired-vs-actual.md`, and
> `docs/desired-state-api.md`.

---

## 1. Purpose

FORGE needs to persist Desired State so the declaration survives restarts,
can be versioned, can be read back by the Web Console and API, and can be used
by the future Control Plane as a target to converge toward.

Without persistence, a Desired State would exist only for the moment of the
request — there would be no history, no way to compare against what is
actually running, and no stable reference for a future Reconciliation system.

Persistence is a future implementation concern. This document defines
**what information must be stored, how it relates to a Project, and what
storage shape FORGE should use** — conceptually.

---

## 2. Existing Project Relationship

The Project entity is already persisted in PostgreSQL:

```
Project
    ↓
Desired State
```

- `Project` is the existing relational model (`apps/web/prisma/schema.prisma`)
  with `id`, `name`, `status`, and `deployments`.
- Desired State **belongs to a Project** (defined in `docs/desired-state.md`
  §4 and `docs/desired-state-api.md` §3).
- The connection is made through `projectId`: every Desired State row must
  reference the Project it belongs to.
- The existing Project schema is **unchanged**. Nothing about Desired State is
  added to the Project model in this design; the relationship is held by the
  future Desired State side of the link.

Conceptually the Project is the parent/owner and Desired State is the child,
one-to-many (one Project → many Desired State versions).

---

## 3. Persistence Requirements

The storage design must support the capabilities the existing documents
already promise:

- **Store a Desired State** — the full declaration, per the component
  vocabulary in `docs/desired-state.md` (applications, runtime, resources,
  environment, deployment, health).
- **Scope by Project** — every stored state knows its owning Project.
- **Version** — each accepted declaration becomes a distinct version, and that
  version is retrievable.
- **Read back** — the current declaration and any specific historical version
  can be returned by the API.
- **Compare later** — the stored declaration must remain comparable with a
  future Actual State (`docs/desired-vs-actual.md`), so its shape must not be
  collapsed into something ambiguous.
- **Remain provider-independent** — persistence stores the declaration, never
  infrastructure-specific execution details.

What is **not** a persistence requirement: the database does not deploy,
schedule, or reconcile. It only stores what the developer declared.

---

## 4. Desired State Identity

Identity is defined by three concepts working together:

| Identifier | Meaning | Uniqueness |
|---|---|---|
| `desiredStateId` | The identity of the Desired State entity itself | Unique across FORGE |
| `projectId` | The Project that owns the Desired State | References an existing Project |
| `version` | The position of a declaration within a Project's history | Unique **within a Project** |

Rules:

- A Desired State exists **for a Project** and only makes sense scoped to that
  Project.
- A **version is unique per Project**: `(projectId, version)` identifies
  exactly one stored declaration. Project A's version 2 is a different
  declaration from Project B's version 2.
- `desiredStateId` stays stable for the Desired State across its versions.
- A specific version is later retrieved by scoping `(projectId, version)`.

Example:

```
Project A
    ├── Desired State v1
    ├── Desired State v2
    └── Desired State v3
```

---

## 5. Versioning

Every accepted declaration is stored as a **version**, tracked in ascending
order:

```
version 1  →  initial declaration
version 2  →  first update
version 3  →  second update
...
```

Design rules:

- Each version is a **stored snapshot** of the declaration as accepted.
- Versions are **immutable once stored** — a declaration is not edited in
  place; a change produces a new version.
- The **current Desired State** is the latest (highest) version for the
  Project.
- Historical versions remain available so that future systems can compare
  versions, audit what was declared, and roll back by re-applying an earlier
  version.

The exact version numbering scheme is a future implementation detail; the
persistence requirement is that versions exist, are ordered, are scoped to a
Project, and are retrievable.

---

## 6. Data That Must Be Persisted

The persisted Desired State is split into two distinct kinds of information,
matching the API contract's separation of metadata from declaration
(`docs/desired-state-api.md` §5).

### Metadata (relational, required)

| Field | What it represents | Why FORGE needs it | Required | Kind |
|---|---|---|---|---|
| `desiredStateId` | Identity of the Desired State | Stable reference across versions, API responses | Required | Metadata |
| `projectId` | Owning Project | Keeps state scoped to the right owner; every API call is project-scoped | Required | Metadata |
| `version` | Position in the Project's history | Enables retrieval, history, comparison, future rollback | Required | Metadata |
| `createdAt` | When the version was stored | Auditing and history ordering | Required | Metadata |
| `updatedAt` | When the stored row was last touched | Lifecycle awareness | Required | Metadata |

### Declared Desired State content (structured payload, required as a whole)

| Group | What it represents | Why FORGE needs it | Required | Kind |
|---|---|---|---|---|
| `applications` | Image, port, version to run | The WHAT of the workload | Required | Desired State content |
| `runtime` | Replicas and execution shape | How many instances must exist | Required | Desired State content |
| `resources` | CPU and memory budgets | Capacity the target must satisfy | Required | Desired State content |
| `environment` | Configuration injected at runtime | Part of the declared target | Optional | Desired State content |
| `deployment` | Target deployment/version to realize | Versioned realization information | Optional | Desired State content |
| `health` | The health rule that must be satisfied | Defines "working" for the target | Required | Desired State content |

No fields beyond these are introduced. The content groups match the
components from `docs/desired-state.md` §4 and the payload from
`docs/desired-state-api.md` §5. Whether individual groups (such as
`environment` or `deployment`) are mandatory per declaration is a future
validation decision, not a persistence decision.

---

## 7. Storage Strategy Options

Three conceptual approaches were evaluated.

### Fully Relational

Represent every component as its own normalized table — a Desired State
header row plus child rows for applications, runtime, resources, environment,
deployment, and health.

- **How it would represent Desired State:** a graph of typed rows joined by
  foreign keys.
- **Advantages:** strong column typing; constraints enforced by the database;
  individual fields directly queryable; high referential integrity.
- **Disadvantages:** heavy migration churn while the Desired State contract is
  still evolving; many joins to reconstruct one declaration; each new version
  means copying every child row — verbose snapshot writes.
- **Impact on versioning:** correct but costly — a version is a full copy of
  the header and all children.
- **Impact on validation:** database enforces much of it — good, but only if
  the schema is exactly right, which is risky before the contract is fixed.
- **Impact on Desired vs Actual comparison:** fields are individually
  addressable, so comparison is easy — but Actual State would need the same
  elaborate relational shape.
- **Impact on reconciliation:** the Control Plane reads specific typed fields
  easily.
- **PostgreSQL relationship:** uses Postgres relations and constraints well,
  at the price of schema rigidity.

### JSON/JSONB

Store each Desired State version as one row whose declaration lives in a
single JSONB column.

- **How it would represent Desired State:** one row = one version; the entire
  declarative payload is one document.
- **Advantages:** mirrors the declarative contract exactly (a declaration IS a
  document); no migration churn as the contract evolves; one write = one
  version snapshot; JSONB is native and queryable in PostgreSQL.
- **Disadvantages:** no per-field server-side typing; validation must live
  entirely in application code; weaker relational integrity for individual
  fields.
- **Impact on versioning:** excellent — each version is simply one immutable
  row insert.
- **Impact on validation:** validation happens at the API boundary (the design
  already places it there); the database is not the validator.
- **Impact on Desired vs Actual comparison:** the comparison model in
  `docs/desired-vs-actual.md` operates on meaningful properties of the whole
  declaration — diffing two documents is natural.
- **Impact on reconciliation:** the Control Plane reads the declared target
  document as a unit.
- **PostgreSQL relationship:** still PostgreSQL (native JSONB type), no new
  storage technology.

### Hybrid

Relational header row for identity and metadata, plus a structured JSONB
column for the declarative payload.

- **How it would represent Desired State:** `desiredStateId`, `projectId`,
  `version`, `createdAt`, `updatedAt` are typed relational columns; the
  declaration (applications, runtime, resources, environment, deployment,
  health) is one JSONB document.
- **Advantages:** strong relational identity (primary keys, foreign keys,
  unique constraints, version ordering) combined with schema-flexible payloads;
  maps exactly onto the API contract's metadata/content split.
- **Disadvantages:** two paradigms in one row require discipline about what is
  relational vs what is JSONB.
- **Impact on versioning:** version is a relational column (uniquely
  constrained per Project); the payload snapshot is JSONB.
- **Impact on validation:** header-level checks are expressible in the
  database; payload checks stay at the API layer, matching the documented
  validation boundary.
- **Impact on Desired vs Actual comparison:** the payload keeps the same
  declarative shape on both sides; comparison diffs payload documents scoped by
  the relational header.
- **Impact on reconciliation:** the Control Plane receives a consistently
  addressed, version-scoped declaration.
- **PostgreSQL relationship:** uses both native relational features and native
  JSONB in the same table.

---

## 8. Selected Persistence Direction

**Selected: Hybrid** (relational metadata header + structured JSONB payload).

This is the direction that best fits the existing FORGE design:

- **It maps the API contract exactly.** `docs/desired-state-api.md` §5 splits
  every request into API metadata (`projectId`, `version`) and Desired State
  data (the declaration). The hybrid stores exactly that split: the metadata
  as typed relational columns, the declaration as the JSONB payload.
- **Versioning is natural.** A version is a relational, per-Project unique
  value, and each accepted declaration is an immutable JSONB snapshot —
  satisfying the Versionable principle in `docs/desired-state.md` §6.
- **Validation belongs at the API, not the database.** The design explicitly
  places validation at the request boundary (`desired-state-api.md` §8,
  persistence section 11 below). The hybrid does not need per-field database
  typing of the payload, avoiding schema churn while the contract is still
  conceptual.
- **It preserves comparability.** The payload keeps the exact declarative
  shape (applications, runtime, resources, environment, deployment, health),
  so a future Actual State — stored in a later, separate design — can use the
  same head+payload shape, keeping the comparison model in
  `docs/desired-vs-actual.md` natural.
- **It is provider-independent.** The stored payload is the declaration only,
  never Docker/Kubernetes/cloud execution details — matching the design rules
  in `desired-state-api.md` §15.
- **It stays on PostgreSQL.** JSONB is native Postgres, which FORGE already
  uses for the Project model (`PROJECT_STATUS.md` §9). No new storage
  technology is introduced.

The JSONB payload does not reduce validation rigor — it concentrates it at the
API boundary, exactly where the existing documents put it.

---

## 9. Conceptual Data Structure

Conceptual structure (no SQL, no Prisma syntax):

```
Project
  └── Desired State (header — relational metadata)
        ├── desiredStateId      identifier
        ├── projectId           → Project (owner)
        ├── version             1, 2, 3, … (unique per Project)
        ├── createdAt           stored time
        ├── updatedAt           last touch time
        └── data (payload — structured declaration)
            ├── applications    image, port, target version
            ├── runtime         replicas, execution shape
            ├── resources       cpu, memory
            ├── environment     runtime configuration
            ├── deployment      deployment/version realization info
            └── health          health rule
```

The header row provides:

- identity (`desiredStateId`),
- ownership (`projectId`, a foreign key to Project),
- history (`version` uniqueness per Project, `createdAt`/`updatedAt`),
- one row per version (each version is one stored declaration).

The payload provides the declaration as a cohesive, structured document that
keeps its component shape and remains comparable.

---

## 10. Current vs Historical Versions

- FORGE should **preserve historical Desired State versions**. Every accepted
  version remains available rather than being overwritten.
- **Why history matters:** auditing what was declared, comparing versions,
  supporting a future rollback to a known-good declaration, and reconciling
  against a specific declared target.
- **Current version vs history:** the current Desired State is the newest
  version in the Project's history; historical versions are the older, still
  usable snapshots. "Update" means *append a new version*, not *mutate the old
  one* — which is what keeps history sound.
- **Retention:** the existing documentation defines **no retention or deletion
  policy**. Whether old versions are ever pruned, and after how long, remains
  a **future decision** and is not specified here.

---

## 11. Validation → Persistence Boundary

The conceptual flow:

```
API Request
    ↓
Validation
    ↓
Valid Desired State
    ↓
Persistence
    ↓
Stored Desired State
    ↓
Control Plane
```

- Validation is the **gate** before persistence
  (`docs/desired-state-api.md` §8): the request is checked (project exists,
  payload present, structure valid, values follow the contract) **before**
  anything is stored.
- **Invalid Desired State must never become persisted Desired State.** If
  validation fails, the request ends before the persistence step; only a
  *valid* declaration reaches storage.
- Persistence then records the accepted declaration, and the stored result is
  what the future Control Plane consumes as the target.

This boundary means the database can trust that anything that reaches it is a
valid declaration — validation is not the database's job.

---

## 12. Desired State vs Actual State

Desired State persistence answers the question **"what should exist?"**

Actual State will answer **"what currently exists?"** It will be designed and
implemented later, collected from the infrastructure/runtime side.

The two must stay separate:

- The **Desired State API writes Desired State** (`desired-state-api.md` §11).
  It never accepts or stores Actual State.
- **No Actual State tables are created** in this design, and no Actual State
  persistence is designed now.
- When Actual State is eventually persisted, it should use a separate path and
  a separate storage shape (conceptually the same header+payload pattern, but
  populated from the runtime side, not from declarations). Keeping the two
  sources distinct is what makes the drift comparison meaningful.

---

## 13. Future Control Plane / Reconciliation Compatibility

The persistence design does not prevent — and directly supports — the future
systems:

- **Control Plane:** reads the stored Desired State as its declared target.
  The header makes ownership and version unambiguous.
- **Desired vs Actual comparison:** the payload keeps the declarative shape the
  comparison model operates on (`docs/desired-vs-actual.md` §6 and §9);
  meaningful properties can be diffed between a desired payload and a future
  actual payload.
- **Drift Detection:** needs both states in comparable shape — the hybrid
  payload shape provides this on the desired side.
- **Reconciliation:** needs a clear declared target and knowledge of which
  version was declared — both are available from the header + payload.
- **Version history, rollback, auditing:** immutable versioned rows give
  history and audit; rollback can later re-apply an older version (as a new
  version, preserving history).

The hybrid choice was made partly because it keeps all of these open rather
than locking the contract into a rigid relational shape prematurely.

---

## 14. Current Implementation Status

- **Desired State persistence is NOT implemented yet.**
- **PostgreSQL is already used** by FORGE for the existing Project model.
- **Work 49 only defines the future persistence design.**
- **The Prisma schema has NOT been changed.** `apps/web/prisma/schema.prisma`
  still contains only the existing `Project` model and `ProjectStatus` enum.

This matches the installed reality in `docs/desired-state.md` §8 (Desired
State persistence and Desired State API both listed as NOT IMPLEMENTED).

---

## 15. Future Implementation Path

The intended progression. **None of these are implemented in Work 49.**

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

- **Persistence Design** — this document;
- **Prisma Domain Model** — typed models for the header and payload;
- **Migration** — a real database migration;
- **PostgreSQL Persistence** — actual storage of Desired State and versions;
- **API Integration** — wiring the Desired State API contract to that storage;
- **Control Plane Integration** — the stored declaration used as the target.

Every step after this design is **FUTURE / NOT IMPLEMENTED**.

---

*This document defines a future persistence design. It may not be read as a
claim that Desired State is stored, that any table or migration exists, or
that any schema has been modified.*