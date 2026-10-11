---
title: "Action lifecycle"
description: "One action call from start to finish: the eight phases, `validate` then `do`, the inferred write strategy, and where policies run."
---

# Action lifecycle

Status: the phases are built (M5; [roadmap](../roadmap/roadmap.md)): cast, transaction, read under the lock, `validate`, `do`, write, the steps after the write, and action composition (`actions`, `tx`, the application's `transaction`). Policies, which fill the authorizer slot, arrive in M8.

::: callout info "What the code does today"
The run-time library (`@meshfw/runtime`) exports `ActionContext` for the second argument ([ADR-0059](../decisions/0059-action-context.md)), with `MeshError`, `InvalidInputError`, `NotFoundError(entity, key)`, `ForbiddenError` and `FrameworkError`. The `actions` generator writes one function per action that casts its input, opens one transaction, reads the stored row under the lock, runs every `check` (all failures are collected into one `InvalidInputError`), runs the `do` steps (`set`, `when`, `load`, `run`), writes through the data layer, then runs the `run [after=:write]` steps. A function of the entity file receives `actions` and `tx` beside `self` and `input` (see [Composition](#composition) below). `mesh explain <entity> <action>` prints the plan. Not built yet: policies (M8); the authorizer slot is in place and empty. This page describes the lifecycle in the entity syntax ([ADR-0067](../decisions/0067-members-imports-input-static-files.md)).
:::

This page follows one action call from the caller to the result. Related: [overview](../overview/architecture.md), [three rings](./three-rings.md), [build pipeline](./build-pipeline.md), [generated code and the guard](./generated-code-and-guard.md), [expressions](./expressions.md), [data layer](./data-layer.md).

## What an action call is

An action is one named operation on an entity. It is a generated TypeScript function, `payInvoice(input, context)`, and calling it is the whole interface: there is no transport in v1 ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)). The second argument is the *action context*, one flat object whose type, `ActionContext`, the application declares once; `actor` is the one key Mesh reads, every other key is the application's ([ADR-0059](../decisions/0059-action-context.md)). It is never ambient, because Ash removed its ambient actor and tenant in 3.0 for "subtle bugs" ([research synthesis](../research/synthesis.md), section 8, "Do differently").

The function body lists the phases in order, written out for that action, not a call into a generic `runAction` ([roadmap](../roadmap/roadmap.md), M2; [ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)).

An action has one `input` section and two execution blocks ([ADR-0053](../decisions/0053-validate-then-do.md), amended by [ADR-0067](../decisions/0067-members-imports-input-static-files.md)):

- **`input`**: member lines such as `&paidAt` take declarations unchanged; typed lines such as `decimal :percent` declare arguments. Duplicate names and options on member lines fail the build.
- **`validate`**: `check :label [ that code message ]`, with `when=` on the check for a condition. It is for rules across fields or about stored state; a rule about one field goes on its line (`decimal :amount min=0`) and is checked in phase 2. It runs first. `self` is the record with the caller's accepted input applied: the sent value for each accepted field, the stored value for the rest (on a create, the defaults); nothing from `do` has run. `input` carries the arguments.
- **`do`**: steps, run in written order. v1 steps are `set` (`&field=value` lines), `when=cond` with nested steps, `load=[...]` and `run(...) { }` for one-off plain code.

`always` blocks under `actions` (scoped with `types=` and `actions=`) add a shared `validate` and `do` to every action in their scope; their checks run before the action's own, and their steps before the action's own.

What `self` holds depends on where a function runs ([ADR-0053](../decisions/0053-validate-then-do.md)):

| Where | `self` is |
|---|---|
| `validate` | The record with the accepted input applied; stored values (on a create, defaults) for fields not sent; nothing from `do` has run |
| A `do` step | The record as the earlier steps left it |
| A policy on a read | The row |
| A policy on an update or destroy | The stored record |
| A policy on a create | The proposed record |
| A computed field | The loaded record |

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
| 2 | Cast | Only members and arguments listed in `input` pass, in one input object; values are cast and checked against their line's rules (`min`, `max`, `match`). On a create every accepted field that is required and has no default must be sent; on an update none must. An unknown field is an error, not dropped. | Attribute types |
| 3 | Plan | The generated function follows the plan fixed at build time (below). | Steps |
| 4 | Pre-check | Policy checks that need no stored record run first. | Authorizer slot |
| 5 | Transaction | Opens. A read-then-write action reads the row with a write lock. `validate` runs, then the `do` steps. Policy checks that read the record run inside it. | Policy checks |
| 6 | Data layer | Calls go through the one data-layer contract; an atomic update is one statement. | Data layer |
| 7 | Commit | The transaction closes. | none in v1 |
| 8 | After commit | The typed result, with anything named by `load`, or a classed error. | Tracer |

([research synthesis](../research/synthesis.md), section 17; [roadmap](../roadmap/roadmap.md), M2 and M5.) The `after-commit` step is planned, not in v1 ([ADR-0053](../decisions/0053-validate-then-do.md)).

## Composition

An action can call other actions in its own transaction ([ADR-0068](../decisions/0068-actions-compose-through-actions-and-tx.md)). A `run` body, and a `check`, `when` or `set` value written as a function, receive two more names beside `self`, `input`, `actor`, `context` and `before`:

- `actions`: every generated action function of the project. A call joins the running transaction and runs the called action's whole lifecycle, its authorizer slot included. It carries the caller's context unless it passes its own as the second argument.
- `tx`: one function per read action, with the caller's `filter`, `sort`, `limit` and `offset`. It reads inside the transaction, so it sees the rows written earlier in it, and it skips the read authorizer.

An application gets the same two from `transaction(fn, context)`, which `#mesh` exports beside `bind`. It opens a transaction, or joins the running one, and resolves with what `fn` resolves with.

How it is wired. Each entity's actions file stays importable on its own, and no actions file imports another, so there is no import cycle. The generated index's `bind(layer)` makes one composer (`composer` in `@meshfw/runtime`) and passes it to every entity's bind function. Once every entity is bound, it hands the composer the bound functions and the read bodies. An action asks the composer for `{ actions, tx }` when it builds a function's scope. The types come from `composition.ts` (the `Actions` and `Reads` interfaces), which imports only the entity types files. An entity bound alone, with its own `bind<Entity>`, has no composer. Its functions get stand-ins that throw a `FrameworkError` when read, so its actions that never compose still run.

A call that fails fails the transaction. A nested call joins through the data layer's re-entrant `transaction`. When a joined call fails, the layer marks the transaction for rollback. The outermost call then rejects with a `FrameworkError` whose `cause` is the nested error, even when the caller caught it. The call joins before the called action casts its input, so a cast failure counts too. An uncaught nested error reaches the caller as itself.

A generated function called directly, as imported from `#mesh`, follows the same rule inside a transaction: its cast runs before it joins, so a failed cast goes through the layer's `transaction` first (`castInput` in `@meshfw/runtime`), joins and marks the running transaction, and rethrows. At top level, outside any transaction, the caller gets the cast error at once: `refuseIfFailed()` says the call would not join, so nothing opens and no lock is taken, and a bad request never waits behind a running transaction. Once a call has failed a transaction, a later call that joins it, through `actions`, directly or as a nested `transaction`, is refused before it casts its input or runs anything, with a `FrameworkError` whose `cause` is the first failure: code that keeps going after a caught failure does no work and has no side effect inside a transaction that rolls back anyway ([data layer](./data-layer.md)). A `transaction` called inside another joins it but does not inherit its context, so pass the context again.

Calls joined to one transaction run one at a time. Siblings started together, as with `Promise.all`, run in the order they were made, each after the one before it settled, so two read-then-write calls on one row cannot both read before either writes: two parallel deposits add both amounts. A call made from inside a joined call queues behind that call's own calls only, so nesting never waits for itself ([data layer](./data-layer.md)). It follows that a joined call must never await a call that was joined after it from the same frame, for example through a promise the two share: the later call's turn comes only once the awaiting call settled, so the transaction hangs.

What is handed over is read-only. A record from `actions` or `tx` follows the same rule as `self` and `before`: it is a read-only view, and a change made in place never reaches storage. In an entity file, `structuredClone` returns a plain copy the function can change. A helper module the entity file imports gets the platform's own `structuredClone`, which throws a `DataCloneError` on a read-only view; it copies with `cloneValue` from `@meshfw/runtime`, which is what the entity file's `structuredClone` is. The application's `transaction` callback gets plain records.

**After the write.** A `run [after=:write]` step runs once the action's own row is written, inside the transaction, with the stored record as `self`. On a create, that record carries the key the data layer filled. On a destroy, `self` is the deleted row as it was. The other steps run before the write. A `when` around an after-write step is evaluated once, before the write, with the record as the earlier steps left it. `explain` lists these steps under "after write". An action that has an after-write step returns the row read again by key once those steps ran, so a step that changed the action's own row through `actions` is in the result; only these actions pay for the extra read.

A nested call that changes the caller's own row must come after the caller's write. Before an update writes, if any call made during its earlier phases wrote anything, the update reads its row again by key and compares it with the copy it read under the lock. A difference means a nested call changed or deleted this very row, so the update's checks and steps decided on a stale row, and the update rejects with a `FrameworkError` that says so and says to move the call to a `run [after=:write]` step. A nested write to another row passes.

## The plan: chosen at build time

The plan is chosen when the project is built, once, and printed by `mesh explain <entity> <action>` ([roadmap](../roadmap/roadmap.md), M5). `explain` is tested in the compiler and the CLI; no example commits its output yet. At run time phase 3 does not choose anything; it runs the steps in the order the plan fixed, and it still gets its own tracing span once tracing returns. Until atomic updates return after Mesh 1.0, every update or destroy is read-then-write and `explain` says so ([ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)).

This is the answer to Ash's bug #2969, fixed the day it was reported. In Ash a single-record update runs `change/3` when the changeset is built, then builds a second changeset and runs `atomic/3`. The second keeps attribute values but drops hooks and filters, so a `change filter(...)` stopped working on the atomic path and a non-matching row was written ([Ash runtime internals](../research/ash-runtime-internals.md), section 1.2 and 12.B item 21; [research synthesis](../research/synthesis.md), section 2.2). Mesh picks one strategy before anything runs, and a step never runs twice ([ADR-0017](../decisions/0017-atomic-by-default-and-classification.md)).

## Strategies: atomic or read-then-write

The build infers the strategy from the body; the author writes nothing to choose it ([ADR-0054](../decisions/0054-write-strategy-is-inferred.md)).

The criterion ([ADR-0054](../decisions/0054-write-strategy-is-inferred.md)): A create always runs as one statement (one `INSERT`). An update or destroy runs as one statement when its `check` and `when` conditions read only `input`, `actor` and `context` and its `set` values translate; a `check` or `when` that reads `self` makes it read the row first (locked, in the same transaction) and then write. Folding a translated `self` condition into the statement's `WHERE` is after v1 ([ADR-0044](../decisions/0044-folding-record-reading-validations.md)). A `run` step, and a `check`, `when` or `set` value that cannot be translated, also make the action read first; none of these is an error.

**Atomic** is one statement, no read first, so a concurrent writer cannot slip between a read and the write. Translated `set` values fold into the `UPDATE` assignments (a literal, an input value, `&count + 1` for `&count`). Conditions that read only `input`, `actor` and `context` run in memory before the statement.

**Read-then-write** is everything else. The action reads the row with a write lock (a row lock on Postgres, an immediate transaction on SQLite), runs `validate` and then `do` in memory with the in-memory forms, collecting every failed check, and writes, all in one transaction, so two calls cannot both act on the same stale row. The data-layer contract gains a "read for update" call for this in M5 ([data layer](./data-layer.md)). `explain` prints "read then write" and names the line that required it.

In v1 there is no zero-row re-read and no conflict error.

Atomic actions need the data adapter capability "atomic expressions"; an adapter without it fails the build at the action ([data layer](./data-layer.md)).

In Ash the decision is a ladder of `{:not_atomic, reason}` results scattered across three files ([Ash runtime internals](../research/ash-runtime-internals.md), Implications for Mesh, item 3), and its compile-time check only warns; the failure comes at run time (same file, section 2.2). Mesh decides once at build time and shows the decision.

## Creates

A create has no stored record. `validate` sees, as `self`, the accepted input applied over the declared defaults; `do` then edits that proposed record; the row is inserted ([ADR-0053](../decisions/0053-validate-then-do.md)). A create policy sees the proposed record; reading a related record (`&list.ownerId`) is a query inside the transaction, before the insert ([ADR-0055](../decisions/0055-policies-are-core.md)).

## Where policies run

Policies are core ([ADR-0055](../decisions/0055-policies-are-core.md)). A policy passes when none of its `forbid-if` holds and, if it has any `authorize-if`, at least one holds; nothing depends on the order of checks or of policies. An action passes only if every policy covering it passes; an action no policy covers, and every action of an entity without a `policies` section, is forbidden. Until M8 the authorizer slot is empty and nothing checks who calls.

The slot has two places: one before the transaction for checks that need no stored record (`isStaff(actor)`), one inside it for checks that read the record. A read policy becomes a filter on the query, so a row the caller may not see is not found. On an atomic update or destroy, the working assumption until [ADR-0046](../decisions/0046-denied-atomic-write-outcome.md) is ruled: a policy check that reads the record is folded into the statement as a filter, so a row the caller may not change is also reported as not found. (Ash compiles the check into the statement as an expression that raises instead.) On a read-then-write action the check is evaluated in memory on the locked row and a denial is reported as forbidden, with the breakdown. A record-reading check written as plain code cannot run on an atomic action or a read; that is a build error.

Ash authorizes writes in six places ([Ash runtime internals](../research/ash-runtime-internals.md), Summary), one of which (filter checks on non-atomic update and destroy as a SELECT before the transaction) is a check-then-act gap. Mesh keeps the pre-transaction place only for checks that read nothing stored.

## Arguments and loads

Typed lines in `input` declare arguments not stored as sent, for example `decimal :percent min=0 max=100`. Member lines such as `&paidAt` take fields as declared. They share one section and one caller object; a duplicate name is a build error. Arguments reach code as `input.percent` and are cast like attributes ([ADR-0067](../decisions/0067-members-imports-input-static-files.md)). A `load=[...]` step names relationships or computed fields to load onto the returned record; it writes nothing ([ADR-0053](../decisions/0053-validate-then-do.md)). A load that cannot be served is a run-time error, never skipped.

## Errors

`validate` collects every failed check, not the first. Failed checks raise one `InvalidInputError` whose `code` is always `invalid_input`; it has one issue per failed check, each carrying the check's label, its declared `code`, the path, the message and the position of the `check` tag. Error classes start with invalid input, not found and framework in M2; M5 adds the hierarchy, M8 the forbidden class.

How a failed rule reports its `.mesh.mx` position is open: [ADR-0039](../decisions/0039-run-time-error-positions.md) is Proposed. The working assumption is that the position is carried as data in the generated code, not through source maps, partly because Bun's `findSourceMap` returns `undefined` ([research synthesis](../research/synthesis.md), section 12, risk 3).

## Tracing

Tracing comes after Mesh 1.0 ([ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)): until then generated code opens no spans and imports no OpenTelemetry package. The design below stands for when it returns.

Each phase gets one span through the OpenTelemetry API, which does nothing unless the application installs an SDK ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md); [roadmap](../roadmap/roadmap.md), M5). Ash telemetry cost 15 to 23% of a create, so M5 measures the cost with no SDK ([research synthesis](../research/synthesis.md), section 6, item 7).

