---
title: "0024. The in-process runner is the first workflow adapter"
description: "Decision record 0024: The in-process runner is the first workflow adapter. Status: Superseded by ADR-023."
---

# 0024. The in-process runner is the first workflow adapter

## Status

Superseded by [ADR-0023](./0023-workflows-and-jobs-deferred.md)

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

Mesh's synthesis left durable workflows as an open question: "which engine, if any" ([research synthesis](../research/synthesis.md), section 19, question 7). A *durable workflow engine* runs a multi-step function so that finished steps survive a crash and are not run again. An *adapter* is one replaceable implementation of a contract that core owns ([ADR-0001](./0001-three-rings.md)). The synthesis table of adapters already read "Jobs and workflows: ... In-process runner first. Durable engines were inventoried, not compared" (section 10).

## Decision

Ruling 7, operator, 2026-10-04, [rulings of 2026-10-04](./rulings-2026-10-04.md), table of eight rulings, as first recorded:

> Compare durable engines now, with the goal of defining Mesh's workflow adapter interface. The in-process runner is the first adapter.

It seemed right for three reasons. The comparison ([durable engines](../research/durable-engines.md)) found that a runner keeping its journal in the application's own database can implement every operation, including committing a step with its checkpoint (section 6.4). It needs no extra infrastructure. And no compared engine runs on SQLite without a server: DBOS and pg-boss need Postgres, the rest need a server or a cloud ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 8.1, citing the comparison's section 3). Plan revision 2 therefore scheduled the runner as M12 ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M12).

**Why superseded.** [ADR-0023](./0023-workflows-and-jobs-deferred.md) replaces it. The operator ruled, 2026-10-04, in [rulings of 2026-10-04](./rulings-2026-10-04.md), "Rulings after the decision review", row "After v1", that the outbox, jobs and workflows milestones come after v1 and that this "replaces ruling 7's "in-process runner first"; the adapter interface stays a design document".

## Options considered

### Option A: In-process runner first (this record)
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: journal tables, replay of the workflow body, a polling loop, persisted cancel flags |
| Cost | The largest thing in plan revision 2 that Mesh builds where established engines exist ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M12 risks) |
| Infrastructure | None |
| Reversibility | Medium: the adapter contract limits what leaks |

**Pros:** works on SQLite; exercises the adapter contract with one real implementation; no dependency on an engine's Bun support.
**Cons:** "a design claim; no code exists yet" ([durable engines](../research/durable-engines.md), section 6.4); Mesh would own replay correctness, versioning of running workflows and the idempotency shim.

### Option B: Adopt DBOS first
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | Low to build; a dependency |
| Infrastructure | Postgres only |
| Reversibility | Hard once generated code targets it |

**Pros:** best external fit, transactional steps ([durable engines](../research/durable-engines.md), section 7).
**Cons:** Bun worker support unverified; needs Postgres, which plan revision 2 scheduled for M10.

### Option C: Job queue only (pg-boss)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Cost | Low |
| Infrastructure | Postgres |
| Reversibility | Easy |

**Pros:** enqueue and completion can join a transaction; Bun documented (section 7).
**Cons:** no multi-step workflows.

## Trade-off analysis

The operator picked A as the first adapter, which kept the cost inside Mesh and avoided depending on unverified engine support. The later review judged even that too large for v1.

## Consequences

Kept for the record so nobody proposes the runner as the obvious first step again without reading [ADR-0023](./0023-workflows-and-jobs-deferred.md)'s list of open sub-decisions.

## Action items
- [ ] After v1: see [ADR-0023](./0023-workflows-and-jobs-deferred.md) for what remains to be done.
