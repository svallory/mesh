---
title: "Expressions: one tree, two evaluators"
description: "One expression tree with two evaluators: in memory and in SQL."
---

# Expressions: one tree, two evaluators

Status: design; built in milestone M4 ([roadmap](../roadmap/roadmap.md), M4). Used by M5 (atomic changes), M7 (calculations, relationship traversal) and M8 (policies). Nothing on this page exists as code yet. The semantics where SQL and JavaScript differ are open: [ADR-0012](../decisions/0012-expression-semantics.md) is Proposed.

Vocabulary note: tag and attribute names on this page are working names. For v1 the vocabulary copies Ash's DSL, and the final name follows the mapping in [vocabulary mapping](../roadmap/vocabulary-mapping.md) ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)). Examples use MX concise syntax ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).

Related: [overview](../overview/architecture.md), [MX integration](./mx-integration.md), [build pipeline](./build-pipeline.md), [action lifecycle](./action-lifecycle.md), [data layer](./data-layer.md), [extension host](./extension-host.md).

## What an expression is

In a resource file an expression is an arrow function. From `packages/compiler/test/fixtures/post.mx`:

```text
read="published"
  filter=({ post }) => post.state === "published"
  sort=["-insertedAt"]
```

and, on the `publish` action:

```text
change=({ post }) => { post.state = "published" }
validate=({ post }) => post.title.length > 0 message="title required"
```

MX does not run these. It hands each over as a parsed Babel node (the syntax tree of the Babel parser) with a source span (MX project notes, getting-started, section 1). MX is core, not an adapter ([ADR-0043](../decisions/0043-mx-is-core.md)), and the conversion from the Babel node to the Mesh tree happens in `packages/compiler` ([roadmap](../roadmap/roadmap.md), M4).

One expression can be needed in two places. A filter must run in the database so that not every row is loaded. A validation on a record already in memory must run in the program. So Mesh turns an arrow function into **one tree** with two evaluators, as Ash does ([rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), "Rulings after the decision review", row "Expressions"; [ADR-0010](../decisions/0010-one-expression-tree-two-evaluators.md); [research synthesis](../research/synthesis.md), section 2.2).

## Translatable and opaque

- **Translatable**: every construct converts to the tree.
- **Opaque**: some construct cannot be converted, for example a call to an imported helper. It is emitted as TypeScript by slicing the authored text at MX's span, and has no tree ([roadmap](../roadmap/roadmap.md), M4).

Where the class matters ([roadmap](../roadmap/roadmap.md), M4, M5, M7, M8):

| Position | Rule |
|---|---|
| `filter` on a read | Must be translatable. An unsupported construct fails the build at that node. |
| `change` and `validate` | Either class; the class is recorded in the model and decides atomic or non-atomic ([action lifecycle](./action-lifecycle.md)). |
| `calculate` (M7) | Translatable: usable in queries, also computed in memory on a loaded record. Opaque: runs after load, cannot be used in a filter (build error). |
| Read policy (M8) | Must be translatable, because it becomes a query filter. A write policy that reads the record is folded into the statement as a filter on an atomic action and evaluated in memory on the locked row otherwise; one that is not translatable on an atomic action is a build error. |

Ash's policy access types (`strict`, `filter`, `runtime`) map onto this split ([research synthesis](../research/synthesis.md), section 8, "Copy from Ash").

Several of these errors need the class. Conversion and classification happen while the model is built (stage 3), so the tree and the class are part of the model. The errors that depend on the class come from the checks step, which becomes the Verify stage from M6 ([roadmap](../roadmap/roadmap.md), M1, M4 and M6). Stage 6 (Compile expressions) only produces the two forms. The stage numbers are the synthesis's ([research synthesis](../research/synthesis.md), section 16); see [build pipeline](./build-pipeline.md).

## The scope rule: no free variables

A translatable expression may use only its own parameters and registered functions. A free variable (a name captured from the enclosing file) is a build error ([roadmap](../roadmap/roadmap.md), M4). A database cannot see a captured value. Every TypeScript library that parses arrow functions at run time loses captured variables, so Mesh does the work at build time, where the whole file is visible ([research synthesis](../research/synthesis.md), section 8, gap 5). Opaque expressions are not under this rule.

## The tree and its forms

Each translatable expression is written into the generated file twice ([roadmap](../roadmap/roadmap.md), M4):

| What | Made when | Used by |
|---|---|---|
| The **tree** itself, as a data literal | Emitted at build time | The data adapter, which compiles it into Drizzle's query builder when a query runs |
| The **SQL** | Compiled by the adapter at query time, in `data-drizzle` | The database |
| The **in-memory form**, emitted TypeScript | Emitted at build time | The program, calling the registered functions' in-memory implementations in `runtime` |

