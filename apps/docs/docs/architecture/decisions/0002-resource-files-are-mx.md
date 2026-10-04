---
title: "0002. Resource files are `.mx`, read as a data tree through MX"
description: "Decision record 0002: Resource files are `.mx`, read as a data tree through MX. Status: Accepted."
---

# 0002. Resource files are `.mx`, read as a data tree through MX

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory); decided before the rulings of 2026-10-04 and recorded in the project's agent instructions. [ADR-0043](./0043-mx-is-core.md) later made MX core.

## Context

A Mesh *resource file* declares one piece of data, its actions and its rules. Mesh needs a way to write that file and a way to read it. MX is a separate project that parses Marko-syntax files; its `data` target returns a static tree of tags and attributes plus diagnostics and executes nothing (MX project notes, getting-started, section 1). A *tag contract* tells MX which attributes, children and parents a tag allows.

The original plan (2026-10-01, not published) proposed a first spike with plain TypeScript objects, "no parser, no MX". Wasp, a full-stack framework, deleted its own DSL in July 2026 ([TypeScript prior art](../research/ts-prior-art.md), Summary).

## Decision

The operator's rule, recorded in the project's agent instructions: resource files are `.mx`, Marko syntax parsed by MX. Mesh invents tag names, not a syntax. Mesh consumes a static data tree through `parseData` from `@mxlang/data`, with `structural: "reject"` and one `CustomTag` contract per tag name. It never re-parses `.mx` text; the tree is the semantics.

Since MX added the `unknownTags` option, Mesh also passes `unknownTags: "reject"`, so an undeclared tag at any depth is an error (MX project notes, updates, entry for `e65707a0`; [roadmap](../roadmap/roadmap.md), M1). [ADR-0043](./0043-mx-is-core.md) settles the consequence: MX is core, not an adapter, so there is no front-end contract and a second authoring syntax is not planned. Option B below is recorded as an alternative that was not taken.

## Options considered

### Option A: MX data tree (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low for Mesh: no parser, contracts check shape at parse time |
| Cost | Cheap to build; maintenance is tracking MX |
| Dependence on another project | High: Mesh consumes MX `main` with nothing pinned |
| Reversibility | Low: MX is core ([ADR-0043](./0043-mx-is-core.md)) |

**Pros:** Marko is an existing syntax, so "the off-distribution risk for a coding agent is the tag vocabulary, not the syntax" ([research synthesis](../research/synthesis.md), section 7). Expressions arrive as parsed Babel nodes, so Mesh needs no expression parser (MX project notes, getting-started, section 1).
**Cons:** A breaking MX change stops Mesh the same day ([roadmap](../roadmap/roadmap.md), section 9, risk 2). `parseData` stops at the first error per file and editors do not yet show diagnostics for data files (MX project notes, getting-started, section 1).

### Option B: TypeScript object-literal declarations

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest at first; functions inside the objects are the hard part |
| Cost | Mesh would own a TypeScript front end on oxc or SWC, since TypeScript 7.0 ships no compiler API |
| Expression handling | Weak: runtime parsing of arrow functions loses closures |
| Reversibility | High |

**Pros:** Wasp moved its app definition to a TypeScript file ([TypeScript prior art](../research/ts-prior-art.md), section 1.3). Editors and `tsc` work today, with no MX dependency.
**Cons:** Libraries that parse arrow functions at run time lose captured variables; a build-time parser means TypeScript 6, oxc or SWC ([TypeScript prior art](../research/ts-prior-art.md), Summary).

### Option C: A custom DSL with its own parser

| Dimension | Assessment |
|-----------|------------|
| Complexity | Highest: grammar, parser, errors |
| Cost | Highest, and permanent |
| Error quality | Best: messages can be tailored |
| Reversibility | Low |

**Pros:** ZenStack, with its own ZModel schema language, is maintained (v3.9.7, 2026-09-30; [TypeScript prior art](../research/ts-prior-art.md), section 1.1).
**Cons:** "A custom language carries a permanent editor-tooling tax" ([research synthesis](../research/synthesis.md), section 7). Wasp's stated reasons for deleting its DSL include editor-tooling cost ([TypeScript prior art](../research/ts-prior-art.md), Summary).

### Option D: Decorated classes

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low to start |
| Cost | Low |
| Fit with [ADR-0003](./0003-generated-code-carries-behaviour.md) | Poor: Remult is listed as "Runtime" reflection, generated code not committed |
| Reversibility | Low |

**Pros:** Familiar to TypeScript developers; Remult ships this way ([TypeScript prior art](../research/ts-prior-art.md), sections 1.2 and 2).
**Cons:** Behaviour stays in the library, the opposite of [ADR-0003](./0003-generated-code-carries-behaviour.md).

## Trade-off analysis

The choice trades dependence on MX for not owning a parser or an editor story. The operator accepted that dependence and later made it permanent ([ADR-0043](./0043-mx-is-core.md)).

## Consequences

- Easier: Mesh designs only tag names; MX reports shape errors with positions.
- Harder: Mesh depends on MX's schedule and on `main`; no CI until MX is published ([ADR-0031](./0031-no-ci-until-mx-is-published.md)).
- Revisit: the vocabulary is reviewed after v1 ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md)).

## Action items

- [ ] M1: call `parseData` with `structural` and `unknownTags` set to reject.
- [ ] M1: pass the contracts directly as `customTags`.
