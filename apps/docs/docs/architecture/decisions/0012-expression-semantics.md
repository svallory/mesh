---
title: "0012. Which semantics a Mesh expression has"
description: "Decision record 0012: Which semantics a Mesh expression has. Status: Accepted (lead ruling, pending operator review): option A."
---

# 0012. Which semantics a Mesh expression has

## Status

Accepted (lead ruling, pending operator review)

## Date

2026-10-04

## Deciders

the lead, ruling on 2026-10-10 (option A, with the M4 design rulings D1 to D10 of the same day, decisions log 13:10 and 13:25), pending the operator's review. Earlier, question Q10 ("SQL's, documented") had been accepted by the lead without analysis ([rulings of 2026-10-04](./rulings-2026-10-04.md), "Review note").

## Context

One expression tree runs both in memory and in SQL ([ADR-0010](./0010-one-expression-tree-two-evaluators.md)), so a `filter` evaluated by the database and a `validate` evaluated in process can disagree on the same record. The roadmap names the places: nulls, string ordering and division, and wherever SQLite and Postgres themselves differ ([roadmap](../roadmap/roadmap.md), M4). In SQL, comparing anything with NULL yields "unknown" (three-valued logic); in JavaScript `null === null` is true.

The central question is that "SQL semantics" is not one thing. Mesh has two SQL adapters in v1 and they disagree. Examples from general database knowledge, not researched in `notes/research/`: default collation (SQLite compares bytes; Postgres follows the database's locale), whether `LIKE` is case sensitive, integer division, and how booleans are stored. M4 acceptance test 1 requires every merged adapter and the in-memory form to give the same answer from one table ([roadmap](../roadmap/roadmap.md), M4). So wherever the two databases differ, at least one adapter must wrap its native operator. A Postgres collation set by server configuration cannot be reproduced by an in-memory form fixed at build time.

Ash is the precedent for the host-language option, not the SQL one. AshPostgres "installs SQL functions so Elixir semantics hold in the database", and that cost a filter written with `&&` about 3,400 ms against about 110 ms with `and`, because the function call defeats the index ([research synthesis](../research/synthesis.md), section 2.2).

## Decision

**Option A.** Mesh defines the semantics of each registered function and operator, and the function tables are the written definition: [Expression functions](../in-depth/expression-functions.md) lists every row; the same rows are test data (`EXPRESSION_TABLES` in `@meshfw/runtime/testing`). Where SQLite and Postgres agree natively (three-valued null logic) Mesh follows SQL. The in-memory evaluator built in M4 must give the answers the M10 SQL evaluator will give; M10 and every later SQL adapter run the same tables.

The semantics, in summary (the design is `notes/m4/design.md`; the page above is the reference):

- A boolean is `true`, `false` or **unknown** (`null`). Comparison with a null operand is unknown; `&&`, `||` and `!` are Kleene logic; `x === null` is `IS NULL`; `??` is `COALESCE`; `?.` is a left join; `undefined` does not exist.
- An unknown result **fails a `check`** (fail closed, not SQL `CHECK` semantics, which pass), **skips a `when`**, **excludes a row** in a `filter`, and is `null` in a computed field. In M8, an unknown `forbid-if` forbids.
- `every` is strict: an element whose predicate is unknown makes it false. M10 must translate `every(p)` as `NOT EXISTS (... WHERE p IS NOT TRUE)`. `some`, `find` and `filter` ignore elements whose predicate is unknown.
- Division by zero is `null`; `integer / integer` truncates toward zero (`7 / 2` is 3, `-7 / 2` is -3), as SQLite and Postgres divide two integers (ruling of 2026-10-10 14:00, and the checker warns because JavaScript gives 3.5); a `float` or `decimal` operand divides exactly (M10's adapters wrap that case); `length` of a string counts Unicode code points (what both databases count); `now()` is read once per scope from an injectable clock.
- A construct the registry does not define (string ordering, truthiness, `==`, string concatenation, string methods) is **not translated**: it stays plain code with JavaScript semantics, and the build warns (`MESH_EXPR_PLAIN`). At M10 these become errors only where SQL is required (`filter`, `sort`, policies). Legal syntax is never made illegal. Member access through a value that may be null is a build error, because TypeScript's strict null checks reject it too.
- A member input on an update is nullable (an omitted input is unknown). The one exemption from the null-to-required error is `set &x=({ input }) => input.x`; **M5 must skip that `set` when the caller omits `x`**, so an omitted member input leaves the stored value instead of writing null.
- Two build warnings cover legal translated code whose JavaScript reading flips on null: `MESH_EXPR_NULL_EQUALITY` (two nullable operands) and `MESH_EXPR_NEGATED_UNKNOWN` (`!`, `!==` over something that can be unknown).

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

Because A was ruled: every function page documents its null behaviour; each adapter ships wrappers for its disagreements; adding a database adapter means passing every table. If unruled, M4 cannot write its tables.

## Action items
- [x] Before M4: ruling by the lead (2026-10-10). The operator reviews it.
- [x] M4: per-function null behaviour in the registry; tables with null cases.
- [x] M4: the disagreements for the first registry, decided: `/` (exact division for float and decimal, zero divisor null), `length` (code points) and string ordering (not translated) are the three to wrap or avoid in M10.
- [ ] M10: pass every table through the SQL evaluator on SQLite and Postgres, wrapping `/` and `every` as above.
- [ ] Operator: review this ruling.
