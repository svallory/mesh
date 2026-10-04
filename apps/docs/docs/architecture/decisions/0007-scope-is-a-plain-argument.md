---
title: "0007. The scope is a plain argument on every action call"
description: "Decision record 0007: The scope is a plain argument on every action call. Status: Accepted."
---

# 0007. The scope is a plain argument on every action call

## Status

Accepted

## Date

2026-10-04

## Deciders

lead; the operator may overrule. Supersedes [ADR-0008](./0008-actor-resolver-adapter.md).

## Context

An action needs to know who is calling (the *actor*) and may need extra data for the call (the *context*). Together this value is the *scope*. Ash, the Elixir framework Mesh is modelled on, takes `actor:`, `tenant:` and `context:` options on each call, and offers `Ash.Scope` to bundle them into one value ([Ash features](../research/ash-features.md), section 6.9, and "Implications for Mesh", item 3). Mesh needs its own answer.

The operator's only statement on the subject is that application-specific concerns must not enter Mesh's architecture. The rest of the earlier design, including "scope = actor and context", was the lead's own ([rulings of 2026-10-04](./rulings-2026-10-04.md), Review note, first bullet).

## Decision

Decided by the lead, as recorded in [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief", first bullet:

> **Scope is a plain argument.** The caller passes `{ actor, context }` on every action call, as Ash's `actor:` option. Drop the actor-resolver contract, the `actor-dev` package, the action registry and the transport contract from v1. N4 is moot.

The scope is never ambient. In the roadmap, the scope is the second argument of every generated function, `createPost(input, scope)`, required on every call; "a call without a scope is a type error" ([roadmap](../roadmap/roadmap.md), M2). Tenancy is not in this type; where it lives is open ([ADR-0009](./0009-tenancy-placement.md)). The operator may overrule.

Connection handling, 2026-10-04: see [ADR-0047](./0047-actions-are-bound-to-a-data-layer.md). Actions are bound to a data layer by a factory; the scope stays `{ actor, context }` and never contains the data layer.

## Options considered

### Option A: A plain argument (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest: a typed parameter |
| Cost | Callers pass it everywhere; generated code threads it |
| Visibility | Best: every call shows who it runs as |
| Reversibility | Medium: a changed scope type changes every generated signature |

**Pros:** Matches the direction Ash took. Ash 3.0 removed `Ash.set_*`, which stored actor, tenant and context in the process dictionary, because "There were fundamental issues with this pattern that manifested in subtle bugs" ([Ash strengths and weaknesses](../research/ash-strengths-weaknesses.md), section 4). The research recommends: "Pass context explicitly, always" (same file, "Implications for Mesh", item 8, the researcher's opinion). Works the same in a test, a script or a daemon.
**Cons:** Boilerplate; every internal call must forward the scope. The research notes that without a bundling value "generated handlers would otherwise thread actor/tenant by hand" ([Ash features](../research/ash-features.md), "Implications for Mesh", item 3, the researcher's opinion), which is why the scope is one object.

### Option B: An actor-resolver adapter

| Dimension | Assessment |
|-----------|------------|
| Complexity | Higher: a contract, an adapter package, a development implementation |
| Cost | Extra package (`actor-dev`) to build and maintain |
| Fit with Ruling 8 | Needs a transport to resolve from |
| Reversibility | Medium |

**Pros:** Callers need not build a scope by hand; each transport can map its own request to a scope.
**Cons:** It only makes sense when a transport exists, and none is in v1 ([ADR-0005](./0005-core-interface-is-a-function-call.md)). It was the lead's invention, not an operator ruling ([rulings of 2026-10-04](./rulings-2026-10-04.md), Review note). See [ADR-0008](./0008-actor-resolver-adapter.md).

### Option C: Ambient scope

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low at call sites |
| Cost | Low to write |
| Risk | High: hidden state |
| Reversibility | Low |

**Pros:** No threading; one place to set it.
**Cons:** Ash removed it. In Bun, `AsyncLocalStorage` (Node's mechanism for async context) is not propagated into `Worker` or `MessagePort` events ([research synthesis](../research/synthesis.md), section 12, risk 4).

## Trade-off analysis

The plain argument costs typing and buys one rule everywhere: the caller states who is calling. Option B adds machinery for a transport that does not exist. Option C was tried by Ash and reversed.

## Consequences

- Easier: tests, scripts and daemons call the same functions; authorization checks in M8 have a defined input.
- Harder: nested calls must forward the scope; adding a field to the scope later changes every generated signature, though regeneration handles it.
- Revisit: [ADR-0009](./0009-tenancy-placement.md) (tenant); the first transport will need its own way to build a scope. How an application types its actor is decided in M2: `runtime` cannot know the application's actor type, so `Scope` needs a generic or an `unknown` actor.

## Action items

- [ ] M2: define the `Scope` type in `runtime`, including how the actor is typed, as a required second argument.
- [ ] M2: test that a call without a scope is a type error.
- [ ] M8: policies read the actor and context from the scope.
