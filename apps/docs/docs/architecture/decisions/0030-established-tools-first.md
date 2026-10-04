---
title: "0030. Established tools first, each behind a Mesh contract"
description: "Decision record 0030: Established tools first, each behind a Mesh contract. Status: Accepted."
---

# 0030. Established tools first, each behind a Mesh contract

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory), as a standing position; the lead for the specific tool choices (Drizzle, drizzle-kit)

## Context

Mesh is a TypeScript framework modelled on Ash, the declarative resource framework for Elixir. Building it means choosing, many times, between writing a component and adopting someone else's: a query builder, migrations, validation, tracing, a code formatter, a docs generator.

The operator stated a position when ruling on how SQL is produced. The implementation-plan rulings table records it as: "Rely on established tools wherever possible (operator's standing position)" ([rulings of 2026-10-04](./rulings-2026-10-04.md), "Implementation-plan rulings", row Q3). The Review note, written later the same day, restates it and separates it from the lead's follow-up choices: it "records the operator's position ('the more we can rely on well-established tools the better'); choosing Drizzle and drizzle-kit specifically was the lead's application of it" (same file, "Review note").

The roadmap turned this into principle 7 and a "Build or reuse" table ([roadmap](../roadmap/roadmap.md), sections 2 and 7).

## Decision

Recorded as the operator's standing position, 2026-10-04, quoted above. In practice: before building anything, look for a well-established tool and put it behind a Mesh contract. Mesh builds only what nothing reusable covers: the expression tree and its two evaluators, the build pipeline and extension host, the generated lifecycle, the simple policy engine, and the conformance suite (roadmap, section 7).

The contract half of the rule is Mesh's, not stated in the ruling. It follows the synthesis finding that for data access "the contract has to be Mesh's own" while "the query library inside an adapter is that adapter's private choice" ([research synthesis](../research/synthesis.md), section 11).

## Options considered

### Option A: Established tools behind Mesh contracts (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium. Each tool needs a contract and a confined import boundary. |
| Cost | Low to build components; recurring cost of upgrades and contract upkeep. |
| Reversibility | High where the contract is real (Drizzle is imported only under `packages/data-*`). |
| Dependency risk | Mesh inherits each tool's maturity. |

**Pros:** Less code to write and own. A tool can be replaced without touching hand-written code or core. Where a tool appears in generated code (Zod in [ADR-0028](./0028-validation-zod-behind-standard-schema.md), the OpenTelemetry API in [ADR-0029](./0029-tracing-opentelemetry-api.md)), a swap means regenerating.
**Cons:** Dependency risk is real. Drizzle v1 is a release candidate, its relations API is being replaced, and drizzle-kit is mid-rewrite (synthesis, section 12, risk 1, and section 10, "Migrations" row). Most candidates take 60 to 97% of commits from five people (risk 6). There is also tension with [ADR-0001](./0001-three-rings.md): that rule keeps core small ("only what Mesh cannot run without is core"), and adopting a tool inside an adapter must not leak into core. Contracts cost design time, and a bad contract is its own failure (Ash's has 46 callbacks and 47 capability names, applied inconsistently; synthesis, section 2.2).

### Option B: Build in-house for control

| Dimension | Assessment |
|-----------|------------|
| Complexity | High: Mesh owns every component. |
| Cost | Highest. |
| Reversibility | Low once users depend on behaviour. |
| Control | Full. |

**Pros:** No third-party release risk; behaviour matches Mesh's rules exactly.
**Cons:** Mesh is small and early; this spends effort on components that are not its point. The old plan's SQL printed by Mesh ([ADR-0015](./0015-sql-printed-by-mesh.md)) was this choice for queries, and was reversed.

### Option C: Established tools without contracts

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest at first. |
| Cost | Cheap now, expensive at swap. |
| Reversibility | Poor. |
| Coupling | High. |

**Pros:** No design work.
**Cons:** Tool types leak into generated code and public APIs. The research shows this: a typed client built from `typeof app` bakes the server framework's types into the client, so "swapping HTTP frameworks is a breaking change for every frontend consumer" ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 5, "HTTP").

## Trade-off analysis

The rule trades build effort for dependency risk and spends some of that saving on contracts to bound the risk. It works where the contract is Mesh's own shape (data layer, tracing through a standard API, validation through Standard Schema). It works less well where the tool is the contract (OpenTelemetry), but there the standard is itself neutral.

## Consequences

- Easier: small v1 scope; clear answer to "build or adopt" in review.
- Harder: version pinning and upgrade pull requests; keeping tool types out of core and generated code.
- Revisit: whenever a pinned tool stalls or a bus-factor event occurs.

## Action items

- [ ] M1: record the "Build or reuse" table in the Architecture docs.
- [ ] M2: add the import check that confines Drizzle to `data-*` (roadmap, M2 test 4).
- [ ] Each milestone: list new tools adopted with their pins and the contract in front.
