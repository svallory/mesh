---
title: "0026. Node parity as an adapter and a v1 milestone"
description: "Decision record 0026: Node parity as an adapter and a v1 milestone. Status: Superseded by ADR-025."
---

# 0026. Node parity as an adapter and a v1 milestone

## Status

Superseded by [ADR-0025](./0025-bun-only.md)

## Date

2026-10-04

## Deciders

operator, through the ruling that v1 is M0 to M14; the content of M14 was the plan's (roadmap author's)

## Context

Mesh is a TypeScript framework modelled on Ash. A runtime executes the build tool and the generated programs. When the architecture was first drawn, the project assumed it should not depend on one runtime. The project's agent instructions, written before the rulings of 2026-10-04, list the replaceable pieces behind core contracts: "database, server, runtime (Bun and Node), query library". The research ring table agrees: the core owns "Web-standard APIs only; no runtime-specific calls", with "Bun and Node" as first adapters, and "drivers are per-runtime adapters" because `better-sqlite3` does not run on Bun ([research synthesis](../research/synthesis.md), section 10, "Runtime" row).

## Decision

As it stood: Mesh supports Bun and Node. The runtime host is an adapter slot. Core stays on web-standard APIs, runtime-specific drivers live inside data adapters, and a final v1 milestone, M14, "proves it on Node" ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 3.2 and M14). M14's goal was "Mesh runs on Bun and on Node", last in v1 "because it runs every other milestone's tests". It also contained the single-binary build.

The operator ruled that v1 is M0 to M14 ([rulings of 2026-10-04](./rulings-2026-10-04.md), "Review note": "M0–M14, SQLite and Postgres, HTTP after" is what the operator chose), which included M14. It seemed right because it applied the three-ring rule ([ADR-0001](./0001-three-rings.md)): a runtime is replaceable, so it should be an adapter. It also hedged against a young runtime: Bun 1.4 is the first Rust release, and `findSourceMap` and `AsyncLocalStorage` have gaps (synthesis section 12, risks 2 to 4).

**Why superseded.** [ADR-0025](./0025-bun-only.md) replaces this. The operator ruled on 2026-10-04 ("Rulings after the decision review", row "Runtime", [rulings of 2026-10-04](./rulings-2026-10-04.md)): "Node is dropped. Mesh runs on Bun only (old M14 disappears). The run-time library keeps to web-standard APIs where it can." The same review moved the single binary out of v1 (row "After v1": "M14 (Node parity, single binary)").

## Options considered

### Option A: Bun and Node, Node proven in the last milestone (this ADR)

| Dimension | Assessment |
|-----------|------------|
| Complexity | High: per-runtime drivers, bundling, a test runner that works on both. |
| Cost | One milestone of size M, but it touches every package. |
| Reversibility | Easy to drop, as happened. |
| Reach | Widest. |

**Pros:** Largest audience; no lock to one runtime.
**Cons:** Bun's test runner, used by PR #1, does not run under Node, so M14 had to rerun suites through another runner or drive a Node-built example. Deciding the runner at M0 would have been cheaper ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M14 risks).

### Option B: Bun only (ADR-0025)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest. |
| Cost | Lowest. |
| Reversibility | Medium. |
| Exposure to Bun defects | Highest. |

Cheapest, and now chosen. See [ADR-0025](./0025-bun-only.md) for the full assessment.

### Option C: Node first, Bun later

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium. |
| Cost | Gives up Bun's built-in drivers and compile. |
| Reversibility | Same two-runtime work later. |
| Fit with ring rule | Same as A. |

**Pros:** Mature runtime. **Cons:** Not argued for in the research.

## Trade-off analysis

The decision was cheap to state and expensive to deliver: a runtime hedge that needed its own driver, bundling path and test runner. The operator judged the reach not worth that cost for v1.

## Consequences

Nothing remains to build. What survives is the habit of keeping `runtime` on web-standard APIs, now enforced by a check ([ADR-0025](./0025-bun-only.md)). Anyone re-proposing Node support should read the M14 risks above first.

## Action items

- [x] M0: remove M14 and the Node items from the plan (done in [roadmap](../roadmap/roadmap.md)).
