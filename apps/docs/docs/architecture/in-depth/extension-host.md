---
title: "Extension host and composed contracts"
description: "How extensions add vocabulary and behaviour through one manifest, and how tag contracts are composed."
---

# Extension host and composed contracts

Status: design; built in milestone M6 ([roadmap](../roadmap/roadmap.md), M6). The first real extension, policies, moves onto it in M8 ([roadmap](../roadmap/roadmap.md), M8). Nothing on this page exists as code yet.

Vocabulary note: tag and attribute names on this page (for example `policies`, `forbid-if`) are working names. For v1 the vocabulary copies Ash's DSL, and the final name follows the mapping in [vocabulary mapping](../roadmap/vocabulary-mapping.md) ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)). Examples use MX concise syntax ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).

Related: [overview](../overview/architecture.md), [three rings](./three-rings.md), [build pipeline](./build-pipeline.md), [MX integration](./mx-integration.md), [expressions](./expressions.md), [data layer](./data-layer.md).

## Extension versus adapter

An **adapter** is one replaceable implementation of a contract that core owns: the database, the runtime. A project picks one. An **extension** is an optional feature built on core's extension points, such as policies ([roadmap](../roadmap/roadmap.md), section 0; [ADR-0001](../decisions/0001-three-rings.md)). Core is only what Mesh cannot run without. MX is core, not an adapter ([ADR-0043](../decisions/0043-mx-is-core.md)). The **extension host** is the part of `packages/compiler` that loads extensions and runs what they declare ([roadmap](../roadmap/roadmap.md), section 3).

## The manifest

An extension declares itself through one typed manifest ([roadmap](../roadmap/roadmap.md), M6; [ADR-0020](../decisions/0020-extension-contributions-through-declared-points.md)). Ash has seven optional tooling callbacks that mix tasks call duck-typed, and no module declares that it implements them, so a reader cannot tell which matter ([research synthesis](../research/synthesis.md), section 3, fact 3). One typed manifest replaces them (same, section 8, "Do differently").

| Entry | What it declares |
|---|---|
| Tags | New vocabulary: tag contracts the extension adds. |
| Transforms | Rewrites of the model, each placed in a named phase. |
| Verifiers | Read-only checks across resources; a failure stops the build ([research synthesis](../research/synthesis.md), section 16). |
| Emitters | Files written from the model. |
| Expression functions | Each with its in-memory implementation and its SQL form per data adapter ([expressions](./expressions.md)). |
| Attribute types | A validator and a column type per adapter. |
| Tooling hooks | A `mesh` subcommand. |
| Adapter requirements | What the extension requires from adapters ([research synthesis](../research/synthesis.md), section 18; the roadmap says only "adapter requirements"). |
| Contribution points | Points the extension publishes for others and points it uses in others. |
| Run-time points | Named, reusable changes, validations, preparations, calculations and policy checks that a resource file refers to by name. |

All entries are from [roadmap](../roadmap/roadmap.md), M6. The roadmap lists the kinds, not the manifest's exact shape: not decided. Core's own emitters and the data adapters' emitters register through the same interface, and the contracts of M2 to M5 are declared stable at that point.

## Named phases

Transforms run in **named phases**. A cycle between phases is a hard error and the resulting order is printed ([research synthesis](../research/synthesis.md), section 16, stage 4; [roadmap](../roadmap/roadmap.md), M6, test 3, which expects the cycle itself to be printed).

This replaces Ash's Spark toolkit, which orders transformers with `before?` and `after?` against module names. A contradictory pair is dropped silently and cycles are broken silently. AshArchival orders itself against two modules that no longer exist, and two Ash core transformers contradict each other ([research synthesis](../research/synthesis.md), section 2.1). In Ash, verifier errors also print only warnings (same place). In Mesh the M1 checks become the Verify stage ([roadmap](../roadmap/roadmap.md), M6) and a verifier failure stops the build. A strictness setting for verifiers is out of scope for M6, so there is no way to downgrade them yet.

## Ruling 5 and contribution points

