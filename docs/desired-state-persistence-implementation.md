# Desired State Persistence Implementation Notes

> Implementation boundary notes that **prepare** FORGE for persisting Desired
> State. Work 53 is a preparation/review task only — it does **not** implement
> the Prisma model, create migrations, or change PostgreSQL. The primary
> persistence design source is `docs/desired-state-persistence.md` (Work 49).

---

## 1. Current Persistence Design

Work 49 (`docs/desired-state-persistence.md`) selected the **Hybrid** storage
direction:

- **Relational metadata header** — typed columns for `desiredStateId`,
  `projectId`, `version`, `createdAt`, and `updatedAt`.
- **Structured JSONB payload** — the declaration as one document:
  `applications`, `runtime`, `resources`, `environment`, `deployment`,
  `health`.

One stored row = one version. Rows are **immutable snapshots**; an update
appends a new version instead of mutating an old one. The **current** Desired
State is the highest version for the Project. `(projectId, version)` uniquely
identifies exactly one stored declaration. No retention/deletion policy is
defined — that remains a future decision.

This maps exactly onto the API contract's separation of metadata
(`projectId`, `version`) from Desired State data (the declaration payload) in
`docs/desired-state-api.md` §5.

No persistence decision was made in Work 53. Work 49 is the source of truth.

---

## 2. Existing Project Database Model

The Project entity is already persisted in PostgreSQL via
`apps/web/prisma/schema.prisma`:

- `id` (`String`, primary key, generated cuid)
- `name` (`String`, required)
- `status` (`ProjectStatus` enum: `running`/`stopped`/`failed`/`deploying`)
- `deployments` (`Int`)

It is connected using Prisma 7 + `@prisma/adapter-pg` through the reusable
singleton client in `apps/web/lib/prisma.ts`, backed by the `forge` PostgreSQL
database (migration `initial_project`, applied).

**How Desired State relates to Project:** Desired State **belongs to a
Project**. The connection is held on the Desired State side via a `projectId`
foreign key. The Project model is **unchanged**; the relationship is a
one-to-many (one Project → many Desired State versions). The existing
`Project` table is not modified.

---

## 3. Future Prisma Model

Conceptual description of what the future Prisma model must represent — **not**
Prisma syntax, and **not** implemented.

The future model represents the **Desired State header row** (one row per
version):

| Conceptual field | What the future model must represent |
|---|---|
| `desiredStateId` | The stable identity of the Desired State across its versions |
| `projectId` | The owning Project (foreign key to the existing `Project` model) |
| `version` | Position in the Project's history, unique within the Project |
| `createdAt` | When the version was stored |
| `updatedAt` | When the stored row was last touched |
| `data` | The declaration payload as a structured JSONB document (applications, runtime, resources, environment, deployment, health) |

The model must also express:

- a **relational foreign key** from the Desired State to `Project`;
- a **compound uniqueness** over `(projectId, version)` so a Project cannot
  store two declarations with the same version;
- storage of the declaration as a **JSONB**-backed structured value (Prisma's
  `Json` column maps to PostgreSQL JSONB for this datasource).

The six payload groups themselves live inside the JSONB document; they are not
separate tables. This keeps the future model small, versionable, and aligned
with the declarative contract.

---

## 4. Future Relationships

### Project → Desired State

```
Project
  └── Desired State (one row per version)
```

- One Project owns many Desired State rows (one per version).
- The link is `projectId` on the Desired State side → `Project.id`.
- The Project model does not gain a Desired State field; the relationship is
  expressed on the Desired State side.

### Version / history relationship

```
Desired State for Project
  ├── version 1  (initial declaration)
  ├── version 2  (first update — new row)
  ├── version 3  (second update — new row)
  └── ...         (historical versions preserved)
```

- There is no separate "history table". History is the collection of all
  Desired State rows for a Project, each being a distinct version.
- "Update" is an append: a new row with the next `version`, never an in-place
  edit of a previous row.
