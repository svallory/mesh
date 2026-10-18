---
title: "Configuration"
description: "Project configuration, the action context, data adapters, extensions and environment variables."
---

# Configuration

::: callout warning "Not released"
Mesh is not released yet. These pages describe what Mesh will be.
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
| `meshfw` | The `mesh` command, and `Mesh`, which application code imports at run time |
| `@meshfw/runtime` | `defineConfig`, and what generated code imports: the action context's type, the error classes, the data-layer contract. `connect()` loads `mesh.config.ts` in the running program, so the config imports only run-time packages |
| `@meshfw/data-sqlite` or `@meshfw/data-postgres` | Exactly one data adapter |
| `zod`, `drizzle-orm`, `@opentelemetry/api` | Imported by generated code itself, so they are ordinary dependencies of your project, not hidden behind `@meshfw/runtime` |
| `drizzle-kit` (dev) | The schema and migration work behind `mesh db push` and `mesh migrate` |

For Postgres, swap `@meshfw/data-sqlite` for `@meshfw/data-postgres` in the first command.

## mesh.config.ts

One file at the project root, written in TypeScript, so your editor checks it and it can read the environment.

```ts "mesh.config.ts"
import { defineConfig } from "@meshfw/runtime";
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
| `ignore` | no | Globs, relative to the project root, of `.mesh.mx` files Mesh skips; see [Ignoring files](#ignoring-files) |
| `data` | yes | The data adapter for this project. Exactly one |
| `extensions` | no | The enabled extensions, each one a call that returns an extension |
| `seams` | no | Code your application runs before a transaction, after each write and after a commit; see [Seams](#seams) |
| `events` | no | How the outbox keeps a row (`keep`) and where the events module is (`load`); see [Events](#events) |

`domain` may also be a glob or a list of relative paths, when a project has entity files outside the main folder. A folder is read recursively and every `.mesh.mx` file beneath it is an entity file.

### Ignoring files

`ignore` takes one glob or a list of globs, relative to the project root. A `.mesh.mx` file that matches is not part of the project: it is not read, not built, and an error inside it is not reported.

```ts "mesh.config.ts (excerpt)"
export default defineConfig({
  domain: "src/domain",
  ignore: ["src/domain/**/drafts/**", "src/domain/legacy.mesh.mx"],
  // ...
});
```

Patterns match files, so write `src/legacy/**` rather than `src/legacy`. A pattern that matches no entity file produces a warning naming it, `MESH_IGNORE_UNUSED`, since it is usually a typo. `ignore` applies to a `domain` folder, glob or list alike. A glob that reaches outside the project, or one that excludes every entity file, is a configuration error. A file that a kept file imports must not be ignored: importing an ignored file is the error `MESH_IGNORED_IMPORT`. To organise files without excluding them, use a `_name/` folder; see [Project structure](./project-structure.md#the-domain).

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

Two keys are reserved: `actor`, which policies read, and `system`, an optional boolean the application sets on a call it makes on its own behalf (see [internal writes](./using-your-domain.md#internal-writes)). They are the only keys Mesh reads. An extension states which keys it reads, and a key clash, between two extensions or with a key Mesh reads (`actor`, `system`), is a build error. The starter exports Alice for its demo. Your program supplies its own caller; [Using your domain](./using-your-domain.md#the-action-context) explains optional keys, tenants and the `actor` key Mesh reads.

## Choosing the database

Mesh does not read anything about your database from an entity file; the project configuration names the adapter. Two are shipped.

**SQLite** is what the quick start and the tutorial use. It needs no server, and the file is yours. Only the adapter import and the `data` line change when you switch databases:

```ts "mesh.config.ts (excerpt)"
data: sqlite({ file: "todo.db" }),
```

**Postgres** reads a URL. There is no default: if the variable is unset, `connect()` throws rather than guessing.

```ts "mesh.config.ts"
import { defineConfig } from "@meshfw/runtime";
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

## Seams

A seam is a place in every generated action where your application may run code: `beforeTransaction` (before the transaction opens, for the call that opens it; throw to refuse the call), `afterWrite` (inside the transaction, right after each row is written; a throw rolls back the whole call) and `afterCommit` (once, after the outermost transaction commits; not called on rollback; a throw there does not fail the call, which has committed, and is reported with `console.error`). List them under `seams`; `connect()` reads them from this file, so the build, your application and your tests configure them in one place. In a test, pass the same object to `bind(dataLayer, { seams })`.

`seams` is an object, here and in `bind`. A seam that needs generated code (`#mesh`, `#mesh/domain/...`) imports it inside its body (`const { Invoice } = await import("#mesh/domain/billing")`); a type-only import (`import type`) may stay at the top. The build lists the modules loaded while it imports this file and refuses any module under the output folder with `MESH_CONFIG_LOAD`, whose message says the config imports `#mesh` directly or through a file it imports, and whose fix is the import inside the function; the same message applies when a `#mesh` specifier fails to resolve. The check sees only what runs while the config loads. Why: `.mesh/` is built from the config, so a config that loads `#mesh` at its top level fails to resolve it on a fresh checkout or silently loads a stale tree.

```ts "mesh.config.ts (excerpt)"
seams: {
  afterCommit({ changes }) {
    for (const change of changes) console.log("committed", change.entity, change.action);
  },
},
```

[Using your domain](./using-your-domain.md#seams) lists what each seam receives.

## Events

A project that declares an event configures it under `events`. `bus` is required in such a project; the other fields are optional:

```ts "mesh.config.ts (excerpt)"
import { localBus } from "@meshfw/bus-local";

events: {
  bus: localBus(),
  load: () => import("./src/events.ts"),
  keep: "all",
  requires: ["replay"],
},
```

| Field | What it is |
|:--|:--|
| `bus` | The event bus that delivers events to handlers and subscriptions, such as `localBus()`. There is no default: a project that declares an event and sets no bus fails the build |
| `load` | A function that imports the events module, which exports the handlers, the `metadata` function and the handlers' `context`. `connect()` calls it; the build never does, so the module may import `#mesh` at its top |
| `keep` | How long the outbox keeps a row: `"until-delivered"`, the default, deletes a row once every reader has passed it; `"all"` keeps every row, for an application that reads its history. Only the deliverer deletes, by its own `keep`, from its next claim, so a deploy that drops `"all"` deletes the delivered history at its first deletion pass |
| `requires` | The capabilities the application needs, from the bus's list (`ordered-delivery`, `replay`, `subscribe`, `dead-letters`, `multi-process`) and the data adapter's. One the configured adapters lack fails the build with `MESH_CAPABILITY`, naming the adapter that lacks it |

The build checks the section: a project that declares an event with no `bus`, a `bus` that is not an event-bus descriptor (a manifest naming the adapter and its capabilities from the closed list, and a `create` function), a `requires` entry that is no capability, any other field, a `keep` that is neither value, or a `load` that is not a function fails it with `MESH_EVENTS_CONFIG`. The build reads the bus's manifest and never starts it. [Events](./events.md) explains the outbox, the bus, handlers and the events module.

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
- [Events](./events.md) — declaring events, `publish` and the outbox.
- [Testing](./testing.md) — binding a database in memory instead of connecting.
