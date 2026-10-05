---
title: "Action lifecycle"
description: "One action call from start to finish: the eight phases, `validate` then `do`, the inferred write strategy, and where policies run."
---

# Action lifecycle

Status: design; built in milestone M5 ([roadmap](../roadmap/roadmap.md), M5). A first version (validate the input, open a transaction, call the data layer, commit) arrives in M2. Nothing on this page exists as code yet. Policies, which fill the authorizer slot, arrive in M8.

::: callout info "The code still uses the old names"
The run-time library on `main` (`@mesh/runtime`) exports a `Scope` type for the second argument. This page uses the design's names: the `ActionContext` ([ADR-0059](../decisions/0059-action-context.md)) and entity file syntax v2 ([ADR-0050](../decisions/0050-entity-file-syntax.md)). The realignment task renames the code ([ADR-0064](../decisions/0064-order-of-work-after-approval.md)).
:::

This page follows one action call from the caller to the result. Related: [overview](../overview/architecture.md), [three rings](./three-rings.md), [build pipeline](./build-pipeline.md), [generated code and the guard](./generated-code-and-guard.md), [expressions](./expressions.md), [data layer](./data-layer.md).

## What an action call is

An action is one named operation on an entity. It is a generated TypeScript function, `payInvoice(input, context)`, and calling it is the whole interface: there is no transport in v1 ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)). The second argument is the *action context*, one flat object whose type, `ActionContext`, the application declares once; `actor` is the one key Mesh reads, every other key is the application's ([ADR-0059](../decisions/0059-action-context.md)). It is never ambient, because Ash removed its ambient actor and tenant in 3.0 for "subtle bugs" ([research synthesis](../research/synthesis.md), section 8, "Do differently").

The function body lists the phases in order, written out for that action, not a call into a generic `runAction` ([roadmap](../roadmap/roadmap.md), M2; [ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)).

An action's body in the entity file has two blocks ([ADR-0053](../decisions/0053-validate-then-do.md)):

- **`validate`**: `require=[...]` and `check :label [ that code message ]`, with `when` to nest. It runs first and sees the stored record as `self`, plus `input`.
- **`do`**: steps, run in written order. v1 steps are `set` (`#field=value` lines), `when=cond` with nested steps, `load=[...]` and `run(...) { }` for one-off plain code.

`always` blocks under `actions` add a shared `validate` and `do` to every action in their scope; their checks run before the action's own, and their steps before the action's own.

## The eight phases

```text
enter -> cast -> plan -> pre-check ->
  [ transaction opens -> (read with lock) -> validate -> do
    -> data layer ]
  -> commit -> after commit
```

| # | Phase | What happens | Extension point |
|---|---|---|---|
| 1 | Enter | The call arrives with its action context. | Transports (none in v1) |
| 2 | Cast | Only accepted fields and declared `arguments` pass; values are cast and checked against their line's shape rules (`min`, `max`, `match`). An unknown field is an error, not dropped. | Attribute types |
| 3 | Plan | The generated function follows the plan fixed at build time (below). | Steps |
| 4 | Pre-check | Policy checks that need no stored record run first. | Authorizer slot |
| 5 | Transaction | Opens. A read-then-write action reads the row with a write lock. `validate` runs, then the `do` steps. Policy checks that read the record run inside it. | Policy checks |
| 6 | Data layer | Calls go through the one data-layer contract; an atomic update is one statement. | Data layer |
| 7 | Commit | The transaction closes. | none in v1 |
| 8 | After commit | The typed result, with anything named by `load`, or a classed error. | Tracer |

([research synthesis](../research/synthesis.md), section 17; [roadmap](../roadmap/roadmap.md), M2 and M5.) The `after-commit` step is planned, not in v1 ([ADR-0053](../decisions/0053-validate-then-do.md)).

## The plan: chosen at build time

The plan is chosen when the project is built, once, and printed by `mesh explain <entity> <action>` ([roadmap](../roadmap/roadmap.md), M5). `explain` output for the example is committed and guarded. At run time phase 3 does not choose anything; it runs the steps in the order the plan fixed, and it still gets its own tracing span.

This is the answer to Ash's bug #2969, fixed the day it was reported. In Ash a single-record update runs `change/3` when the changeset is built, then builds a second changeset and runs `atomic/3`. The second keeps attribute values but drops hooks and filters, so a `change filter(...)` stopped working on the atomic path and a non-matching row was written ([Ash runtime internals](../research/ash-runtime-internals.md), section 1.2 and 12.B item 21; [research synthesis](../research/synthesis.md), section 2.2). Mesh picks one strategy before anything runs, and a step never runs twice ([ADR-0017](../decisions/0017-atomic-by-default-and-classification.md)).

## Strategies: atomic or read-then-write

The build infers the strategy from the body; the author writes nothing to choose it ([ADR-0054](../decisions/0054-write-strategy-is-inferred.md)).

**Atomic** is one statement, no read first, so a concurrent writer cannot slip between a read and the write. An update or destroy is atomic when every `check` reads only `input` and every `set` value is a translated expression that reads nothing stored except the column it assigns: a literal, an input value, `self.count + 1` for `#count`. Those values fold into the `UPDATE` assignments. Checks that read only `input` run in memory before the statement.

**Read-then-write** is everything else: a `check` or a `when` that reads `self`, a `set` value that reads another stored column or has a block body, or a `run` step. The action reads the row with a write lock (a row lock on Postgres, an immediate transaction on SQLite), runs `validate` and then `do` in memory with the in-memory forms, collecting every failed check, and writes, all in one transaction, so two calls cannot both act on the same stale row. The data-layer contract gains a "read for update" call for this in M5 ([data layer](./data-layer.md)). `explain` prints "read then write" and names the line that required it.

