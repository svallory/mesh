---
title: "Configuration and the command line"
description: "What mesh.config.ts holds, which database to use, and every mesh command."
---

# Configuration and the command line

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

Mesh's configuration is one file, and its whole developer interface is one command, `mesh`. This page has both: the file every command reads, and the commands themselves.

## What is installed

The starter installs everything below. Adding Mesh to a project you already have means these commands:

```bash
bun add -d @meshfw/cli
bun add @meshfw/runtime @meshfw/data-sqlite zod drizzle-orm @opentelemetry/api
bun add -d drizzle-kit
```

| Package | What it is |
|:--|:--|
| `@meshfw/cli` | The `mesh` command: `init`, `build`, `build --check`, `inspect`, `explain`, plus what the adapter and extensions add |
| `@meshfw/runtime` | What generated code imports: the action context's type, the error classes, the data-layer contract |
| `@meshfw/data-sqlite` or `@meshfw/data-postgres` | Exactly one data adapter |
| `zod`, `drizzle-orm`, `@opentelemetry/api` | Imported by generated code itself, so they are ordinary dependencies of your project, not hidden behind `@meshfw/runtime` |
| `drizzle-kit` (dev) | The schema and migration work behind `mesh db push` and `mesh migrate` |

For Postgres, swap `@meshfw/data-sqlite` for `@meshfw/data-postgres` in the second command.

## mesh.config.ts

One file at the project root, written in TypeScript, so your editor checks it and it can read the environment.

```ts "mesh.config.ts"
import { defineConfig } from "@meshfw/cli";
import { sqlite } from "@meshfw/data-sqlite";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: sqlite({ file: "todo.db" }),
});
```

`bunx mesh init` writes this file and asks the same questions the starter asked.

| Key | Required | What it is |
|:--|:--|:--|
| `domain` | yes | The folder holding the `.mesh.mx` files, read recursively, relative to the project root |
| `output` | yes | The folder generated code is written to, relative to the project root |
| `data` | yes | The data adapter for this project. Exactly one |
| `extensions` | no | The enabled extensions, each one a call that returns an extension |

`domain` may also be a glob or a list of relative paths, when a project has entity files outside the main folder. A folder is read recursively and every `.mesh.mx` file beneath it is an entity file.

`connect()` reads this file, which is why the build, the commands and your application can never disagree about where the data is. There is nowhere else to configure a connection.

## Choosing the database

Mesh does not read anything about your database from an entity file; the project configuration names the adapter. Two are shipped.

**SQLite** is what the quick start and the tutorial use. It needs no server, and the file is yours. Only the `data` line changes, from `postgres` to `sqlite` or back:

```ts "mesh.config.ts (excerpt)"
data: sqlite({ file: "todo.db" }),
```

**Postgres** reads a URL. There is no default: if the variable is unset, `connect()` throws rather than guessing.

Only the import and the `data` line change:

```ts "mesh.config.ts"
import { defineConfig } from "@meshfw/cli";
import { postgres } from "@meshfw/data-postgres";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: postgres({ url: process.env.DATABASE_URL }),
});
```

Set `DATABASE_URL` in that project's environment, create the database, and bring the schema to it:

```bash
export DATABASE_URL="postgres://localhost:5432/todo_app"
createdb todo_app
bunx mesh migrate generate
bunx mesh migrate apply
```

Nothing in Mesh creates a Postgres server or a database for you; `migrate apply` runs against the one you named.

SQLite in its in-memory mode is what tests use. See [Testing](./testing.md).

If your entity file uses something your adapter cannot do, the build fails and names the declaration. It never falls back to doing it in memory.

## Enabling extensions

An extension adds to Mesh through declared points: the tags an entity file may use, transforms and verifiers, emitted files, expression functions, field types, `mesh` subcommands and named run-time behaviour. Extensions are listed here explicitly, each one a call that returns an extension:

```ts "mesh.config.ts (excerpt)"
extensions: [audit()],
```

Nothing is discovered by scanning `node_modules`, so nothing changes under you. A project-local extension goes in `src/extensions/` and is listed the same way. Authorization is not an extension: `policies` is a section of the entity file, and an entity with no `policies` section forbids every action it has.

Mesh reads nothing else: no `tsconfig.json` paths, no `.env` of its own. That is what makes `mesh build` give the same result in your editor, in a container and on a colleague's machine.

