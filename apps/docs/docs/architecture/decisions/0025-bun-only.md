---
title: "0025. Mesh runs on Bun only"
description: "Decision record 0025: Mesh runs on Bun only. Status: Accepted."
---

# 0025. Mesh runs on Bun only

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory) for the ruling; roadmap author for the web-standard check

## Context

Mesh is a TypeScript framework modelled on Ash, the declarative resource framework for Elixir. A JavaScript runtime executes both the Mesh build tool and the programs Mesh generates. Bun and Node are the two realistic choices.

Until this decision Mesh planned to support both. The project's agent instructions, written before the rulings of 2026-10-04, listed "runtime (Bun and Node)" among the adapters. The research proposed "Web-standard APIs only; no runtime-specific calls" for the core, with Bun and Node as first adapters ([research synthesis](../research/synthesis.md), section 10, "Runtime" row). Plan revision 2 ended v1 with a milestone, M14, whose goal was "Mesh runs on Bun and on Node" ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M14). That plan is recorded in [ADR-0026](./0026-node-parity.md), which this ADR supersedes.

## Decision

The operator ruled on 2026-10-04, in "Rulings after the decision review", row "Runtime" ([rulings of 2026-10-04](./rulings-2026-10-04.md)):

> Node is dropped. Mesh runs on Bun only (old M14 disappears). The run-time library keeps to web-standard APIs where it can.

The second sentence keeps a later port possible without making it a goal. The roadmap author turned it into a check: `verify` fails if `runtime` imports a `bun:*` module or uses the `Bun` global, so Bun-specific code lives in adapters ([roadmap](../roadmap/roadmap.md), M2, acceptance test 7).

## Options considered

### Option A: Bun only (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest. One runtime, one SQLite driver, one test runner. |
| Cost | Lowest. Old M14 is deleted. |
| Reversibility | Medium. Web-standard `runtime` keeps a port possible. |
| Exposure to Bun defects | Highest. Every Bun gap is Mesh's gap. |

**Pros:** Bun compiles to a single binary for eight targets and ships SQLite and Postgres drivers ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 3; synthesis section 10). `better-sqlite3` does not run on Bun (open issue `oven-sh/bun#4290`), so supporting both means a second SQLite driver (07, section 3). PR #1's tests already use Bun's test runner, which does not run under Node ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M14 risks).
**Cons:** Mesh carries the Bun risks the research lists (synthesis section 12, risks 2 to 5), and some touch v1:
- `findSourceMap` always returns `undefined` (risk 3). Run-time `.mx` positions arrive in M5, so [ADR-0039](./0039-run-time-error-positions.md) recommends embedded positions rather than source maps.
- `AsyncLocalStorage` does not propagate into `Worker` or `MessagePort` events (risk 4). The OpenTelemetry spans of M5 may depend on it ([ADR-0029](./0029-tracing-opentelemetry-api.md) marks this unchecked).
- Bun 1.4 is the first release written in Rust (risk 2). Every v1 milestone runs on Bun, so this is a general platform risk that touches all of v1 and is accepted with Bun itself.
- Idle memory of a Bun server with SQLite is unmeasured (risk 5). v1 does not measure it either; the single-binary build that would is after v1.

The operator accepted these. Users on Node or on hosts without Bun cannot use Mesh.

### Option B: Bun and Node (ADR-0026)

| Dimension | Assessment |
|-----------|------------|
| Complexity | High. Per-runtime drivers, two test paths, a bundling step that differs ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M6 risks and M14). |
| Cost | A whole milestone, last in v1, because it reruns every other milestone's tests. |
| Reversibility | Easy to add later. |
| Reach | Widest. |

**Pros:** Larger audience; no dependence on one runtime's maturity.
**Cons:** Doubles the surface the tests must cover. The plan itself flagged that settling the test runner at M0 would have been cheaper than at M14.

### Option C: Node first

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium. Node is the mature target. |
| Cost | Loses Bun's built-in SQLite, Postgres and compile. |
| Reversibility | Adding Bun later needs the same two-runtime work. |
| Fit with chosen tools | Poor. |

**Pros:** Most mature platform.
**Cons:** The compared HTTP frameworks both need an adapter package on Node (07, Summary), and single-binary output would be unavailable. The research gives no argument for this option beyond maturity.

## Trade-off analysis

The operator traded reach for focus. Bun's risks are real. The Rust rewrite touches all of v1 and is accepted with Bun itself. Two reach into M5: source maps have a proposed mitigation (embedded positions, [ADR-0039](./0039-run-time-error-positions.md), not yet ruled), and the OpenTelemetry context manager is an open check (action item below). Idle memory is unmeasured in v1. The web-standard check costs little and removes most of the argument against revisiting.

## Consequences

- Easier: one driver (`bun:sqlite` through Drizzle), Bun's bundler for the contracts module, Bun's test runner.
- Harder: Mesh cannot be adopted where Bun is not allowed. Bun regressions hit Mesh directly.
- Revisit: single-binary memory, and the Bun risks above if any becomes a blocker.
- Node, Deno and edge runtimes are listed as not planned ([roadmap](../roadmap/roadmap.md), section 6).

## Action items

- [ ] M1: record Bun as the only supported runtime in the project instructions and the docs.
- [ ] M2: add the web-standard check to `verify` (roadmap, M2 test 7).
- [ ] M5: confirm OpenTelemetry context propagation works on Bun ([ADR-0029](./0029-tracing-opentelemetry-api.md)).
- [ ] After v1: measure idle memory of the compiled binary.
