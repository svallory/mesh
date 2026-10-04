---
title: "Installation"
description: "How to add Mesh to a new project or to one you already have, and what gets installed."
---

# Installation

::: callout warning "Live spec, not released"
This page describes how Mesh **will** work, not how it works today. It is a live spec of the developer experience, written before the code. Mesh is not released: nothing here can be installed or run yet, and any detail may change.
:::

This page shows the two ways to start: a new project, and a project you already have.

## Prerequisites

Mesh runs on [Bun](https://bun.sh) only. Node is dropped from the roadmap: see [ADR-0025](../architecture/decisions/0026-node-parity.md), which records the ruling and the Node record it supersedes.

- **Bun.** The minimum version is fixed at the first release. Nothing else: no build step, no global install, no separate runtime.
- **Postgres**, only if you use the Postgres adapter. The example on these pages uses SQLite, which needs no server. See [Configuration](./configuration.md).

`bun`, `bunx`, `bun run` and `bun create` below are Bun's own commands. Use Bun for every package command in this project; npm and yarn are not supported.

## A new project

```bash
bun create mesh todo-app
```

That asks the starter a few questions (database, whether to enable policies) and writes a project that already builds. The scaffold contains a `mesh.config.ts`, one resource file, one script that calls a generated action, and the dependencies listed below.

Then:

```bash
cd todo-app
bun run src/main.ts
```

## An existing project

Mesh does not own your project layout; it reads `resources/` and writes `generated/` inside it. Add the dependencies, then run `mesh init` to write the configuration file and the folder.

**Build-time packages (development dependencies).** `@mesh/cli` is the `mesh` command; it brings the compiler, the resource model and MX, the parser that reads `.mx` files. `drizzle-kit` is what the data adapter's schema commands call.

```bash
bun add -d @mesh/cli drizzle-kit
```

**Run-time packages.** `@mesh/runtime` is the thin library generated code imports: the scope type, the error classes and the data-layer contract. `@mesh/data-sqlite` is the SQLite adapter; `@mesh/data-postgres` is the Postgres one; you need exactly one. `@mesh/ext-policies` is the first-party extension that adds authorization; without it nothing checks who is calling.

```bash
bun add @mesh/runtime @mesh/data-sqlite @mesh/ext-policies
```

**Peer dependencies.** Generated code imports these packages directly, so your project needs them too:

```bash
bun add zod drizzle-orm @opentelemetry/api
```

- `zod` builds the input validators Mesh generates ([ADR-0028](../architecture/decisions/0028-validation-zod-behind-standard-schema.md)).
- `drizzle-orm` backs the SQL adapters ([ADR-0014](../architecture/decisions/0014-sql-adapters-on-drizzle.md)).
- `@opentelemetry/api` is what a generated handler calls for tracing; with no SDK installed the calls do nothing ([ADR-0029](../architecture/decisions/0029-tracing-opentelemetry-api.md)).

::: callout info "Not decided yet"
The `@mesh/*` package names and the `mesh` command are working names. Check npm availability before v1 ships; [ADR-0040](../architecture/decisions/0040-package-and-command-names.md) records the recommendation and the two alternatives (waiting, or picking final names now).
:::

Then write the configuration and build:

```bash
bunx mesh init
bunx mesh build
```

`mesh init` asks where resource files are and where generated files go, and writes `mesh.config.ts`. See [Configuration](./configuration.md) for what is in it.

## What gets installed

| Package | Kind | Why you need it |
|---|---|---|
| `@mesh/cli` | dev dependency | The `mesh` command: `build`, `check`, `inspect`, `explain`, and whatever commands an enabled extension or the data adapter adds. It brings the compiler, the model and MX. |
| `@mesh/runtime` | run-time | What generated code imports. Deliberately thin: the scope type, the error classes, the data-layer contract. It never reads the resource model. |
| `@mesh/data-sqlite`, `@mesh/data-postgres` | run-time | One data adapter. Its build half emits the database schema as a generated file; its run-time half talks to the database. |
| `@mesh/ext-policies` | run-time | The first-party extension that fills the authorizer slot. Without it, no action checks who is calling. |
| `zod`, `drizzle-orm`, `@opentelemetry/api` | peer dependencies | Imported by generated code and by the adapters. |
| `drizzle-kit` | dev dependency | Generates and applies schema and migrations. Never needed at run time, so it does not ship to production. |

::: callout info "Not decided yet"
Whether generated code should import `zod`, `drizzle-orm` and `@opentelemetry/api` from the user's project, or from re-exports inside `@mesh/runtime`, is not settled. The versions Mesh pins can also clash with the versions you already have. [ADR-0014](../architecture/decisions/0014-sql-adapters-on-drizzle.md) and [ADR-0028](../architecture/decisions/0028-validation-zod-behind-standard-schema.md) are the records; the peer-dependency arrangement shown here is the reading this page commits to.
:::

## Next

- [Project structure](./project-structure.md) — where files live and which ones are committed.
- [Example: a todo list](./example-todo-list.md) — the first resource.
- [Getting started](./getting-started.md) — the reading path.