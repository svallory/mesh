---
title: "Getting started"
description: "Which page answers which question, and how to try Mesh today."
---

# Getting started

::: callout warning "Live spec, not released"
This page describes how Mesh **will** work, not how it works today. It is a live spec of the developer experience, written before the code. Mesh is not released: nothing here can be installed or run yet, and any detail may change.
:::

There is no install step to run yet: Mesh has no release. This page is therefore a reading path, plus a short section on what does work today.

## Where to start

If you have never seen Mesh, read **[Example: a todo list](./example-todo-list.md)**. It is the shortest complete picture: two resource files, a relationship, a validation, a policy, a calculation, and a plain TypeScript script that calls the generated functions. Everything else in this section can wait.

Then work through the loop:

1. **[Installation](./installation.md)** — Bun only, and adding Mesh to a new project or to one you already have.
2. **[Project structure](./project-structure.md)** — where resource files, generated code, configuration and migrations live, and which of them you commit.
3. **[Usage](./usage.md)** — the working loop: write a resource, build, call an action, change the resource, rebuild, check before committing.
4. **[Calling actions](./calling-actions.md)** — the generated function signatures, the scope argument, filters, `load`, and the errors an action throws.
5. **[Configuration](./configuration.md)** — `mesh.config.ts`, and **[Command-line tool](./command-line.md)** — every `mesh` command.
6. **[Resource file reference](./resource-file-reference.md)** — the tags, one by one, when you need the exact spelling.

## The shape in one paragraph

One `.mx` file declares a resource: its attributes, its relationships, its actions and the rules around them. `mesh build` reads those files with MX, the parser, and writes ordinary TypeScript: a type per resource, a function per action with the whole lifecycle written out, an input validator per action, and the database schema. You import those functions and call them. The call takes the input and a **scope** — who is calling — as a plain argument. That is the whole interface: no server, no routes, no generated client, no RPC.

## Trying Mesh today

Nothing is installed, so the only way to try Mesh is to work on it. The parts that exist are the resource vocabulary, enforced as tag contracts when MX parses a `.mx` file, and the plain-data resource model built from that tree.

The contracts live in the `packages/compiler` workspace package. They depend on MX, a separate project, through `link:` entries in `packages/compiler/package.json`. Register your MX checkout once by running `bun link` inside it. After that a plain `bun install` at the repository root resolves the `link:` entries, so there is no per-clone link step. Do not run `bun link @mxlang/data @mxlang/core` at the repository root: `bun link <package>` writes a `link:` dependency into the `package.json` of the directory it runs in, which would add MX to the root package.

Then install and verify from the repository root:

```bash
bun install
bun run verify      # tests, type check, docs build and link check
bun run test        # tests only
bun run typecheck   # type check only
```

The `examples/blog` directory holds the fixture resource `post.mx` and is where the first generated handlers will be called. To build this documentation site, read [Contributing to these docs](../architecture/contributing.md).

## Next

- [Docs overview](./index.md) — what Mesh is and how to read these pages.
- [Roadmap](../architecture/roadmap/roadmap.md) — the order the code will be built in.