---
title: "0023. Workflows, jobs and the outbox are deferred; the adapter interface stays a design document"
description: "Decision record 0023: Workflows, jobs and the outbox are deferred; the adapter interface stays a design document. Status: Accepted."
---

# 0023. Workflows, jobs and the outbox are deferred; the adapter interface stays a design document

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory) for the deferral; lead for the spike and for the sub-decisions listed below

## Context

A *durable workflow engine* runs a multi-step function so that it survives a crash or deploy: finished steps are recorded and not run again. A *job queue* runs independent background jobs with retries. An *outbox* is a table written in the same database transaction as an action, then relayed to the engine afterwards, so an event is never lost or sent for a rolled-back write. [durable engines](../research/durable-engines.md) compares six durable engines and three job queues, and proposes two adapter contracts, `JobQueueAdapter` and `WorkflowAdapter`, with an in-process runner as first implementation (sections 1 and 6).

The operator's first ruling on this ordered the in-process runner first (Ruling 7, see [ADR-0024](./0024-in-process-runner-first.md)). Plan revision 2, written by the roadmap author, therefore scheduled the outbox, jobs and workflows as milestones M11 and M12 ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M11 and M12).

## Decision

Review ruling, operator, 2026-10-04, [rulings of 2026-10-04](./rulings-2026-10-04.md), "Rulings after the decision review", row "After v1":

> M9 (bulk, identities, upserts; overrides the bulk half of ruling 3), M11 and M12 (outbox, jobs, workflows; replaces ruling 7's "in-process runner first"; the adapter interface stays a design document), M13 (agent and test surface), M14 (Node parity, single binary), M15 (HTTP).

Those are revision-2 numbers; in the roadmap the outbox, jobs and workflows sit in the "After v1" table ([roadmap](../roadmap/roadmap.md), section 6). Lead decisions ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief"): "Outbox relay and rule R3 are deferred with the workflow milestones. [durable engines](../research/durable-engines.md) stays the design input ... a small spike 'DBOS worker on Bun' precedes any engine choice. No engine is a clear winner (DBOS best fit on paper for workflows, pg-boss for plain jobs on Postgres)."

Five sub-decisions, taken by the lead in one line without analysis and therefore provisional ([rulings of 2026-10-04](./rulings-2026-10-04.md), "Review note"), which the future ADR must revisit ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.1):
- Loops as step families, not `for-each` or `parallel` tags (Q5; [durable engines](../research/durable-engines.md), section 8, question 2).
- Running workflows when code changes: a guard plus a version entry, no automated migration (Q6; section 6.6 leaves this to the operator).
- Outbox in core (Q7; section 8, question 3).
- A relay row older than the engine's dedupe window: stop and alert (Q7; section 8, question 4).
- Adopting the section 6.2 interface with rule R3 and the relay as is (Q14).

A sixth provisional answer from that list, the bulk transaction default (Q12), belongs to bulk actions, also after v1 ([ADR-0019](./0019-v1-scope.md)); that plan revisits it.

## Options considered

### Option A: Defer; keep the interface as design input (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | None in v1 |
| Cost | Zero code; one spike later |
| Evidence quality | Spike answers the open unknowns before any commitment |
| Reversibility | Complete: nothing is built |

**Pros:** v1 shrinks by two milestones; the sub-decisions above are not baked into generated code.
**Cons:** no multi-step operations or background jobs in v1; the design document can go stale, and without code its seams (stable step names, events in the same transaction) are untested.

### Option B: In-process runner first (ADR-0024)
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: journal tables, replay, polling, cancel |
| Cost | Largest thing in the plan that Mesh builds where established engines exist ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M12 risks) |
| Infrastructure | None: it runs on SQLite, which no compared engine does without a server ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 8.1) |
| Reversibility | Medium |

**Pros:** it can implement every capability, including a step committing with its checkpoint ([durable engines](../research/durable-engines.md), section 6.4).
**Cons:** that section calls it "a design claim; no code exists yet".

### Option C: Adopt an engine now
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | Low to build, ongoing dependency |
| Fit | DBOS is the best external fit: Postgres only, no server, transactional steps (section 7) |
| Reversibility | Hard once generated code targets it |

**Pros:** established tool ([ADR-0030](./0030-established-tools-first.md)).
**Cons:** DBOS worker support on Bun is unverified and a Bun crash report exists; whether Mesh's transaction can be a DBOS data source is untested (sections 2.4 and 8). It needs Postgres, which the roadmap delivers in M9.

## Trade-off analysis

A costs nothing now and lets evidence arrive first. B and C each commit Mesh to an unverified claim.

## Consequences

Easier: a shorter v1. Harder: later work must reopen five provisional choices. Revisit after v1, starting with the DBOS-on-Bun spike.

## Action items
- [ ] After v1: spike "DBOS worker on Bun", including the transaction question.
- [ ] After v1: new ADR for the adapter contract, deciding the five sub-decisions.
- [ ] After v1: keep [durable engines](../research/durable-engines.md) current as the design input, before the spike starts.
