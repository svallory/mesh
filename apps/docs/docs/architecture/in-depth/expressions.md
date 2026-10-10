---
title: "Expressions: one tree, two evaluators"
description: "How a function whose body is one expression becomes one tree that runs in memory and in SQL, and what plain code is."
---

# Expressions: one tree, two evaluators

Status: the in-memory half is built (M4); the SQL half is design, for M10 ([roadmap](../roadmap/roadmap.md)). Used by M5 (the lifecycle runs the checks and `set` values), M7 (computed fields, relationship loading) and M8 (policies). What exists: the tree and the registry (`@meshfw/model`), the conversion from MX's Babel node and the type pass (`packages/compiler`), the in-memory functions (`@meshfw/runtime`'s `expr`), and `<entity>.expressions.ts`, which holds every expression of an entity file as one function of a scope. Every generated action calls them for its checks and `set` values (M5, first half), and nothing evaluates in SQL. The semantics where SQL and JavaScript differ are ruled: [ADR-0012](../decisions/0012-expression-semantics.md), option A, with every function's inputs and outputs, null cases included, on [Expression functions](./expression-functions.md). In short: a boolean is true, false or unknown; comparison with null is unknown; an unknown fails a `check`, skips a `when` and excludes a row; a construct the registry does not define stays plain TypeScript with JavaScript's rules, and the build warns. Whether Mesh reads Greffon's source is an M10 task (roadmap revision 5).

Related: [overview](../overview/architecture.md), [how Mesh uses MX](./mx-integration.md), [build pipeline](./build-pipeline.md), [action lifecycle](./action-lifecycle.md), [data layer](./data-layer.md), [extension host](./extension-host.md).

## What an expression is

An entity file holds small functions. From the reference file of [ADR-0050](../decisions/0050-entity-file-syntax.md):

```mx
read :overdue
  filter=() => &isOverdue
  sort
    asc &dueOn
```

```mx
do
  set
    &paidAt=({ input }) => input.paidAt
  when=() => &amount > 10000
    set
      &needsReview=true
```

```mx
computed
  boolean :isOverdue() {
    return &status === :sent && &dueOn < today()
  }
  string :label() {
    return &number + " · " + formatMoney(&total)
  }
```

Every function receives one object with four keys: `self` (the record), `input` (the fields and arguments of the action's one `input` section), `actor` (the caller, a shortcut for `context.actor`) and `context` (the [action context](../decisions/0059-action-context.md)). Members are written `&name`, lowering to record reads ([ADR-0067](../decisions/0067-members-imports-input-static-files.md)); the empty parameter list means no other context is used. MX does not run these functions. It hands each over as a parsed Babel node (the syntax tree of the Babel parser) with a source span (MX project notes, getting-started, section 1). Conversion to Mesh's tree happens in `@meshfw/compiler` ([ADR-0043](../decisions/0043-mx-is-core.md)).

One rule can be needed in two places. A filter must run in the database so that not every row is loaded. A check on a record already in memory must run in the program. So Mesh turns a function into **one tree** with two evaluators, as Ash does ([ADR-0010](../decisions/0010-one-expression-tree-two-evaluators.md); [research synthesis](../research/synthesis.md), section 2.2).

## Translated or plain code: the author's form decides

[ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md):

- A function whose **body is one expression Mesh can translate** is **translated**: an arrow, `() => &status === :sent`, or a method body that is a single `return`, as in `:isOverdue` above. It becomes a tree; it runs in SQL where a query needs it and in memory otherwise.
- **Where SQL is required** (a `filter`, a `sort`, a policy check, a rollup's `of`, or inside another translated expression), the expression must translate. A construct the translator does not support there is a build error at that node, reported in the editor through the contracts' `analyze` hook and again by the build. Using a computed field that runs in memory there is a build error that **names the field and the part that could not be translated**.
- **A computed field** whose single expression cannot be translated is not an error: `:label` above calls the helper `formatMoney` on `&total`, so it runs in memory after the record is loaded. `mesh explain` shows which computed fields are translated. Nobody writes a second statement to opt out ([rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), "Rulings after the review of the user docs (2026-10-05, lead under delegation)").
- **Plain code** is a body with more than one statement, or a `run` step. It is emitted as TypeScript by slicing the authored text at MX's span and runs in memory only.
- In a `check`'s `that`, a `when` or a `set` value, an expression that cannot be translated is not an error either: it runs in memory. Every update is read-then-write until atomic updates return after 1.0 ([ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)), so the form does not change the strategy, and the build warns when plain code uses JavaScript's null rules. Only a `filter`, a `sort` and a policy require SQL.

The parameter types expose only what translates, so the editor offers `&status` but not, for example, string methods the translator lacks.

Where the form matters:

| Position | Rule |
|---|---|
| `filter` on a read | Must be translated; plain code, or a computed field that runs in memory, is a build error naming the field and the untranslatable part. |
| `check`'s `that`, `when` | Either form, never an error. Plain code or an expression that cannot be translated runs in memory; until atomic updates return, every update is read-then-write ([ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)). |
| `set` value | Either form, never an error. A translated value is applied in memory in this version; folding it into an atomic `UPDATE` waits until after 1.0. |
| Computed field with a body (M7) | A single `return` that Mesh can translate is translated: usable in filters, sorts and policies, also computed in memory on a loaded record. Otherwise the field runs in memory after load, which is not an error; using it in a filter, a sort, a policy or another translated expression is. `mesh explain` shows which. |
| Rollup `of="lines.amount"` (M7) | A path string checked at build time against generated path types; always SQL. The function form, where a path cannot express it, must be translated. |
| Policy check (M8) | On a read, must be translated, because it becomes a query filter. Checks inside a policy combine without order ([ADR-0055](../decisions/0055-policies-are-core.md)). On a write, a record-reading check is folded into an atomic statement as a filter, or evaluated on the locked row of a read-then-write action. |

An earlier design classified each function by its content: *translatable* if every construct converted, *opaque* otherwise. It is superseded: the class was invisible to the author, and a small edit could move a rule from SQL to memory ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)).

