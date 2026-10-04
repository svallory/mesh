---
title: "Project structure"
description: "Where resource files, generated code, configuration, extensions and migrations live, and which files are committed."
---

# Project structure

::: callout warning "Live spec, not released"
This page describes how Mesh **will** work, not how it works today. It is a live spec of the developer experience, written before the code. Mesh is not released: nothing here can be installed or run yet, and any detail may change.
:::

Mesh does not own your project. You choose where resource files live and where generated files go; Mesh reads the first and writes the second. This page shows the layout the starter template writes, using the `todo-app` project from [Example: a todo list](./example-todo-list.md).

## The layout

```text
todo-app/
  mesh.config.ts
  package.json            "mx": { "contracts": "generated/mx-contracts.js" }
  resources/              .mx files (one resource per file)
    list.mx
    todo.mx
  generated/              written by `mesh build`, committed, guarded
    model.json
    index.ts              connect(), disconnect(), re-exports every action function and type
    schema.ts             Drizzle table definitions (adapter's build half)
    mx-contracts.js       composed contracts module for MX tooling (M6)
    todos/                one folder per `domain`; no domain: generated/ itself
      list.types.ts  list.actions.ts  list.validators.ts
      todo.types.ts  todo.actions.ts  todo.validators.ts
  migrations/             SQL from `mesh migrate generate`, committed
  extensions/             project-local extensions, if any (build entry + run-time entry)
  src/
    actor.ts              registers the actor type
    main.ts               the program
```

## Resource files

One resource per `.mx` file, under the folder `resources` names in the configuration. A file holds exactly one `resource`; two resources in one file is a build error.

The names a resource file carries, and the expressions inside it, follow Ash's DSL, in kebab-case with the trailing `?` dropped ([ADR-0034](../architecture/decisions/0034-vocabulary-copies-ash-dsl.md)). Every example is written in MX concise syntax, the indentation-based form ([ADR-0041](../architecture/decisions/0041-mx-concise-syntax.md)). The full list of tags is in the [Resource file reference](./resource-file-reference.md).

::: callout info "Not decided yet"
In Ash a `belongs_to` creates its foreign-key attribute as `<name>_id` (`list_id`). The roadmap uses `listId`, following the fixture. Which name Mesh generates is settled when relationships are built. [The vocabulary mapping](../architecture/roadmap/vocabulary-mapping.md), row D12, records both.
:::

::: callout info "Not decided yet"
`table` sits on the `resource` tag in Mesh. In Ash it lives in the data layer's own section, because a data layer is an extension there. Mesh's recommendation is to keep it on `resource`, since both v1 SQL adapters use the same table name. [The vocabulary mapping](../architecture/roadmap/vocabulary-mapping.md), exception X1, holds the options.
:::

## The generated tree

`mesh build` writes `generated/` and you commit it. The reason is review: a resource file is a small declarative change, and the committed TypeScript beside it is what the program actually runs. A reviewer reads the diff of both together.

| Path | Written by | Milestone |
|---|---|---|
| `generated/model.json` | the compiler | M1 |
| `generated/todos/todo.types.ts` | the compiler | M1 |
| `generated/todos/todo.actions.ts` | the compiler | M2 |
| `generated/todos/todo.validators.ts` | the compiler | M2 |
| `generated/schema.ts` | the data adapter | M2 |
| `generated/mx-contracts.js` | the compiler, composed from core plus enabled extensions | M6 |

`generated/index.ts` is the only module your program imports. It exports `connect` and `disconnect`, and re-exports every action function and every type, so a resource added later appears in the same import statement.

The subfolder `todos/` is named after the `domain` attribute on the resource. A resource with no `domain` has its files directly in `generated/`. Grouping by domain keeps one feature's generated code in one folder.

**Column names equal attribute names.** Mesh does not transform names from camelCase to snake_case, so an attribute `dueOn` becomes a column `dueOn`. Drizzle quotes identifiers, so this works on both databases without a naming convention.

::: callout info "Not decided yet"
Whether Mesh should transform attribute names to a column convention is not settled. The mapping records that a name an author chooses is a value and stays as written, following the fixture; a snake_case option would be a separate decision. [The vocabulary mapping](../architecture/roadmap/vocabulary-mapping.md), row D33.
:::

**The guard.** `mesh build --check` regenerates the tree in memory, writes nothing, and fails if the result differs from what is committed. It catches hand edits and stale trees. See [Generated code and the guard](../architecture/in-depth/generated-code-and-guard.md).

::: callout info "Not decided yet"
Whether the committed SQL in `migrations/` is covered by the guard is not stated. Until it is, a hand-edited migration and a stale `generated/schema.ts` can disagree.
:::

## Configuration

One file, `mesh.config.ts`, at the project root. It names the resource folder, the output folder, the data adapter and the enabled extensions. See [Configuration](./configuration.md).

`package.json` carries one extra key, `"mx": { "contracts": "generated/mx-contracts.js" }`. That points MX tooling at the composed contracts module, which `mesh build` writes: one self-contained module holding the tag contracts of core plus every enabled extension ([ADR-0021](../architecture/decisions/0021-composed-contracts-module.md)). It arrives in M6; before that the contracts are composed in memory for the build only.

## Migrations

`migrations/` holds plain SQL files that `mesh migrate generate` writes and you commit. They are the record of how the database got to its current shape, and they are how another machine or another environment reaches it. Nothing is applied automatically; `mesh migrate apply` is explicit.

For a file-backed SQLite database in development, `mesh db push` is quicker. It is the same schema without a history, and it is a development tool.

## Extensions

`extensions/` holds project-local extensions. An extension has two entries: a build-time one, which contributes tags, transforms, verifiers, emitters and `mesh` subcommands through a manifest, and a run-time one, which supplies behaviour. The run-time entry follows the same import rule as `@mesh/runtime`: no compiler, no model, no MX, so a deployed program never carries the build pipeline.

First-party extensions are installed from npm instead, and are enabled by listing them in `mesh.config.ts`. `@mesh/ext-policies` is the one that exists in v1. See [Extension host](../architecture/in-depth/extension-host.md).

## Your own code

`src/` is yours. Mesh never reads it. In the example:

- `src/actor.ts` registers the actor type by module augmentation, so `scope.actor` is typed as whatever your application says a caller is.
- `src/main.ts` is the program: connect, call actions, disconnect.

Nothing in `src/` must be named a particular way, and nothing in it is generated.

## What to commit

| Path | Commit? |
|---|---|
| `resources/*.mx` | yes, always |
| `generated/` | yes, always |
| `migrations/*.sql` | yes, always |
| `mesh.config.ts`, `package.json`, `bun.lock` | yes |
| `extensions/` | yes |
| `src/` | yes, it is your code |
| `node_modules/` | no |
| `*.db`, `*.db-journal` (SQLite database files) | no |
| `.env` | no |

## Next

- [Example: a todo list](./example-todo-list.md) — the resources behind this layout.
- [Configuration](./configuration.md).
- [Usage](./usage.md) — the loop, including what the guard checks.