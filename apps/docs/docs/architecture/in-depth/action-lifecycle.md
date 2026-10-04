---
title: "Action lifecycle"
description: "One action call from start to finish: the eight phases, atomic and non-atomic writes, and where authorization runs."
---

# Action lifecycle

Status: design; built in milestone M5 ([roadmap](../roadmap/roadmap.md), M5). A first four-step version (validate input, open a transaction, call the data layer, commit) arrives in M2 ([roadmap](../roadmap/roadmap.md), M2). Nothing on this page exists as code yet. Policies, which fill the authorizer slot, arrive in M8.

Vocabulary note: tag and attribute names on this page (for example `require-atomic=false`) are working names. For v1 the vocabulary copies Ash's DSL, and the final name follows the mapping in [vocabulary mapping](../roadmap/vocabulary-mapping.md) ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)). Examples use MX concise syntax ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).

This page follows one action call from the caller to the result. Related: [overview](../overview/architecture.md), [three rings](./three-rings.md), [build pipeline](./build-pipeline.md), [generated code and the guard](./generated-code-and-guard.md), [expressions](./expressions.md), [data layer](./data-layer.md).

## What an action call is

An action is one named operation on a resource. In v1 it is a generated TypeScript function taking the input and a scope, `{ actor, context }`, which the caller passes on every call ([roadmap](../roadmap/roadmap.md), sections 0 and M2). The scope says who is calling and carries extra data; it is never ambient, because Ash removed its ambient actor and tenant in 3.0 for "subtle bugs" ([research synthesis](../research/synthesis.md), section 8, "Do differently"; [ADR-0007](../decisions/0007-scope-is-a-plain-argument.md)). There is no transport, so the function call is the whole interface ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)).

The function body lists the phases in order, written out for that action, not a call into a generic `runAction` ([roadmap](../roadmap/roadmap.md), M2; [ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)).

## The eight phases

```text
enter -> cast -> plan -> pre-check ->
  [ transaction opens -> before hooks -> checks that read data
    -> data layer -> after hooks ]
  -> commit -> after commit
```

| # | Phase | What happens | Extension point |
|---|---|---|---|
| 1 | Enter | The call arrives with its scope. | Transports (none in v1) |
| 2 | Cast | Only accepted fields pass; values are cast and constrained. An unknown field is an error, not dropped. | Attribute types |
| 3 | Plan | The generated function follows the plan fixed at build time (below). | Changes, validations, preparations |
| 4 | Pre-check | Authorization checks that need no data run first. | Authorizer slot |
| 5 | Transaction | Opens. Before hooks run. Checks that read data run inside it. | Policy checks |
| 6 | Data layer | Calls go through the one data-layer contract; atomic changes fold into the statement; non-atomic actions read for update first. | Data layer |
| 7 | Commit | After hooks run inside the transaction, then it closes. | Hooks |
| 8 | After commit | The typed result or a classed error. | Notifiers, tracer |

([research synthesis](../research/synthesis.md), section 17; [roadmap](../roadmap/roadmap.md), M2 for the unknown-field rule.) Notifications are out of scope for M5 ([roadmap](../roadmap/roadmap.md), M5), so phase 8 has no notifier in v1.

## The plan: chosen at build time

The plan is chosen when the project is built, once, and printed by `mesh explain <resource> <action>` ([roadmap](../roadmap/roadmap.md), M5). `explain` output for the example is committed and guarded ([roadmap](../roadmap/roadmap.md), M5, test 5). At run time phase 3 does not choose anything. It runs the steps in the order the plan fixed, and it still gets its own tracing span ([roadmap](../roadmap/roadmap.md), M5, test 7).

Which phase runs each kind of rule is stated only in part:

