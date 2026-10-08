---
title: "Extension host and composed contracts"
description: "How extensions add vocabulary and behaviour through one manifest, and how tag contracts are composed."
---

# Extension host and composed contracts

Status: design; built in milestone M6 ([roadmap](../roadmap/roadmap.md), M6). Nothing on this page exists as code yet. No first-party extension ships in v1: policies, the planned first one, became core ([ADR-0055](../decisions/0055-policies-are-core.md)), so M6 is exercised by test extensions and by project-local extensions in `src/extensions/`.

Related: [overview](../overview/architecture.md), [three rings](./three-rings.md), [build pipeline](./build-pipeline.md), [how Mesh uses MX](./mx-integration.md), [expressions](./expressions.md), [data layer](./data-layer.md).

## Extension versus adapter

An **adapter** is one replaceable implementation of a contract that core owns, such as the database. A project picks one. An **extension** is an optional feature built on core's extension points ([roadmap](../roadmap/roadmap.md), section 0; [ADR-0001](../decisions/0001-three-rings.md)). Core is only what Mesh cannot run without; MX and policies are core ([ADR-0043](../decisions/0043-mx-is-core.md), [ADR-0055](../decisions/0055-policies-are-core.md)). The **extension host** is the part of `@meshfw/compiler` that loads extensions and runs what they declare.

A project lists its extensions in `mesh.config.ts` (`extensions: [...]`); nothing is discovered by scanning `node_modules`. A project-local extension lives in `src/extensions/` ([ADR-0057](../decisions/0057-one-domain-modules-as-folders.md)). An extension has a build-time entry and a run-time entry; the run-time entry follows the same import rule as `runtime` (no `model`, `compiler` or MX), so a deployed program never carries the compiler.

## The manifest

An extension declares itself through one typed manifest ([roadmap](../roadmap/roadmap.md), M6; [ADR-0020](../decisions/0020-extension-contributions-through-declared-points.md)). Ash has seven optional tooling callbacks that mix tasks call duck-typed, and no module declares that it implements them, so a reader cannot tell which matter ([research synthesis](../research/synthesis.md), section 3, fact 3). One typed manifest replaces them.

