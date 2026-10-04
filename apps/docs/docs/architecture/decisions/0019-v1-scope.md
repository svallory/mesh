---
title: "0019. Where version 1 ends"
description: "Decision record 0019: Where version 1 ends. Status: Accepted."
---

# 0019. Where version 1 ends

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory), in the review rulings "v1 line" and "After v1"

## Context

The plan is divided into milestones. Revision 2 numbered them M0 to M14, plus M15 for HTTP. Its v1, the first release, was M0 to M14, "command line only, SQLite and Postgres" ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.1, Q1 and Q13). The operator then reviewed every decision of the day. The Review note voided "CLI only" and said what the operator had chosen: "M0–M14, SQLite and Postgres, HTTP after" ([rulings of 2026-10-04](./rulings-2026-10-04.md), Review note, last bullet). After the review the operator moved the line.

## Decision

The operator ruled on 2026-10-04 in [rulings of 2026-10-04](./rulings-2026-10-04.md), "Rulings after the decision review":

> **v1 line:** v1 = M0–M8 plus M10: workspace, build skeleton, run skeleton, data-layer contract, expressions, action lifecycle, extension host, relationships/calculations/aggregates, policies, migrations and Postgres.

> **After v1:** M9 (bulk, identities, upserts; overrides the bulk half of ruling 3), M11 and M12 (outbox, jobs, workflows; replaces ruling 7's "in-process runner first"; the adapter interface stays a design document), M13 (agent and test surface), M14 (Node parity, single binary), M15 (HTTP).

The roadmap, not the ruling, fixes the content of each milestone. It renumbers v1 as M0 to M9: the old M0 to M8 plus the old M10 (migrations and Postgres) as M9 ([roadmap](../roadmap/roadmap.md), section 1, item 1). The milestones were also reworked for the later rulings: M0 (workspace) is done, and the vocabulary alignment opens M1 ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md)); M1 loads through MX in `compiler` ([ADR-0043](./0043-mx-is-core.md)); M2 has no transport, takes the scope as an argument and ends in a function call ([ADR-0005](./0005-core-interface-is-a-function-call.md), [ADR-0007](./0007-scope-is-a-plain-argument.md)); M4 builds one tree with two evaluators ([ADR-0010](./0010-one-expression-tree-two-evaluators.md)); M8 brings deny by default ([ADR-0036](./0036-deny-by-default-arrives-with-policies.md)). v1 is therefore: workspace (done), build skeleton with the vocabulary alignment, run skeleton, data-layer contract, expressions, action lifecycle, extension host, relationships, policies, migrations and Postgres. After v1 is an unordered table without milestone numbers (same file, section 6). The later "Runtime" ruling drops Node parity; the single binary stays as an item after v1 ([roadmap](../roadmap/roadmap.md), section 6).

## Options considered

### Option A: M0–M8 plus M10 (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Ten milestones; six are size L ([roadmap](../roadmap/roadmap.md), section 9, item 8) |
| Cost | Large, but excludes bulk, workflows, agent surface and HTTP |
| Coverage of the rulings | Rulings 4, 5 and 6 and the expression ruling are all exercised |
| Reversibility | High: items after v1 can be pulled forward |

**Pros:** A second database (Postgres) tests the data-layer contract, which has one real implementation until then ([roadmap](../roadmap/roadmap.md), M3 risks). The example `post.mx` builds in full only at M8 (roadmap, M8 test 6).
**Cons:** Six milestones run without access control, and a project built on them must not be exposed (roadmap, section 9, item 7). The bulk half of Ruling 3 is postponed: concurrent batch work has no story in v1. Only the atomic half of the synthesis's gap 3 ships ([research synthesis](../research/synthesis.md), section 8).

### Option B: The revision-2 line, M0–M14 with workflows and Node

| Dimension | Assessment |
|-----------|------------|
| Complexity | Fifteen milestones |
| Cost | Highest: adds bulk, outbox, jobs, workflows, agent surface and Node |
| Coverage of the rulings | Complete, including Ruling 7 |
| Reversibility | Low |

**Pros:** Bulk and identities (old M9) reach v1.
**Cons:** The operator overrode it. No workflow engine was a clear winner, and a spike on DBOS running on Bun must come before any choice ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief"; roadmap, section 6). Node parity is dropped ([ADR-0025](./0025-bun-only.md)).

### Option C: A minimal line ending at the action lifecycle (M0–M5)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Six milestones |
| Cost | Lowest |
| Coverage of the rulings | Leaves Rulings 5 and 6 and the second database untested |
| Reversibility | High |

**Pros:** The earliest working framework: handlers, expressions, atomic updates, tracing.
**Cons:** No relationships, policies, extension host or Postgres. This option is not in the sources; it is the natural lower bound.

## Trade-off analysis

Option A keeps Rulings 4, 5 and 6 and both evaluators in v1 and defers everything that needs a transport or an external engine. It pays in length (six L milestones) and in the bulk gap.

## Consequences

- Easier: v1 has no transport, workflow engine or Node concerns.
- Harder: batch work must wait; teams with bulk needs cannot use v1.
- Revisit: the order of the after-v1 items is not fixed; each gets its own plan when picked up ([roadmap](../roadmap/roadmap.md), section 6). The "After v1" ruling still lists Node parity in M14, which the Runtime ruling later removes; the Runtime ruling wins.

## Action items

- [x] M0: workspace (done, PR #6).
- [ ] M1 to M9: deliver in the order of the roadmap, section 4.
- [ ] after v1: plan each item of the roadmap's section 6 when it is picked up; the order is not fixed.
