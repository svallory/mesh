---
title: "0003. Generated code carries the behaviour"
description: "Decision record 0003: Generated code carries the behaviour. Status: Accepted."
---

# 0003. Generated code carries the behaviour

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory), Ruling 2. The test and the guard are the roadmap author's way of applying it.

## Context

From a resource file Mesh produces TypeScript: types, handlers (one function per action) and database schema. A design question is how much of what an action does (cast input, run validations and changes, check policy, open a transaction, call the data layer) is written into that generated file, and how much stays in a shared library that the generated file calls.

Ash, the Elixir framework Mesh is modelled on, keeps behaviour in its library. The research ties two complaints to that: "Behaviour lives in the library, so traces are unhelpful and test coverage of your own resource reads 0%" ([research synthesis](../research/synthesis.md), section 6, item 2). The synthesis flagged the question as an open gap: if generated handlers are thin calls into a shared core, "Mesh inherits Ash's coverage and stack-trace problems" (same file, section 8, gap 1).

## Decision

The operator ruled on 2026-10-04, in Ruling 2 of [rulings of 2026-10-04](./rulings-2026-10-04.md) (question "How much logic is generated per resource?"):

> As much as Ash puts in its resources, or more. Generated code carries the behaviour; the shared engine stays thin.

The roadmap turns this into a test: the run-time library never reads the resource model. Every decision that depends on the model is made at build time and written into the generated file ([roadmap](../roadmap/roadmap.md), section 2, principle 1). The generated tree is committed, and the `verify` script regenerates it and fails on any difference (same section, principle 6; [research synthesis](../research/synthesis.md), section 16, stage 8). One clarification, this record's own reasoning: M4 emits expression trees into the generated file as data literals. A literal is generated code, not the model, so the test still holds as long as generated code never imports `model` or `model.json` ([roadmap](../roadmap/roadmap.md), M2 test 4).

## Options considered

### Option A: Generate the whole lifecycle per action (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Higher: emitters per phase, plus the guard |
| Cost | Large generated output to review and keep deterministic |
| Debuggability | Best: the first stack frame is the generated handler |
| Reversibility | Low once users commit generated trees |

**Pros:** A user's resource shows in stack traces and coverage. Output is plain code.
**Cons:** The risk is named in the roadmap: "If generated handlers become unreadable, the point of Ruling 2 is lost" ([roadmap](../roadmap/roadmap.md), section 9, risk 6). A repeated pattern tempts authors to move it into the library; the roadmap allows only small pure helpers that take values, never the model (M5 risks). A fix in the library does not change already generated handlers until they are regenerated (this follows from the design; not in the sources).

### Option B: Thin generated handlers calling a shared engine

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest generated output |
| Cost | Cheapest to build and to review |
| Debuggability | Poor: Ash's shape |
| Reversibility | High |

**Pros:** Small diffs; library fixes reach every app on upgrade. This is how Ash works.
**Cons:** Ash's measured results: 0% coverage of the user's resource, unhelpful traces ([research synthesis](../research/synthesis.md), section 6, item 2).

### Option C: Interpret the model at run time, no code generation

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: no emitters, no guard |
| Cost | Lowest build step |
| Debuggability | Poor: the model is data, not code |
| Fit with the guard | None: nothing to commit |

**Pros:** Prior art exists. ZenStack v3 produces SQL at run time on every query, and Prisma 8 states that "query compilation happens at runtime" ([TypeScript prior art](../research/ts-prior-art.md), Summary).
**Cons:** Same traces and coverage problem as B, and no readable output for an agent to inspect.

## Trade-off analysis

Option A is the only one that fixes Ash's two named defects. Its price is volume and the discipline to keep output boring. The ruling says "or more" than Ash puts in its resources, so the volume cost is accepted.

## Consequences

- Easier: stack traces start in generated code; coverage tools see per-resource code; behaviour can be read without understanding a framework.
- Harder: the emitters carry the lifecycle; the guard must keep output byte-identical ([roadmap](../roadmap/roadmap.md), M1 tests 2 and 3).
- Revisit: after M5, check whether helper functions have crept in (roadmap, section 9, risk 6).

## Action items

- [ ] M2: generate one function per action with the steps in order, not a call to a generic `runAction`.
- [ ] M2: add the import-rule check and the stack-trace test (roadmap, M2 tests 3 and 4).
- [ ] M5: generate the full eight-phase lifecycle; review helpers added to `runtime`.
