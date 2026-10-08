---
title: "Quick start"
description: "Check the requirements, create a project, build it and call your first action."
---

# Quick start

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

Create a runnable project, then call one action. You do not need to write an entity file to check that your setup works.

## Requirements

- **Bun 1.3.14 or later** — [install Bun](https://bun.sh/docs/installation). Mesh runs on Bun, not Node.js; use Bun for package commands.
- **Git 2.x** — [install Git](https://git-scm.com/downloads), to track your domain and the code Mesh builds from it.
- **An editor**, such as the current stable version of [Visual Studio Code](https://code.visualstudio.com/download). Any editor that can edit TypeScript and text files works.

::: callout tip "Let an agent check"
Copy this prompt into your coding agent:

```text
Check this machine for Bun 1.3.14 or later, Git 2.x,
and an editor (the current stable Visual Studio Code is fine).
Verify each installed version and that each tool opens or runs.
Install or update anything missing or too old, asking before changes.
Report each tool's version, what you changed and any remaining problem.
```
:::

## Install

```bash
bun create mesh todo-app
cd todo-app
```

Choose **SQLite** when asked. The `create-mesh` starter installs the dependencies, including the `meshfw` package that provides the `mesh` command. It creates a minimal runnable app: one `List` entity in `src/domain/todo/list.mesh.mx`, `mesh.config.ts`, `src/context.ts` with a demo actor named `alice`, and `src/demo.ts`. Its `bun run demo` script calls `createList` and prints the record. The `#mesh` import is already configured.

For an existing project, install the CLI with `bun add -d meshfw`; [Configuration](./configuration.md#dependencies) lists the runtime and adapter dependencies. The commands below use `mesh`: `bunx mesh build` runs the project's own copy without a global install, and `bun add -g meshfw` gives you a global `mesh`.

## Run it

```bash
mesh build
mesh db push
bun run demo
```

The build writes the functions you call. The schema push creates the table in `todo.db`; use it only for development. The demo connects, creates a list as Alice and disconnects. Expect a record like this; its id and timestamp change on each run:

```text
{
  id: "8a3f5c10-0000-4000-8000-000000000001",
  name: "Groceries",
  ownerId: "00000000-0000-4000-8000-000000000001",
  insertedAt: 2026-10-04T09:12:31.004Z
}
```

## Use your domain

Import a function from `#mesh` and pass its input and the caller's context:
```ts "src/demo.ts"
import { connect, createList, disconnect } from "#mesh";
import { alice } from "./context";
await connect();
try {
  console.log(await createList({ name: "Groceries" }, { actor: alice }));
} finally { await disconnect(); }
```
Continue with the [Tutorial](./tutorial.md) to add todos, or [Using your domain](./using-your-domain.md) to call actions from your own program.
