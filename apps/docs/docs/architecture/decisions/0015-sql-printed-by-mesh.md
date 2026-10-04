---
title: "0015. SQL printed by Mesh"
description: "Decision record 0015: SQL printed by Mesh. Status: Superseded by ADR-014."
---

# 0015. SQL printed by Mesh

## Status

Superseded by [ADR-0014](./0014-sql-adapters-on-drizzle.md)

## Date

2026-10-04

## Deciders

roadmap author (recommended, plan revision 1, not published); never adopted; reversed by the operator's Q3 ruling

## Context

Mesh's SQL adapters must turn a query and an expression tree into SQL for SQLite and Postgres and must generate schema migrations. The first plan had to choose between building on Drizzle (an established TypeScript query builder, with drizzle-kit for migrations) and writing its own SQL printer and schema differ.

## Decision

Plan revision 1 (not published) recommended "own SQL printer and own minimal migration differ" with medium confidence, and noted that this reversed the research's lean towards Drizzle. That text is not published; the fact that Q3 reversed the plan's recommendation is in [plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.1. Reasons that seemed right, as far as the sources show: Drizzle v1 is a release candidate, its relations API is being replaced and drizzle-kit is mid-rewrite ([research synthesis](../research/synthesis.md), sections 10 and 12, risk 1), and Mesh's own expression tree must be compiled to SQL anyway.

**Why superseded.** [ADR-0014](./0014-sql-adapters-on-drizzle.md) replaces it. The operator answered the question in [rulings of 2026-10-04](./rulings-2026-10-04.md), "Implementation-plan rulings", row Q3:

> Rely on established tools wherever possible (operator's standing position). SQL adapters use Drizzle for queries and drizzle-kit for migrations, behind Mesh's data-layer contract. Mesh still compiles its own expression tree into Drizzle's SQL builder.

Plan revision 2 marks Q3 as "Reversed from the plan's recommendation" ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.1).

## Options considered

### Option A: Own SQL printer and differ (this record)
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: SQL dialect printing, type mapping, schema snapshots and diffs |
| Cost | Highest to build; Mesh owns every dialect bug |
| Dependency risk | None on Drizzle's release schedule |
| Fit with the operator's position | Contradicts it |

**Pros:** no exposure to a release candidate; full control of output.
**Cons:** rebuilds the migration differ that Ash needed 27 operation types to cover ([Ash runtime internals](../research/ash-runtime-internals.md), section 4.3); Ash's generator also overwrites files without prompting and cannot cover triggers or backfills (same section).

### Option B: Drizzle and drizzle-kit (ADR-0014)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | Low to build; upgrade work |
| Dependency risk | High, contained by pins and one package family |
| Fit with the operator's position | Matches |

**Pros:** established tools; schema and migrations included.
**Cons:** release-candidate churn.

## Trade-off analysis

The roadmap author weighed control and stability against effort; the operator weighed reuse first, and the risk was handled by confining Drizzle to the `data-*` packages.

## Consequences

If Drizzle is dropped later, the cost is bounded: only `data-*` packages change, because handlers call Mesh's contract. The cost of Option A was never measured.

## Action items
- [x] M2: replaced by [ADR-0014](./0014-sql-adapters-on-drizzle.md) in roadmap revision 3 ([roadmap](../roadmap/roadmap.md), section 7).
