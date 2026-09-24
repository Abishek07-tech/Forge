# FORGE Desired State vs Actual State

> Conceptual design for comparing **Desired State** against **Actual State**
> and identifying **Drift**.
> This is a design document, **not an implemented feature**. Actual State
> collection, the comparison engine, drift detection, and reconciliation do
> not exist in code yet.

---

## 1. Desired State

Desired State is **what a developer declares they want their application or
environment to look like**. It is the target that FORGE will eventually work
toward.

It is **declarative**: the developer says *what* should exist, never *how*
FORGE should create it. There are no steps, commands, or procedures in a
Desired State — only the end result that must be true.

Desired State describes:

- which image and version should run,
- how many replicas should exist,
- how much CPU and memory each replica gets,
- which port the application serves on,
- what health rule must be satisfied.

Simple example of a Desired State:

```
Application:
    image = forge-api:v2

Runtime:
    replicas = 3

Resources:
    cpu = 2
    memory = 1GB

Health:
    path = /health
```

This says nothing about *how* to start the containers, where to place them, or
how to reach 3 replicas. It only declares the target.

---

## 2. Actual State

Actual State is **what is actually running in the infrastructure right now**.
It is the observed reality, not the declared intent.

Actual State will eventually be collected from the live system:

- workloads,
- nodes,
- containers,
- and other infrastructure components.

Actual State is **NOT implemented yet**. Nothing in FORGE today observes the
infrastructure, reports what is running, or produces an Actual State. This
section describes only the concept.

Simple example of an Actual State:

```
Application:
    image = forge-api:v1

Runtime:
    replicas = 2

Resources:
    cpu = 2
    memory = 1GB

Health:
    status = healthy
```

> **Actual State collection — FUTURE / NOT IMPLEMENTED.** No collector, agent
> reporting, or state aggregation exists in the FORGE codebase.

---

## 3. Desired State vs Actual State

Placing the two side by side is the basis of everything that follows.
Each property of the declaration is compared against the observed reality.

Example comparison:

| Property | Desired State | Actual State | Result |
|----------|---------------|--------------|--------|
| image    | forge-api:v2  | forge-api:v1  | Drift  |
| replicas | 3             | 2             | Drift  |
| cpu      | 2             | 2             | Match  |
| memory   | 1GB           | 1GB           | Match  |
| health   | healthy       | healthy       | Match  |

Two properties match and two drift. FORGE will eventually use this comparison
as the foundation for **Drift Detection**: the places where Desired and Actual
differ are exactly the places that need attention.

> The comparison itself is **future design** for Drift Detection. It is not
> implemented.

---

## 4. Define Drift

**Drift = Actual State differs from Desired State.**

When the observed environment no longer matches the declaration, the
environment has drifted. The declaration did not change — reality did.

Drift is not a single mechanism; it can be caused by many ordinary events:

- someone manually changes infrastructure,
- a workload crashes,
- a deployment partially succeeds,
- configuration changes,
- infrastructure fails,
- a node disappears,
- an older version remains running,
- the actual number of replicas changes.

None of these causes are addressed in this document and none are implemented.
They are listed to motivate *why* FORGE must eventually compare state
continuously instead of assuming the world stays where it was told.

---

## 5. Drift Categories

When Desired and Actual differ, the difference falls into a small set of
conceptual categories. A single drift can contain several categories at once.
These categories are descriptive only — **no implementation logic exists for
them yet**.

### Missing

Something required by Desired State does not exist in Actual State.

```
Desired:  3 replicas
Actual:   2 replicas
```

The third replica does not exist. It is missing.

### Extra

Something exists in Actual State that Desired State does not request.

```
Desired:  2 replicas
Actual:   3 replicas
```

The third replica was not declared but is running. It is extra.

### Changed

The resource exists, but one or more of its properties differ.

```
Desired:  image = forge-api:v2
Actual:   image = forge-api:v1
```

The workload is present; its image property has changed from the target.

### Unhealthy

The expected workload exists, but its health does not satisfy Desired State.

```
Desired:  health = healthy
Actual:   health = unhealthy
```

The workload is there but not satisfying the declared health rule.

### Configuration mismatch

A configuration value differs.

```
Desired:  port = 8080
Actual:   port = 3000
```

The application is running, but a configuration value (the port) does not
match the declaration.

### Version mismatch

The running version differs from the desired version.

```
Desired:  version = 2
Actual:   version = 1
```

The workload is present and configured, but an older version remains running.

> These categories will guide future Drift Detection. **No code implements
> them today.**

---

## 6. Comparison Model

Conceptually, FORGE will compare state in a single pipeline:

```
Desired State
      ↓
Actual State
      ↓
State Comparison
      ↓
Differences
      ↓
Drift Result
      ↓
Future Reconciliation
```

The comparison takes the Desired State as the reference and scans the Actual
State against it. For each relevant property it should identify:

- **matching values** — no difference;
- **missing resources** — required, not present;
- **extra resources** — present, not required;
- **changed values** — present, but different;
- **unhealthy resources** — present but not healthy;
- **version differences** — present, but wrong version.

The output is a **Drift Result**: an explicit list of what matches and what
does not, categorized so that a future Reconciliation system has a concrete
answer to the question "what is different?".

---

## 7. What Happens After Drift Is Detected?

For now this is documented **only conceptually**.

