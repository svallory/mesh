---
title: "0044. Folding record-reading validations into the atomic statement"
description: "Decision record 0044: Folding record-reading validations into the atomic statement. Status: Proposed."
---

# 0044. Folding record-reading validations into the atomic statement

## Status

Proposed

## Date

2026-10-04

## Deciders

lead and operator, when atomic writes are revisited after v1. Proposed by the roadmap author.

## Context

In Mesh an update or destroy is atomic by default: one `UPDATE` or `DELETE` statement with no read first ([ADR-0017](./0017-atomic-by-default-and-classification.md)). A *validation* is a rule that must hold for the write to happen, written in the resource file as an expression. Since Mesh has one expression tree with two evaluators ([ADR-0010](./0010-one-expression-tree-two-evaluators.md)), a validation that converts to the tree can run in memory or as SQL.

In v1 the rule is simple: a change or validation that reads the stored record makes the action non-atomic. The action must say `require-atomic=false` (Ash's `require_atomic?`, in Mesh's spelling); it then reads the row with a write lock, runs everything in memory and writes ([roadmap](../roadmap/roadmap.md), M5). The lead decided this on 2026-10-04, replacing an earlier decision the same day that translatable validations fold into the statement ([rulings of 2026-10-04](./rulings-2026-10-04.md), "Lead decisions of the architecture-docs brief").

The cost of the v1 rule shows in the example resource: `publish` checks that the post's title is not empty, the title is stored, and so the most ordinary state change in the example needs a row lock and two statements. Ash can keep such an action atomic: on its atomic path it compiles validation constraints into the write statement as expressions that raise an error in the database ([Ash runtime internals](../research/ash-runtime-internals.md), section 2.1). That is option C below.

## Decision

Not decided. For v1 nothing is folded except changes that do not read the stored record ([ADR-0017](./0017-atomic-by-default-and-classification.md)). This record keeps the design for folding validations so it can be judged later. It blocks nothing in v1.

The design, as proposed:

1. A translatable validation that reads the record folds into the statement's `WHERE` condition. It sees the record as it will be after the changes: each attribute a change assigns is replaced, inside the condition, by that change's expression.
2. When the statement affects no row, the handler reads the row once in the same transaction. No row, or no row the caller may see, is "not found". The statement also carries the write-policy checks that v1 already folds in as a filter ([ADR-0022](./0022-policies-simple-tier-as-extension.md)), so the handler next evaluates those in memory on the row; if one fails, the answer is again "not found", as in v1. Only then is every folded validation evaluated in memory on that row, and all that fail are reported, the same errors the non-atomic path gives.
3. If the row exists, the policies pass and no validation fails, another writer changed it between the statement and the read. The call fails with a conflict error that the caller may retry.

## Options considered

### Option A: Record-reading validations make the action non-atomic (v1, ADR-0017)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: one rule at build time, one read-then-write path at run time |
| Cost | Every such action takes a row lock and two statements |
| Error reporting | Complete: all validation errors, collected in memory |
| Risk of the two evaluators disagreeing | None for validations: only the in-memory form is used on writes |

**Pros:** Easy to explain and to print in `mesh explain`. Matches what Ash requires when a validation has no atomic form.
**Cons:** Authors must write the opt-out on ordinary actions. Locks under load.

### Option B: Fold them into the statement, with the zero-row protocol above

| Dimension | Assessment |
|-----------|------------|
| Complexity | High: expression substitution, a re-read, a new error class |
| Cost | One statement in the success case; a second on failure |
| Error reporting | Complete, but only after the re-read |
| Risk of the two evaluators disagreeing | Real: the SQL form decides whether the write happens and the in-memory form explains why it did not; if they differ, a write can fail with no error to report, which the protocol would misreport as a conflict |

**Pros:** `publish` and its like stay atomic with no opt-out. No row lock.
**Cons:** The conflict case is new behaviour callers must handle. The disagreement risk above is the kind of divergence between paths that Ash's bug #2969 showed ([research synthesis](../research/synthesis.md), section 2.2).

### Option C: Fold them, and let the database raise the error

| Dimension | Assessment |
|-----------|------------|
| Complexity | High, and per database: an expression that raises inside the statement |
| Cost | One statement always |
| Error reporting | First failing validation only, unless each is encoded separately |
| Risk of the two evaluators disagreeing | None: only the SQL form runs |

**Pros:** No re-read, no conflict case, and only one form of each validation decides anything. This is what Ash does on its default, atomic path: constraints become `ash_raise_error(...)` expressions inside the statement ([Ash runtime internals](../research/ash-runtime-internals.md), section 2.1), so it is a design with a working precedent.
**Cons:** Needs a way to raise from SQL in every adapter; SQLite has no direct equivalent (not checked). Breaks "validations collect all errors".

## Trade-off analysis

Option A costs performance and some verbosity; B and C cost correctness risk and build effort. Before v1 has a single user, the performance cost is hypothetical and the correctness risk is not. Between the two folding designs, C has the precedent (Ash) and the simpler failure story: no conflict case and no dependence on two forms agreeing. Its costs are a raise mechanism in every adapter, unproven on SQLite, and reporting only the first failure, which breaks a rule Mesh states for validations. B keeps full error reports and needs nothing special from the database, but it is only as good as the guarantee that the two forms of an expression agree, which the shared function tables of M4 test for single functions, not for combinations. Which of B and C is better for Mesh is the open question this record leaves; it should be settled by a prototype, not by argument.

## Consequences

- Until this is decided, authors write `require-atomic=false` on actions whose validations read the record.
- If B is adopted later, those actions can drop the option without changing their meaning, so adopting it is not a breaking change for resource files; callers must handle the new conflict error where the locked path used to serialise them.
- Adopting B adds a conflict error class to the run-time library.

## Action items

- [ ] After v1: measure how many actions in real projects carry the opt-out only because of a record-reading validation.
- [ ] After v1: if folding is wanted, prototype options B and C on SQLite and Postgres and test both against concurrent writers.
