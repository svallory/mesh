---
title: "0046. What a denied write reports on an atomic action"
description: "Decision record 0046: What a denied write reports on an atomic action. Status: Proposed."
---

# 0046. What a denied write reports on an atomic action

## Status

Proposed

## Date

2026-10-04

## Deciders

operator. The lead set the working assumption (option A) on 2026-10-04 and asked for this record.

## Context

A *policy* is a declared rule about who may run an action ([ADR-0022](./0022-policies-simple-tier-as-extension.md)). Some policy checks need the record: "only the author may publish this post". An update in Mesh is atomic by default, one statement with no read first ([ADR-0017](./0017-atomic-by-default-and-classification.md)), so such a check cannot be evaluated in memory beforehand. It is compiled into the statement.

There are two ways to compile it, and they give the caller different answers when the check fails.

Ash, the Elixir framework Mesh is modelled on, compiles the check into the update statement as an expression that raises an error inside the database, so the caller gets a forbidden error ([Ash runtime internals](../research/ash-runtime-internals.md), sections 2.1 and 6.6). For reads Ash does the other thing: a read policy becomes a filter, so a forbidden row looks like "not found" ([research synthesis](../research/synthesis.md), section 2.2).

The roadmap's working assumption for Mesh is the filter on writes too ([roadmap](../roadmap/roadmap.md), M8). The lead accepted it on 2026-10-04 believing it to be Ash's behaviour, then confirmed it as a deliberate deviation once the research showed otherwise ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief"). The ruling that Mesh copies Ash covers the DSL's names and structure ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md)), not run-time behaviour, so nothing forces Ash's outcome here; but a caller-visible difference from the framework Mesh is modelled on is worth a ruling.

## Decision

Not decided. Working assumption: option A. It blocks M8.

## Options considered

### Option A: Fold the check in as a filter; a denied row reports not found

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: the same compilation as a read policy, added to the statement's condition |
| Cost | Nothing new in the data adapters |
| Fidelity to Ash | Deviates for writes; matches Ash for reads |
| What the caller learns | Less: forbidden and missing look the same on atomic actions |

**Pros:** Needs no way to raise an error from SQL, which SQLite lacks in a direct form (not checked). When the read policy hides the row as well, reads and writes agree: the row does not exist for that caller, and its existence is not revealed.
**Cons:** In the common case the read policy does not hide the row: in the roadmap's own example a non-author can read a published post and may not rename it. That caller, having just read the post, is told it does not exist. The same denied write reports not found on an atomic action and forbidden on a `require-atomic=false` action, where the row is loaded and the check runs in memory. The policy breakdown, which the research calls the best debugging tool in Ash ([research synthesis](../research/synthesis.md), section 2.2), is not produced on the atomic path; the caller must ask `can`.

### Option B: Compile the check as an expression that raises; a denied row reports forbidden

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium to high: a raise mechanism per data adapter |
| Cost | A SQL function or equivalent in Postgres and in SQLite; Ash's atomic path uses an `ash_raise_error` function for this ([Ash runtime internals](../research/ash-runtime-internals.md), section 2.1) |
| Fidelity to Ash | Exact |
| What the caller learns | The same error on both paths |

**Pros:** Ash's behaviour. One outcome for a denied write whichever path the action takes.
**Cons:** Installing functions in the user's database is a step Mesh otherwise avoids. Which check failed still needs a second query or `can`. Tells a caller that a row they may not change exists.

### Option C: Record-reading write policies make the action non-atomic

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: the rule v1 already applies to record-reading validations ([ADR-0017](./0017-atomic-by-default-and-classification.md)) |
| Cost | A row lock and a read on every update whose policy reads the record; how common that is has not been measured |
| Fidelity to Ash | Deviates: Ash keeps these atomic |
| What the caller learns | Everything: forbidden, with the breakdown |

**Pros:** One outcome, full breakdown, no SQL tricks.
**Cons:** Atomic updates become rare in any project with policies, which undoes the point of [ADR-0017](./0017-atomic-by-default-and-classification.md).

### Option D: Fold the check in as a filter, and re-read when no row is affected

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: the filter of option A plus one read and an in-memory evaluation on the failure path |
| Cost | A second query only when a write is denied or the row is missing; nothing new in the adapters |
| Fidelity to Ash | Same outcome as Ash (forbidden), by a different mechanism |
| What the caller learns | Forbidden with the breakdown when the row is visible to them; not found when it is not |

**Pros:** Reaches Ash's outcome with no function installed in the database. The breakdown is available, because the check is evaluated in memory on the re-read row. Reports not found only when the caller could not have read the row anyway.
**Cons:** The re-read sees the row as it is after the statement, so under a concurrent writer it can explain a denial with a row that has changed; [ADR-0044](./0044-folding-record-reading-validations.md) describes the same caveat for folded validations and the conflict case that comes with it. The in-memory and SQL forms of the check must agree.

## Trade-off analysis

B gives one consistent outcome and is exactly what Ash does, at the price of database functions on two engines. A is the cheapest and is consistent with reads only when the read policy hides the row too; where it does not, A tells a caller that a row they can see does not exist. C is the simplest to reason about and the most expensive at run time. D reaches B's outcome without B's database functions and costs a query only on denial, but it brings the re-read protocol that v1 otherwise avoids ([ADR-0044](./0044-folding-record-reading-validations.md)).

Recommendation of the roadmap author: keep A as the working assumption only until the operator rules, and prefer D if the cost of its failure path is acceptable, because A's wrong answer in the common case is a real defect and D removes it without touching the database. The lead's working assumption is A.

## Consequences

- Under A, user documentation must say that an atomic action reports not found for a row the caller may not change, and that `can` explains why.
- Under A, a test compares `can` with the action by decision, not by error class ([roadmap](../roadmap/roadmap.md), M8, test 8).
- Under D, M8 adds a re-read and an in-memory policy check on the failure path, and must say what is reported when the row changed between the statement and the re-read (the caveat [ADR-0044](./0044-folding-record-reading-validations.md) describes).
- If B is chosen later, callers of atomic actions start receiving forbidden where they received not found: a behaviour change, though not a change to resource files.

## Action items

- [ ] Before M8: the operator rules among A, B and D.
- [ ] M8: implement the ruled option; state the outcome in the user docs and in `mesh explain`.
- [ ] After v1: revisit with [ADR-0044](./0044-folding-record-reading-validations.md) if a raise mechanism is added to the adapters.
