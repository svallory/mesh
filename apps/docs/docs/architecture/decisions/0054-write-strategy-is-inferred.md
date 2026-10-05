---
title: "0054. Mesh infers the write strategy from the action body; there is no `require-atomic`"
description: "Decision record 0054: an update or destroy is atomic when its body allows it, read-then-write otherwise, chosen at build time and printed by `mesh explain`. Status: Accepted."
---

# 0054. Mesh infers the write strategy from the action body; there is no `require-atomic`

## Status

Accepted. Amends [ADR-0017](./0017-atomic-by-default-and-classification.md) (the opt-out attribute).

## Date

2026-10-05

## Deciders

the lead, delegated by the operator (decided while updating the Architecture section to syntax v2); the operator may overrule

## Context

An *atomic* update folds its work into one `UPDATE` statement with no read first, so two concurrent callers cannot lose a write. A *read-then-write* update reads the row with a write lock, runs its rules in memory and writes, in one transaction. [ADR-0017](./0017-atomic-by-default-and-classification.md) made update and destroy atomic by default and required an action that cannot be atomic to say so with `require-atomic=false`, Ash's `require_atomic? false`; without it the build failed. The point was that a user never gets a read-then-write where they expected atomicity.

Entity file syntax v2 ([ADR-0050](./0050-entity-file-syntax.md), [ADR-0053](./0053-validate-then-do.md)) changes the inputs:

- In `validate`, `self` is the stored record with the accepted input applied, so any `check` that reads `self` on an update needs the row first.
- The rulings say a `run` step "makes the action non-atomic"; they do not ask the author to declare it.
- The reference file has two such updates (`send` and `pay` check `self`) and neither carries `require-atomic=false`.
- The operator's principle for the syntax is to minimise the rules a user must remember.

The rulings do not mention `require-atomic`. Something had to be decided.

## Decision

The write strategy is chosen by the build from the action body. There is no `require-atomic` attribute.

- An update or destroy is **atomic** when every `check` reads only `input`, and every `set` value is a translated expression that reads nothing stored except the column it assigns (a literal, an input value, `self.count + 1` for `#count`).
- Anything else makes it **read-then-write**: a `check` or `when` that reads `self`, a `set` value that reads another stored column, a `check`, `when` or `set` value that cannot be translated (a body that is not one expression, or one expression the translator does not support), or a `run` step. None of these is an error ([ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md)).
- `mesh explain <entity> <action>` prints the strategy and the reason, naming the line or the expression that made the action read-then-write. The output for the example is committed and guarded, so a change of strategy shows in review.
- Everything else in [ADR-0017](./0017-atomic-by-default-and-classification.md) stands: the strategy is fixed at build time, a step never runs twice, the read-then-write path takes a write lock, and folding record-reading checks into the statement stays after v1 ([ADR-0044](./0044-folding-record-reading-validations.md)).

## Options considered

### Option A: infer, print in `explain` (chosen)

**Pros:** nothing to remember; the reference file stays as the operator wrote it; the strategy is still decided once and visible.
**Cons:** a small edit (a `check` that starts reading `self`) silently changes an action from atomic to read-then-write; only `explain` and review catch it.

### Option B: keep `require-atomic=false` ([ADR-0017](./0017-atomic-by-default-and-classification.md))

**Pros:** the author states the cost; a change of strategy fails the build.
**Cons:** under syntax v2 most updates with a rule on `self` need it, so it becomes boilerplate; it is a rule the user must learn; the reference file would need it on two actions the operator approved without it.

### Option C: an opt-in `atomic` flag that fails the build when the body cannot be atomic

**Pros:** the author who cares about atomicity gets a guarantee; others write nothing.
**Cons:** a second way to express the same thing; can be added later without breaking files.

## Trade-off analysis

Option B protects against a surprise the committed `explain` output already shows in review, at the price of a word on most updates. Option A follows the operator's "minimise the rules" principle. Option C stays available if users ask for a guarantee.

## Consequences

- `require-atomic` is not in the v2 vocabulary. Ash's `require_atomic?` maps to nothing ([vocabulary mapping](../roadmap/vocabulary-mapping.md)).
- M5's acceptance tests change: "fails the build without `require-atomic=false`" becomes "`explain` reports read-then-write and names the line".
- The data-layer capability "atomic expressions" is still required for an atomic action; an adapter without it fails the build at the action.

## Action items

- [ ] M5: implement the inference and the `explain` reason line.
- [ ] Operator: confirm or overrule (Option B or C).