| Entry | What it declares |
|---|---|
| Tags | New vocabulary: tag contracts the extension adds, in the `kind :name options` shape ([ADR-0050](../decisions/0050-entity-file-syntax.md)). |
| Transforms | Rewrites of the model, each placed in a named phase. |
| Verifiers | Read-only checks across entities; a failure stops the build. |
| Emitters | Each a typed view of the model plus a Jig template ([ADR-0061](../decisions/0061-generators-are-jig-templates.md)). |
| Expression functions | Each with its in-memory implementation and its SQL form per data adapter ([expressions](./expressions.md)). |
| Attribute types | A new type tag, with a validator and a column type per adapter. |
| Steps (planned) | Reusable steps an entity file uses as tags. Their definitions are `step :name` files in `.mesh.mx`, with an `options` section and a body; Mesh derives the tag's contract from the definition. Extensions contribute steps the same way projects do ([ADR-0053](../decisions/0053-validate-then-do.md)). Not in v1. |
| Context keys read | The keys of the action context the extension reads (for example a multitenancy extension's `tenantId`). Two extensions claiming one key fail the build ([ADR-0059](../decisions/0059-action-context.md)). |
| Tooling hooks | A `mesh` subcommand. |
| Adapter requirements | What the extension requires from adapters. |
| Contribution points | Points the extension publishes for others and points it uses in others. |
| Run-time points | Named, reusable checks, computed fields and policy helpers an entity file refers to by name. |

The roadmap lists the kinds, not the manifest's exact shape: not decided. Core's own emitters and the data adapters' emitters register through the same interface, and the contracts of M2 to M5 are declared stable at that point.

## Named phases

Transforms run in **named phases**. A cycle between phases is a hard error and the resulting order is printed ([research synthesis](../research/synthesis.md), section 16, stage 4; [roadmap](../roadmap/roadmap.md), M6, test 3).

This replaces Ash's Spark toolkit, which orders transformers with `before?` and `after?` against module names. A contradictory pair is dropped silently and cycles are broken silently ([research synthesis](../research/synthesis.md), section 2.1). In Ash, verifier errors also print only warnings (same place). In Mesh the M1 checks become the Verify stage and a verifier failure stops the build. A strictness setting for verifiers is out of scope for M6.

## Ruling 5 and contribution points

Ruling 5: an extension may contribute to another extension's part of the model "only through contribution points the owning extension publishes and the contributor declares in its manifest. Anything else is a build error" ([rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), Ruling 5). The evidence in Ash: AshPaperTrail inserts entities straight into AshPostgres's `references` section; it works and nothing checks it ([research synthesis](../research/synthesis.md), section 3, fact 2).

A **contribution point** is a place in the model or the vocabulary that its owner names as open to additions. The owner publishes it; the contributor lists it in its manifest as a point it uses. An undeclared write fails the build and names both extensions ([roadmap](../roadmap/roadmap.md), M6, test 2).

### Worked example: a section on `entity`

`entity` belongs to core, and its children (`attributes`, `relationships`, `computed`, `actions`, `policies`) are closed in its contract. Core publishes a contribution point on `entity` for children. Suppose a project-local extension adds an `audit` section:

```mx
entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    enum :status values=[:draft, :paid]
    decimal :amount
  audit fields=[&status, &amount]
```

The extension declares the `audit` tag and, in its manifest, that it uses core's point on `entity`. With the extension listed in `mesh.config.ts`, the file builds; without it, `audit` is an unknown tag and the build fails at that line ([roadmap](../roadmap/roadmap.md), M6, test 1: a test extension adds a child tag to the root tag through a declared point). What a published point looks like in the manifest is not decided.

Until 2026-10-05 this example was policies, which were to move from the core contracts into an `ext-policies` extension in M8. Policies are now core, so they never move ([ADR-0055](../decisions/0055-policies-are-core.md)).

## Composed tag contracts

A **tag contract** tells MX which attributes, children and parents a tag allows. The `children` set on `entity` is closed once present (MX project notes, getting-started, section 1). If an extension adds a child, the `entity` contract must be rebuilt to include it. So the contracts are composed from core plus the enabled extensions ([ADR-0021](../decisions/0021-composed-contracts-module.md)).

Two forms exist ([roadmap](../roadmap/roadmap.md), M6):

1. **In memory, for the build.** The compiler composes the contracts and passes them directly to `parseData`, MX's entry point for static data, so a stray local tag file cannot change the build.
2. **A generated, self-contained module, for MX tooling**, written to `.mesh/mx-contracts.js`. The `mesh` MX host hands it to the editor and other MX tools ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)); until the host exists, `package.json#mx.contracts` names it.

Why a single generated file rather than one module per extension: MX merges contract sources by replacing a whole entry, and cannot see a module's imports, so an edited helper file goes unnoticed. A single generated file is the form MX's scan invalidates and merges correctly ([ADR-0021](../decisions/0021-composed-contracts-module.md)). Why bundling: the module contains `analyze` functions, which hold the conditional rules (for example `values` required only on `enum`) and the editor diagnostics for translated expressions ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)), so it must be self-contained and is produced with Bun's bundler. The module is guarded like other generated files, and a test requires that it declares the same tag names as the in-memory composition (M6, test 4).

Limit: the module has no consumer until MX ships editor support for data files ([roadmap](../roadmap/roadmap.md), M6, risks).

## What is not in the host

- **Discovery.** Extensions are not found by scanning; loading by discovery is out of scope ([roadmap](../roadmap/roadmap.md), M6). The loading mechanism itself is not decided.
- **A strictness setting for verifiers.** See above.
