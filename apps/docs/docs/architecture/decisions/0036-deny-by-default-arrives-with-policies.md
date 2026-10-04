---
title: "0036. Deny by default arrives with the policies extension"
description: "Decision record 0036: Deny by default arrives with the policies extension. Status: Accepted."
---

# 0036. Deny by default arrives with the policies extension

## Status

Accepted

## Date

2026-10-04

## Deciders

lead, operator may overrule

## Context

*Deny by default* means an action with no rule allowing it is forbidden. Ash, the Elixir framework Mesh is modelled on, forbids a call when no policy matches ([research synthesis](../research/synthesis.md), section 1, "Policies" row; [Ash features](../research/ash-features.md), section 6.8). That applies only to a resource that enables the policy authorizer, which is opt-in through `authorizers:` ([Ash features](../research/ash-features.md), section 6.8 and "Implications for Mesh", item 6). Mesh deviates: its policies extension is on by default, so from M8 every resource is covered. Ash 3.0 moved every safety default from permissive to conservative ([research synthesis](../research/synthesis.md), section 6, last paragraph), and Mesh adopted "deny unless allowed" as a design goal (section 14, goal 4).

Plan revision 2 applied it from the first runnable milestone: until policies existed, an action ran only when the project config set `authorization: "none"`, otherwise every call failed as forbidden ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M2; section 8, D6). That plan assumed a command-line transport. [ADR-0005](./0005-core-interface-is-a-function-call.md) removed it: v1 has no transport, and calling a generated function is the whole interface.

## Decision

Lead decision, 2026-10-04, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief":

> `public` and default-deny before policies (old D10, D6): no transport exists in v1, so `public` has nothing to filter yet, and the `authorization: "none"` flag is wiring for nothing. Drop both from M2; deny-by-default arrives with the policies extension.

Concretely ([roadmap](../roadmap/roadmap.md), M2 and M8, the roadmap author's wording): in M2 to M7 actions run for any caller, and the scope `{ actor, context }` is only passed through. From M8, with `ext-policies` enabled (it is on by default), an action with no matching policy is forbidden, and the example resources get a policy for every action, so their tests run under deny-by-default.

## Options considered

### Option A: Deny arrives with policies in M8 (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest: no flag, no config key |
| Cost | Nothing to build before M8 |
| Safety of early milestones | None: no access control |
| Reversibility | Easy; the rule is one verifier plus the policy check |

**Pros:** no wiring for a gate that nobody outside the program could reach; tests and the example script need no opt-out.
**Cons:** the honest one. Six milestones (M2 to M7) produce runnable actions with no access control, and a project built on them must not be exposed (roadmap, section 9, risk 7, and M8 risks). This must be stated in the user docs.

### Option B: Default deny from M2 with an opt-out flag (plan revision 2, D6)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: one config flag and one generated check |
| Cost | Small, but every example and test sets the flag |
| Safety of early milestones | Better by default |
| Reversibility | Easy to drop once M8 lands |

**Pros:** keeps the conservative default true from the first build.
**Cons:** the flag protects nothing in a program that calls functions directly, and teaches users to set it. The plan itself says it stops being needed in M8 ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M8).

### Option C: Policies before the lifecycle
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: reorders the roadmap |
| Cost | High |
| Safety of early milestones | Best |
| Reversibility | Hard |

**Pros:** no unprotected milestone.
**Cons:** not feasible in this order. Policies are an extension ([ADR-0022](./0022-policies-simple-tier-as-extension.md)), so they need the extension host (M6); read policies are filters over the expression tree (M4); the example's policies compare `post.authorId` with the actor, which exists only through relationships (M7; [plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 8, D8).

## Trade-off analysis

C is blocked by dependencies, so the choice is between a flag with little to protect (B) and an honest gap (A). The gap is loud in the docs and short-lived in the roadmap, so A.

## Consequences

Easier: M2 to M7 tests and examples. Harder: nothing may ship to users before M8. Revisit if a transport is built earlier ([ADR-0005](./0005-core-interface-is-a-function-call.md), [ADR-0027](./0027-no-mcp-agent-surface.md)), since then the gap becomes reachable.

## Action items
- [ ] M2: state in the user docs that nothing checks the caller until M8.
- [ ] M8: forbid actions with no matching policy (roadmap, M8 test 2).
- [ ] M8: give every example action a policy.
