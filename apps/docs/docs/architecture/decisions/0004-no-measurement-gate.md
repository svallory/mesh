---
title: "0004. Mesh is built regardless; the agent-benefit measurement is not a gate"
description: "Decision record 0004: Mesh is built regardless; the agent-benefit measurement is not a gate. Status: Accepted."
---

# 0004. Mesh is built regardless; the agent-benefit measurement is not a gate

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory), Ruling 1

## Context

Mesh exists because of an experiment: the same daemon engine was built in Elixir with Ash and in TypeScript, and the Ash version took fewer round trips, tokens and time and had fewer bugs when an LLM agent built it. The working theory is that the declarative resource model, not Elixir, produced the win (the original plan of 2026-10-01, not published). That plan defined a "Phase 0 spike" to test it with plain TypeScript objects before building the compiler, and named "density win doesn't transfer to TS" as a risk to the premise.

The research argued that the measurement should come first. Its section 7 found that "Nobody has measured this": Wasp's benchmark is one vendor-run test per arm with no correctness measure; Convex's +20% pass rate measures curated rules files, not language design; one controlled study (arXiv 2602.11198) cuts both ways; field reports conflict. Its conclusion: "the plan's Phase 0 spike is not a formality. It is the only experiment anyone will have run on this question, and it should gate everything after it" ([research synthesis](../research/synthesis.md), section 7).

## Decision

The operator ruled on 2026-10-04, in Ruling 1 of [rulings of 2026-10-04](./rulings-2026-10-04.md) (question "Measure the agent hypothesis before building?"):

> No. Mesh is built regardless. The measurement is not a gate.

The later ruling "Order of work" confirms it: "Framework code (M0 onward) starts once the roadmap and decision records are published; nothing else gates it" (same file, "Rulings after the decision review"). The roadmap's traceability table records the effect: "none; nothing waits on a measurement" ([roadmap](../roadmap/roadmap.md), section 8).

The rulings do not say whether the measurement will ever run, and no roadmap milestone measures agent performance ([roadmap](../roadmap/roadmap.md), section 8, row "Ruling 1").

## Options considered

### Option A: Build regardless (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest: no experiment design |
| Cost | Lowest now; the build effort is at risk if the premise is false |
| Risk | The premise may fail after much of the work is done |
| Reversibility | Low: v1 is ten milestones ([ADR-0019](./0019-v1-scope.md)) |

**Pros:** Starts immediately. Ash's ranked strengths do not depend on agents: derived operations arriving complete, authorization as data, one declaration feeding many surfaces ([research synthesis](../research/synthesis.md), section 5). Mesh copies that design.
**Cons:** If frontier models do worse on the tag vocabulary than on plain TypeScript, the main motive is gone. The one team that removed Ash reports that models "struggle with Ash" (same file, section 7).

### Option B: A Phase 0 spike gates everything

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: a fair comparison needs the same application in both forms |
| Cost | One more piece of work before any framework code |
| Risk | Lowest: the premise is tested first |
| Reversibility | High: nothing built yet to lose |

**Pros:** It is "the only experiment anyone will have run on this question" ([research synthesis](../research/synthesis.md), section 7).
**Cons:** The result is uncertain, since the literature is mixed. A spike with object literals does not test the `.mx` vocabulary, which the research names as the real risk (same section). It delays all work.

### Option C: Measure in parallel without gating

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: a second track |
| Cost | Moderate; competes for the same people |
| Risk | Information arrives while work continues |
| Reversibility | High |

**Pros:** Evidence arrives without delaying the build, and it could change later priorities.
**Cons:** Nothing forces anyone to act on the result. This option is not in the rulings; it is listed because someone could defend it.

## Trade-off analysis

The operator took the schedule over the evidence: the ruling declines to wait for a result. Option C is compatible with it but not scheduled.

## Consequences

- Easier: M0 can start as soon as the roadmap and ADR set are published.
- Harder: if the premise fails, the framework still exists and needs a different justification.
- Revisit: whether to run any agent measurement, and on which milestone's output (M2 is the first runnable example).

## Action items

- [ ] M0: none; nothing waits on a measurement.
- [ ] after v1: the operator may decide whether to run an agent comparison on `examples/blog`; no one has scheduled it.
