---
title: "Docs overview"
description: "What Mesh is, and what exists today."
---

# Docs overview

Mesh is a planned TypeScript framework. One `.mx` resource file declares data, actions and rules, and Mesh derives types, handlers and schema from it. Mesh runs on Bun only.

::: callout warning "Mesh is pre-release"
You cannot build an application with Mesh yet. This section grows as features ship, and it documents only features that exist.
:::

## What exists today

- **Tag contracts for resource files.** The vocabulary of a resource file (`resource`, `attribute`, `create` and so on) is defined as contracts that MX (the parser Mesh builds on) enforces when it parses a `.mx` file. The code is in `src/contracts.ts` in the repository. See the [Resource file reference](./resource-file-reference.md).
- **Tests for those contracts.** They live in `test/` and run with `bun test`.

## What does not exist yet

There is no model builder, no code generation, no runtime, no CLI and no package to install. Plans and open decisions are in the [Architecture section](../architecture/index.md).

## Next

- [Getting started](./getting-started.md)
- [Resource file reference](./resource-file-reference.md)
