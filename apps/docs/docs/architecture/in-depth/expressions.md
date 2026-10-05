---
title: "Expressions: one tree, two evaluators"
description: "How a function whose body is one expression becomes one tree that runs in memory and in SQL, and what plain code is."
---

# Expressions: one tree, two evaluators

Status: design; built in milestone M4 ([roadmap](../roadmap/roadmap.md), M4). Used by M5 (atomic updates), M7 (computed fields, relationship traversal) and M8 (policies). Nothing on this page exists as code yet. The semantics where SQL and JavaScript differ are open: [ADR-0012](../decisions/0012-expression-semantics.md) is Proposed and must be ruled before M4. Before designing the translator, M4 reads Greffon, the one project with the same design, and reports what to copy ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)).

Related: [overview](../overview/architecture.md), [how Mesh uses MX](./mx-integration.md), [build pipeline](./build-pipeline.md), [action lifecycle](./action-lifecycle.md), [data layer](./data-layer.md), [extension host](./extension-host.md).

## What an expression is

An entity file holds small functions. From the reference file of [ADR-0050](../decisions/0050-entity-file-syntax.md):

```mx
read #overdue
  filter=({ self }) => self.isOverdue
  sort=["dueOn"]
```

```mx
do
  set
    #paidAt=({ input }) => input.paidAt
  when=({ self }) => self.amount > 10000
    set
      #needsReview=true
```

```mx
computed
  boolean #isOverdue({ self }) {
    return self.status === "sent" && self.dueOn < today()
  }
  string #label({ self }) {
    const amount = formatMoney(self.total)
    return self.number + " · " + amount
  }
```

Every function receives one object with four keys: `self` (the record), `input` (the action's accepted fields and arguments), `actor` (the caller, a shortcut for `context.actor`) and `context` (the [action context](../decisions/0059-action-context.md)). MX does not run these functions. It hands each over as a parsed Babel node (the syntax tree of the Babel parser) with a source span (MX project notes, getting-started, section 1). Conversion to Mesh's tree happens in `@meshfw/compiler` ([ADR-0043](../decisions/0043-mx-is-core.md)).

One rule can be needed in two places. A filter must run in the database so that not every row is loaded. A check on a record already in memory must run in the program. So Mesh turns a function into **one tree** with two evaluators, as Ash does ([ADR-0010](../decisions/0010-one-expression-tree-two-evaluators.md); [research synthesis](../research/synthesis.md), section 2.2).

## Translated or plain code: the author's form decides

[ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md):

- A function whose **body is one expression** is **translated**: an arrow, `({ self }) => self.status === "sent"`, or a method body that is a single `return`, as in `#isOverdue` above. It becomes a tree; it runs in SQL where a query needs it and in memory otherwise. A construct the translator does not support is an error at that node, reported in the editor through the contracts' `analyze` hook and again by the build. It is never silently turned into plain code.
- **Anything else is plain code**: a method body with more than one statement, as in `#label` above, or a `run` step. It is emitted as TypeScript by slicing the authored text at MX's span and runs in memory only. `#label` is written with two statements on purpose: as a single `return` it would be translated, and a helper call that reads `self` cannot be translated.
- Using a plain-code computed field in a filter, a sort, a policy or another translated expression is a build error that **names the field** ([rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), "Rulings after the review of the user docs").

The parameter types expose only what translates, so the editor offers `self.status` but not, for example, string methods the translator lacks.

Where the form matters:

| Position | Rule |
|---|---|
| `filter` on a read | Must be translated; plain code, or a plain-code computed field, is a build error. |
| `check`'s `that`, `when` | Either form. Plain code, or a translated one reading `self`, makes an update read-then-write ([ADR-0054](../decisions/0054-write-strategy-is-inferred.md)). |
| `set` value | Either form. Only a translated value reading nothing stored except its own column can fold into an atomic `UPDATE`. |
| Computed field with a body (M7) | A body that is one expression (a single `return`) is translated: usable in filters, sorts and policies, also computed in memory on a loaded record. Any other body runs after load; using it in a filter, a sort, a policy or another translated expression is a build error naming the field. |
| Rollup `of="lines.amount"` (M7) | A path string checked at build time against generated path types; always SQL. The function form, where a path cannot express it, must be translated. |
| Policy check (M8) | On a read, must be translated, because it becomes a query filter. Checks inside a policy combine without order ([ADR-0055](../decisions/0055-policies-are-core.md)). On a write, a record-reading check is folded into an atomic statement as a filter, or evaluated on the locked row of a read-then-write action. |

An earlier design classified each function by its content: *translatable* if every construct converted, *opaque* otherwise. It is superseded: the class was invisible to the author, and a small edit could move a rule from SQL to memory ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)).

## No free variables; parameters are bound

A translated expression may use only its parameters and registered functions. A free variable (a name captured from the enclosing file) is a build error ([roadmap](../roadmap/roadmap.md), M4). A database cannot see a captured value.

A part of a translated expression that does not read `self` (for example `isStaff(actor)`, a call to an imported helper, or `today()`) is evaluated once in memory before the query and enters the SQL as a bound parameter ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)). This is how imported helpers appear in policy checks, and why an imported function must be pure. The research on expression languages recommends the same rule ("parameters, never closures") and the same treatment of the current date ([expression language](../research/expression-language.md), section 6).

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
3. Relationship traversal (`self.customer.userId`) rewritten into joins as a normalisation pass before SQL generation.
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
