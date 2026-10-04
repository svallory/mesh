---
title: "0008. Every transport obtains the scope through an actor-resolver adapter"
description: "Decision record 0008: Every transport obtains the scope through an actor-resolver adapter. Status: Superseded by ADR-007."
---

# 0008. Every transport obtains the scope through an actor-resolver adapter

## Status

Superseded by [ADR-0007](./0007-scope-is-a-plain-argument.md)

## Date

2026-10-04

## Deciders

lead. Not an operator ruling.

## Context

The *scope* is the value `{ actor, context }` that tells an action who is calling and carries extra data for the call. When Mesh was planned with a command-line transport ([ADR-0006](./0006-cli-first-transport.md)), a question arose: how does the command line establish the actor, a tenant and the context? The operator said only that application-specific concerns must not enter Mesh's architecture ([rulings of 2026-10-04](./rulings-2026-10-04.md), Review note, first bullet). Flags such as `--actor` or `--tenant` would have put exactly those concerns into core.

## Decision

As it stood, the lead restated Ruling 8 in the rulings file under "Consequences for the proposal" (the same section [ADR-0005](./0005-core-interface-is-a-function-call.md) quotes), and the second bullet added the actor resolver ([rulings of 2026-10-04](./rulings-2026-10-04.md)):

> Section 17 phase 1 "Enter": every transport, the CLI included, obtains the caller's scope through the actor-resolver adapter contract. Mesh core defines no flags, no tenant and no login; tenant belongs to the multitenancy extension. (Corrected 2026-10-04: …)

Plan revision 2 built it. An *actor resolver* is an adapter that produces the scope from whatever a transport received. M2 defined the contract and one implementation, `actor-dev`, which "returns the actor and context named in a file the project config points to", for development and tests, and with no resolver configured every transport call failed ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M2). The scope was actor and context only; a tenant was to arrive through a "scope contribution point" in M6 (same file, M6 and section 11, Revision 2, bullet on plan ruling Q4). The plan's question Q4 asked how the command line sets these values. The rulings file marks the row "Withdrawn: it brought app concerns into core" ([rulings of 2026-10-04](./rulings-2026-10-04.md), plan rulings table, Q4), after the operator said app-specific concerns must not enter Mesh's architecture; the Review note says the row itself was never an operator ruling.

It seemed right because it kept login, flags and tenants out of core while still giving every transport a scope. The sources record no other reasoning.

**Why superseded.** The Review note says: "'Plan ruling Q4' was never an operator ruling... The actor-resolver adapter, 'scope = actor and context' and 'tenant belongs to the multitenancy extension' were the lead's inventions" ([rulings of 2026-10-04](./rulings-2026-10-04.md), Review note). The resolver only made sense with a transport in v1, and [ADR-0005](./0005-core-interface-is-a-function-call.md) puts none there. The lead then decided: "Drop the actor-resolver contract, the `actor-dev` package, the action registry and the transport contract from v1" ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief"). [ADR-0007](./0007-scope-is-a-plain-argument.md) replaces this decision. The "scope = actor and context" shape survives in [ADR-0007](./0007-scope-is-a-plain-argument.md); the resolver, its package and the scope contribution point do not.

## Options considered

### Option A: Actor-resolver adapter (the decision as it stood)

| Dimension | Assessment |
|-----------|------------|
| Complexity | A contract, an adapter slot and a development implementation |
| Cost | `actor-dev` to build; every transport must supply a resolver |
| Fit with "no app concerns in core" | Good on paper |
| Reversibility | Medium |

**Pros:** Transports differ in how callers are identified (a token, a header, a file); an adapter is the place for that. `actor-dev` is flagged in the plan as "plainly unfit for production" because it trusts a file ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.2, N4).
**Cons:** Needs a transport to exist. Adds a package and a contract to a milestone that only needs to run an action.

### Option B: Plain argument

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest |
| Cost | Callers build the scope |
| Fit with Ruling 8 | Good |
| Reversibility | Medium |

**Pros:** Least machinery; works for tests, scripts and daemons alike.
**Cons:** Callers build the scope themselves. [ADR-0007](./0007-scope-is-a-plain-argument.md) adopts it.

### Option C: No shipped resolver (N4 option b)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lower than A |
| Cost | Each application writes its own from day one |
| Fit | Leaves tests without a ready scope |
| Reversibility | High |

**Pros:** Nothing in Mesh that must be marked unfit for production.
**Cons:** The plan rejected it because the walking skeleton and every test need some resolver ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.2, N4).

## Trade-off analysis

The resolver was a sound answer to a question the operator had not asked. Once no transport was in v1, the question disappeared and the answer with it.

## Consequences

- No `actor-dev` package, no resolver contract, and no way for extensions to add to the scope in M6 ([roadmap](../roadmap/roadmap.md), M6 out of scope).
- A future transport will have to design its own way of building a scope.

## Action items

- [ ] M2: none; the roadmap contains no resolver.
- [ ] after v1: the first transport's design includes how it obtains a scope.
