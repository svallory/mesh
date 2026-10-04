---
title: "Docs overview"
description: "What Mesh is, how to read these pages, and what exists today."
---

# Docs overview

::: callout warning "Live spec, not released"
This page describes how Mesh **will** work, not how it works today. It is a live spec of the developer experience, written before the code. Mesh is not released: nothing here can be installed or run yet, and any detail may change.
:::

Mesh is a TypeScript framework modelled on [Ash](https://ash-hq.org), the declarative resource framework for Elixir. You describe a resource once, in one `.mx` file: its data, its actions and its rules. Mesh derives types, handlers and schema from that file. Mesh runs on Bun only.

Mesh serves any kind of program: a command line, a daemon, a worker or a web app. There is no server in version 1 and no transport at all. An action is a generated TypeScript function, and calling it is the whole interface.

## How to read these pages

These pages are written **before the code**, from the design, to model how using Mesh should feel. They are a live spec: a specific proposal, not a description of a shipped framework. Anything on them can change, and several details are marked "Not decided yet" with a link to the decision record that has to settle them.

If you want to know what Mesh does rather than what it will do, read the [Architecture](../architecture/index.md) section: the roadmap, the decision records and the research behind them.

## The reading path

1. **[Getting started](./getting-started.md)** — which page answers which question, and how to try Mesh today.
2. **[Installation](./installation.md)** — Bun, and adding Mesh to a new or existing project.
3. **[Example: a todo list](./example-todo-list.md)** — two resources, a relationship, a validation, a policy and a calculation, and a script that calls them. This is the page to read first if you want to see the shape of the thing.
4. **[Usage](./usage.md)** — the loop: change a resource, build, let the type checker tell you what broke, update the database, check before committing.
5. **[Project structure](./project-structure.md)** — which files live where, and which ones are committed.
6. **[Calling actions](./calling-actions.md)** — the generated signatures, the scope argument, filters, `load`, the error classes and `can`.
7. **[Configuration](./configuration.md)** — `mesh.config.ts`: the resource folder, the output folder, the data adapter, the extensions.
8. **[Command-line tool](./command-line.md)** — every `mesh` command, the guard, and `explain`.
9. **[Resource file reference](./resource-file-reference.md)** — the tags a resource file may use, one by one.

## What exists today

Only two things:

- **Tag contracts for resource files.** The vocabulary of a resource file (`resource`, `attribute`, `create` and so on) is defined as contracts that MX, the parser Mesh builds on, enforces when it parses a `.mx` file. The code is `packages/compiler/src/contracts.ts` in the repository. See the [Resource file reference](./resource-file-reference.md).
- **The resource model.** A plain-data representation of a resource: attributes, actions, relationships and their registries, with a diagnostic type. It is `packages/model` in the repository.

There is no code generation, no runtime, no CLI and no package to install. Milestone M0 is done; M1, the build skeleton, is next. The order of work is the [roadmap](../architecture/roadmap/roadmap.md).

::: callout info "Names can still move"
The vocabulary follows Ash's DSL for v1, in kebab-case with the trailing `?` dropped, and is reviewed after v1. `allow-nil`, `type="atom"`, `destination=` and `create-timestamp` are the current spellings; some are still being aligned. [The vocabulary mapping](../architecture/roadmap/vocabulary-mapping.md) lists every one and what Ash does.
:::