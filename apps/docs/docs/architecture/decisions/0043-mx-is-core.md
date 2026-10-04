---
title: "0043. MX is core, not an adapter"
description: "Decision record 0043: MX is core, not an adapter. Status: Accepted."
---

# 0043. MX is core, not an adapter

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (the ruling); lead (which packages may import MX, checked by `verify`); roadmap author (where the load stages live). The operator may overrule the lead, and either may overrule the roadmap author

## Context

Mesh resource files are `.mx` files: Marko syntax, parsed by MX, a separate project. Mesh never parses that text itself; it calls `parseData` from the package `@mxlang/data` and receives a static tree of tags and attributes, with each expression already parsed into a Babel syntax node (MX project notes, getting-started, section 1). [ADR-0002](./0002-resource-files-are-mx.md) records that choice of syntax.

Mesh's architecture has three rings ([ADR-0001](./0001-three-rings.md)): core is what Mesh cannot work without, an adapter is one replaceable implementation of a contract core owns, an extension is an optional feature. The research synthesis proposed putting the authoring syntax in the adapter ring: its ring table lists "Front end (Marko by default)" and "Expression parser" under adapters ([research synthesis](../research/synthesis.md), section 15), and its table of layers names "TypeScript declarations as a second front end" (same file, section 10, "Authoring syntax" row). Plan revision 2 followed that proposal with a package `frontend-mx` in the adapter ring ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 3.2), and its first milestone was going to move the tag contracts there (same file, M0).

The question is whether a Mesh project could ever swap MX for something else, and whether the code should be shaped as if it could.

## Decision

Ruling, operator, 2026-10-04, recorded in [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings after the decision review", row "MX":

> MX is not replaceable: it is core, not an adapter. No "front end" adapter slot and no `frontend-mx` package; the tag contracts live in the core compiler package.

So there is no front-end contract, no front-end adapter, and the tag contracts live in `packages/compiler`.

Three things follow that the ruling does not spell out. The first two are the roadmap author's reading of it ([roadmap](../roadmap/roadmap.md), section 3 and M1); the third is the lead's decision ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief"). The build stages that load a resource file and check its structure live in `compiler` too. The expression-parser slot of the synthesis ring table disappears for the same reason: expressions arrive from MX as Babel nodes. And MX is imported only by packages that declare tag contracts, which is `compiler` and, from M6, extensions; `model` and `runtime` never import it, and `verify` checks that.

## Options considered

### Option A: MX is core (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: one fewer package, one fewer contract |
| Cost | Low to build; the cost is a hard dependency on a project Mesh does not control |
| Honesty of the abstraction | High: the code says what is true, that the vocabulary is written as MX tag contracts |
| Reversibility | Low: the vocabulary, its `analyze` rules and every positioned error are MX-shaped |

**Pros:** No contract to design for a second implementation nobody plans. The vocabulary has one source, the MX tag contracts ([ADR-0037](./0037-vocabulary-source-of-truth.md) discusses what else needs a registry). Errors keep MX's source positions end to end.
**Cons:** Mesh cannot run, or even be tested, without MX; MX is consumed from its `main` branch with nothing pinned (MX project notes, getting-started, section 5), and is not yet published, which is why Mesh has no continuous integration ([ADR-0031](./0031-no-ci-until-mx-is-published.md)). A breaking change in MX stops Mesh the same day.

### Option B: A front-end adapter slot, MX as its first implementation

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: a "declarations with source positions" contract between the front end and the model builder |
| Cost | Medium: the contract must be kept general with one implementation to test it against |
| Honesty of the abstraction | Low: tag contracts, `analyze` hooks and the composed contracts module ([ADR-0021](./0021-composed-contracts-module.md)) are MX concepts that would leak through any neutral contract |
| Reversibility | Higher on paper |

**Pros:** This is the synthesis's proposal (section 15). It would let a second syntax feed the same model, and it isolates Mesh's model builder from MX's tree shape.
**Cons:** An adapter contract with a single implementation is a guess. "It was in the plan" is not a reason to keep a slot ([ADR-0001](./0001-three-rings.md)).

### Option C: MX is core, isolated behind one module inside `compiler`

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low to medium: an internal module boundary, no published contract |
| Cost | Low: a convention and one import rule |
| Honesty of the abstraction | High: it claims nothing about replaceability |
| Reversibility | Somewhat better than A for the part that converts Babel nodes to Mesh's expression tree |

**Pros:** The ruling permits it. The code that touches MX's tree shape and Babel's node types stays in one place, so a change in either is absorbed there.
**Cons:** A boundary nobody outside `compiler` can see tends to erode; it needs the import rule to mean anything. Extensions still import MX's contract types for their own tags.

Writing resource declarations in TypeScript with no MX at all is not an option here: [ADR-0002](./0002-resource-files-are-mx.md) already decided the authoring syntax.

## Trade-off analysis

Option A is chosen, and the import rule gives it option C's boundary. Option B buys the ability to replace MX, and the operator has ruled that MX will not be replaced. Paying for a contract whose only purpose is a replacement that is ruled out would be exactly the hardcoding-in-reverse that the three-rings rule warns against: structure kept because a document proposed it. Option A accepts the real cost openly, a hard dependency on an unpublished project, and puts the mitigation where it belongs: MX is touched in one package, and nothing downstream of the model sees it.

## Consequences

- Easier: one package and one contract fewer; the M0 workspace layout puts `packages/compiler/src/contracts.ts` in `packages/compiler`.
- Easier: the three-rings description is simpler; two slots of the synthesis ring table (authoring syntax, expression parser) are gone.
- Harder: Mesh's build tool cannot be used without MX, and MX's release state gates Mesh's ([ADR-0031](./0031-no-ci-until-mx-is-published.md)).
- Kept on purpose: `model` and `runtime` do not import MX, so the generated program and everything that reads the model stay independent of it.
- To revisit: nothing scheduled. A second authoring syntax is not planned.

## Action items

- [x] M0: move the tag contracts, fixtures and tests to `packages/compiler` (done, PR #6).
- [ ] M1: implement load and check-structure in `compiler`; add the import rule to `verify` (`@mxlang/*` only in packages that declare tag contracts; never in `model` or `runtime`).
- [x] Remove the front-end and expression-parser slots from the three-rings page and the roadmap's adapter list (done).
