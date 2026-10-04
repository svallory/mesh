---
title: "0012. Which semantics a Mesh expression has"
description: "Decision record 0012: Which semantics a Mesh expression has. Status: Proposed."
---

# 0012. Which semantics a Mesh expression has

## Status

Proposed

## Date

2026-10-04

## Deciders

open; the operator or the lead must rule. The recommendation is the roadmap author's. Provisional until ruled: question Q10 ("SQL's, documented") was accepted by the lead without analysis ([rulings of 2026-10-04](./rulings-2026-10-04.md), "Review note").

## Context

One expression tree runs both in memory and in SQL ([ADR-0010](./0010-one-expression-tree-two-evaluators.md)), so a `filter` evaluated by the database and a `validate` evaluated in process can disagree on the same record. The roadmap names the places: nulls, string ordering and division, and wherever SQLite and Postgres themselves differ ([roadmap](../roadmap/roadmap.md), M4). In SQL, comparing anything with NULL yields "unknown" (three-valued logic); in JavaScript `null === null` is true.

The central question is that "SQL semantics" is not one thing. Mesh has two SQL adapters in v1 and they disagree. Examples from general database knowledge, not researched in `notes/research/`: default collation (SQLite compares bytes; Postgres follows the database's locale), whether `LIKE` is case sensitive, integer division, and how booleans are stored. M4 acceptance test 1 requires every merged adapter and the in-memory form to give the same answer from one table ([roadmap](../roadmap/roadmap.md), M4). So wherever the two databases differ, at least one adapter must wrap its native operator. A Postgres collation set by server configuration cannot be reproduced by an in-memory form fixed at build time.

Ash is the precedent for the host-language option, not the SQL one. AshPostgres "installs SQL functions so Elixir semantics hold in the database", and that cost a filter written with `&&` about 3,400 ms against about 110 ms with `and`, because the function call defeats the index ([research synthesis](../research/synthesis.md), section 2.2).

## Decision

Not decided.

**Recommendation (roadmap author):** option A. The function tables of M4 test 1 are the written definition. **Blocks:** M4, whose tables and in-memory implementations are that definition ([roadmap](../roadmap/roadmap.md), section 4: M4 needs ADR-0012 ruled). It must be ruled before M4 starts.

## Options considered

### Option A: Mesh defines the semantics per registered function and operator
Wherever both databases agree natively (three-valued null logic), use the native operator. Wherever one disagrees, wrap the operator in that adapter.
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: a definition per function, plus wrappers where dialects differ |
| Cost | Moderate; paid per function, and again for each new adapter |
| Query speed | Native where dialects agree; wrappers may defeat indexes |
| Surprise for authors | Documented per function; null logic follows SQL |

**Pros:** only pays where a real disagreement exists; the tables prove it.
**Cons:** the cost of B appears locally, wherever a wrapper is needed. String ordering under a server-configured Postgres collation may not be reproducible in memory; it may have to be excluded, which is option C's remedy. Every new adapter owes the whole table.

### Option B: JavaScript semantics everywhere, forced on both databases
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: helper SQL functions in each dialect, versioned |
| Cost | High to maintain; a measured run-time cost |
| Query speed | Can be far worse |
| Surprise for authors | Lowest |

**Pros:** authors get what they typed; one definition.
**Cons:** Ash's measured cost above applies to every comparison that needs a helper. One measured filter does not rule a semantics out, but it is the only evidence there is.

### Option C: A restricted language that rejects what dialects or evaluators disagree on
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: build-time checks on operands |
| Cost | Moderate; rejects some natural expressions |
| Query speed | Native |
| Surprise for authors | Errors at build time, with a fix named |

**Pros:** nothing to wrap or test for the rejected cases; fits "no silent fallback" ([roadmap](../roadmap/roadmap.md), section 2, item 2). Mesh already knows which attributes are `required`, so for field references the nullability check is cheaper than it sounds.
**Cons:** nullability through computed values and function results is unresearched; the language gets smaller.

## Trade-off analysis

A and C combine: define semantics per function, and reject at build time what cannot be defined cheaply. B buys uniformity with a measured price. A costs the most in test tables and adapter work; the tables are needed anyway.

## Consequences

If A: every function page documents its null behaviour; each adapter ships wrappers for its disagreements; adding a database adapter means passing every table. If unruled, M4 cannot write its tables.

## Action items
- [ ] Before M4: ruling by the operator or the lead.
- [ ] M4: per-function null behaviour in the registry; tables with null cases.
- [ ] M4: list the SQLite and Postgres disagreements for the first registry and decide wrap or reject for each.