In v1 no check is folded into the statement, and there is no zero-row re-read and no conflict error. Folding record-reading checks into the `WHERE` clause is kept as a Proposed design for after v1 ([ADR-0044](../decisions/0044-folding-record-reading-validations.md)).

Atomic actions need the data adapter capability "atomic expressions"; an adapter without it fails the build at the action ([data layer](./data-layer.md)).

In Ash the decision is a ladder of `{:not_atomic, reason}` results scattered across three files ([Ash runtime internals](../research/ash-runtime-internals.md), Implications for Mesh, item 3), and its compile-time check only warns; the failure comes at run time (same file, section 2.2). Mesh decides once at build time and shows the decision.

## Creates

A create has no stored record. `validate` sees, as `self`, the record built from the accepted input and the declared defaults; `do` then edits that proposed record; the row is inserted ([ADR-0053](../decisions/0053-validate-then-do.md)). A create policy sees the proposed record; reading a related record (`self.list.ownerId`) is a query inside the transaction, before the insert ([ADR-0055](../decisions/0055-policies-are-core.md)).

## Where policies run

Policies are core ([ADR-0055](../decisions/0055-policies-are-core.md)). An action passes only if every policy covering it passes; an action no policy covers, and every action of an entity without a `policies` section, is forbidden. Until M8 the authorizer slot is empty and nothing checks who calls.

The slot has two places: one before the transaction for checks that need no stored record (`isStaff(actor)`), one inside it for checks that read the record. A read policy becomes a filter on the query, so a row the caller may not see is not found. On an atomic update or destroy, a check that reads the record is folded into the statement as a filter, so a row the caller may not change is also reported as not found; Ash compiles the check into the statement as an expression that raises instead, and which outcome Mesh keeps is open ([ADR-0046](../decisions/0046-denied-atomic-write-outcome.md)). On a read-then-write action the check is evaluated in memory on the locked row and a denial is reported as forbidden, with the breakdown. A record-reading check written as a block body cannot run on an atomic action or a read; that is a build error.

Ash authorizes writes in six places ([Ash runtime internals](../research/ash-runtime-internals.md), Summary), one of which (filter checks on non-atomic update and destroy as a SELECT before the transaction) is a check-then-act gap. Mesh keeps the pre-transaction place only for checks that read nothing stored.

## Arguments and loads

`arguments` are action inputs that are not attributes, declared in the attribute line shape (`datetime #paidAt`). They reach functions as `input` and the generated input type, and are cast like attributes ([ADR-0052](../decisions/0052-actions-auto-and-on-load.md)). A `load=[...]` step names relationships or computed fields to load onto the returned record; it writes nothing ([ADR-0053](../decisions/0053-validate-then-do.md)). A load that cannot be served is a run-time error, never skipped.

## Errors

`validate` collects every failed check, not the first. A failed check raises `InvalidInputError` with one issue per check, each carrying the check's `code`, `message` and label. Error classes start with invalid input, not found and framework in M2; M5 adds the hierarchy, M8 the forbidden class.

How a failed rule reports its `.mesh.mx` position is open: [ADR-0039](../decisions/0039-run-time-error-positions.md) is Proposed. The working assumption is that the position is carried as data in the generated code, not through source maps, partly because Bun's `findSourceMap` returns `undefined` ([research synthesis](../research/synthesis.md), section 12, risk 3).

## Tracing

Each phase gets one span through the OpenTelemetry API, which does nothing unless the application installs an SDK ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md); [roadmap](../roadmap/roadmap.md), M5). Ash telemetry cost 15 to 23% of a create, so M5 measures the cost with no SDK ([research synthesis](../research/synthesis.md), section 6, item 7).

## Example: `pay`

From the reference file in [ADR-0050](../decisions/0050-entity-file-syntax.md):

```mx
update #pay
  arguments
    datetime #paidAt
  validate
    check :invoiceNotSent [
      that=({ self }) => self.status === "sent"
      code="invalid_state"
      message="only a sent invoice can be paid"
    ]
  do
    set
      #status="paid"
      #paidAt=({ input }) => input.paidAt
      #paidById=({ actor }) => actor.id
    when=({ self }) => self.amount > 10000
      set
        #needsReview=true
    load=["customer"]
```

and the `always` block that adds `check :amountNotNegative` to every create and update, and the policy `#staffWrites types=["create", "update", "destroy"]` with `authorize-if=({ actor }) => isStaff(actor)`.

The check reads `self.status`, a stored value, so the build makes `pay` **read-then-write**; `explain` names the `check :invoiceNotSent` line.

1. **Enter.** `payInvoice({ id, paidAt }, { actor })`.
2. **Cast.** `id` and the argument `paidAt` pass; anything else is an error.
3. **Plan.** Read with lock, then write.
4. **Pre-check.** `isStaff(actor)` reads nothing stored, so `#staffWrites` runs here. A non-staff caller is forbidden before the transaction opens.
5. **Transaction.** Opens; the invoice is read with a write lock; a missing invoice is not found. `validate` runs: the `always` check (`self.amount >= 0`), then `invoiceNotSent`. If either fails, the call raises `InvalidInputError` with every failed check and writes nothing. Then `do`: the `set` assigns three fields; `when` sees the record as the `set` left it and, for an amount above 10000, sets `needsReview`.
6. **Data layer.** The proposed row is written inside the locked transaction.
7. **Commit.** The transaction closes.
8. **After commit.** `customer` is loaded onto the returned record, which comes back typed.