Nothing produces SQL at build time. The reason is that queries are assembled at run time from the action's filter, the caller's filter and, later, policies ([roadmap](../roadmap/roadmap.md), M4). At build time the adapter is checked instead: every function a resource uses must have a SQL form in the configured adapter, or the build fails (same place).

The in-memory form is emitted rather than interpreted, so it is readable in the generated file ([ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)). [ADR-0010](../decisions/0010-one-expression-tree-two-evaluators.md) records this build design as a design choice, separate from the project owner's ruling.

The tree type lives in `runtime`, because it crosses the data-layer contract ([data layer](./data-layer.md)). The registry of functions and operators lives in `model`. `runtime` imports nothing from `model` ([roadmap](../roadmap/roadmap.md), M4 and section 3).

## Where each form is used

- Filters on reads: the tree, compiled to SQL at query time.
- Atomic changes that do not read the stored record (M5): the tree, folded into the `UPDATE` assignments. A validation that reads only the input uses the in-memory form before the statement ([roadmap](../roadmap/roadmap.md), M5).
- Non-atomic updates (opaque, or reading the stored record): the in-memory form on the row read with a write lock. No validation is folded into the statement in v1 ([ADR-0044](../decisions/0044-folding-record-reading-validations.md), Proposed).
- Policies (M8): the tree for reads and for record-reading checks on atomic writes, the in-memory form otherwise.
- Calculations (M7): the tree in queries, the in-memory form on a loaded record.

The fixture's `create` action has a change `post.authorId = actor.id`. A create is not an update, and the roadmap does not say which form it uses: not decided. Parameters such as the actor are bound from the scope and the input when the expression runs ([roadmap](../roadmap/roadmap.md), M4); the mechanism for the SQL form is not decided.

## The function registry

Every operator and function an expression may use is registered once, in `model` ([roadmap](../roadmap/roadmap.md), M4). A function used in a resource needs an in-memory implementation in `runtime` and a SQL form in the configured adapter. Extensions add functions through their manifest, supplying both ([roadmap](../roadmap/roadmap.md), M6; [extension host](./extension-host.md)). A fake adapter with no SQL form for a used function fails the build (M6, test 5). One registry exists because Ash's docs drift from its registries: 39 registered functions, about 30 documented ([research synthesis](../research/synthesis.md), section 8).

## Keeping the evaluators in agreement

Every registered function has one table of inputs and expected outputs, null cases included. The table is run through the in-memory form and through every merged SQL adapter, and all must give the table's answer ([roadmap](../roadmap/roadmap.md), M4, test 1; M9, test 5 adds Postgres). The tables cover single functions, not combinations ([roadmap](../roadmap/roadmap.md), section 9, risk 5).

## Where SQL and JavaScript differ

Nulls and string ordering give different results in SQL and in JavaScript. Which one a Mesh expression follows is open: [ADR-0012](../decisions/0012-expression-semantics.md) is Proposed and blocks M4. The roadmap's only assumption is that both evaluators follow one definition, Mesh's own ([roadmap](../roadmap/roadmap.md), M4).

## What Ash does and where it went wrong

Ash's expression is a two-stage tree: unresolved call nodes, resolved into operator and function structs when a filter is parsed. The same tree runs in memory (`Ash.Filter.Runtime`) or compiles to SQL (`AshSql.Expr`) ([Ash runtime internals](../research/ash-runtime-internals.md), sections 5.1 and 5.4). Two failures matter:

1. **Paths that disagree.** Bug #2969 (fixed the day it was reported, 2026-09-26): a filter added by an action's own change was lost when a single-record update ran atomically, so the row was written although the non-atomic path rejected it (same file, 12.B item 21). Strictly this is a lifecycle bug, not an evaluator bug; the roadmap cites it as the example of two paths drifting ([roadmap](../roadmap/roadmap.md), M4, risks). The shared tables do not guard against this kind of drift; M5's rule that a change is never run twice does, together with the single plan in [action lifecycle](./action-lifecycle.md) ([roadmap](../roadmap/roadmap.md), M4, risks). The tables guard the other risk, the two forms giving different answers.
2. **JavaScript semantics forced onto the database.** AshPostgres installs SQL functions (`ash_elixir_and` and others) so `&&` behaves as in Elixir. A filter written with `&&` ran in about 3,400 ms against about 110 ms with `and`, because the function call defeats the index (same file, 4.2 and 12.B item 17). This bears on [ADR-0012](../decisions/0012-expression-semantics.md) ([roadmap](../roadmap/roadmap.md), M4, risks).

Ash also sometimes filters in memory when a data layer cannot run an expression (same file, 5.4). Mesh has an in-memory evaluator, but it is never a fallback for a missing database capability ([data layer](./data-layer.md)).
