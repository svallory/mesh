---
title: "0059. An action's second argument is the flat `ActionContext`"
description: "Decision record 0059: the action context replaces the scope; `actor` is the one key Mesh reads; this also settles where a tenant lives. Status: Accepted, amended by ADR-0071."
---

# 0059. An action's second argument is the flat `ActionContext`

> **Amended** by [ADR-0071](./0071-system-key-on-the-action-context.md) on 2026-10-10: `system` is a second reserved key of the `ActionContext`. The body below is kept as history.

## Status

Accepted. Supersedes [ADR-0007](./0007-scope-is-a-plain-argument.md) and [ADR-0009](./0009-tenancy-placement.md). Amends [ADR-0047](./0047-actions-are-bound-to-a-data-layer.md).

Amended by [ADR-0071](./0071-system-key-on-the-action-context.md) (2026-10-10): `system` is a second reserved key of the `ActionContext`.

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

[ADR-0007](./0007-scope-is-a-plain-argument.md) made the caller pass a *scope*, `{ actor, context }`, as the second argument of every action call, never ambient. `actor` said who was calling; `context` was a bag for anything else. How an application typed its actor was left to M2. [ADR-0009](./0009-tenancy-placement.md) left open whether a tenant (the customer whose data a call may touch) is a core concept or an extension's, and the scope had no field for it.

Writing the user docs showed that the nested bag made every call longer (`{ actor, context: { tenantId } }`), and that the typing question had no answer a user could write once.

## Decision

Operator, 2026-10-04 evening, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings on the user docs, layout and terms (2026-10-04 evening, operator)", row "Action context":

> The second argument of every action is the action context: `createTodo(input, context)`. Its type, `ActionContext`, is one flat object the user declares once by declaration merging in `src/context.ts`. `actor` is the one key Mesh reads; every other key (tenant, locale, ...) is the user's. No `scope`, no nested `context` bag, no `Register` interface. An extension that needs a key states which one it reads; a clash is a build error (this settles tenant placement). In `.mx` functions: the record, `actor` as a shortcut, and `context`. Replaces "scope `{actor, context}`" in ADR-0007 and ADR-0047.

With syntax v2 the record is `self` ([ADR-0050](./0050-entity-file-syntax.md)), so a function in an entity file receives `{ self, input, actor, context }`, where `actor` is `context.actor`.

```ts
// src/context.ts
import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string; role: "admin" | "member" };
    tenantId: string;
  }
}
```

The mechanism, as ruled by the lead, delegated by the operator ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings after the review of the contributor docs (2026-10-05, lead under delegation)"): `@meshfw/runtime` exports an empty `interface ActionContext {}`. The project adds its keys, `actor` included, by declaration merging in `src/context.ts`; the runtime declares no `actor` itself, because that would make the project's own declaration a duplicate-property error. Generated functions take `context: ActionContext`, and the parameter is optional when the merged interface has no required key. In entity-file functions, `actor` has the type the project declared, or `unknown` when it declared none. The argument is still plain and required on every call, as [ADR-0007](./0007-scope-is-a-plain-argument.md) decided; only its shape changed. It never carries the data layer ([ADR-0047](./0047-actions-are-bound-to-a-data-layer.md)).

**Tenancy.** A tenant is an ordinary key the user declares. An extension that implements multitenancy states in its manifest which key it reads; two extensions claiming one key fail the build. This answers [ADR-0009](./0009-tenancy-placement.md): tenancy is not in core.

## Options considered

### Option A: one flat interface, extended by declaration merging (chosen)

**Pros:** short calls; typed once in one file; extensions say which keys they read, so a clash is caught.
**Cons:** keys share one namespace with the user's own; declaration merging is a TypeScript idiom some users have not met.

### Option B: the nested scope `{ actor, context }` ([ADR-0007](./0007-scope-is-a-plain-argument.md))

**Pros:** separates Mesh's key from the user's.
**Cons:** longer calls; no answer for typing.

### Option C: a `Register` interface carrying type parameters (as in TanStack Router)

**Pros:** a known pattern for library-wide types.
**Cons:** an indirection with nothing to gain over merging into the type itself.

## Trade-off analysis

Option A puts the cost (learning declaration merging) once, in one file, and removes it from every call. The shared namespace is managed by the rule that extensions declare their keys.

## Consequences

- `runtime` exports `ActionContext` instead of `Scope`; generated signatures become `(input, context: ActionContext)`.
- [ADR-0047](./0047-actions-are-bound-to-a-data-layer.md) stands with the new argument name: `bind(dataLayer)` and `connect()` are unchanged.
- The extension manifest gains "context keys read" ([extension host](../in-depth/extension-host.md)).
- The code on `main` (`@meshfw/runtime`) exports `ActionContext` since PR #48 (2026-10-09).

## Action items

- [x] Realignment task: `ActionContext` in `runtime`, generated signatures, the example's `context.ts`. (`ActionContext` in PR #48; `ContextArgument`, the generated `(input, ...[context]: ContextArgument)` signatures and `examples/blog/src/context.ts` in [PR #54](https://github.com/svallory/mesh/pull/54).)
- [ ] M6: the manifest entry for context keys and the clash error.
