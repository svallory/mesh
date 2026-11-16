---
title: "0060. Packages are published as `@meshfw/*`; the command is `mesh`"
description: "Decision record 0060: the npm scope, the package names and the command name. Status: Accepted. Amended 2026-11-14 (the package list also holds `@meshfw/bus-local` and `@meshfw/jsonrpc`)."
---

# 0060. Packages are published as `@meshfw/*`; the command is `mesh`

## Status

Accepted. Supersedes [ADR-0040](./0040-package-and-command-names.md).

**Amended 2026-10-09, docs structural review:** the CLI is the unscoped package **`meshfw`**, installed with `bun add -d meshfw`, and its binary is **`mesh`**. `defineConfig` is imported from `meshfw`. (Superseded by the lead's ruling in the review of [PR #54](https://github.com/svallory/mesh/pull/54), 2026-10-09: `connect()` loads `mesh.config.ts` in the running program, and `meshfw` is a dev dependency, so a config imports `defineConfig` from `@meshfw/runtime`; `meshfw` keeps the re-export for compatibility.) The starter is **`create-mesh`**, invoked as `bun create mesh todo-app`; the remaining framework packages stay under `@meshfw/*`. This replaces the earlier CLI name in the historical ruling below. The operator still needs to register `meshfw` and `create-mesh` on npm. See the [docs review ruling](./rulings-2026-10-04.md#docs-review-notes-operator-2026-10-09-0135-and-the-leads-rulings-for-the-docs-structure-round).

**Amended 2026-10-11, operator (PRJ-04):** the starter is **`create-meshfw`**, invoked as `bun create meshfw todo-app` (Bun resolves `bun create X` to the package `create-X`). The CLI stays `meshfw` with binary `mesh`, and the framework packages stay `@meshfw/*`. The operator still has to register `create-meshfw` on npm.

**Amended 2026-10-13, PRJ-22 ([PR #98](https://github.com/svallory/mesh/pull/98)):** a project adds `meshfw` as a regular dependency (`bun add meshfw`), not a dev one, because application code imports `Mesh` from it at run time (see [ADR-0086](./0086-entity-values-privileged-barrels-and-fqns.md)). `meshfw` and the other Mesh packages that use the runtime (`@meshfw/compiler`, `@meshfw/data-drizzle`, `@meshfw/data-sqlite`) take `@meshfw/runtime` as a peer dependency, so an installed project holds one copy of it: the runtime recognises an entity value by a `Symbol` and `WeakMap`s private to each copy, and a second copy makes `Mesh.privileged(Task)` refuse the project's own `Task`. The project lists `@meshfw/runtime` itself, since its generated code imports it.

**Amended 2026-11-14, package list:** the list of v1 packages in the Decision below was written before two packages that are now built and in the workspace. Read the list with both added; each follows this record's `@meshfw/*` rule. **`@meshfw/bus-local`** holds `localBus`, the first event-bus adapter, which delivers events from the outbox inside the deliverer's process on any data adapter; it was built in milestone M6 ([ADR-0079](./0079-commands-events-and-the-outbox.md), Decision item 3: an event bus delivers what `publish` wrote to the outbox; [Events](../../docs/events.md#localbus)). **`@meshfw/jsonrpc`** is the JSON-RPC transport adapter, newline-delimited JSON-RPC 2.0 over a Unix socket, and the one transport built before the 1.0 gate ([ADR-0077](./0077-surfaces-and-file-kinds.md), Decision item 6). The [roadmap](../roadmap/roadmap.md), section 3, lists every package with its ring.

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

The packages were written `@mesh/*` as working names, and [ADR-0040](./0040-package-and-command-names.md) asked for an npm availability check before M2's generated code imported them, because a later rename touches every generated file. The name `mesh` is taken on npm.

## Decision

Operator, 2026-10-04 evening, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings on the user docs, layout and terms (2026-10-04 evening, operator)", row "npm organisation":

> `meshfw`, at least for now (`mesh` is taken on npm). Packages are `@meshfw/*` (`@meshfw/cli`, `@meshfw/runtime`, ...); the product is still called Mesh and the binary `mesh`. Registered by the operator on 2026-10-04.

The v1 packages are `@meshfw/model`, `@meshfw/compiler`, `@meshfw/runtime`, `meshfw` (CLI), `create-meshfw` (starter), `@meshfw/data-drizzle`, `@meshfw/data-sqlite` and `@meshfw/data-postgres`, plus the MX host package `mesh` ([ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md)), whose name MX fixes. There is no `@meshfw/ext-policies`: policies are core ([ADR-0055](./0055-policies-are-core.md)).

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

- [ ] Operator: register the unscoped `meshfw` and `create-meshfw` packages on npm.
- [ ] Realignment task: rename every workspace package, import and import rule, including the CLI exception.