## Example: `pay`

From the reference file in [ADR-0050](../decisions/0050-entity-file-syntax.md):

```mx
update :pay
  input
    &paidAt
  validate
    check :invoiceIsSent [
      that=() => &status === :sent
      code="invalid_state"
      message="only a sent invoice can be paid"
    ]
    check :invoiceHasLines [
      that=() => &lineCount > 0
      code="invalid_state"
      message="an invoice needs at least one line"
    ]
  do
    set
      &status=:paid
      &paidById=({ actor }) => actor.id
    when=() => &amount > 10000
      set
        &needsReview=true
    load=[&customer]
```

and the `always` block that adds `check :dueAfterIssue` (`&dueOn >= &issuedOn`) to every create and update, and the policy `:staffWrites types=[:create, :update, :destroy]` with `authorize-if=({ actor }) => isStaff(actor)`.

The checks read `&status` and `&lineCount`, so the build makes `pay` **read-then-write**; `explain` names those checks.

1. **Enter.** `payInvoice({ id, paidAt }, { actor })`.
2. **Cast.** `id` and the member input `paidAt` pass; anything else is an error.
3. **Plan.** Read with lock, then write.
4. **Pre-check.** `isStaff(actor)` reads nothing stored, so `:staffWrites` runs here. A non-staff caller is forbidden before the transaction opens.
5. **Transaction.** Opens; the invoice is read with a write lock; a missing invoice is not found. `validate` runs on the stored invoice with the supplied `paidAt` applied: the `always` check `dueAfterIssue`, then `invoiceIsSent` and `invoiceHasLines`. If any fails, the call raises `InvalidInputError` (`code` `invalid_input`) with one issue per failed check and writes nothing. Then `do`: the `set` assigns status and payer; `when` sees the record as the `set` left it and, for an amount above 10000, sets `needsReview`.
6. **Data layer.** The proposed row is written inside the locked transaction.
7. **Commit.** The transaction closes.
8. **After commit.** `customer` is loaded onto the returned record, which comes back typed.
