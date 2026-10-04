---
title: "0009. Where multitenancy lives"
description: "Decision record 0009: Where multitenancy lives. Status: Proposed."
---

# 0009. Where multitenancy lives

## Status

Proposed

## Date

2026-10-04

## Deciders

open. The operator must rule, when multitenancy is scheduled.

## Context

*Multitenancy* means one deployment serves several customers (*tenants*) whose data must not mix. In Ash, the Elixir framework Mesh is modelled on, it is part of the core resource language: a `multitenancy` section with two strategies, `:context` (defers to data-layer features) and `:attribute` (filters on an attribute such as `org_id`), plus per-action overrides (`:enforce`, `:allow_global`, `:bypass`, `:bypass_all`) and an `all_tenants?` option on identities ([Ash features](../research/ash-features.md), section 7). Ash's expression language also has a `^tenant` template ([research synthesis](../research/synthesis.md), section 1, "Expressions" row). The tenant travels with the actor in the scope ([Ash features](../research/ash-features.md), section 6.9).

Mesh has not decided. The original plan (2026-10-01, not published) listed it as an open question: whether multi-tenancy is in the first version or deferred to an extension. The synthesis put multitenancy in the extension column of its ring table ([research synthesis](../research/synthesis.md), section 15), a proposal that was never ruled on. The rulings file's "Consequences for the proposal", second bullet, says "tenant belongs to the multitenancy extension", and plan revision 2 copied it; the Review note calls it the lead's invention, not an operator ruling ([rulings of 2026-10-04](./rulings-2026-10-04.md), Review note). The scope in [ADR-0007](./0007-scope-is-a-plain-argument.md) is `{ actor, context }` with no tenant field. Multitenancy is not scheduled in the roadmap ([roadmap](../roadmap/roadmap.md), section 6).

## Decision

Not decided.

Recommendation: decide when multitenancy is scheduled, not before. Until then Mesh behaves as Option C: nothing is built, and an application that needs a tenant carries it in `context`. Consequence for v1: M6 builds no way for an extension to add fields to the scope, the "scope contribution point" of plan revision 2 ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M6; [roadmap](../roadmap/roadmap.md), M6, out of scope). This blocks nothing in v1.

## Options considered

### Option A: Tenant is a core scope field and a core data-layer concern

| Dimension | Assessment |
|-----------|------------|
| Complexity | Highest in core: scope type, data-layer contract and expressions all change |
| Cost | Every data adapter must implement tenant isolation |
| Reversibility | Low: core gains a concept it cannot easily drop |
| Fit with [ADR-0001](./0001-three-rings.md) | Weak: many applications never use a tenant |

**Pros:** It is Ash's shape. One typed `scope.tenant`; isolation enforced in one place.
**Cons:** Grows the data-layer contract, whose Ash version the research counts at 46 callbacks and 47 capability names applied inconsistently ([research synthesis](../research/synthesis.md), section 2.2). Under [ADR-0001](./0001-three-rings.md) anything optional is an extension.

### Option B: A multitenancy extension that contributes to the scope and filters

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: needs a scope contribution point and a way to add filters |
| Cost | Defers until the extension host (M6) is mature |
| Reversibility | Medium |
| Fit with [ADR-0001](./0001-three-rings.md) and [ADR-0020](./0020-extension-contributions-through-declared-points.md) | Good |

**Pros:** Core stays small. Contributions go through declared points ([ADR-0020](./0020-extension-contributions-through-declared-points.md)).
**Cons:** The scope type would depend on which extensions are enabled. The extension must reach into every read and write, which is the kind of cross-extension write that Ruling 5 allows only through published points.

### Option C: Not supported until needed; tenant carried in `context`

| Dimension | Assessment |
|-----------|------------|
| Complexity | None |
| Cost | None now |
| Reversibility | High |
| Risk | Isolation is each application's job |

**Pros:** Nothing to build or get wrong. Matches the roadmap.
**Cons:** Nothing enforces isolation: a forgotten filter is a data leak (this follows from the design; not in the sources). Adding tenancy later may change generated signatures and queries.

### Option D: Tenancy as a data-adapter capability

Ash's `:context` strategy defers isolation to the data layer (a schema or database per tenant, or Postgres row-level security).

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: a declared capability ([ADR-0013](./0013-data-layer-contract-and-capabilities.md)) plus a tenant in the scope |
| Cost | Only adapters that support it implement it |
| Reversibility | Medium |
| Fit with [ADR-0013](./0013-data-layer-contract-and-capabilities.md) | Good: a missing capability is a build error |

**Pros:** Isolation enforced by the database, not by every query.
**Cons:** Still needs a tenant in the scope, so it does not settle Option A against B; it covers only Ash's `:context` strategy, not the `:attribute` filter.

## Trade-off analysis

A and B differ on where the concept lives, C on whether it exists. Choosing early buys nothing, since no milestone uses a tenant, and risks building a contribution point nobody exercises. Choosing late costs a possible rework of generated code, which regeneration softens.

## Consequences

- No scope contribution point in M6; the extension host is smaller.
- Applications needing tenants pass them in `context` and filter themselves until this is decided.
- Revisit when multitenancy is scheduled; also check how policies (M8) would express a tenant condition.

## Action items

- [ ] after v1: schedule multitenancy and have the operator rule on this ADR.
- [ ] M6: do not add a way for extensions to add to the scope (roadmap, M6).
- [ ] M8: write policy examples that do not assume a tenant.
