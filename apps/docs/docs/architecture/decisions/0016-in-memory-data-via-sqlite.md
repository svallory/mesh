---
title: "0016. Tests use SQLite in-memory mode, not a hand-written in-memory adapter"
description: "Decision record 0016: Tests use SQLite in-memory mode, not a hand-written in-memory adapter. Status: Accepted."
---

# 0016. Tests use SQLite in-memory mode, not a hand-written in-memory adapter

## Status

Accepted

## Date

2026-10-04

## Deciders

roadmap author, at the lead's request; the lead or the operator may overrule

## Context

Tests and prototypes need a data layer with no database server. Ash, the Elixir framework Mesh is modelled on, ships in-memory data layers for this and treats them as part of its testing story ([research synthesis](../research/synthesis.md), section 4, "Testing"). The synthesis listed "in-memory" among the first data adapters ([research synthesis](../research/synthesis.md), section 10, "Data layer" row). Plan revision 1 (not published) had a hand-written one; revision 2 dropped it in favour of SQLite's `:memory:` mode, as open question N2 ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.2). The lead then asked to reconsider N2 now that an in-memory expression evaluator exists ([ADR-0010](./0010-one-expression-tree-two-evaluators.md)) and to decide with reasons ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief").

## Decision

Tests and prototypes use SQLite's `:memory:` mode through `data-sqlite`. No hand-written in-memory data adapter in v1 ([roadmap](../roadmap/roadmap.md), M3 and section 7).

Reasoning. N2's original argument was that a second adapter means "a second implementation of expression semantics" to keep identical to SQL by hand ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.2, N2). That is weaker now: an in-memory adapter could reuse the evaluator. But the evaluator only evaluates expressions on records already loaded. An adapter must also provide the mandatory set of Ruling 4 (select, insert, update, delete, transactions, filters, sort, pagination), and SQLite already does all of it. Joins and aggregates are optional capabilities ([ADR-0013](./0013-data-layer-contract-and-capabilities.md)), so a minimal in-memory adapter is smaller than a full one, but from M7 on the tests of relationships and aggregates need a real SQL engine anyway. Ash's in-memory layer shows the drift risk: ETS reports `:transact` as false, so it has no transactions ([Ash runtime internals](../research/ash-runtime-internals.md), section 3.4), and a filter policy on creates works on one data layer and raises on ETS ([Ash runtime internals](../research/ash-runtime-internals.md), section 12.A, item 7).

## Options considered

### Option A: SQLite `:memory:` through `data-sqlite` (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: same code path as the file-backed adapter |
| Cost | Nearly none; Drizzle documents `bun:sqlite` ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 3) |
| Test fidelity | Real SQL, real transactions, but SQLite's |
| Contract proof | Only SQL-shaped implementations until Postgres |

**Pros:** tests exercise the same SQL as production for SQLite; nothing extra to maintain.
**Cons:** SQLite is not Postgres. Tests on `:memory:` say nothing about Postgres behaviour, which is the problem [ADR-0012](./0012-expression-semantics.md) describes. The contract has one implementation until M9, and every implementation is SQL-shaped, so nothing proves the contract is not SQL-specific ([roadmap](../roadmap/roadmap.md), M3 risks).

### Option B: Hand-written in-memory adapter on the evaluator
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: the mandatory set only (transactions, sort, pagination, filters) |
| Cost | A permanent second implementation to keep in step with the suite |
| Test fidelity | Drifts from SQL, as Ash's ETS does |
| Contract proof | The only non-SQL check on the contract |

**Pros:** no driver; the strongest test that the contract is not tied to SQL.
**Cons:** transactions and pagination reimplemented; drift against SQL; M7 and later tests still need SQLite.

### Option C: In-memory adapter as contract proof only
Build option B but run it only in the conformance suite, never for application tests.
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | Medium: written once, no application dependence |
| Test fidelity | Application tests stay on SQLite |
| Contract proof | As B |

**Pros:** buys B's proof without making tests depend on it.
**Cons:** effort spent on something no user runs; no ruling needs the proof in v1.

## Trade-off analysis

B's one real advantage, proof that the contract is not SQL-shaped, is a long-term benefit; its costs are immediate. C isolates that benefit and could be added later without changing A. Postgres in M9 supplies a second dialect, though not a non-SQL one.

## Consequences

Easier: M2 and M3 tests; the walking skeleton. Harder: nothing in v1 runs without a SQLite driver, and Postgres behaviour is tested only from M9. Revisit if a non-SQL store is ever wanted: an in-memory adapter then becomes the cheapest proof.

## Action items
- [ ] M3: `data-sqlite` in-memory mode passes the conformance suite ([roadmap](../roadmap/roadmap.md), M3 test 1).
- [ ] After v1: revisit if a non-SQL adapter is proposed.