- The **current** Desired State is derived as the highest `version` for the
  Project; every older row is a preserved historical version.

---

## 5. Domain Type → Persistence Mapping

The Work 51 domain types (`apps/web/types/desired-state.ts`) map cleanly onto
the future persistence structure:

| Domain type field | Persistence representation |
|---|---|
| `desiredStateId` | Relational column (identity metadata) |
| `projectId` | Relational column (ownership metadata, FK to Project) |
| `version` | Relational column (version metadata) |
| `createdAt` | Relational column (persistence metadata) |
| `updatedAt` | Relational column (persistence metadata) |
| `applications` | JSONB payload group |
| `runtime` | JSONB payload group |
| `resources` | JSONB payload group |
| `environment` (optional) | JSONB payload group |
| `deployment` (optional) | JSONB payload group |
| `health` | JSONB payload group |

Naming is consistent between the domain type and the persistence design
(`desiredStateId`, `projectId`, `version`, and the six payload group names all
match). Identity (`desiredStateId`, `projectId`) and versioning (`version`)
information exists in the domain type. The nested declaration can be persisted
in full under the selected hybrid strategy.

The `createdAt` / `updatedAt` fields present in the domain type are not an
error: Work 49 §6 defines them as required **relational persistence metadata**
of the stored header, and the retrieval contract (`desired-state-api.md` §6)
returns the stored envelope. They belong in the persistence header by design
and are intentionally included in the domain type. No correction to the domain
types is needed.

---

## 6. Validation → Persistence Boundary

The intended flow is exactly:

```
External/API input
      ↓
Domain validation (Work 52)
      ↓
Valid Desired State
      ↓
Persistence
      ↓
PostgreSQL
```

Validation is the **gate before persistence** (`desired-state-persistence.md`
§11, `desired-state-api.md` §8). Invalid Desired State must never be persisted:
if validation fails, the request ends before any write.

Work 53 does **not** connect validation to persistence. The boundary is
verified conceptually only.

At the time this Work 53 document was verified, the working tree contained an
uncommitted Work 52 validation module (`apps/web/lib/validation/desired-state.ts`
with `desired-state.test.ts`) alongside the Work 51 domain types. It enforces
the checks from `desired-state-api.md` §8 on the declaration shape used by the
persistence design (`desired-state-persistence.md` §6):

- required header fields (`desiredStateId`, `projectId`, `version` ≥ 1);
- required sections (`applications`, `runtime`, `resources`, `health`);
- optional sections may be absent (`environment`, `deployment`);
- nested value checks (image, port 1–65535, replicas ≥ 1, cpu/memory strings,
  health path).

This matches the payload groups the future JSONB payload must store, and it
sits at the documented gate before persistence. Its tests pass (13/13) under
`node --test`. No persistence or API code consumes it yet, and Work 53 makes
no change to it.

---

## 7. API → Persistence Boundary

The future Desired State API (`docs/desired-state-api.md`) will interact with
persistence at the storage step of its flow — after validation:

```
Web Console
    ↓
Desired State API
    ↓
Validation
    ↓
Desired State Storage   ← persistence boundary
    ↓
Control Plane
```

- **POST** (create) → persist an initial declaration as version 1.
- **GET** (current) → read the highest version for the Project.
- **GET .../{version}** (specific version) → read the row scoped by
  `(projectId, version)`.
- **PUT** (update) → append a new version (the write produces the new
  version).

The persistence design supports all four operations without schema changes:
the header columns provide scoping and ordering, and the JSONB payload provides
the returned declaration. No API endpoint is implemented in Work 53.

---

## 8. Versioning Requirements

The future database design must support:

| Requirement | How the design satisfies it |
|---|---|
| Version 1 | Initial create stores the first row with `version` 1 |
| Version 2, 3, … | Each update appends a new row with the next integer version |
| Retrieving a specific version | Lookup by `(projectId, version)`, unique per Project |
| Identifying the current version | Highest `version` value for the Project |
| Preserving historical versions | Rows are immutable snapshots; never overwritten |

