---
title: "0028. Generated validators are Zod schemas, seen through Standard Schema"
description: "Decision record 0028: Generated validators are Zod schemas, seen through Standard Schema. Status: Accepted."
---

# 0028. Generated validators are Zod schemas, seen through Standard Schema

## Status

Accepted

## Date

2026-10-04

## Deciders

lead, operator may overrule; the recommendation is the roadmap author's (plan revision 2, question N1)

## Context

Every action in Mesh takes input from a caller. Mesh generates the code that checks that input: only declared fields pass, types are right, unknown fields are rejected ([roadmap](../roadmap/roadmap.md), M2). Something has to do the checking.

Zod and Valibot are TypeScript validation libraries. Standard Schema is a small shared interface, `@standard-schema/spec`, that many validation libraries implement so a tool can call `validate` on any of them without library-specific code. The research names it one of four neutral contracts to use wherever they fit ([research synthesis](../research/synthesis.md), section 9) and lists "Validators generated from the model, exposed as Standard Schema" as the validation layer (section 10, "Validation" row). One limit: a Standard Schema value is opaque. It exposes a validation function and types, but you cannot read fields or defaults off it ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 4, "Validation layer"). That matters less for Mesh, which generates validators from its own model and so already holds the field list.

Plan revision 2, written by the roadmap author, raised the library choice as question N1 and recommended Zod ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.2). The lead accepted it: "N1 Zod behind Standard Schema: accepted." ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief").

## Decision

The lead decided, 2026-10-04, on the roadmap author's recommendation: generated input validators are Zod schemas, and the rest of Mesh sees them only through Standard Schema. The plan's reason: Zod is "the most established of the three, and the rest of Mesh sees only Standard Schema, so it can be swapped" ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.2, N1). The operator has not ruled; this follows the operator's standing preference for established tools ([ADR-0030](./0030-established-tools-first.md)).

## Options considered

### Option A: Zod behind Standard Schema (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low. Emit schemas; call `~standard.validate`. |
| Cost | One dependency in every generated application. |
| Reversibility | High, as long as nothing imports Zod's own API outside generated files. |
| Adoption | Highest: `zod` 4.6.5, about 360 million weekly downloads (07, section 1, "Schema and validation"). |

**Pros:** Most used; pure JavaScript, so it runs on Bun (07, section 3 table). Both candidate HTTP frameworks accept Standard Schema (07, Summary), so a later HTTP adapter needs no conversion.
**Cons:** Valibot is smaller ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.2, N1), which matters for a single binary. The size of either in a compiled binary is not checked. 77% of commits come from five people (07 table), the bus-factor pattern the synthesis warns about for most candidates (synthesis, section 12, risk 6).

### Option B: Valibot behind Standard Schema

| Dimension | Assessment |
|-----------|------------|
| Complexity | Same as A. |
| Cost | Same; smaller output (per the plan; not measured). |
| Reversibility | Same as A. |
| Adoption | `valibot` 1.5.0, about 24 million weekly downloads, 83% of commits from five people (07 table). |

**Pros:** Smaller, as the plan notes.
**Cons:** Fewer users; no evidence in the research that it is better for Mesh's use.

### Option C: Mesh's own cast functions

| Dimension | Assessment |
|-----------|------------|
| Complexity | Higher: Mesh owns coercion, error messages, edge cases. |
| Cost | Build and maintain forever. |
| Reversibility | Hard to replace once errors are part of the public API. |
| Fit with [ADR-0030](./0030-established-tools-first.md) | Poor. |

**Pros:** No dependency; exact control over error shape.
**Cons:** Rebuilds something established; the plan recommended option (a), Zod, over it ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.2, N1).

## Trade-off analysis

All three options give the same behaviour to users. They differ in who maintains the code and what ships. Standard Schema makes A and B interchangeable at run time, so the choice can be corrected cheaply. C is the only irreversible one, which is why it lost.

## Consequences

- Easier: M2 emits schemas with no hand-written casting; unknown fields are rejected by the library.
- Harder: errors take the shape Zod gives them; Mesh maps them into its own error classes.
- Revisit: binary size, when the single binary is measured after v1.

## Action items

- [ ] M2: generate Zod schemas; add an import check that only generated validator files name Zod.
- [ ] M2: wrap validation so only `~standard.validate` results reach the handler body.
- [ ] After v1: measure Zod against Valibot in the compiled binary.
