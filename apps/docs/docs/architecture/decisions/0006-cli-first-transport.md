---
title: "0006. The first transport is a command line"
description: "Decision record 0006: The first transport is a command line. Status: Superseded by ADR-005."
---

# 0006. The first transport is a command line

## Status

Superseded by [ADR-0005](./0005-core-interface-is-a-function-call.md)

## Date

2026-10-04

## Deciders

lead, reading the operator's Ruling 8. Not an operator decision.

## Context

The operator was asked which server adapter Mesh should build first, Elysia or Hono (two TypeScript web frameworks), or both ([research synthesis](../research/synthesis.md), section 19, question 8). A *transport* is whatever lets an outside caller reach an action, the named operation on a resource: a command line, an HTTP server, a job runner. The operator answered with a refusal of both and a remark about how to test first (see Decision below). This record stays so nobody proposes the command-line transport again without knowing it was a misreading.

## Decision

As it stood: the first version of Ruling 8 in [rulings of 2026-10-04](./rulings-2026-10-04.md) said "The first transport is a CLI". The lead read the operator's words "let's test Mesh with a leaner thing that will require less wiring" as naming the first transport.

Plan revision 1 (not published) and plan revision 2 built on it. Revision 2 kept a command line as the first transport, minus caller flags ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 11, Revision 2, bullet on plan ruling Q4). It gave M2 the title "Run skeleton: generated handlers, SQLite, command-line transport" and included a `transport-cli` package, a generated action registry, one exit code per error class, generated `--help`, an `actor-dev` package ([ADR-0008](./0008-actor-resolver-adapter.md)), a `--stdin` mode in M9 and a `worker` command in M11 ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 3 and M2, M9, M11). Its traceability table read "8. First transport is a command line; Mesh not tied to web applications" (same file, section 7). The plan's first decision (D1) chose a SQLite file for the skeleton because "a command line starts a new process per call" (section 8).

**Why superseded.** The operator corrected the record on 2026-10-04. Ruling 8 now reads: "This is a statement about how to test first, **not** a ruling that a CLI is the first transport" ([rulings of 2026-10-04](./rulings-2026-10-04.md), Ruling 8). The Review note adds that "'CLI only' in Q1/Q13 follows the misreading of ruling 8 and is void". [ADR-0005](./0005-core-interface-is-a-function-call.md) replaces this decision: the core's interface is a function call and no transport is built in v1.

## Options considered

### Option A: A command-line transport first (the decision as it stood)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: registry, argument parsing, exit codes, scope resolver |
| Cost | A transport and a resolver in M2, plus `--stdin` and `worker` later |
| Fit with the operator's intent | Wrong: adds wiring the operator wanted to avoid |
| Reversibility | Medium |

**Pros:** Leaner than HTTP; runs from a shell; one process per call exercises the build end to end.
**Cons:** Needs the wiring listed above. It also pulled questions about how a caller is identified into core design, which the operator ruled out ("app-specific concerns must not enter Mesh's architecture", [rulings of 2026-10-04](./rulings-2026-10-04.md), Review note).

### Option B: HTTP first

| Dimension | Assessment |
|-----------|------------|
| Complexity | Highest |
| Cost | A web framework in the first milestone |
| Fit with the operator's intent | Rejected by Ruling 8 |
| Reversibility | Low if it shapes core |

**Pros:** The Fetch handler is a neutral standard ([research synthesis](../research/synthesis.md), section 9).
**Cons:** Ties Mesh to web applications ([ADR-0005](./0005-core-interface-is-a-function-call.md), [ADR-0038](./0038-elysia-is-not-core.md)).

### Option C: No transport; a function call

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest |
| Cost | Lowest |
| Fit with the operator's intent | Exact |
| Reversibility | High |

**Pros:** Least wiring ([ADR-0005](./0005-core-interface-is-a-function-call.md) adopts it).
**Cons:** Nothing outside a TypeScript program can call Mesh (see [ADR-0005](./0005-core-interface-is-a-function-call.md)).

## Trade-off analysis

The CLI-first reading was defensible as a reading of one sentence and wrong as a reading of the ruling it sat in, which says Mesh must serve "a CLI, a daemon, a web app or an API equally".

## Consequences

- Removed from v1: `transport-cli`, the action registry, exit codes, `--stdin`, the `worker` command.
- A command-line adapter generated for agents may still come after v1 ([ADR-0027](./0027-no-mcp-agent-surface.md)).

## Action items

- [ ] M2: keep every transport out of v1 (done in [roadmap](../roadmap/roadmap.md), section 3).
