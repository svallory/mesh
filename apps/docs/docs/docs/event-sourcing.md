---
title: "Event sourcing"
description: "The event-sourcing extension, @meshfw/event-sourcing: project handlers, which build a read model from every event they list, from the beginning of history; the from option; the rule that refuses a read model built from part of the history; and how to rebuild one."
---

# Event sourcing

::: callout warning "Not released"
Mesh is not released yet. These pages describe what Mesh will be.
:::

`@meshfw/event-sourcing` is an extension: a package you add when you need it, which core runs through a point it publishes for extensions ([ADR-0094](../architecture/decisions/0094-run-time-points-for-event-extensions.md)). This first version gives one thing, the **project handler**: a handler that builds a **read model**, rows kept only to be read, from every event it lists, starting from the beginning of the history the outbox keeps. Core's own handlers, `process` and `listen` ([Handlers](./events.md#handlers)), start from now and never see an event published before they were first registered; a project handler is the one that does.

An event store, `apply` (folding events into an event-sourced aggregate) and declared read models are not built. The outbox is not made the source of truth: `keep: "all"` keeps its rows, it does not make them the record of what happened.

## Installing it

Add `@meshfw/event-sourcing` to the project's dependencies. It takes `@meshfw/runtime` as a peer, so the project's one copy of the runtime is the one it uses, and it needs no line in `mesh.config.ts`. It adds no syntax to entity files and changes nothing `mesh build` generates.

## A read model

A read model is an ordinary entity. Here, one row per paid invoice, written only by the system:

```mx "src/domain/billing/paid-invoice.mesh.mx"
import { Mesh } from "meshfw"

entity :PaidInvoice
  attributes
    uuid :id primary-key
    uuid :invoiceId
  actions auto=[:read]
    create :record
      input
        &invoiceId
  policies
    policy :system types=[:create, :read]
      authorize-if=({ context }) => Mesh.isSystem(context)
```

The events module lists its handler under `handlers.project`, made with `project(...)`:

```ts "src/events.ts"
import { project } from "@meshfw/event-sourcing";
import { InvoicePaid, PaidInvoice } from "#mesh/domain/billing";

export const handlers = {
  project: {
    paidInvoices: project({
      events: [InvoicePaid],
      run: async (event, { context }) => {
        await PaidInvoice.record({ invoiceId: event.payload.invoiceId }, context);
      },
    }),
  },
};
```

`project(options)` takes `events`, `run`, `renamedFrom` and `from`, as `Mesh.handler` does except for `onFailure`, and TypeScript infers `event.payload` from `events` in the same way. Names are unique across every kind, so `paidInvoices` cannot also be a `process` handler.

The first time delivery starts with this module, `paidInvoices` has no progress row. On a database that has never deleted an outbox row, it registers at position 0 and is handed every kept `InvoicePaid` row in order, then each new one as it is published. With three invoices paid before the deploy, `PaidInvoice` has three rows after the first round.

## What a project body may do

A project body runs as a `process` body does: inside the handler transaction, so its writes and the record that it handled the event commit together, and a failure rolls both back. It differs in three ways:

- **It may not publish or dispatch.** A read model is rebuilt by running its handler again over history, and a rebuild must never raise an event again or run a command again. A publish by any action the body calls, at any depth, and a `dispatch` anywhere in it, are `FrameworkError`s with `retryable: false`, so the handler stops at that event. The same holds for an action a seam starts while the handler call runs (an `afterCommit` that reacts to a read-model write, for instance): that action fails and is logged, and the handler's own work stays committed. An action whose `publish` step does not run (a `when=` that is false) is fine. A call started after the handler call has settled, such as a timer that fires later, is not refused.
- **It never skips an event.** `onFailure: "skip"` is refused at start whatever the bus declares, since a read model built without one event is wrong. A failing event stops the handler as any other, and `resumeHandler(name)` resumes it from its progress row once the cause is fixed.
- **It starts from the beginning of history** unless `from: "now"`.

## `from`

