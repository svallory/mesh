---
title: "0020. Extensions contribute to each other only through declared points"
description: "Decision record 0020: Extensions contribute to each other only through declared points. Status: Accepted, amended by ADR-0072, ADR-0075."
---

# 0020. Extensions contribute to each other only through declared points

> **Amended** by [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) and [ADR-0075](./0075-seams-use-the-extension-hosts-names.md) on 2026-10-10: The extension host comes after Mesh 1.0; the lifecycle seams that an extension would use are built first, for the application. The body below is kept as history.

## Status

Accepted

Amended by [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) and [ADR-0075](./0075-seams-use-the-extension-hosts-names.md) (2026-10-10): The extension host comes after Mesh 1.0; the lifecycle seams that an extension would use are built first, for the application.

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

An *extension* in Mesh is an optional feature built on core's extension points ([ADR-0001](./0001-three-rings.md)), for example the policies extension. Extensions change the *model*, the plain-data description of each resource that the build pipeline passes from stage to stage. The open question was whether one extension may change the part of the model another extension owns ([research synthesis](../research/synthesis.md), section 19, question 5).

Ash, the Elixir framework Mesh is modelled on, lets this happen with no check. AshPaperTrail, an audit extension, "inserts entities straight into AshPostgres's `references` section. It works, and nothing checks it" ([research synthesis](../research/synthesis.md), section 3, item 2; [Ash DSL and extensions](../research/ash-dsl-and-extensions.md), section 9, row 41). Ordering between extension transforms is also unreliable: "A contradictory pair is dropped silently, and cycles are broken silently" ([research synthesis](../research/synthesis.md), section 2.1), with live casualties in AshArchival, AshPaperTrail and Ash core ([Ash DSL and extensions](../research/ash-dsl-and-extensions.md), sections 2.5 and 8.4). Tooling callbacks are duck-typed: seven optional callbacks, and no module in the cloned packages declares the behaviour (same file, section 7.3).

## Decision

Ruling 5, operator, 2026-10-04, [rulings of 2026-10-04](./rulings-2026-10-04.md), table of eight rulings:

> Only through contribution points the owning extension publishes and the contributor declares in its manifest. Anything else is a build error.

The following is the roadmap author's design ([roadmap](../roadmap/roadmap.md), M6), not part of the ruling. Each extension has one typed manifest listing the tags, transforms, verifiers, emitters and contribution points it publishes and uses. Transforms run in named phases; a cycle is a hard error and the resolved order is printed ([research synthesis](../research/synthesis.md), section 8, "Do differently"). An undeclared write to another extension's part of the model fails the build and names both extensions (roadmap, M6 test 2).

## Options considered

### Option A: Declared contribution points (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: manifest type, ownership tracking for model parts, a check on every transform |
| Cost | Moderate in M6; every new cross-extension feature needs a published point first |
| Failure timing | Build time, naming both extensions |
| Fit with ring rule | Core need not know extension tags ([ADR-0001](./0001-three-rings.md)) |

**Pros:** the PaperTrail-style link stays possible but is visible and checked; the manifest also drives docs and ordering.
**Cons:** the owning extension must anticipate what others need; a missing point blocks a contributor until the owner ships one. Ownership tracking is new code with no Ash equivalent to copy. An extension that adds tags declares its own tag contracts, so it imports MX's contract types and depends on MX ([ADR-0043](./0043-mx-is-core.md)); the composition happens in `packages/compiler` ([ADR-0021](./0021-composed-contracts-module.md)).

### Option B: Forbid cross-extension contribution
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Cost | Lowest |
| Failure timing | Build time |
| Fit with ring rule | Poor: a feature that adds a tag to `resource` cannot exist outside core |

**Pros:** simplest rule; no way to create hidden coupling. The Ash maintainers lean this way for the declared mechanism: Spark's `dsl_patches` can only add entities to another extension's section, and a request to replace or delete was refused because "allowing extensions to overwrite entities by other extensions is a whole can of worms" ([Ash DSL and extensions](../research/ash-dsl-and-extensions.md), section 3.2). Ash still lets a transform bypass that mechanism (Option C).
**Cons:** policies must add a `policies` section under `resource` (roadmap, M8), so core would have to list every extension's tags, which breaks "anything optional is an extension".

### Option C: Free writes, as in Ash
| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest to build |
| Cost | Low now, high in debugging later |
| Failure timing | Run time or never |
| Fit with ring rule | Works, but coupling is invisible |

**Pros:** nothing to build; extensions like PaperTrail work today.
**Cons:** the failures in Context. A change in one extension silently breaks another.

## Trade-off analysis

B fails the ring rule, C repeats Ash's documented failures. The synthesis offered exactly the choice "either forbidden, or declared in the extension manifest" ([research synthesis](../research/synthesis.md), section 8, "Do differently"); A is the one that keeps extensions optional.

## Consequences

Easier: reading what an extension touches; testing an extension alone. Harder: designing an extension that others build on, since its points are API. Revisit if no extension ever publishes a point besides `resource` children.

## Action items
- [ ] M6: manifest type, ownership check, named phases, cycle error, printed order.
- [ ] M6: test extension proving the declared and the undeclared case (roadmap, M6 tests 1 to 3).
- [ ] M8: first real use, the policy tags.
