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

Mesh runs on [Bun](https://bun.sh) only. Node is dropped from the roadmap: see [ADR-0025](../architecture/decisions/0025-bun-only.md), which supersedes [ADR-0026: Node parity](../architecture/decisions/0026-node-parity.md).

- **Bun.** The minimum version is fixed at the first release. No global Mesh install or separate runtime is needed; the generated code is built in your project.
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
bunx mesh build
bunx mesh db push
bun run src/main.ts
```

## An existing project

Mesh does not own your project layout; it reads `resources/` and writes `generated/` inside it. Add the dependencies, then run `mesh init` to write the configuration file and the folder.

**Build-time packages (development dependencies).** `@mesh/cli` is the `mesh` command; it brings the compiler, the resource model and MX, the parser that reads `.mx` files. `drizzle-kit` is what the data adapter's schema commands and in-process test/development schema function call.

```bash
bun add -d @mesh/cli drizzle-kit@0.31.11
```

**Run-time packages.** `@mesh/runtime` is the thin library generated code imports: the scope type, the error classes and the data-layer contract. `@mesh/data-sqlite` is the SQLite adapter; `@mesh/data-postgres` is the Postgres one; you need exactly one. `@mesh/ext-policies` is the first-party extension that adds authorization; without it nothing checks who is calling.

```bash
bun add @mesh/runtime @mesh/data-sqlite @mesh/ext-policies
```

**Application dependencies required by generated code.** Install these as ordinary dependencies of your application. Generated code imports `zod`, `drizzle-orm` and `@opentelemetry/api` directly, so your project must depend on all three. From M2, `mesh build` checks that these imports resolve from your project:

```bash
bun add zod@4.6.5 drizzle-orm@0.45.3 @opentelemetry/api
```

- `zod@4.6.5` builds the input validators Mesh generates ([ADR-0028](../architecture/decisions/0028-validation-zod-behind-standard-schema.md)).
- `drizzle-orm` is imported by the generated schema and backs the SQL adapters ([ADR-0014](../architecture/decisions/0014-sql-adapters-on-drizzle.md)).
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
| `@mesh/cli` | dev dependency | The `mesh` command: `init`, `build`, `build --check`, `inspect`, `explain`, and whatever commands an enabled extension or the data adapter adds. It brings the compiler, the model and MX. |
| `@mesh/runtime` | run-time | What generated code imports. Deliberately thin: the scope type, the error classes, the data-layer contract. It never reads the resource model. |
| `@mesh/data-sqlite`, `@mesh/data-postgres` | run-time | One data adapter. Its build half emits the database schema as a generated file; its run-time half talks to the database. |
| `@mesh/ext-policies` | run-time | The first-party extension that fills the authorizer slot. Without it, no action checks who is calling. |
| `zod`, `drizzle-orm`, `@opentelemetry/api` | application dependencies | Imported by generated code and by the adapters. |
| `drizzle-kit` | dev dependency | Schema/migration development tooling and in-process schema preparation for tests. Not needed by production action calls. |

[ADR-0048](../architecture/decisions/0048-schema-inside-the-process-for-tests.md) pins the stable pair exactly: `drizzle-orm@0.45.3`, `drizzle-kit@0.31.11`. The SQLite adapter's in-process schema function is only for tests and development. It dynamically imports drizzle-kit and reports a clear installation error if it is missing; production uses migrations, not schema push. No top-level import from the adapter's run-time code pulls drizzle-kit into production.

Generated libraries are application dependencies, not re-exports from `@mesh/runtime`. If your project already uses them, reconcile its versions with Mesh's supported versions rather than relying on a transitive dependency.

## Next

- [Project structure](./project-structure.md) — where files live and which ones are committed.
- [Example: a todo list](./example-todo-list.md) — the first resource.
- [Getting started](./getting-started.md) — the reading path.