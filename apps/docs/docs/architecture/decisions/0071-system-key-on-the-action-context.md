---
title: "0071. `system` is a reserved key of the `ActionContext`; policies decide what it admits"
description: "Decision record 0071: how an internal write (a cascade, the bootstrap, a timer) passes authorization without a `bypass`. Status: Accepted."
---

# 0071. `system` is a reserved key of the `ActionContext`; policies decide what it admits

## Status

Accepted. Amends [ADR-0059](./0059-action-context.md) (a second reserved key) and complements [ADR-0055](./0055-policies-are-core.md) (no `bypass`).

## Date

2026-10-10

## Deciders

operator (Saulo Vallory), accepting [roadmap revision 5](../roadmap/roadmap.md) on 2026-10-10 at 09:05, decision D11 with its recommended option.

## Context

Hyper's bootstrap, lease sweeper and 11 nested change modules call actions with `authorize?: false` and keep the human actor (70 call sites in `lib/`, `pipeline/changes.ex:26-31`). [ADR-0055](./0055-policies-are-core.md) has no `bypass` and forbids any action no policy covers. Without a rule, an internal write either cannot pass or needs a flag no record names ([gap G20](../research/hyper-port-gap-analysis.md)). [ADR-0068](./0068-actions-compose-through-actions-and-tx.md) makes nested calls checked by the called action's policies, so the question is how a cascade or a timer is admitted.

## Decision

`ActionContext` has one more reserved key, **`system`**, a boolean the runtime declares optional (`system?: boolean`).

- Mesh does not act on it. No policy is skipped: a policy admits an internal write by testing the key, with `isSystem(context)` in the project's own helper, in `authorize-if`.
- The application sets it, for the bootstrap, a timer, or a call it makes on the system's behalf. It is never read from input. It is as trustworthy as the code that builds the context.
- The `actions` handle of a `run` step carries the caller's whole context into a nested call, `system` included, and the human `actor` stays on it, so an event written by a cascade still names the person who caused it.
- A write policy of an internal-only action (a Completion recorded by a cascade) is `authorize-if=({ actor, context }) => hasRole(actor, ["owner"]) || isSystem(context)`.

## Options considered

1. **A reserved `system` key on the context (chosen).** One documented key, the human actor kept.
2. **A marker on the actor** (`actor.system`). A nested call must swap the actor, so events lose the human unless a second key (`onBehalfOf`) is added.
3. **A call-level exemption**: a separate `internal` binding of the action functions that skips policies, mirroring `authorize?: false`. No clause in the policies, but policies no longer say who can reach an action, and it is a bypass by API where [ADR-0055](./0055-policies-are-core.md) rejected one by syntax.
4. **No exemption**: nested calls checked as the human, and cascade-only actions admit whoever cascades. Assignment, Completion and Event become writable by any worker unless the transport hides them.

## Trade-off analysis

Option 1 keeps the rule that access is declared in policies and the human actor on events, for one reserved key and a clause in each write policy of an internal-only action. If that clause repeats too much, shared checks (after 1.0) are the fix, not a `bypass`. Option 3 is shorter to write and gives up the property that reading the policies tells you who can reach an action.

## Consequences

- [Using your domain](../../docs/using-your-domain.md#internal-writes) and [Configuration](../../docs/configuration.md#srccontextts) document the key.
- A restore or import write that skips checks, if one is built after 1.0, requires `system` and is exported from its own entry that `#mesh` does not re-export.

## Action items

- [ ] M8: `system?: boolean` in the runtime's `ActionContext`; the policy tests of M8 cover a nested call.
