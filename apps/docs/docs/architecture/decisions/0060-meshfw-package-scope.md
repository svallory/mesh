---
title: "0060. Packages are published as `@meshfw/*`; the command is `mesh`"
description: "Decision record 0060: the npm scope, the package names and the command name. Status: Accepted."
---

# 0060. Packages are published as `@meshfw/*`; the command is `mesh`

## Status

Accepted. Supersedes [ADR-0040](./0040-package-and-command-names.md).

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

The packages were written `@mesh/*` as working names, and [ADR-0040](./0040-package-and-command-names.md) asked for an npm availability check before M2's generated code imported them, because a later rename touches every generated file. The name `mesh` is taken on npm.

## Decision

Operator, 2026-10-04 evening, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings on the user docs, layout and terms", row "npm organisation":

> `meshfw`, at least for now (`mesh` is taken on npm). Packages are `@meshfw/*` (`@meshfw/cli`, `@meshfw/runtime`, ...); the product is still called Mesh and the binary `mesh`. Registered by the operator on 2026-10-04.

The v1 packages are `@meshfw/model`, `@meshfw/compiler`, `@meshfw/runtime`, `@meshfw/cli`, `@meshfw/data-drizzle`, `@meshfw/data-sqlite` and `@meshfw/data-postgres`, plus the MX host package `mesh` ([ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md)), whose name MX fixes. There is no `@meshfw/ext-policies`: policies are core ([ADR-0055](./0055-policies-are-core.md)).

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
- The workspace packages on `main` are still `@mesh/*` until the realignment task.

## Action items

- [ ] Realignment task: rename every workspace package, import and import rule.