## What a translated expression may reference

A translated expression may reference its parameters, registered functions, and calls to imported pure functions that do not read `self`; such a call is evaluated once in memory before the query and bound as a parameter. A bare captured value (a variable from the file) is a build error. ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)). A database cannot see a captured value, so a free variable is an error; a call to an imported pure function that does not read `self` is computed once and sent as a parameter, which is how `isStaff(actor)` appears in a policy and `today()` in `:isOverdue`. This is why an imported function must be pure. The research on expression languages recommends the same rule ("parameters, never closures") and the same treatment of the current date ([expression language](../research/expression-language.md), section 6).

## The tree and its forms

Each translated expression is written into the generated file twice ([roadmap](../roadmap/roadmap.md), M4):

| What | Made when | Used by |
|---|---|---|
| The **tree** itself, as a data literal | Emitted at build time | The data adapter, which compiles it into Drizzle's query builder when a query runs |
| The **SQL** | Compiled by the adapter at query time, in `data-drizzle` | The database |
| The **in-memory form**, emitted TypeScript | Emitted at build time | The program, calling the registered functions' in-memory implementations in `runtime` |

Nothing produces SQL at build time, because queries are assembled at run time from the action's filter, the caller's filter and the policies. At build time the adapter is checked instead: every function an entity uses must have a SQL form in the configured adapter, or the build fails.

The in-memory form is emitted rather than interpreted, so it is readable in the generated file ([ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)). The tree type lives in `runtime`, because it crosses the data-layer contract ([data layer](./data-layer.md)). The registry of functions and operators lives in `model`. `runtime` imports nothing from `model`.

## Design taken from the research

The [expression-language research](../research/expression-language.md) found no established project that captures a normal TypeScript arrow and runs it both in memory and as SQL; Greffon, the one young project with the same design, is too new to depend on ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)). Its list of what to copy shapes this page:

1. Two interpreters over one tree, so a rule cannot be true in one and false in the other.
2. A small, enumerated node vocabulary, plus a function-call node with a fixed allow-list.
3. Relationship traversal (`&customer.userId`) rewritten into joins as a normalisation pass before SQL generation.
4. A declared supported subset, checked before anything else, with errors at a source span.
5. Parameters, never closures.
6. Policies folded into the query tree, so indexes still work.

The same section lists pitfalls that bear on [ADR-0012](../decisions/0012-expression-semantics.md): null against `undefined`, booleans stored as integers on SQLite, dates, string case and `LIKE`, short-circuit evaluation, and coercion (`==`, `+` on strings).

## The function registry

Every operator and function an expression may use is registered once, in `model` ([roadmap](../roadmap/roadmap.md), M4). A function used in an entity needs an in-memory implementation in `runtime` and a SQL form in the configured adapter. Extensions add functions through their manifest, supplying both ([extension host](./extension-host.md)). One registry exists because Ash's docs drift from its registries: 39 registered functions, about 30 documented ([research synthesis](../research/synthesis.md), section 8).

## Keeping the evaluators in agreement

Every registered function has one table of inputs and expected outputs, null cases included. The table is run through the in-memory form and through every merged SQL adapter, and all must give the table's answer ([roadmap](../roadmap/roadmap.md), M4, test 1; M9, test 5 adds Postgres). The tables cover single functions, not combinations.

## What Ash does and where it went wrong

Ash's expression is a two-stage tree: unresolved call nodes, resolved into operator and function structs when a filter is parsed. The same tree runs in memory (`Ash.Filter.Runtime`) or compiles to SQL (`AshSql.Expr`) ([Ash runtime internals](../research/ash-runtime-internals.md), sections 5.1 and 5.4). Two failures matter:

1. **Paths that disagree.** Bug #2969: a filter added by an action's own change was lost when a single-record update ran atomically (same file, 12.B item 21). Strictly a lifecycle bug; Mesh's rule that a step never runs twice, with one plan per action, guards against it ([action lifecycle](./action-lifecycle.md)). The shared tables guard the other risk, the two forms giving different answers.
2. **JavaScript semantics forced onto the database.** AshPostgres installs SQL functions (`ash_elixir_and` and others) so `&&` behaves as in Elixir. A filter written with `&&` ran in about 3,400 ms against about 110 ms with `and`, because the function call defeats the index (same file, 4.2 and 12.B item 17). This bears on [ADR-0012](../decisions/0012-expression-semantics.md).

Ash also sometimes filters in memory when a data layer cannot run an expression (same file, 5.4). Mesh's in-memory evaluator is never a fallback for a missing database capability ([data layer](./data-layer.md)).