| Rule | Where it runs |
|---|---|
| Translatable validation that reads only the input | In memory, before the statement ([roadmap](../roadmap/roadmap.md), M5). The phase is not decided. |
| Translatable change that does not read the stored record, atomic update | Folded into the `UPDATE` statement's assignments, phase 6. |
| Anything on a non-atomic update (opaque, or reads the stored record) | In memory, on the row read with a write lock, in one transaction. The phase is not decided. |
| Change or validation on a create | Not stated by the roadmap: not decided. A create has no stored row to update. |

This is the answer to Ash's bug #2969, fixed the day it was reported. In Ash a single-record update runs `change/3` when the changeset is built, then builds a second changeset and runs `atomic/3`. The second keeps attribute values but drops hooks and filters, so a `change filter(...)` stopped working on the atomic path and a non-matching row was written ([Ash runtime internals](../research/ash-runtime-internals.md), section 1.2 and 12.B item 21; [research synthesis](../research/synthesis.md), section 2.2). Mesh picks one strategy before anything runs, and a change is never run twice ([roadmap](../roadmap/roadmap.md), M5; [ADR-0017](../decisions/0017-atomic-by-default-and-classification.md)).

## Strategies: atomic or read-then-write

**Atomic** is the default for update and destroy: one statement, no read first, so a concurrent writer cannot slip between a read and the write ([roadmap](../roadmap/roadmap.md), M5, test 1: two concurrent increments both apply). Translatable changes that do not read the stored record fold into the statement's assignments (a literal, an input value, an increment of the column itself). A translatable validation that reads only the input runs in memory before the statement, on either path.

Each change and validation is classified, as described in [expressions](./expressions.md) ([roadmap](../roadmap/roadmap.md), M4 and M5): a **translatable** one can be converted into the Mesh expression tree; an **opaque** one is arbitrary TypeScript.

A change or validation that is opaque, or that reads the stored record, makes the action **non-atomic**. The action must say `require-atomic=false`, Ash's name for the opt-out (spelling per [vocabulary mapping](../roadmap/vocabulary-mapping.md)); without it the build fails ([roadmap](../roadmap/roadmap.md), M5, tests 2c and 3). Such an action reads the row with a write lock (a row lock on Postgres, an immediate transaction on SQLite), runs changes and validations in memory with the in-memory forms, collecting every validation error, and writes, all in one transaction, so two calls cannot both act on the same stale row (M5, test 2b). The data-layer contract gains a "read for update" call for this in M5 ([data layer](./data-layer.md)). `explain` prints "read then write".

In v1 no validation is folded into the statement, and there is no zero-row re-read and no conflict error. Folding validations that read the record is kept as a Proposed design for after v1: [ADR-0044](../decisions/0044-folding-record-reading-validations.md).

Atomic changes need the data adapter capability "atomic expressions"; an adapter without it fails the build at the resource-file position ([data layer](./data-layer.md); [roadmap](../roadmap/roadmap.md), M5, test 4).

In Ash the decision is a ladder of `{:not_atomic, reason}` results scattered across three files ([Ash runtime internals](../research/ash-runtime-internals.md), Implications for Mesh, item 3), and its compile-time check only warns; the failure comes at run time (same file, section 2.2). Mesh decides once at build time and fails the build.

## Where authorization runs

The authorizer slot has two places ([roadmap](../roadmap/roadmap.md), M5): one before the transaction for checks that need no data, one inside it for checks that read data. The slot is empty until M8, when `ext-policies` fills it ([ADR-0022](../decisions/0022-policies-simple-tier-as-extension.md)); until then nothing checks who calls ([ADR-0036](../decisions/0036-deny-by-default-arrives-with-policies.md)).

From M8, a write policy that needs no record runs in memory before the statement. A check that reads the record is folded into the statement as a filter on an atomic action, so a row the caller may not change is reported as not found, as for reads. This is Mesh's choice: Ash also compiles the check into the statement, but as an expression that raises an error ([ADR-0022](../decisions/0022-policies-simple-tier-as-extension.md)). On a non-atomic action it is evaluated in memory on the locked row and a denial is reported as forbidden, with the breakdown ([roadmap](../roadmap/roadmap.md), M8).

