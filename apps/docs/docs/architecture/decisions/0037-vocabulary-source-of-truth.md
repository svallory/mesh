---
title: "0037. Where the vocabulary is defined: contracts for tags, registries for values"
description: "Decision record 0037: Where the vocabulary is defined: contracts for tags, registries for values. Status: Proposed."
---

# 0037. Where the vocabulary is defined: contracts for tags, registries for values

## Status

Proposed

## Date

2026-10-04

## Deciders

open; the operator or the lead rules. The lead's one-line acceptance in plan revision 2 (Q2) is the working assumption

## Context

The vocabulary is the set of names a resource file may use ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md)). Its names now come from Ash's DSL, by the operator's ruling. Two kinds of name exist. *Tag names* (`resource`, `attribute`, `policy`) are checked by MX, the separate project that parses `.mx` files, through one tag contract per name ([ADR-0002](./0002-resource-files-are-mx.md)). *Value names* are lists of words that fill an attribute: the attribute types (`string`, `number`, `enum` and others), the expression functions an arrow function may call, the kinds of policy check. The question is which place defines each kind, so that one list is not copied into several files that drift apart.

Today the lists live inside the contracts: `ATTRIBUTE_TYPES` and `ACTION_TYPES` are constants in `packages/compiler/src/contracts.ts`. The compiler, the generated validators and the docs also need them, and extensions will add to them ([roadmap](../roadmap/roadmap.md), M6: an attribute type entry names its validator and column type per data adapter).

Drift is real in Ash: "Ash's own docs drift from its registries: 39 registered functions, about 30 documented" ([research synthesis](../research/synthesis.md), section 8, "Copy from Ash"). Ash's toolkit, Spark, declares each DSL as sections and entities with typed option schemas, and those same declarations generate cheat sheets, hover text and docs ([research synthesis](../research/synthesis.md), section 2.1; [Ash DSL and extensions](../research/ash-dsl-and-extensions.md), section 6).

MX is core ([ADR-0043](./0043-mx-is-core.md)), so the tag contracts live in `packages/compiler`, which imports MX, while `model` never imports MX. The lead accepted the first option below in plan revision 2 (Q2) in one line; the "Review note" calls that provisional ([rulings of 2026-10-04](./rulings-2026-10-04.md), "Review note"; [plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.1).

## Decision

Not decided. Recommendation: Option A, the working assumption in the roadmap. It blocks the registry-against-contract drift test in M1 ([roadmap](../roadmap/roadmap.md), M1, test 6) and the shape of the M6 manifest.

## Options considered

### Option A: Contracts own tag names; registries own value lists; a drift test links them
Registries live in `model`; the contract's `type` enum is built from the registry; a test fails if they differ ([roadmap](../roadmap/roadmap.md), M1). Because `model` cannot import MX, value lists have to be defined there for the contracts in `compiler` to read.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: two places and one test |
| Cost | Small in M1 |
| Reversibility | Good: either side can later be generated from the other |
| Fit with extensions | Good: an extension adds to a registry; the composed contract reads it ([ADR-0021](./0021-composed-contracts-module.md)) |

**Pros:** MX already describes tags, including conditional rules in its `analyze` hook that no plain declaration expresses (Mesh's answers to MX on `mx.contracts`, 2026-10-04, "What Mesh is"); the compiler needs value lists without importing MX.
**Cons:** tag names exist only in contracts, so docs and tooling must read them from there; the drift test checks only the names it lists.

### Option B: A syntax-neutral vocabulary registry; contracts generated from it (Spark's shape)
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: Mesh defines its own description language for tags and a generator |
| Cost | High; it duplicates what MX contracts already express |
| Reversibility | Hard |
| One list for docs, errors and both evaluators | Best: a single source, but tags and values alike need Mesh's own description format |

**Pros:** one declaration drives contracts, docs, error messages and editor help, which the researcher recommends in spirit ("derive that metadata from a single declaration", [Ash DSL and extensions](../research/ash-dsl-and-extensions.md), "Implications for Mesh", item 5).
**Cons:** MX contracts already describe tags, so Mesh would build and maintain a second description format and a generator; the conditional `analyze` rules must be expressed in it or kept as hand-written code anyway. Option A already gives value lists a single home (the registries), which covers the most drift-prone part.

### Option C: Contracts only, no registries
| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest |
| Cost | Lowest now |
| Reversibility | Medium |
| Fit with extensions | Poor: an extension's attribute type or function has no registry to join |

**Pros:** no drift test, one file, nothing new to build.
**Cons:** the lists stay constants inside `packages/compiler/src/contracts.ts`. Anything that needs them outside the contracts (generated validators, `runtime` function tables, docs, error messages) must import from the compiler, which `runtime` may not, or copy them, which is the drift the registries prevent. It also contradicts the synthesis advice of one registry per vocabulary ([research synthesis](../research/synthesis.md), section 8). The M4 function tables, which both evaluators must satisfy, need a list that is not owned by the contracts.

## Trade-off analysis

C leaves value lists with no home outside the compiler, B rebuilds part of MX's job for a gain the registries already give for values. A is cheapest and keeps B reachable.

## Consequences

If A: easier to add values from an extension; tag docs depend on contracts. Revisit if tag documentation or error messages start to drift from the contracts.

## Action items
- [ ] M1: registries in `model`; `type` enum from the registry; drift test.
- [ ] M1: the operator or the lead confirms or changes this ADR before the registries are written.
