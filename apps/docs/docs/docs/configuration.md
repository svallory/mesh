---
title: "Configuration"
description: "Project configuration, the action context, data adapters, extensions and environment variables."
---

# Configuration

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

`mesh.config.ts` configures the project; `src/context.ts` declares what each action call carries. The [tutorial](./tutorial.md) starts from the starter's configuration and builds a program around it. For commands, flags and exit codes, see [Command line](./command-line.md).

## Dependencies

The [Quick start](./quick-start.md#install) covers CLI installation and the starter. When adding Mesh to an existing project, install the runtime and your chosen adapter alongside `meshfw`:

```bash
bun add @meshfw/runtime @meshfw/data-sqlite zod drizzle-orm @opentelemetry/api
bun add -d drizzle-kit
```

| Package | What it is |
|:--|:--|
| `meshfw` (dev) | The `mesh` command and `defineConfig` |
| `@meshfw/runtime` | What generated code imports: the action context's type, the error classes, the data-layer contract |
| `@meshfw/data-sqlite` or `@meshfw/data-postgres` | Exactly one data adapter |
| `zod`, `drizzle-orm`, `@opentelemetry/api` | Imported by generated code itself, so they are ordinary dependencies of your project, not hidden behind `@meshfw/runtime` |
| `drizzle-kit` (dev) | The schema and migration work behind `mesh db push` and `mesh migrate` |

For Postgres, swap `@meshfw/data-sqlite` for `@meshfw/data-postgres` in the first command.

## mesh.config.ts

One file at the project root, written in TypeScript, so your editor checks it and it can read the environment.

```ts "mesh.config.ts"
import { defineConfig } from "meshfw";
import { sqlite } from "@meshfw/data-sqlite";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: sqlite({ file: "todo.db" }),
});
```

[`mesh init`](./command-line.md#init) writes this file and asks the same questions the starter asked.

| Key | Required | What it is |
|:--|:--|:--|
| `domain` | yes | The folder holding the `.mesh.mx` files, read recursively, relative to the project root |
| `output` | yes | The folder generated code is written to, relative to the project root |
| `data` | yes | The data adapter for this project. Exactly one |
| `extensions` | no | The enabled extensions, each one a call that returns an extension |

`domain` may also be a glob or a list of relative paths, when a project has entity files outside the main folder. A folder is read recursively and every `.mesh.mx` file beneath it is an entity file.

`connect()` reads this file, which is why the build, the commands and your application can never disagree about where the data is. There is nowhere else to configure a connection.

## src/context.ts

Declare the shape of an action's second argument once, by adding to `ActionContext`. This is a type declaration, not a global caller: each call still passes its own context.

```ts "src/context.ts"
import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string };
  }
}

export const alice = { id: "00000000-0000-4000-8000-000000000001" };
```

The starter exports Alice for its demo. Your program supplies its own caller; [Using your domain](./using-your-domain.md#the-action-context) explains optional keys, tenants and the `actor` key Mesh reads.

## Choosing the database

Mesh does not read anything about your database from an entity file; the project configuration names the adapter. Two are shipped.

**SQLite** is what the quick start and the tutorial use. It needs no server, and the file is yours. Only the adapter import and the `data` line change when you switch databases:

```ts "mesh.config.ts (excerpt)"
data: sqlite({ file: "todo.db" }),
```

**Postgres** reads a URL. There is no default: if the variable is unset, `connect()` throws rather than guessing.

```ts "mesh.config.ts"
import { defineConfig } from "meshfw";
import { postgres } from "@meshfw/data-postgres";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: postgres({ url: process.env.DATABASE_URL }),
});
```

Nothing in Mesh creates a Postgres server or a database for you. Create the database, then use [migrations](./command-line.md#migrations) to bring the schema to it.

SQLite in its in-memory mode is what tests use. See [Testing](./testing.md).

If your entity file uses something your adapter cannot do, the build fails and names the declaration. It never falls back to doing it in memory.

## Enabling extensions

An extension adds to Mesh through declared points: the tags an entity file may use, transforms and verifiers, emitted files, expression functions, field types, `mesh` subcommands and named run-time behaviour. Extensions are listed here explicitly, each one a call that returns an extension:

```ts "mesh.config.ts (excerpt)"
extensions: [audit()],
```

Nothing is discovered by scanning `node_modules`, so nothing changes under you. A project-local extension goes in `src/extensions/` and is listed the same way. Authorization is not an extension: `policies` is a section of the entity file, and an entity with no `policies` section forbids every action it has.

## Environment

Read environment variables explicitly in `mesh.config.ts`, as the Postgres example does with `process.env.DATABASE_URL`. For a local Postgres database:

```bash
export DATABASE_URL="postgres://localhost:5432/todo_app"
createdb todo_app
```

Mesh has no `.env` loader of its own and does not read `tsconfig.json` paths to configure the project. Supply the same configuration and environment to the build and to your application; keep credentials out of version control.

## Next

- [Command line](./command-line.md) — every command, the build guard and migrations.
- [Using your domain](./using-your-domain.md) — connecting and passing a context.
- [Testing](./testing.md) — binding a database in memory instead of connecting.