Example:

```
Desired:  replicas = 3
Actual:   replicas = 2
```

FORGE detects:

```
replicas → drift   (category: Missing)
```

The difference has been recognized and named. That is where Drift Detection
ends and where a future system begins.

Later, the **Reconciliation** system may determine how to bring Actual State
back toward Desired State — for example, by starting the missing replica. That
decision, and the action that follows it, belongs to Reconciliation.

**Reconciliation is a future engineering work and is NOT implemented in Work 46.**

Nothing in the current codebase detects drift, and nothing repairs it.

---

## 8. Desired State and Actual State Relationship

The four concepts fit together as one idea:

- **Desired State** = target
- **Actual State** = current reality
- **Drift** = the difference between them
- **Reconciliation** = future process that attempts to reduce the difference

Diagram:

```
Developer
   ↓
Desired State
   ↓
      Compare
   ↑
Actual State
   ↓
Drift
   ↓
Future Reconciliation
```

The developer produces the target. Reality produces the current state. The
comparison produces the drift. A future Reconciliation step attempts to shrink
the drift back to zero.

---

## 9. Comparison Boundaries

FORGE should compare **only meaningful properties** — the ones that define
whether the declared intent has been realized.

Should compare:

- image
- replicas
- ports
- resources
- environment configuration
- deployment version
- health requirements

Should **not** blindly compare implementation-specific or temporary runtime
details such as:

- container identifier strings,
- ephemeral metadata,
- timestamps and uptime,
- provider-specific runtime fields,
- scheduling or placement internals.

This keeps the comparison model **independent from any single infrastructure
provider**. The same Desired State and the same comparison should mean the same
thing whether the infrastructure is Docker, Kubernetes, a cloud platform, or
something else.

> No provider adapters are implemented. The comparison model is defined here
> as a stable, provider-neutral concept.

---

## 10. Relationship to Existing FORGE Architecture

This design sits inside the already-documented FORGE architecture:

```
Project
   ↓
Desired State
   ↓
Control Plane
   ↓
Infrastructure
   ↓
Actual State
   ↓
Drift Detection
   ↓
Reconciliation
```

Each element has a distinct role:

- **Desired State** is the declared target (defined in
  `docs/desired-state.md`).
- **Actual State** is the observed reality of the Infrastructure.
- **Drift Detection** identifies differences between the two.
- **Reconciliation** will later attempt to converge Actual State toward
  Desired State.

The **Control Plane** is the component expected to hold Desired State, receive
Actual State, run the comparison, and (in future) drive reconciliation.

Nothing in this chain beyond the Project entity and the concept documents is
implemented. Every future component below is **NOT IMPLEMENTED**:

- Actual State collector
- State comparison engine
- Drift Detection engine
- Reconciliation engine
- Infrastructure state reporting

---

## 11. Relationship to Previous Documents

This document is one step in a chain:

1. `docs/desired-state.md` — what Desired State is, its components,
   principles, and its place in the FORGE lifecycle.
2. `docs/desired-state-model.md` — the conceptual data structure for a
   Desired State.
3. This document — how Desired State is compared against Actual State and how
   Drift is defined.

This document is consistent with `docs/desired-state.md`:

- uses the same component vocabulary (Application, Runtime, Resources,
  Environment, Deployment, Health);
- keeps the same strict separation of **implemented** vs **planned**;
- treats drift detection and reconciliation as **future** work, exactly as
  `docs/desired-state.md` does;
- assumes Desired State is declarative and describes *what*, not *how*.

It does not repeat the full contents of either previous document. It focuses
specifically on the comparison: **Desired State vs Actual State vs Drift**.

> `docs/desired-state-model.md` was reviewed for consistency where present.
> If that file is not yet committed to the repository, this document still
> stands on its own relative to `docs/desired-state.md`.

---

## 12. Implementation Status

### Current Status

Implemented:

- Desired State concept documentation
- Desired State conceptual data structure
- Desired vs Actual State design (this document)

NOT IMPLEMENTED:

- Actual State collector
- State comparison engine
- Drift Detection engine
- Reconciliation engine
- Infrastructure state reporting

Everything listed under "NOT IMPLEMENTED" is future engineering work. The
three "Implemented" items are documentation and design only — no code.

---

## 13. Future Implementation Path

The path forward, in order:

```
Desired State
→ Actual State Collection
→ State Comparison
→ Drift Detection
→ Reconciliation
→ Verification
```

- **Desired State** — defined conceptually (done, documentation only).
- **Actual State Collection** — FUTURE / NOT IMPLEMENTED. Observing what is
  really running.
- **State Comparison** — FUTURE / NOT IMPLEMENTED. Producing differences from
  the two states.
- **Drift Detection** — FUTURE / NOT IMPLEMENTED. Classifying differences into
  the drift categories in section 5.
- **Reconciliation** — FUTURE / NOT IMPLEMENTED. Deciding and taking action to
  converge Actual toward Desired.
- **Verification** — FUTURE / NOT IMPLEMENTED. Confirming the converged outcome
  satisfies the declaration.

Every step after the documentation stage is clearly **FUTURE / NOT
IMPLEMENTED** and must not be claimed as working.

---

*This document distinguishes **implemented** from **planned**. The comparison
and drift concepts described here are design only; they may not be read as a
claim that FORGE currently detects or repairs drift.*