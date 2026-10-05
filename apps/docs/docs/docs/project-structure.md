---
title: "Project structure"
description: "Where entity files, generated code, configuration, extensions and migrations live, and which files you commit."
---

# Project structure

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

Mesh does not own your project. It reads the entity files you write and writes the code you call; everything else is yours. This page is the layout the starter creates, what each part is for, and what belongs in version control.

```text
todo-app/
  .mesh/                  generated; never edited; imported as "#mesh"
  migrations/             SQL from `mesh migrate generate`
  mesh.config.ts          what Mesh reads
  package.json            "imports": { "#mesh": "./.mesh/index.ts" }
  src/
    domain/               your domain
      accounts/
        user.mesh.mx
      todo/
        list.mesh.mx
        todo.mesh.mx
        todo.helpers.ts    hand-written code that todo.mesh.mx calls
    extensions/           project-local extensions, if any
    context.ts             declares the action context type
    main.ts               the program
```

Mesh prescribes nothing under `src/`. `context.ts` and `main.ts` are the starter's names and are only convention; what matters is that the domain folder is where the `.mesh.mx` files are.

## The domain

`src/domain/` is the domain: everything your program stores. Inside it, each folder is a group of entities that belong together. `src/domain/todo/` holds `list.mesh.mx` and `todo.mesh.mx`; `src/domain/accounts/` holds `user.mesh.mx`.

The folder is the module, so nothing in the file repeats it. `todo.mesh.mx` does not carry a `module=` option, and the generated code for a folder lands in one place.

An entity file holds exactly one entity and ends in `.mesh.mx`. Two entities in one file is a build error, as are two entities with the same name anywhere in the domain.

A hand-written helper next to the entity that uses it is the ordinary way to keep an entity file small. `todo.helpers.ts` is a normal TypeScript module; a `check` or a `do` step in `todo.mesh.mx` calls into it.

## Generated code

`.mesh/` is written by `mesh build` and committed. You import it, and you never edit it: the guard in [the command line](./configuration.md#the-guard) fails the build if a file in it differs from what the build would write.

One entry point, in `package.json`:

```json
"imports": { "#mesh": "./.mesh/index.ts" }
```

Your code imports `#mesh`. Never import a path into `.mesh`: the paths are an implementation detail and the entry point is what stays stable.

What is inside, for the tutorial's two entities:

| File | What it is |
|:--|:--|
| `.mesh/index.ts` | `connect`, `disconnect`, `bind`, and every action function and type, re-exported |
| `.mesh/todo/list.types.ts` | `List` and the input types of its actions |
| `.mesh/todo/list.actions.ts` | One function per action, with the whole lifecycle written out |
| `.mesh/todo/list.validators.ts` | The schema each input is checked against |
| `.mesh/todo/todo.types.ts` | `Todo`, `TodoInput`, and the same for each action |
| `.mesh/todo/todo.actions.ts` | `createTodo`, `completeTodo`, `pendingTodo`, and the rest |
| `.mesh/todo/todo.validators.ts` | The input schemas for those actions |
| `.mesh/schema.ts` | The database tables, written by the data adapter |
| `.mesh/model.json` | One document per entity, with the source position of every declaration |
| `.mesh/mx-contracts.js` | The composed tag contracts, for MX tooling in your editor |
| `.mesh/rules.md` | A short description of your entities and of Mesh's vocabulary, for a coding agent to read |

That is the whole of it, plus `.mesh/rules.md`, which exists for agents and which [Working with AI agents](./ai-agents.md) covers. You should not have to think about any of it day to day, and you never have to edit it. Two reasons it is committed rather than hidden:

- **A reviewer reads what runs.** An entity file is a small declarative change. The TypeScript beside it is what the program actually executes, and reading the two diffs together is how you review a change to a rule.
- **`git diff` is the record of behaviour.** Adding an attribute shows up as a new column, a new type field and a new input key in one diff, in the file you changed.

Two entities that would export the same function name is a build error naming both. Mesh never renames an export behind your back.

## Configuration

`mesh.config.ts` at the project root names the data adapter, the folder holding your entity files, the output folder and the enabled extensions. [Configuration and the command line](./configuration.md) has it in full.

## Migrations

`migrations/` holds plain SQL files that `mesh migrate generate` writes and you commit. They are the record of how the database reached its current shape, and they are how another machine or another environment reaches the same shape. Nothing is ever applied automatically; `mesh migrate apply` is explicit.

## Extensions

`src/extensions/` holds a project-local extension, if you write one. An extension has two entries: a build-time half that contributes tags, transforms, verifiers, emitters and `mesh` subcommands, and a run-time half that supplies the behaviour. The run-time half imports only `@meshfw/runtime`, never the compiler, so a deployed program does not carry the build pipeline.

First-party extensions are installed from npm and enabled by name in `mesh.config.ts`. Authorization is not one of them: `policies` is a section of the entity file, so who may do what is core.

## Your own code

Everything else under `src/` is yours, and Mesh never reads it. In the tutorial:

- `src/context.ts` declares the action context's type, so every action's second argument is typed as whatever your application says it is. See [Calling actions](./calling-actions.md#the-action-context).
- `src/main.ts` is the program: connect, call actions, disconnect.

## What to commit

| Path | Commit? |
|:--|:--|
| `src/**/*.mesh.mx` | yes |
| `.mesh/` | yes |
| `migrations/*.sql` | yes |
| `mesh.config.ts`, `package.json`, `bun.lock` | yes |
| `src/**` (your TypeScript) | yes |
| `*.db`, `*.db-journal` | no |
| `node_modules/` | no |
| `.env` | no |

`.mesh/` is marked `linguist-generated` in `.gitattributes`, so GitHub and other viewers collapse it in a diff instead of showing a thousand lines of generated code.

## Next

- [Configuration and the command line](./configuration.md) — `mesh.config.ts` and every command.
- [Testing](./testing.md) — where a test's files go.
- [Customising generated code](./customising-generated-code.md) — a proposal for changing what the generators emit.