## The commands

Run these from the project root, after [installation](./quick-start.md):

```bash
bunx mesh <command> [options]
```

`mesh` builds your project. It does not run your application's actions.

| Command | What it does |
|:--|:--|
| `mesh init` | Writes `mesh.config.ts` and the folders, asking where your entity files are and where generated code goes |
| `mesh build` | Reads the entity files and writes `.mesh/` |
| `mesh build --check` | The guard: rebuilds in memory, writes nothing, fails on any difference with what is committed |
| `mesh inspect [entity]` | Prints the model as JSON, with the source position of every declaration |
| `mesh explain <entity> <action>` | Prints the plan that action's handler follows |
| `mesh db push` | Pushes the schema straight to the database. Development only |
| `mesh migrate generate [--allow <change>]` | Writes a SQL migration into `migrations/` |
| `mesh migrate apply` | Applies the migrations that have not been applied |

The last three come from the data adapter, which is why `@meshfw/cli` never imports a query library. `mesh --help` lists the commands your enabled extensions add.

Exit codes: `0` success, `1` errors were found, `2` usage error.

## What a build error looks like

Every diagnostic names the file, the line and the column, both 1-based, and says what to do:

```text
src/domain/todo/todo.mesh.mx:22:9 error &titel is not a member of :Todo. Did you mean &title?
```

The same shape is used for an unknown declaration, one the build does not implement, a duplicate input name, a free variable in an expression and a capability the adapter does not declare. Nothing is silently dropped.

## The guard

```bash
bunx mesh build --check
```

It runs the whole build, regenerates in memory, writes nothing, and fails if the result differs from what is committed. It catches two mistakes: a hand edit to a file in `.mesh/`, and an entity file you changed without rebuilding.

It is exact because the build is deterministic. The same entity files produce the same bytes, so a difference means something really changed.

Put it in the same script as your tests:

```json
"scripts": { "test": "bunx mesh build --check && bun test" }
```

## inspect

```bash
bunx mesh inspect Todo
```

Prints the model as JSON: every attribute with its type and constraints, every action with what it accepts, every relationship, computed field and policy, each with the source position of the declaration it came from. It is the first thing to look at when a build error mentions a rule you did not expect, and it is what to paste into a [bug report](https://github.com/svallory/mesh/issues).

## explain

```bash
bunx mesh explain Todo complete
```

Prints the plan the generated handler follows. The plan is chosen at build time; the handler then performs it without deciding anything at run time.

```text
Todo.complete (update)
  strategy     read-then-write: check notDoneYet reads &done
  steps        &done = true
  policy       &list.ownerId === actor.id   folded into the statement as a filter
  checks       notDoneYet
```

Two lines are worth learning:

- **`strategy`** is one statement (`atomic`) or `read-then-write`, and `explain` says why: a `check` or `when` that reads `self`, a `run` step, or an expression Mesh cannot translate. `Todo.complete` is the first because `check :notDoneYet` reads `&done`; `Todo.rename` is one statement because it has no check.
- **`folded into the statement`** means the rule costs no extra query. A rule that cannot fold runs in memory on the row read inside the transaction instead.

`explain` prints a plan, not SQL. Queries are assembled at run time from the entity's filter, the caller's filter and the policies, because which of those apply is only known when the call arrives.

## Migrations

During development, pushing the schema is quicker:

```bash
bunx mesh db push
```

It creates the tables and columns and records no history. It is a development tool: never run it against a database whose contents you care about.

For anything you keep, generate a migration:

```bash
bunx mesh migrate generate
bunx mesh migrate apply
```

`mesh migrate generate` compares the committed schema with the model, and refuses a destructive or ambiguous change unless you name it: dropping a column, changing its type, renaming it, making an optional column required.

```bash
bunx mesh migrate generate --allow drop:Todo.title
```

The name after the colon is the entity and the column, without the colon the entity file writes them with.

The migration is a plain SQL file in `migrations/`, and you commit it. Generating never applies anything; applying is a separate, explicit command. So a new machine, and your production environment, reach the same shape with `mesh migrate apply`.

## Next

- [Testing](./testing.md) — binding a database in memory instead of connecting.
- [Project structure](./project-structure.md) — what each command reads and writes.
- [Working with AI agents](./ai-agents.md) — `inspect` and `explain` are the tools an agent uses.