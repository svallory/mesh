---
title: "Configuration and the command line"
description: "What mesh.config.ts holds, which database to use, and every mesh command."
---

# Configuration and the command line

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

Mesh's configuration is one file, and its whole developer interface is one command, `mesh`. This page has both: the file every command reads, and the commands themselves.

## mesh.config.ts

One file at the project root, written in TypeScript, so your editor checks it and it can read the environment.

```ts "mesh.config.ts"
import { defineConfig } from "@mesh/cli";
import { sqlite } from "@mesh/data-sqlite";
import { policies } from "@mesh/ext-policies";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: sqlite({ file: "todo.db" }),
  extensions: [policies()],
});
```

`bunx mesh init` writes this file and asks the same questions.

| Key | Required | What it is |
|:--|:--|:--|
| `domain` | yes | The folder holding the `.mx` files, read recursively, relative to the project root |
| `output` | yes | The folder generated code is written to, relative to the project root |
| `data` | yes | The data adapter for this project. Exactly one |
| `extensions` | no | The enabled extensions, each one a call that returns an extension |

`domain` may also be a glob or a list of relative paths, when a project has entity files outside the main folder. A folder is read recursively and every `.mx` file beneath it is an entity file.

`connect()` reads this file, which is why the build, the commands and your application can never disagree about where the data is. There is nowhere else to configure a connection.

## Choosing the database

Mesh does not read anything about your database from an entity file; the project configuration names the adapter. Two are shipped.

**SQLite** is what the quick start and the tutorial use. It needs no server, and the file is yours:

```ts "mesh.config.ts"
import { defineConfig } from "@mesh/cli";
import { sqlite } from "@mesh/data-sqlite";
import { policies } from "@mesh/ext-policies";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: sqlite({ file: "todo.db" }),
  extensions: [policies()],
});
```

**Postgres** reads a URL. There is no default: if the variable is unset, `connect()` throws rather than guessing.

```ts "mesh.config.ts"
import { defineConfig } from "@mesh/cli";
import { postgres } from "@mesh/data-postgres";
import { policies } from "@mesh/ext-policies";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: postgres({ url: process.env.DATABASE_URL }),
  extensions: [policies()],
});
```

Nothing in Mesh creates a Postgres server for you.

SQLite in its in-memory mode is what tests use. See [Testing](./testing.md).

If your entity file uses something your adapter cannot do, the build fails and names the tag. It never falls back to doing it in memory.

## Enabling extensions

An extension adds to Mesh through declared points: the tags an entity file may use, transforms and verifiers, emitted files, expression functions, field types, `mesh` subcommands and named run-time behaviour. Extensions are listed here explicitly. Nothing is discovered by scanning `node_modules`, so nothing changes under you.

`@mesh/ext-policies` is the first-party extension that adds authorization. With it enabled, an action with no matching policy is forbidden. Without it, a `policies` block is not a valid tag and the build fails.

A project-local extension goes in `src/extensions/` and is listed the same way.

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
| `mesh inspect [entity]` | Prints the model as JSON, with the source position of every tag |
| `mesh explain <entity> <action>` | Prints the plan that action's handler follows |
| `mesh db push` | Pushes the schema straight to the database. Development only |
| `mesh migrate generate [--allow <change>]` | Writes a SQL migration into `migrations/` |
| `mesh migrate apply` | Applies the migrations that have not been applied |

The last three come from the data adapter, which is why `@mesh/cli` never imports a query library. `mesh --help` lists the commands your enabled extensions add.

Exit codes: `0` success, `1` errors were found, `2` usage error.

## What a build error looks like

Every diagnostic names the file, the line and the column, both 1-based, and says what to do:

```text
src/domain/todo/todo.mx:11:21 error `accept` names "titel", which is not an attribute of todo. Did you mean "title"?
```

The same shape is used for an unknown tag, an accepted tag the build does not implement, a duplicate entity name, a free variable in an expression and a capability the adapter does not declare. Nothing is silently dropped.

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
bunx mesh inspect todo
```

Prints the model as JSON: every field with its type and constraints, every action with what it accepts, every relationship, calculation, aggregate and policy, each with the source position of the tag it came from. It is the first thing to look at when a build error mentions a rule you did not expect, and it is what to paste into a bug report.

## explain

```bash
bunx mesh explain todo complete
```

Prints the plan the generated handler follows. The plan is chosen at build time; the handler then performs it without deciding anything at run time.

```text
todo.complete (update)
  strategy     atomic: one UPDATE, no read first
  changes      done = true                 folded into the statement
  policy       list.ownerId = actor.id     folded into the statement as a filter
  validations  none
```

Two lines are worth learning:

- **`strategy`** is `atomic` (one statement, no read first) or read-then-write. An update whose change or validation reads the stored record must declare `require-atomic=false`, or the build fails.
- **`folded into the statement`** means the rule costs no extra query. A rule that cannot fold runs in memory on the locked row instead.

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
bunx mesh migrate generate --allow drop:todo.dueOn
```

The migration is a plain SQL file in `migrations/`, and you commit it. Generating never applies anything; applying is a separate, explicit command. So a new machine, and your production environment, reach the same shape with `mesh migrate apply`.

## Next

- [Testing](./testing.md) — binding a database in memory instead of connecting.
- [Project structure](./project-structure.md) — what each command reads and writes.
- [Working with AI agents](./ai-agents.md) — `inspect` and `explain` are the tools an agent uses.