| `from` | A new handler starts | Needs |
|:--|:--|:--|
| `"beginning"` (the default) | at position 0, so it is handed every kept row it lists | the bus's `replay`, and a database that has never deleted an outbox row |
| `"now"` | at the highest position, as `process` and `listen` do | nothing |

On a bus without `replay`, `from` is required and can only be `"now"`: the type of `project`'s options says so, and a handler that leaves it out fails at start with `HandlerOptionError` (`MESH_HANDLER_OPTION`). `localBus()` declares `replay`. A `from` other than the two values is `MESH_HANDLER_OPTION` too.

A handler under `from: "now"` misses every event before it started. To fill its read model, backfill it from current rows (a script that reads the entities and writes the read model) before or after the deploy.

## The history rule

A read model silently built from part of the history is wrong, so a handler whose `from` is `"beginning"` takes on an event only when it has missed no row of it. Mesh does not record which events' rows were deleted, so the rule counts any deletion: once the deliverer has deleted any outbox row on a database (`keep: "until-delivered"`, the default, deletes after its first round), no `from: "beginning"` handler can start there, or gain an event, again. Switching to `keep: "all"` later does not bring back what was deleted, so it does not lift the refusal. A project that wants project handlers built from history sets `keep: "all"` from its first deploy.

When the rule refuses, delivery does not start: `connect()`, `startDelivery()` or `deliver()` rejects with `HandlerHistoryError` (`MESH_HANDLER_HISTORY`), and nothing is claimed or written. Its `handler`, `events` and `reason` say what failed, and its message names only the remedies that work on that database:

| `reason` | When | What to do |
|:--|:--|:--|
| `"deleted"` | a new handler, or one whose list gained events, on a database that has deleted rows | `from: "now"` and a backfill. For an event that is new and has never been published, `from: "now"` misses nothing and the backfill is empty |
| `"kept-below"` | a handler gained an event that has a kept row at or below the handler's position, which it would never be handed | rebuild it (below), give it a new name, or `from: "now"` and a backfill |
| `"kind"` | its progress row was registered under another kind (a `process` handler of that name, or one it takes over with `renamedFrom`) | rebuild it or give it a new name; once rows were deleted, `from: "now"` |
| `"from"` | its progress row started from now (it was deployed with `from: "now"`, or takes over such a row with `renamedFrom`) | the same as `"kind"`: such a row lacks every event before its start |

These do not trigger it: an unchanged handler, which keeps registering whatever was deleted since; a handler that lists fewer events; a gained event with no kept row at or below the position (it is handled from there on); `renamedFrom` from another project handler whose history is complete; and any handler under `from: "now"`. A project handler's progress row records whether its history is complete in its stored kind, `project` or `project:now`, which `mesh_handler_progress` shows. A complete one run for a while under `from: "now"` stays complete as long as its list does not grow, and may go back to `"beginning"`.

## Rebuilding a read model

On a database that has never deleted a row:

1. Stop delivery.
2. Clear the read model's rows.
3. Forget the handler's progress: `mesh events forget paidInvoices` ([Command line](./command-line.md#events-forget)).
4. Start delivery. The handler registers anew at position 0 and is handed every kept row again.

On a database that has deleted rows, the history to rebuild from is gone: rebuild by backfilling the read model from current rows under `from: "now"`.

## Errors

| Class | `code` | `retryable` | Thrown when |
|:--|:--|:--|:--|
| `HandlerHistoryError` | `MESH_HANDLER_HISTORY` | `false` | A project handler that starts from the beginning of history would build its read model from part of it; see [The history rule](#the-history-rule) |
| `HandlerOptionError` | `MESH_HANDLER_OPTION` | `false` | A project handler has a `from` other than `"beginning"` or `"now"`, asks for `onFailure: "skip"`, or starts from the beginning on a bus without `replay` |
| `FrameworkError` | `framework` | `false` | A project handler's body, or an action it or a seam started while it ran, published or dispatched |

`HandlerHistoryError` is exported by `@meshfw/event-sourcing`, the others by `@meshfw/runtime`. The other errors of delivery are under [Events](./events.md#failures-and-retries).
