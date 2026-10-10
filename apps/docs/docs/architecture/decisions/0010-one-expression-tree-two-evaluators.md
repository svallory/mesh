---
title: "0010. One expression tree, two evaluators"
description: "Decision record 0010: One expression tree, two evaluators. Status: Accepted, amended by ADR-0056, ADR-0072."
---

# 0010. One expression tree, two evaluators

> **Amended** by [ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md) on 2026-10-05: read the successor for what changed. The body below is kept as history.
>
> **Amended** by [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) on 2026-10-10: Only the in-memory evaluator is built before Mesh 1.0; the SQL evaluator comes after it. The body below is kept as history.

## Status

Accepted, amended by [ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md)

Amended by [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) (2026-10-10): Only the in-memory evaluator is built before Mesh 1.0; the SQL evaluator comes after it.

## Date

2026-10-04

## Deciders

operator (ruling); roadmap author (how the two forms are produced, roadmap M4); the lead or the operator may overrule that part

## Context

A resource file contains small rules written as arrow functions: a `filter` on a read, a `validate` with a message, a `change` that sets a field. Mesh turns each one into an *expression tree*, a plain-data description of the computation (field references, literals, registered functions and operators). Ash, the Elixir framework Mesh is modelled on, does the same: "Expressions are a two-stage tree. The same tree can run in memory or compile to SQL" ([research synthesis](../research/synthesis.md), section 2.2).

History. Plan revision 1 (not published) had a hand-written in-memory data adapter with its own evaluator, and the lead accepted "SQL's semantics, documented" (question Q10) against that plan. Plan revision 2, by the roadmap author, removed the adapter and said "no second, in-process evaluator" ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M4), recommending it as question N2. N2 was never accepted by the lead or the operator: the lead's next word was to reconsider it ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief"), and the operator's ruling below reversed it.

## Decision

Ruling, operator, 2026-10-04, recorded in [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings after the decision review", row "Expressions":

> One expression tree, evaluated both in memory and in SQL (as Ash does). Replaces the plan's "translatable expressions only ever run as SQL" (plan Q10/N2).

How the two forms are produced is the roadmap author's design ([roadmap](../roadmap/roadmap.md), M4). Conversion and classification happen while the model is built. Each translatable expression is then written into the generated file twice: as the tree itself, a data literal that the data adapter compiles into Drizzle's query builder when a query runs, because queries are assembled at run time from the action's filter, the caller's filter and policies; and as its in-memory form, emitted TypeScript that calls the in-memory implementations of the registered functions in `runtime`. Nothing produces SQL at build time; the build only checks that every function used has a SQL form in the configured adapter. An expression that cannot be converted is *opaque* and exists only as emitted TypeScript. This supersedes [ADR-0011](./0011-sql-only-expressions.md).

## Options considered

### Option A: Tree literal compiled when a query runs, plus emitted in-memory form (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: every function needs a SQL form and an in-memory form |
| Cost | Large in M4; each new function costs two implementations and a test table |
| Fit with [ADR-0003](./0003-generated-code-carries-behaviour.md) | In-memory form is generated code; SQL path is library code over generated data |
| Drift risk | Real; guarded by shared tables |

**Pros:** rules that need no database run in process; the same tree serves tests, atomic updates and policies; queries can still be composed at run time.
**Cons:** two implementations of one semantics can disagree ([ADR-0012](./0012-expression-semantics.md)). The SQL path is a run-time library walking a tree.

### Option B: Interpret the tree at run time for both paths
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: one interpreter |
| Cost | Lower build cost; a permanent run-time component |
| Fit with [ADR-0003](./0003-generated-code-carries-behaviour.md) | Weaker: the in-memory behaviour sits in the library |
| Drift risk | Same as A |

**Pros:** less generated code. This is Ash's shape (`Ash.Filter.Runtime`, [Ash runtime internals](../research/ash-runtime-internals.md), section 5.3).
**Cons:** unhelpful stack traces and 0% coverage of a user's own resource ([research synthesis](../research/synthesis.md), section 6, item 2).

### Option C: SQL only (ADR-0011)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Cost | Lowest |
| Fit with the ruling | Rejected by it |
| Drift risk | None |

**Pros:** one semantics. **Cons:** a validation that reads only the input still needs a database.

### Option D: "In memory" means running the SQL form against an in-process SQLite
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: no second implementation of any function |
| Cost | Low to build; a SQLite instance in every deployed program |
| Fit with [ADR-0003](./0003-generated-code-carries-behaviour.md) | Neutral |
| Drift risk | None between forms |

**Pros:** one engine, so no drift between evaluators. **Cons:** a database in every run-time program just to check a field; Postgres semantics would still differ from SQLite's wherever the real database is Postgres, so parity is lost; slower than a TypeScript expression.

## Trade-off analysis

The real line: the in-memory form is emitted code ([ADR-0003](./0003-generated-code-carries-behaviour.md)), while the SQL form is compiled when a query runs, because queries compose at run time. That does not breach [ADR-0003](./0003-generated-code-carries-behaviour.md)'s rule that the run-time library never reads the resource model: the tree literal is generated data, not the model. Option B was rejected for putting behaviour in the library; the SQL path is a library too, but it only translates data into a query and holds no authored logic. Drift is guarded by M4 acceptance test 1: every registered function has one table of inputs and answers, null cases included, run through the in-memory form and every merged SQL adapter ([roadmap](../roadmap/roadmap.md), M4).

## Consequences

Easier: the in-memory form runs validations and changes on the non-atomic update path ([ADR-0017](./0017-atomic-by-default-and-classification.md)), calculations on loaded records (M7), and policy checks in memory and `can` (M8, [ADR-0022](./0022-policies-simple-tier-as-extension.md)). Harder: each function needs two forms. Revisit: the shared semantics ([ADR-0012](./0012-expression-semantics.md), Proposed).

## Action items
- [ ] M4: tree type in `runtime`, registry in `model`, emitter for the in-memory form and the tree literal.
- [ ] M4: build check that each function used has a SQL form in the configured adapter.
- [ ] M4: function tables run through every merged adapter.
- [ ] M6: extension-supplied functions must bring both forms.