Ash authorizes writes in six places ([Ash runtime internals](../research/ash-runtime-internals.md), Summary): strict checks before the transaction; create filter checks after `after_action`; update and destroy runtime checks as a prepended `before_action` (or a pre-flight SELECT when the action does not transact); filter checks on non-atomic update and destroy as a SELECT before the transaction; checks compiled into an atomic statement; and generic actions. The fourth is a check-then-act gap. Mesh keeps the pre-transaction place only for checks that read nothing stored. The synthesis proposed one place inside the transaction ([research synthesis](../research/synthesis.md), section 8); the roadmap, which is the authority, has two.

## Hooks, preparations, arguments

Hooks run inside the transaction and after commit. A hook that throws rolls the write back ([roadmap](../roadmap/roadmap.md), M5, test 6). **Preparations** are the read-side counterpart: a preparation can add a filter that changes what a read returns (M5, test 8). **Arguments** are action-level inputs. Preparations and arguments are new vocabulary ([research synthesis](../research/synthesis.md), section 8, gap 4). Their tag shapes are not given: not decided. How an update or destroy names its record, and what an action's input holds beyond `accept`, is also not stated.

## Errors

Validations collect all errors, not the first ([roadmap](../roadmap/roadmap.md), M5). Error classes start with invalid input, not found and framework in M2, and M5 adds the hierarchy.

How a failed rule reports its `.mx` position is open: [ADR-0039](../decisions/0039-run-time-error-positions.md) is Proposed. The roadmap's working assumption is that the position is carried as data in the generated code, not through source maps ([roadmap](../roadmap/roadmap.md), M5). One reason is that Bun's `findSourceMap` returns `undefined` ([research synthesis](../research/synthesis.md), section 12, risk 3). Build-time errors name file, line and fix ([roadmap](../roadmap/roadmap.md), section 2, item 2).

##  Tracing

Each phase gets one span through the OpenTelemetry API, which does nothing unless the application installs an SDK ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md); [roadmap](../roadmap/roadmap.md), M5, test 7: eight spans in order with a test SDK, no error without one). Ash telemetry cost 15 to 23% of a create, so M5 measures the cost with no SDK ([research synthesis](../research/synthesis.md), section 6, item 7).

## Example: `publish`

From `packages/compiler/test/fixtures/post.mx`:

```mx
update="publish"
  change=({ post }) => { post.state = "published" }
  validate=({ post }) => post.title.length > 0 message="title required"
```

and, in `policies`:

```mx
policy action="publish"
  authorize-if=({ post, actor }) => post.authorId === actor.id
```

`publish` validates `post.title`, a stored value, so it reads the record. It is a non-atomic action and must say `require-atomic=false` in the fixture once the vocabulary is aligned ([roadmap](../roadmap/roadmap.md), M5). Its change is translatable but runs in memory with the rest.

1. **Enter.** The call carries a scope. How it names the post is not decided.
2. **Cast.** The action has no `accept` list; what its input holds is not decided.
3. **Plan.** Fixed at build time: read with lock, then write. `explain` shows "read then write".
4. **Pre-check.** The policy reads the stored post, so it does not run here.
5. **Transaction.** Opens. The post is read with a write lock. A missing post is a not-found error. From M8 the policy is evaluated in memory on the locked row, and a denial is reported as forbidden with the breakdown ([roadmap](../roadmap/roadmap.md), M8).
6. **Data layer.** (The phase that runs in-memory rules is not decided.) The validation runs in memory on the locked row; if `title` is empty the call fails with "title required" and writes nothing ([roadmap](../roadmap/roadmap.md), M5, test 2). Otherwise the change sets `state` and the row is written.
7. **Commit.** No hooks are declared; the transaction closes.
8. **After commit.** The typed record comes back.
