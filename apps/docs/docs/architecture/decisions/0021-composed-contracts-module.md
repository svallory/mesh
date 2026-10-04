---
title: "0021. One composed contracts module, generated from core plus enabled extensions"
description: "Decision record 0021: One composed contracts module, generated from core plus enabled extensions. Status: Accepted."
---

# 0021. One composed contracts module, generated from core plus enabled extensions

## Status

Accepted

## Date

2026-10-04

## Deciders

lead, operator may overrule; the build and bundling details are the roadmap author's design

## Context

MX is a separate project that parses Marko-syntax files; Mesh resource files are `.mx` files ([ADR-0002](./0002-resource-files-are-mx.md)). A *tag contract* tells MX which attributes, children and parents a tag allows. Mesh passes contracts to MX's `parseData` as `customTags`, and MX tooling (editors, a language server) can find them through `package.json#mx.contracts`, which names modules whose default export is a plain map of contracts (MX project notes, updates, entry "2026-10-03 19:51").

Two MX facts shape the problem. First, a `children` set on a contract is closed once present (MX project notes, getting-started, section 1), so a `resource` contract that lists its allowed child tags rejects any tag an extension adds. Second, when two sources define the same tag the winner replaces the whole entry and the two are not merged (MX project notes, mx-contracts, section 3), and MX cannot see a module's transitive imports, so an edited helper file goes unnoticed (same file, section 2, "Transitive imports are not stamped").

Extensions ([ADR-0020](./0020-extension-contributions-through-declared-points.md)) add tags, for example policies adding a `policies` section under `resource`, so the `resource` contract has to be composed from several parts.

## Decision

Lead decision, 2026-10-04, [rulings of 2026-10-04](./rulings-2026-10-04.md), "Lead decisions (operator may overrule)":

> Mesh generates one self-contained `mx.contracts` module from core plus the enabled extensions, so extensions add tags without any MX change. Follows ruling 5 (contributions only through declared points: a closed `resource.children` must accept children an extension contributes).

Mesh stated this to the MX maintainers in Mesh's answers to MX on `mx.contracts`, 2026-10-04 (Q3, Q5, Q7); that file says no MX ruling changes. The rest is the roadmap author's design ([roadmap](../roadmap/roadmap.md), M1 and M6): the composition code lives in `packages/compiler` ([ADR-0043](./0043-mx-is-core.md)). The build composes the contracts in memory and hands them to `parseData` directly, so a stray local tag file cannot change a build (the reasoning is in Mesh's answers to MX on `mx.contracts`, 2026-10-04, "For decision 142", item 1). Each extension declares its own tag contracts and therefore imports MX's contract types ([ADR-0020](./0020-extension-contributions-through-declared-points.md), [ADR-0043](./0043-mx-is-core.md)). `mesh build` also writes the self-contained module for MX tooling, produced with Bun's bundler because it contains `analyze` functions, and the guard regenerates it.

## Options considered

### Option A: Generated single module (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: composition code plus a bundling step |
| Cost | One generator in M6; a guard test per build |
| Reversibility | Easy: only Mesh writes the module |
| Correctness of reloads | MX stamps one file, so regenerating invalidates correctly (Mesh's answers to MX on `mx.contracts`, 2026-10-04, Q7) |

**Pros:** no MX change; `resource` is composed in Mesh's own generator, where ruling 5 is checked; a disabled extension contributes no tags.
**Cons:** the module is a generated artifact to guard. It has no consumer until MX ships editor support for data files (roadmap, M6 risks), so the in-memory composition is what the build depends on.

### Option B: One module per extension, listed in `mx.contracts`
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low to start |
| Cost | Hand-maintained modules; core would list nothing about extensions |
| Reversibility | Easy |
| Correctness of reloads | Poor if modules import shared helpers |

**Pros:** the array form exists, and MX describes an explicit spread of a module's declaration into a project's own per-tag file as a readable merge (MX project notes, mx-contracts, section 3).
**Cons:** the extended `resource` must still be one entry, so one module has to import and rewrite another's, which hits both the whole-entry rule and the unstamped imports. Mesh's own answer: it "will not rely on that" (Mesh's answers to MX on `mx.contracts`, 2026-10-04, Q1, Q5).

### Option C: Ask MX for field-level merge
| Dimension | Assessment |
|-----------|------------|
| Complexity | Falls on MX |
| Cost | A new MX feature and a wait |
| Reversibility | Easy for Mesh: it can stop using the feature |
| Fit with ruling 5 | MX cannot check contribution points |

**Pros:** no generator in Mesh.
**Cons:** MX rejected merging: error messages from a half-merged `children` would be unexplainable, and it is unclear which side's `parseOptions` wins (MX project notes, mx-contracts, section 3). Mesh also does not want it (Mesh's answers to MX on `mx.contracts`, 2026-10-04, Q5).

## Trade-off analysis

A is the only option that needs nothing from MX and keeps the ruling-5 check in Mesh. B and C both push composition into a place that cannot check contribution points.

## Consequences

Easier: adding tags in an extension; one file for MX tooling to read. Harder: the generated module must stay byte-stable. Revisit when MX ships editor dispatch for data files.

## Action items
- [ ] M6: composition code in `packages/compiler`, bundled module, guard, test that the module loads through MX's scan with the same tag names as the in-memory composition.
- [ ] M6: name the module in `package.json#mx.contracts`.
- [ ] M6: extensions declare their tag contracts with MX's contract types.
