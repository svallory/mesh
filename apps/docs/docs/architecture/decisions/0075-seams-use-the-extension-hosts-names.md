---
title: "0075. Three lifecycle seams, named and shaped as the extension host's run-time points"
description: "Decision record 0075: code the application may run before the transaction, after each write and after commit, and why they are the host's first slice. Status: Accepted."
---

# 0075. Three lifecycle seams, named and shaped as the extension host's run-time points

## Status

Accepted. Amends [ADR-0020](./0020-extension-contributions-through-declared-points.md) (the first run-time points are built before the host).

## Date

2026-10-10

## Deciders

operator (Saulo Vallory), accepting [roadmap revision 5](../roadmap/roadmap.md) on 2026-10-10 at 09:05, decision D10 with its recommended option (a).

## Context

Hyper's event log, plugin hooks, idempotency record and broadcast are code at three points of every write: before the transaction opens, inside it after the row is written, and after it commits ([gaps G11, G12, G13 and G31](../research/hyper-port-gap-analysis.md)). The [action lifecycle](../in-depth/action-lifecycle.md) page gives each phase an extension point but names none for the commit and none "after the write". The extension host that would offer them to extensions comes after 1.0 ([ADR-0072](./0072-mesh-1-0-is-the-port-gate.md)); the port cannot wait for it.

## Decision

Mesh builds the three points now, for the application, with the names and payloads the extension host will use, so that the host later wraps them instead of replacing them.

| Seam | Runs | Receives | May |
|:--|:--|:--|:--|
| `beforeTransaction` | before the transaction opens and before the write queue is entered | `{ entity, action, input, context }` | throw to refuse |
| `afterWrite` | inside the transaction, right after each row is written and before any `after=:write` step | `tx` and `{ entity, action, before, after, input, context }` | write through `tx`; throw to roll everything back |
| `afterCommit` | once, after the outermost transaction commits | `{ changes }`, every row written in it, in order | nothing that can fail the call; not called on rollback |

- They are registered when the application binds a data layer, `bind(layer, { seams })`, and `connect()` reads the same functions from the `seams` key of `mesh.config.ts`.
- A nested call ([ADR-0068](./0068-actions-compose-through-actions-and-tx.md)) runs the seams of its own row writes with the caller's `context`, so `caller` and `commandId` reach every event.
- Payloads are plain data. In `afterWrite`, `tx` is the transaction's data operations (the data layer's `insert`, `selectByKey`, `updateByKey` and `deleteByKey`, with the tables from `#mesh`), so a seam can write a row of its own, such as an event, without calling an action; writes through it run no seams. It is not the read handle that `run` steps receive ([ADR-0068](./0068-actions-compose-through-actions-and-tx.md)), which is the same transaction seen through the generated reads.

## Options considered

1. **Seams with the host's names and payloads (chosen).** One extension surface.
2. **A separate, application-only API** that is not meant to grow. Faster to build and leaves two surfaces later.
3. **18 `always` blocks** (one per entity) with an after-write `run`, instead of a global `afterWrite`. No new construct, but 18 blocks that repeat.

## Trade-off analysis

Option 1 costs agreeing now the shape the host will use, which the [extension-host page](../in-depth/extension-host.md) says is not decided; keeping the payloads plain and the points three keeps the later wrapping cheap. `afterWrite` receives `before`, which is free while every update reads first. If atomic updates return after 1.0, `before` must become lazy or opt-in, or it cancels their point.

## Consequences

- Hyper's typed events are an application table from (entity, action) to event type and payload; the seam stays generic.
- [Using your domain](../../docs/using-your-domain.md#seams) and [Configuration](../../docs/configuration.md#seams) document the seams.
- An action manifest for generic dispatch is not built before 1.0: the spec's v0 dispatches a fixed method table.

## Action items

- [ ] M6: the three seams, `bind(layer, { seams })` and the `seams` configuration key.
