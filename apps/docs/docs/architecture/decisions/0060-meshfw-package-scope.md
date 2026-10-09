---
title: "0060. Packages are published as `@meshfw/*`; the command is `mesh`"
description: "Decision record 0060: the npm scope, the package names and the command name. Status: Accepted."
---

# 0060. Packages are published as `@meshfw/*`; the command is `mesh`

## Status

Accepted. Supersedes [ADR-0040](./0040-package-and-command-names.md).

**Amended 2026-10-09, docs structural review:** the CLI is the unscoped package **`meshfw`**, installed with `bun add -d meshfw`, and its binary is **`mesh`**. `defineConfig` is imported from `meshfw`. (Superseded by the lead's ruling in the review of [PR #54](https://github.com/svallory/mesh/pull/54), 2026-10-09: `connect()` loads `mesh.config.ts` in the running program, and `meshfw` is a dev dependency, so a config imports `defineConfig` from `@meshfw/runtime`; `meshfw` keeps the re-export for compatibility.) The starter is **`create-mesh`**, invoked as `bun create mesh todo-app`; the remaining framework packages stay under `@meshfw/*`. This replaces the earlier CLI name in the historical ruling below. The operator still needs to register `meshfw` and `create-mesh` on npm. See the [docs review ruling](./rulings-2026-10-04.md#docs-review-notes-operator-2026-10-09-0135-and-the-leads-rulings-for-the-docs-structure-round).

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

The packages were written `@mesh/*` as working names, and [ADR-0040](./0040-package-and-command-names.md) asked for an npm availability check before M2's generated code imported them, because a later rename touches every generated file. The name `mesh` is taken on npm.

## Decision

Operator, 2026-10-04 evening, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings on the user docs, layout and terms (2026-10-04 evening, operator)", row "npm organisation":

> `meshfw`, at least for now (`mesh` is taken on npm). Packages are `@meshfw/*` (`@meshfw/cli`, `@meshfw/runtime`, ...); the product is still called Mesh and the binary `mesh`. Registered by the operator on 2026-10-04.

The v1 packages are `@meshfw/model`, `@meshfw/compiler`, `@meshfw/runtime`, `meshfw` (CLI), `create-mesh` (starter), `@meshfw/data-drizzle`, `@meshfw/data-sqlite` and `@meshfw/data-postgres`, plus the MX host package `mesh` ([ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md)), whose name MX fixes. There is no `@meshfw/ext-policies`: policies are core ([ADR-0055](./0055-policies-are-core.md)).

## Options considered

### Option A: `@meshfw/*` (chosen)

**Pros:** registered; one scope groups every package.
**Cons:** the scope differs from the product name.

### Option B: keep `@mesh/*` as working names

**Pros:** no rename.
**Cons:** cannot be published.

### Option C: unscoped names (`mesh-runtime`, ...)

**Pros:** no scope.
**Cons:** each name is a separate claim; packages are not grouped.

## Trade-off analysis

Only Option A can be published. The mismatch between scope and product name is cosmetic.

## Consequences

- Generated code imports `@meshfw/runtime`; the import rules checked by `verify` name `@meshfw/*`.
- The workspace packages on `main` are `meshfw` and `@meshfw/*` since PR #48 (2026-10-09).

## Action items

- [ ] Operator: register the unscoped `meshfw` and `create-mesh` packages on npm.
- [ ] Realignment task: rename every workspace package, import and import rule, including the CLI exception.