The `(projectId, version)` compound uniqueness is the database-level guarantee
that a Project has exactly one declaration per version. No retention policy is
defined; whether old versions are ever pruned remains a future decision (Work
49 §10).

Version numbering details (exact integer scheme) are a future implementation
detail; the design satisfies the ordering, scoping, and retrieval
requirements. Work 53 does not implement versioning.

---

## 9. Control Plane Compatibility

The persistence design supports the future Control Plane flow:

```
PostgreSQL
    ↓
Desired State
    ↓
Control Plane
    ↓
Execution
    ↓
Actual State
```

The database stores the **declaration** — what the developer wants to exist.
It is not responsible for scheduling, execution, reconciliation, node control,
or deployment commands. Those remain future Control Plane / Scheduler / Node
Agent concerns (`desired-state.md` §9, `desired-state-persistence.md` §13).

By keeping the declaration as a structured, version-scoped payload, the stored
Desired State can later be read by the Control Plane as an unambiguous target,
remain comparable with a future Actual State, and support drift detection and
rollback (re-applying an earlier version as a new version).

---

## 10. Work 54 Implementation Plan

Recommended sequence for Work 54, based on the actual repository and the Work
49 design. **Not implemented here.**

1. **Prisma schema** — add the future Desired State model to
   `apps/web/prisma/schema.prisma`:
   - relational header fields (`desiredStateId`, `projectId`, `version`,
     `createdAt`, `updatedAt`);
   - structured `Json` field for the declaration payload;
   - relation to the existing `Project` model via `projectId`;
   - compound uniqueness on `(projectId, version)`, plus an index for
     per-Project version lookups.
   - leave the existing `Project` model and `ProjectStatus` enum unchanged.
2. **Migration** — create and apply a Prisma migration for the new Desired
   State table only (existing `Project` table untouched).
3. **Generate the Prisma client** for the new model.
4. **Persistence module** — implement write/read helpers using the existing
   singleton client in `apps/web/lib/prisma.ts`:
   - create version (compute next `version`, insert immutable row);
   - read current (highest version per Project);
   - read a specific version `(projectId, version)`.
5. **Verify** — `npx tsc --noEmit`, `prisma migrate status`, and manual
   persistence checks against PostgreSQL.

The API routes, validation wiring, and Control Plane integration are later
works and are **not** part of Work 54.

---

## 11. Current Status

- **Persistence is NOT implemented yet.** No Desired State row is written to
  or read from PostgreSQL.
- **Prisma schema in the committed repo (`HEAD`) has NOT been changed** —
  `apps/web/prisma/schema.prisma` at `HEAD` still contains only the existing
  `Project` model and `ProjectStatus` enum.
- **Working-tree note (verified at the end of Work 53):** the **uncommitted**
  working tree currently also contains a `DesiredState` model added to
  `apps/web/prisma/schema.prisma` (plus a `desiredStates` relation on
  `Project`), alongside the Work 51 domain types and the Work 52 validation
  module. **These working-tree changes were not created by Work 53** — Work 53
  wrote only `docs/desired-state-persistence-implementation.md` and modified
  nothing else (no schema, database, API, or package changes). They are
  reported here so Work 54 starts from the real current tree, not the committed
  one.
- **PostgreSQL has NOT been changed** — no new tables, columns, or migrations
  have been applied.
- **Work 53 only prepares the implementation boundary.** It is a
  preparation/review task: it read the design and the current implementation,
  verified the persistence direction and its Prisma representability,
  reviewed the domain types and the Project relationship, and produced this
  document.

No Prisma, database, API, or package changes were made by Work 53.

---

*This document is consistent with `docs/desired-state-persistence.md`
(Work 49), the primary persistence design source, and does not introduce a
competing persistence strategy.*