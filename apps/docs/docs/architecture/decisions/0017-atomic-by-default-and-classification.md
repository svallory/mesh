---
title: "0017. Updates are atomic by default; changes and validations are classified"
description: "Decision record 0017: Updates are atomic by default; changes and validations are classified. Status: Accepted."
---

# 0017. Updates are atomic by default; changes and validations are classified

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Ruling 3, atomic clause); lead (validations are classified like changes; in v1 a record-reading change or validation makes the action non-atomic); roadmap author (atomic by default for update and destroy, the write lock, "a change never runs twice"). The lead or the operator may overrule the roadmap author's part.

## Context

Two requests updating one record at once can lose a write if each reads, changes in memory and writes back. An *atomic* update folds the change into the database statement (`SET count = count + 1`). In Ash, the Elixir framework Mesh is modelled on, "atomic" is "a protocol by which a change rewrites itself into expressions" ([Ash runtime internals](../research/ash-runtime-internals.md), section 2.1). Ash 3.0 made atomic the default ([research synthesis](../research/synthesis.md), section 6, last paragraph). Its atomic path rebuilds the changeset, so a change ran twice ([Ash runtime internals](../research/ash-runtime-internals.md), "Implications for Mesh", item 3) and a change's filter was silently dropped, bug #2969 ([Ash runtime internals](../research/ash-runtime-internals.md), section 12.B, item 21).

## Decision

**Operator**, Ruling 3, 2026-10-04, [rulings of 2026-10-04](./rulings-2026-10-04.md), table of eight rulings: "Atomic single-record updates (changes folded into the statement)". Its bulk clause moved after v1 ([ADR-0019](./0019-v1-scope.md)).

**Lead**: validations are classified like changes now that an in-memory evaluator exists ([ADR-0010](./0010-one-expression-tree-two-evaluators.md)) ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief"); and, later the same day, in v1 a change or validation that reads the stored record makes the action non-atomic.

**Roadmap author** ([roadmap](../roadmap/roadmap.md), M5): update and destroy are atomic by default, one statement and no read first ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 8, D9). A change is never run twice. The rules:
- **What "reads the stored record" means.** A translatable change folds into the `UPDATE` assignments when its right-hand side reads nothing stored except the column it assigns: a literal, an input value, or an increment of the column itself (`count + 1`), which the statement evaluates. Anything else that reads stored values makes the action non-atomic in v1, and so does every validation that reads a stored column, even one an SQL condition could express (`publish`'s `post.title` check), because v1 folds nothing into the `WHERE` clause; folding conditions is [ADR-0044](./0044-folding-record-reading-validations.md).
- A translatable validation that reads only the input runs in memory before the statement, on either path.
- A change or validation that is opaque, or that reads the stored record, makes the action non-atomic. It must say `require-atomic=false` (Ash's opt-out `require_atomic?` set to false); without it the build fails.
- The non-atomic path reads the row with a write lock (a row lock on Postgres, an immediate transaction on SQLite; a "read for update" call in the data-layer contract), runs changes and validations in memory with the in-memory forms, collects every validation error, and writes, all in one transaction. Without the lock, "one transaction" would still lose updates at Postgres's default isolation. The in-memory evaluator ([ADR-0010](./0010-one-expression-tree-two-evaluators.md)) is what runs validations on this path.
- The example's `publish` action validates `post.title`, a stored value, so it says `require-atomic=false`.

Folding record-reading validations into the statement is not in v1; [ADR-0044](./0044-folding-record-reading-validations.md) ([ADR-0044](./0044-folding-record-reading-validations.md), Proposed) keeps the design.

## Options considered

### Option A: Atomic by default; record-reading or opaque code opts out (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: classification, build error, locked path |
| Cost | Large in M5 (size L) |
| Concurrency safety | Safe on both paths, by statement or by lock |
| Author effort | Stored-value validations need `require-atomic=false` |

**Pros:** safe by default; no failure protocol to design; follows Ash 3.0.
**Cons:** the common case of validating a stored value takes a lock and two statements; authors meet a build error until they opt out.

### Option B: Fold record-reading validations into the statement (ADR-0044, not taken for v1)
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: substitution of change expressions, zero-row failure protocol |
| Cost | Large; two forms of every such validation must agree |
| Concurrency safety | Safe, no lock |
| Author effort | Lowest |

**Pros:** fewer round trips, no lock.
**Cons:** when the statement affects no row, a re-read and a conflict error are needed to tell not found from a failed validation; the SQL form and the in-memory form of each validation must give the same answer.

### Option C: Read-modify-write by default, atomic opt-in
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Cost | Low |
| Concurrency safety | Races unless the author remembers |
| Author effort | None until a race shows up |

**Pros:** any TypeScript works. **Cons:** non-atomic actions "are susceptible to having problems when operating concurrently" ([Ash runtime internals](../research/ash-runtime-internals.md), section 12.B, item 20).

### Option D: Always atomic, reject opaque changes on updates
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: no locked path |
| Cost | Medium |
| Concurrency safety | Always safe |
| Author effort | Cannot call arbitrary code in an update |

**Pros:** one path. **Cons:** blocks real use; Ash users complained that one `manage_relationship` makes an action non-atomic ([Ash runtime internals](../research/ash-runtime-internals.md), section 12.B, item 20).

## Trade-off analysis

A and B differ in who pays: A makes a stored-value validation cost a lock; B makes the framework carry a failure protocol. For v1 the lead chose the simpler framework. Both avoid Ash's trap: plan the write once and never rerun a change ([research synthesis](../research/synthesis.md), section 8, "Do differently").

## Consequences

Easier: concurrent updates (M5 test 1). Harder: stored-value validations pay a lock; adapters must offer atomic expressions ([ADR-0013](./0013-data-layer-contract-and-capabilities.md)) and a "read for update" call.
**Policies (M8).** Record-reading write policies stay folded: on an atomic action they fold into the statement as a filter and a row the caller may not change is reported as not found; on a `require-atomic=false` action they are evaluated in memory on the locked row and reported as forbidden with the breakdown ([roadmap](../roadmap/roadmap.md), M8; [ADR-0022](./0022-policies-simple-tier-as-extension.md)). Ash compiles the check into the update statement as an expression that raises, so it reports a forbidden error ([Ash runtime internals](../research/ash-runtime-internals.md), sections 2.1 and 6.6); Mesh reports not found. That differs from Ash and is the working assumption, in line with reads. Revisit [ADR-0044](./0044-folding-record-reading-validations.md) and batched-atomic bulk after v1. Which outcome a denied atomic write reports is not settled: it is [ADR-0046](./0046-denied-atomic-write-outcome.md) (Proposed), and what this paragraph describes is the working assumption.

## Action items
- [ ] M4: record the class of each change and validation in the model, including whether it reads the stored record.
- [ ] M5: `require-atomic` attribute, build error, locked read, `explain` output.
- [ ] M5: tests: concurrent increments, concurrent `require-atomic=false` calls, a change never run twice.
- [ ] M8: fold write policies into the statement's condition on atomic actions ([ADR-0022](./0022-policies-simple-tier-as-extension.md)).
- [ ] After v1: rule on [ADR-0044](./0044-folding-record-reading-validations.md).