Ruling 5: an extension may contribute to another extension's part of the model "only through contribution points the owning extension publishes and the contributor declares in its manifest. Anything else is a build error" ([rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), Ruling 5). The evidence in Ash: AshPaperTrail inserts entities straight into AshPostgres's `references` section; it works and nothing checks it ([research synthesis](../research/synthesis.md), section 3, fact 2).

A **contribution point** is a place in the model or the vocabulary that its owner names as open to additions. The owner publishes it; the contributor lists it in its manifest as a point it uses. An undeclared write fails the build and names both extensions ([roadmap](../roadmap/roadmap.md), M6, test 2).

### Worked example: policies adding tags to `resource`

From M1 until M8, the policy tags `policies`, `policy` and `authorize-if` are in the core contracts, and a resource using them gets a not-implemented build error ([ADR-0018](../decisions/0018-not-implemented-is-a-build-error.md); [roadmap](../roadmap/roadmap.md), M1). In M8 they move into `ext-policies` through the M6 mechanism, and `forbid-if` is added ([roadmap](../roadmap/roadmap.md), M8). In `packages/compiler/test/fixtures/post.mx`, `policies` is a child of `resource`, next to `attributes` and `actions`:

```text
policies
  policy action="publish"
    authorize-if=({ post, actor }) => post.authorId === actor.id
```

`resource` belongs to core. Core publishes a contribution point on it, for children. `ext-policies` declares in its manifest that it uses that point and adds the tags. With the extension disabled, a file with a `policies` block fails because the tag is not declared. That `resource` publishes such a point is an interpretation of Ruling 5 and the M6 test, not a roadmap statement ([roadmap](../roadmap/roadmap.md), M6, test 1: a test extension adds a child tag to `resource` through a declared point). What a published point looks like in the manifest is not decided.

## Composed tag contracts

A **tag contract** tells MX which attributes, children and parents a tag allows. The `children` set on `resource` is closed once present (MX project notes, getting-started, section 1). If an extension adds a child, the `resource` contract must be rebuilt to include it. So the contracts are composed from core plus the enabled extensions ([ADR-0021](../decisions/0021-composed-contracts-module.md)). [ADR-0021](../decisions/0021-composed-contracts-module.md) records the deciders; the project owner may overrule.

Two forms exist ([roadmap](../roadmap/roadmap.md), M6):

1. **In memory, for the build.** The compiler composes the contracts and passes them directly to `parseData`, MX's entry point for static data, so a stray local tag file cannot change the build (M1 and M6).
2. **A generated, self-contained module, for MX tooling.** `mesh build` also writes it, and `package.json#mx.contracts` names it. The editor and other MX tools read this one.

Why a single generated file rather than one module per extension: MX merges contract sources by replacing a whole entry, and cannot see a module's imports, so an edited helper file goes unnoticed. A single generated file is the form MX's scan invalidates and merges correctly ([ADR-0021](../decisions/0021-composed-contracts-module.md), Context and Options). Why bundling: the module contains `analyze` functions, which hold the conditional rules (for example `values` required only when `type="enum"`), so it must be self-contained and is produced with Bun's bundler ([roadmap](../roadmap/roadmap.md), M6). The module is guarded like other generated files, and a test requires that it declares the same tag names as the in-memory composition (M6, test 4).

Limit: the module has no consumer until MX ships editor support for data files ([roadmap](../roadmap/roadmap.md), M6, risks).

## What is not in the host

- **Discovery.** Extensions are not found by scanning; loading by discovery is out of scope ([roadmap](../roadmap/roadmap.md), M6). A project's enabled extensions are named in `mesh.config.ts` from M6, the one configuration file that also names the resource files, the output directory and (from M2) the data adapter; an extension takes part only where that file names it ([roadmap](../roadmap/roadmap.md), M1 and M6). The loading mechanism itself is not decided.
- **A way to add to the scope.** Whether a tenant belongs in core or in an extension is open: [ADR-0009](../decisions/0009-tenancy-placement.md) is Proposed. The working assumption in the roadmap is that M6 builds no scope contribution point ([roadmap](../roadmap/roadmap.md), M6). The scope stays `{ actor, context }` ([action lifecycle](./action-lifecycle.md)).
- **A strictness setting for verifiers.** See above.
