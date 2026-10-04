---
title: "0011. Translatable expressions run only as SQL"
description: "Decision record 0011: Translatable expressions run only as SQL. Status: Superseded by ADR-010."
---

# 0011. Translatable expressions run only as SQL

## Status

Superseded by [ADR-0010](./0010-one-expression-tree-two-evaluators.md)

## Date

2026-10-04

## Deciders

roadmap author, in plan revision 2; never accepted by the lead or the operator

## Context

Resource files hold small rules as arrow functions. Mesh converts the ones it can into an expression tree (a plain-data description of the computation). The question was whether that tree also needs an evaluator that runs on records already in memory, or only a compiler to SQL. Ash, the Elixir framework Mesh is modelled on, has both ([research synthesis](../research/synthesis.md), section 2.2).

## Decision

Plan revision 2 chose SQL only. Its M4 said: "There is no second, in-process evaluator of the tree: a translatable expression always runs in the database" ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M4). Open question N2 recommended dropping the hand-written in-memory data adapter for the same reason: it "removes a second implementation of expression semantics that Mesh would have to keep identical to SQL's by hand" (same file, section 9.2). Plan revision 1 (not published) had still planned that adapter with its own evaluator; the lead had accepted only the semantics answer to question Q10, "SQL's, documented" (same file, section 9.1), against that plan. N2 itself was never accepted; the lead's next word on it was to reconsider it ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief").

It seemed right because two evaluators drift apart: Ash's atomic and non-atomic update paths disagreed in bug #2969, and AshPostgres paid for forcing Elixir semantics on the database ([research synthesis](../research/synthesis.md), section 2.2).

**Why superseded.** [ADR-0010](./0010-one-expression-tree-two-evaluators.md) replaces it. The operator ruled, 2026-10-04, in [rulings of 2026-10-04](./rulings-2026-10-04.md), "Rulings after the decision review", row "Expressions":

> One expression tree, evaluated both in memory and in SQL (as Ash does). Replaces the plan's "translatable expressions only ever run as SQL" (plan Q10/N2).

## Options considered

### Option A: SQL only (this record)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: one semantics, one compiler |
| Cost | Lowest to build and maintain |
| Capability | A rule needing no stored data still needs a database |
| Reversibility | Adding an evaluator later means a second implementation per function |

**Pros:** no drift between evaluators; no null-comparison question.
**Cons:** validations on input alone, calculations on loaded records and in-process policy checks have no engine. The operator did not accept this.

### Option B: Two evaluators over one tree (ADR-0010)
| Dimension | Assessment |
|-----------|------------|
| Complexity | High |
| Cost | Two implementations per function |
| Capability | Rules run wherever the data is |
| Reversibility | Hard to remove once generated code depends on it |

**Pros:** what Ash does.
**Cons:** drift risk, guarded by shared function tables.

## Trade-off analysis

The plan traded capability for simplicity. The operator valued the capability and chose to carry the drift risk.

## Consequences

Anyone proposing "SQL only" again should know the operator has decided against it. The semantics question did not go away; it became [ADR-0012](./0012-expression-semantics.md).

## Action items
- [x] M4: replaced by [ADR-0010](./0010-one-expression-tree-two-evaluators.md) in roadmap revision 3 ([roadmap](../roadmap/roadmap.md), M4).
