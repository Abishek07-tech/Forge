# FORGE Actual State Persistence Design

> Design document (Work 71) for storing Actual State observations.
> This is a **design**, not yet an implemented schema. Implementation happens
> in Work 72. It follows the same architectural decisions already proven for
> Desired State persistence (`docs/desired-state-persistence.md`) and stays
> consistent with the comparison model in `docs/desired-vs-actual.md`.

---

## 1. Purpose

FORGE already stores **Desired State** (what should exist). It has no place
to record **Actual State** (what was observed to exist). Without stored
observations there is nothing for a future drift detector to compare against
the declaration.

This design defines the minimum persistence model for the first Actual State
foundation: immutable, timestamped, project-scoped observation records that
distinguish *observed values* from *unknown values*.

## 2. What Is Stored

One row = **one observation snapshot** of one workload at one point in time.
Rows are **immutable once stored**; a newer observation never overwrites an
older one. This mirrors the Desired State version-row model and preserves
auditability.

### Relational header (required)

| Field | Represents | Why FORGE needs it |
|---|---|---|
| `observationId` | Identity of the observation record | Stable reference in APIs, tests, audit trails (primary key) |
| `projectId` | Owning Project | Keeps observations scoped to the declared unit of work; every query is project-scoped |
| `workloadId` | Which workload within the Project was observed | A Project may later host several workloads; observations must be attributable to one |
| `source` | Where the observation came from | Distinguishes `test-harness` (today) from future `node-agent` / `manual` reports; supports trust and debugging |
| `observedAt` | When reality was sampled | **This**, not the storage time, orders "latest"; supports staleness judgments |
| `status` | Observed lifecycle status (enum) | First-class, queryable: `running` / `stopped` / `failed` / `unknown` |
| `createdAt` | When the record was stored | Storage auditing, consistent with the DesiredState header |

### Observed payload (JSONB `data`)

Stored as one structured JSON document, using the **same component
vocabulary** as Desired State so the two remain comparable
(`docs/desired-vs-actual.md` §11):

| Group | Contents | Unknown semantics |
|---|---|---|
| `application` | `image`, `port`, optional `version` | `image`/`port` may be `null` = observed but unknown |
| `runtime` | `replicas` | `null` = unknown; `0` = genuinely observed zero (absence proven by observation) |
| `resources` | `cpu`, `memory` | may be `null` = unknown |
| `environment` | string map | **omitted** = not part of this observation |
| `deployment` | `version` | may be `null` = unknown; group omitted = not observed |
| `health` | `status` (`healthy` / `unhealthy` / `unknown`) | `unknown` = could not determine |

The nullable-vs-omitted rule is the persistence embodiment of the domain rule:
**a missing observation is never treated as proof that a resource is
absent.** Only an explicitly observed `0` (or an observed status like
`stopped`) states something about reality; `null`/omitted states that we do
not know.

## 3. Project Relationship

```
Project
  └── ActualStateObservation[]   (many observations per project)
```

- `projectId` is a required foreign key to `Project.id`
  (`ON DELETE RESTRICT`, `ON UPDATE CASCADE`) — identical semantics to
  `DesiredState.projectId`, so a Project cannot be deleted while
  observations reference it.
- Back-relation added on `Project` (e.g. `observations`).
- **Actual State records and Desired State records live in separate tables**
  and never reference each other; the future drift detector reads both.

## 4. History and Latest Observation

| Question | Answer |
|---|---|
| Is history preserved? | **Yes.** Every accepted observation is one immutable row. Nothing is updated in place. |
| How is the latest observation found? | `findFirst` over `(projectId, workloadId)` ordered by `observedAt DESC` |
| Why order by `observedAt`, not `createdAt`? | `observedAt` is when reality was sampled; `createdAt` is when FORGE stored the report. An agent may report late; latest *reality* is `observedAt`. |
| Can two observations share `observedAt`? | Yes. Tie-break by `createdAt DESC` gives a deterministic storage-order winner. |
| Is `(projectId, workloadId)` unique? | **No.** Many observations per workload over time is the whole point. `observationId` (PK) provides row uniqueness. |

Supporting index: `(projectId, workloadId, observedAt)` — serves both the
latest-observation lookup and history listing.

## 5. Domain ↔ Persistence Mapping

| Domain (`types/actual-state.ts`) | Persistence column |
|---|---|
| `observationId` | `observationId` (PK) |
| `projectId` | `projectId` (FK) |
| `workloadId` | `workloadId` |
| `source` | `source` |
| `observedAt` | `observedAt` |
| `status` | `status` (enum) |
| `application`, `runtime`, `resources`, `environment?`, `deployment?`, `health` | JSONB `data` payload |
| — (storage detail) | `createdAt` (DB `@default(now())`) |

Prisma types never appear in the domain layer; the persistence module converts
row ↔ domain object exactly as `lib/persistence/desired-state.ts` does.

## 6. How This Supports Later Drift Detection

`docs/desired-vs-actual.md` §6 defines the comparison pipeline. This storage
model supplies its input:

```
current Desired State  = highest version row in DesiredState  for the Project
latest Actual State    = row with max(observedAt) in
                         ActualStateObservation for (projectId, workloadId)
                              ↓
                    future comparison / drift classification
```

- **Latest observation** gives the present-tense comparison source.
- **History** enables point-in-time comparison, observation auditing, and
  "when did this drift appear?" questions.
- **`observedAt`** lets a future comparator judge staleness honestly instead
  of claiming an old observation is current.
- **Null-vs-observed semantics** prevent the comparator from misreading
  "unknown" as "absent" — a core correctness requirement for the six drift
  categories.

## 7. Consistency With the Existing Database Architecture

| Decision | Desired State (proven) | Actual State (this design) |
|---|---|---|
| Hybrid header + JSONB payload | yes | yes |
| Immutable rows, append-only | yes (per version) | yes (per observation) |
| Project FK semantics | RESTRICT / CASCADE | RESTRICT / CASCADE |
| Client-declared string PK | `desiredStateId` | `observationId` |
| DB-owned timestamps | `createdAt` / `updatedAt` | `createdAt` (+ caller `observedAt`) |
| Enum for first-class status | `ProjectStatus` | `ObservedStatus` |
| Separate tables per concept | `DesiredState` | `ActualStateObservation` |

No unique-per-project constraint is copied from Desired State: Desired State
uniqueness is `(projectId, version)` because a Project has one *current*
declaration with ordered versions; Actual State has no versioning concept —
time (`observedAt`) provides ordering instead.

## 8. Out of Scope (unchanged by this design)

- Observation ingestion API / Node Agent (later works)
- Drift detection and classification (later works)
- Reconciliation (later works)
- Retention / pruning of old observations (future decision, same as
  Desired State retention)
