---
title: "0055. Policies are core; every covering policy must pass; an entity without policies forbids everything"
description: "Decision record 0055: policy scope by `types=` and `actions=`, the combining rule, no `bypass`, fail closed, and policies in core instead of an extension. Status: Accepted."
---

# 0055. Policies are core; every covering policy must pass; an entity without policies forbids everything

## Status

Accepted. Supersedes [ADR-0036](./0036-deny-by-default-arrives-with-policies.md). Amends [ADR-0022](./0022-policies-simple-tier-as-extension.md) (packaging and policy scope).

## Date

2026-10-05

## Deciders

operator (Saulo Vallory) for the policy syntax and the combining rule; the lead, delegated by the operator, for "policies are core" and "an entity without policies forbids everything"

## Context

A *policy* is a declared rule about who may run an action. [ADR-0022](./0022-policies-simple-tier-as-extension.md) set the depth (the operator's Ruling 6: a simple tier of ordered allow and deny checks, read policies as query filters, a structured breakdown, the formula kept for a later solver) and placed the engine in a first-party extension, `ext-policies`, on by default. [ADR-0036](./0036-deny-by-default-arrives-with-policies.md) made "an action no policy allows is forbidden" arrive with that extension in M8. The user docs then had to explain that a `policies` block is not a valid tag unless `@meshfw/ext-policies` is installed and `policies()` is listed in `mesh.config.ts`.

Ash, the Elixir framework Mesh is modelled on, picks a policy by a condition such as `action_type(:read)` and has `bypass` policies: a passing bypass skips the policies after it ([Ash features](../research/ash-features.md), section 6.1). Mesh copied the condition as a check call, `policy=action_type("read")`, in M1.

## Decision

Operator, 2026-10-05, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Entity file syntax, continued (2026-10-05 morning, operator)", row "Policies":

> `policy #name` with scope attributes `actions=[...]` (action names) and `types=[...]` (action types); neither means every action. Checks `authorize-if` / `forbid-if`. Every policy covering an action must pass; none covering it means forbidden. No `bypass` in v1 (it fails open and is order-dependent); write `isStaff(actor) || ...` with a helper.

and, same section, row "Confirmed (2026-10-05)": "A create policy sees the proposed record."

The lead, delegated by the operator, same file, section "Decisions delegated to the lead (2026-10-05)":

> **Entity without policies.** Every action of an entity with no `policies` section is forbidden (fail closed), by the same rule as "an action no policy covers is forbidden". The error says which policy is missing and how to write an open one.

> **Policies are core.** `policies` is a section of the entity file, so authorization is part of core, not an extension. The `ext-policies` package and the `policies()` entry in `mesh.config.ts` disappear.

So:

- A policy covers an action when the action's name is in `actions=` or its type is in `types=`; a policy with neither covers every action.
- Inside one policy the checks run in written order and the first check that applies decides: `authorize-if` allows when it holds, `forbid-if` forbids when it holds. A policy in which no check decides fails. This is Ruling 6's "ordered allow/deny checks", unchanged.
- An action passes only if every policy covering it passes. An action no policy covers is forbidden, and so is every action of an entity with no `policies` section.
- `bypass` is not in v1.
- The rest of [ADR-0022](./0022-policies-simple-tier-as-extension.md) stands: read policies become query filters; the breakdown is data; `can` asks without acting; the formula stays solver-ready. A create policy sees the proposed record; reading a related record is a query inside the transaction before the insert.

## Options considered

### Option A: policies in core, fail closed, every covering policy must pass (chosen)

**Pros:** forgetting a policy can never open an entity; no package or configuration line to forget; the combining rule does not depend on order, so moving a policy cannot change the outcome.
**Cons:** a prototype must write an open policy (`policy #open` with `authorize-if=() => true`) before anything runs; the authorization engine is no longer replaceable as a unit.

### Option B: the `ext-policies` extension, on by default ([ADR-0022](./0022-policies-simple-tier-as-extension.md), [ADR-0036](./0036-deny-by-default-arrives-with-policies.md))

**Pros:** the rules engine is replaceable; core stays smaller.
**Cons:** a disabled extension makes the `policies` section a build error, so turning authorization off is a configuration change far from the entity; two steps (install, enable) before a rule works.

### Option C: Ash's first-match across policies, with `bypass`

**Pros:** expresses "staff may do anything" in one policy.
**Cons:** order-dependent; a misplaced bypass opens actions (fails open), which is what the operator rejected.

## Trade-off analysis

Authorization is the one feature where a silent gap is a security bug. Option A makes the safe state the default with no setup, at the cost of one explicit open policy in a prototype. Replaceability was never exercised: no second engine was planned.

## Consequences

- The three rings change: authorization moves from the extension column to core ([three rings](../in-depth/three-rings.md)). The core still has an authorizer slot in the lifecycle; the engine fills it directly.
- The `policies`, `policy`, `authorize-if` and `forbid-if` contracts stay in the core contracts; M8 no longer moves them to an extension, and the worked example of a cross-extension contribution in [extension host](../in-depth/extension-host.md) changes.
- Exception X2 of the [vocabulary mapping](../roadmap/vocabulary-mapping.md) (policies on by default against Ash's opt-in) is closed.
- Until M8 builds the engine, generated actions check nothing; the fail-closed rule applies from M8.
- [ADR-0046](./0046-denied-atomic-write-outcome.md) (what a denied atomic write reports) stays open.

## Action items

- [ ] Realignment task: `policy #name types=[...] actions=[...]` in the contracts; drop the check-call condition.
- [ ] M8: build the engine in core, with the fail-closed rule and its error message.
