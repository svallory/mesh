---
title: "0039. Run-time errors carry `.mx` positions as embedded data"
description: "Decision record 0039: Run-time errors carry `.mx` positions as embedded data. Status: Proposed."
---

# 0039. Run-time errors carry `.mx` positions as embedded data

## Status

Proposed

## Date

2026-10-04

## Deciders

lead (provisional acceptance of the roadmap author's recommendation); operator may overrule. Must be ruled before M5.

## Context

Mesh generates TypeScript from `.mx` resource files and commits it ([ADR-0003](./0003-generated-code-carries-behaviour.md)). When a declared rule fails at run time (a validation, a policy), a developer wants to know which line of the `.mx` file declared it, not only where the generated code threw.

A source map is a file that maps positions in generated code back to the original source, so a debugger or error reporter can show the original line. An embedded position is simpler: the generated code carries the file, line and column of the declaring tag as plain data and puts it in the error it raises.

Two facts shape the choice. Bun's `findSourceMap` always returns `undefined`, so the Node API for run-time mapping does not work there, and "the runtime half of 'stack traces resolve to `.mx`' needs a mechanism other than the Node API" ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 8, "Bun facts", compatibility table and the note after it; [research synthesis](../research/synthesis.md), section 12, risk 3). And Wasp, a framework that generates code from a declarative spec, has no mapping at all: "Source mapping. None." ([TypeScript prior art](../research/ts-prior-art.md), section 4.2). The old plan wanted source maps (pipeline stage 7; [plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 6, "Not scheduled").

Plan revision 2 (the roadmap author) recommended "Embedded positions in v1; revisit at M14", and the lead accepted it ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.1, Q11). The operator's Review note says the lead accepted that answer "in one line without analysis" and it is provisional ([rulings of 2026-10-04](./rulings-2026-10-04.md), "Review note"). M14 no longer exists ([ADR-0025](./0025-bun-only.md)), so that trigger is gone; this record proposes (it is not in the roadmap) to revisit it when the single-binary item is picked up after v1.

## Decision

Not decided. Recommendation: embedded positions in v1, no source maps, as the roadmap currently assumes ([roadmap](../roadmap/roadmap.md), M5: "A declared rule that fails at run time reports its `.mx` position, carried as data in the generated code").

This blocks the error-class design in M5. The lead accepted the roadmap author's recommendation provisionally; the operator may overrule.

## Options considered

### Option A: Embedded positions (recommended)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low. The emitter writes a position next to each declared rule. |
| Cost | A few bytes per rule in generated code. |
| Coverage | Declared rules only. Other errors point at generated code. |
| Dependence on runtime | None. Works wherever the code runs. |

**Pros:** Works on Bun today. The generated file is committed and readable, and the first frame outside Mesh packages is the generated handler (roadmap, M2 test 3), so non-rule errors are still traceable.
**Cons:** Covers only positions the emitter chose to embed. Opaque TypeScript copied from the `.mx` file ([ADR-0010](./0010-one-expression-tree-two-evaluators.md)) is reported at generated lines, not original ones. Positions go stale if the `.mx` file is edited and not rebuilt, though the guard catches that by regenerating.

### Option B: Source maps

| Dimension | Assessment |
|-----------|------------|
| Complexity | High. The emitter must produce maps, and every output stage must preserve them. |
| Cost | Maps to generate, commit and keep in sync; a consumer to read them at run time. |
| Coverage | Any stack frame. |
| Dependence on runtime | High. `findSourceMap` returns nothing on Bun, so a Mesh-owned reader would be needed. |

**Pros:** Maps every frame, including opaque code.
**Cons:** The prior art has none (Wasp); the Bun gap means building the reader yourself; committed generated files make maps another artifact to guard. How a map reader behaves on Bun's single binary is not checked.

### Option C: Both

| Dimension | Assessment |
|-----------|------------|
| Complexity | Highest. |
| Cost | Sum of A and B. |
| Coverage | Best. |
| Dependence on runtime | As B. |

**Pros:** Embedded positions give a reliable minimum; maps add depth.
**Cons:** Two mechanisms for one need, against "one way to do each thing".

## Trade-off analysis

A gives the useful case (a user's declared rule fails, here is the line) for little cost and no runtime dependency. B gives more, at the price of work that nothing in the research shows anyone has done in this setting. C can be added later without undoing A, so deferring B loses little.

## Consequences

- Easier: M5 can define its error classes now.
- Harder: opaque code errors cite generated lines.
- Revisit: when the single-binary item is picked up after v1, with real error reports, before investing in maps.

## Action items

- [ ] Before M5: operator or lead rules on this ADR.
- [ ] M5: add a `position` field to the declared-rule error classes and a test that asserts it.
- [ ] After v1: when the single-binary item is picked up, revisit source maps if opaque-code errors prove hard to debug.
