---
title: "0074. A write policy may read other entities through `tx`"
description: "Decision record 0074: how a policy reads the actor's membership inside the transaction, so a revoked role cannot go stale. Status: Accepted."
---

# 0074. A write policy may read other entities through `tx`

## Status

Accepted. Amends [ADR-0022](./0022-policies-simple-tier-as-extension.md) and [ADR-0055](./0055-policies-are-core.md) (what a policy on a write may read).

## Date

2026-10-10

## Deciders

operator (Saulo Vallory), accepting [roadmap revision 5](../roadmap/roadmap.md) on 2026-10-10 at 09:05, decision D5 with its recommended option (b).

## Context

Hyper reads the actor's role inside the write transaction (`checks/role.ex:16-61`), so an owner revoked a moment ago is refused on the next write. In the port the actor arrives in the context. If the application reads the role before the call, a membership revoked between that read and the write still passes ([gap G21](../research/hyper-port-gap-analysis.md)). Re-reading it in the `beforeTransaction` seam does not help, because that seam runs before the transaction opens.

## Decision

A policy on a **write** (create, update or destroy) may read other entities through `tx`, the reads of the running transaction ([ADR-0068](./0068-actions-compose-through-actions-and-tx.md)). Its `authorize-if` and `forbid-if` functions receive `{ self, input, actor, context, tx }`, and a check that uses `tx` is evaluated in memory on the locked row, inside the transaction. The role is then read where Hyper reads it.

**Read policies are unchanged**: they are query filters, a row the caller may not see is not found, and a read policy has no `tx`.

## Options considered

1. **Accept the staleness.** The application builds `actor.role` before the call. Simple, and wrong in the case the decision names.
2. **A write policy reads through `tx` (chosen).** M5 already gives function-valued checks a `tx`; giving the same to a write policy is M5 or M8 work and needs no SQL translation.
3. **The application re-checks in an `afterWrite` check** inside the transaction and aborts. No policy change and one more use of a seam, but the rule sits outside the entity file.

## Trade-off analysis

Option 2 keeps the rule next to the other policies and closes the race. It gives up one thing: a policy that calls `tx` is plain code, so it cannot be kept as a boolean formula for a future solver ([ADR-0022](./0022-policies-simple-tier-as-extension.md)). The solver is after 1.0 and the formula remains for policies that do not read.

## Consequences

- A write policy reading `tx` costs a query per decision.
- [Entities](../../docs/entities.md#policies) documents `tx` in a policy.
- Test 3 and 5 of M8 (the revoker and the assignee) use it.

## Action items

- [ ] M8: pass `tx` to write-policy checks; assert that a membership revoked inside the same transaction is seen.
