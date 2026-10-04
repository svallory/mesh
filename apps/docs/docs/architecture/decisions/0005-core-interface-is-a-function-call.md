---
title: "0005. The core's interface is an in-process function call"
description: "Decision record 0005: The core's interface is an in-process function call. Status: Accepted."
---

# 0005. The core's interface is an in-process function call

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory) ruled the principle (Ruling 8 as corrected); the lead restated it in the rulings file and turned it into roadmap scope. Supersedes [ADR-0006](./0006-cli-first-transport.md).

## Context

An *action* is one named operation on a resource (create, read, update, destroy). A *transport* is whatever lets an outside caller reach an action: a command line, an HTTP server, a job runner. The synthesis asked which server adapter should come first, Elysia or Hono (TypeScript web frameworks), or both ([research synthesis](../research/synthesis.md), section 19, question 8).

Ash, which Mesh is modelled on, is not tied to the web: its web and API transports (Phoenix, JSON:API, GraphQL) are separate packages ([research synthesis](../research/synthesis.md), section 4, table rows 17, 18 and 20). Mesh actions "must also run with no request: jobs, tests, agent tools, daemons" (same file, section 11).

## Decision

The operator ruled on 2026-10-04, in Ruling 8 of [rulings of 2026-10-04](./rulings-2026-10-04.md), as corrected the same day:

> Neither Elysia nor Hono first. Mesh is not to be tied to web apps, or to any kind of application: like Ash, it must serve a CLI, a daemon, a web app or an API equally. The operator's words: "let's test Mesh with a leaner thing that will require less wiring." This is a statement about how to test first, **not** a ruling that a CLI is the first transport.

The lead restated it in the same file, "Consequences for the proposal", first bullet:

> Section 15 "Server and API protocol" adapter: no transport is chosen as first. The core's interface is an in-process function call; every transport is an optional adapter over it.

So the operator ruled the principle in Ruling 8 as corrected; the lead's restatement says what follows for the architecture; and the lead turned it into roadmap scope: no transport is built in v1 and a transport is built when something needs it. The roadmap follows: the walking skeleton (M0 to M2) "ends in a function call", a test and a script of about twenty lines call the generated functions against SQLite, and there is "no command line, no server" ([roadmap](../roadmap/roadmap.md), section 1, item 2; M2).

## Options considered

### Option A: Function call only; transports are later adapters (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest: no transport contract, registry or exit codes in v1 |
| Cost | Least wiring now; each transport is built later |
| Fit with Ruling 8 | Exact: serves any program equally |
| Reversibility | High: a transport can be added without changing core |

**Pros:** Testing the stack needs no wiring. Core stays free of web and process concepts ([roadmap](../roadmap/roadmap.md), section 2, principle 8).
**Cons:** Nothing outside a TypeScript program can call Mesh in v1. No transport contract is designed until a transport exists, so core may assume something a transport must later change. The first transport "will need a way to obtain a scope, which is that adapter's design, not core's" ([roadmap](../roadmap/roadmap.md), section 6).

### Option B: A command-line transport first

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: argument parsing, action registry, exit codes |
| Cost | A transport contract and a scope resolver in M2 |
| Fit with Ruling 8 | Rejected by the correction |
| Reversibility | Medium |

**Pros:** Leaner than HTTP. This was plan revision 2 ([ADR-0006](./0006-cli-first-transport.md)).
**Cons:** It builds the wiring the operator wanted to avoid (an action registry, a way to obtain a scope; [ADR-0008](./0008-actor-resolver-adapter.md)).

### Option C: HTTP first (Elysia or Hono)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Highest of the three: routes, validation hand-off, errors |
| Cost | A server dependency in the first milestone |
| Fit with Ruling 8 | Poor |
| Reversibility | Low if it shapes core |

**Pros:** The Fetch handler is one of four neutral standards ([research synthesis](../research/synthesis.md), section 9).
**Cons:** Ruling 8 rejects it. For Elysia, "everything hangs off an HTTP request" (section 11).

## Trade-off analysis

Option A trades reach for leanness: v1 cannot be called from outside, in return for a core that assumes nothing about who calls.

## Consequences

- Easier: M2 is small; tests call functions directly.
- Harder: the scope has to be passed by the caller ([ADR-0007](./0007-scope-is-a-plain-argument.md)); the agent surface waits for the command-line adapter ([ADR-0027](./0027-no-mcp-agent-surface.md)).
- Revisit: when the first transport is built, check that core did not assume a shape for it. Elysia stays a candidate ([ADR-0038](./0038-elysia-is-not-core.md)).

## Action items

- [ ] M2: generate handlers as exported functions `createPost(input, scope)` and an example script of about twenty lines.
- [ ] M2: add no action registry or transport contract.
- [ ] After v1: design the first transport and its way of obtaining a scope.
