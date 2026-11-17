---
title: "0098. Retention rules, dead letters and the rename map"
description: "Decision record 0098: `events.renamed` maps a moved event's stored rows to the event it now is; a handler with `onFailure: \"skip\"` sets an event aside in `mesh_outbox_failures` through `core.setAside`, a table every event project has, and `retryFailed(name)` replays them in order and stops at the first that fails; core warns once per set-aside and adds no list or forget call; keep periods are whole days, per-event keep is built with holes, and trace context stays a project recipe. Status: Accepted in part (lead ruling D45, pending operator review)."
---

# 0098. Retention rules, dead letters and the rename map

## Status

Accepted in part (lead ruling D45, pending operator review). The rename map and dead letters are built; keep periods and per-event keep are decided here and built by the next two pull requests of the same unit, which complete this record. Amends [ADR-0079](./0079-commands-events-and-the-outbox.md): its amendment of 2026-10-12 and 2026-10-13 says "a per-event setting can be added later without breaking anything", and this record is where it is added.

## Date

2026-11-17

## Deciders

lead, delegated: ruling D45 of 2026-11-17 takes every recommendation of the reviewed events-metadata design (open decisions OD-1 to OD-7); it waits for the operator's review with the other rulings of that run.

## Context

The events specification names four things M6 left for later: a way to move or rename an event declaration while the outbox keeps rows stored under the old name, `onFailure: "skip"` with the bus capability `dead-letters` and `retryFailed(name)`, how long rows are kept beyond the two values of `events.keep`, and trace context in an event's metadata. Before this record a project could not move a declaration under `keep: "all"` (every reader stopped at the first old row with `MESH_EVENT_UNDECLARED`), and core refused `onFailure: "skip"` on every bus, because nothing could record a skipped event. The specification fixes the outline: a skipped event "is copied whole into `mesh_outbox_failures`, which keeps it after the outbox row is deleted", "`retryFailed(name)` replays it", and "no failure is ever dropped without a record". It does not say in what order a replay runs, what it does when an event fails again, how a set-aside is reported, whether set-aside events can be listed or dropped, or where the table exists.

## Decision

1. **The rename map (OD-1 (a)).** `events.renamed` in `mesh.config.ts` maps a former FQN to the event it is now; core applies it at every read, so handlers, subscriptions, `readEvents` and the deletion pass see the new name and the stored rows are never rewritten. A key is written in full and is no declared event; a value names a declared event; a value is never a key, so the map has no chains and applying it twice changes nothing.
2. **Setting an event aside.** A handler with `onFailure: "skip"`, on a bus whose manifest declares `dead-letters`, whose retries are used up, or whose error says `retryable: false`, is not stopped: the bus calls `core.setAside(handler, row, error)`, a new member of `BusCore`, and core copies the row whole into `mesh_outbox_failures` with the handler's name and the error's `code` and message, and moves the handler's progress to the row's position, in one transaction fenced as `runHandler`'s is (the generation in single mode, the handler's lease in multi mode). Only core writes the table: a bus sets an event aside only through `setAside`. A row no declared event matches is never set aside; `DatabaseBusyError` and a lost claim or lease are never a handler's failure and set nothing aside. Without `dead-letters`, `onFailure: "skip"` stays `MESH_HANDLER_OPTION`. `localBus` declares the capability.
3. **The table in every event project (OD-4 (a)).** `mesh_outbox_failures` is a core table of every project that declares an event, whatever its bus, so switching to a bus without `dead-letters` never makes `mesh db push` drop rows a handler set aside. A failure row outlives its outbox row under every `keep`. The data layer reaches it through four optional operations (`writeFailure`, `readFailures`, `deleteFailure`, `renameFailures`), checked when delivery starts with a `"skip"` handler, so an adapter without them delivers every project that never skips.
4. **Replay order (OD-2 (a)).** `retryFailed(name)`, exported by `#mesh` only when the bus declares `dead-letters`, runs the handler once on each of its set-aside events in position order, deleting each failure row in the transaction that handles it (for a `listen` handler, in a short fenced transaction after its body); it stops at the first that fails again, or that the handler no longer lists, or that no declared event matches, and resolves `{ handled, failed }` with that row and every later one kept. It runs only where delivery may run: refused on a `{ deliver: false }` binding, `MESH_DELIVERER_TAKEN` while another process holds the claim, `MESH_HANDLER_LOST` where another process holds the handler's lease, and a `FrameworkError` while a call for the same handler runs in this process. A `renamedFrom` take-over moves the handler's failure rows with its progress.
5. **Reporting, no list or forget (OD-3 (a) and (c)).** Core writes one `console.warn` per set-aside naming the handler, the position, the event, the error and `retryFailed`. There is no call that lists or drops set-aside events: they are read with SQL and deleted by hand, and `forgetHandler` leaves them, so a handler registered again under the name can still replay them.
6. **Keep periods (OD-7 (a)).** A period is `{ days: n }`, whole days of 1 or more. Not built yet.
7. **Per-event keep (OD-5 (b)).** A per-event rule deletes rows inside the kept range, leaving holes that a hole record names, and a read that would cross a hole fails with `MESH_EVENTS_DELETED` rather than return a gap. Built last. Not built yet.
8. **Trace context (OD-6 (a)).** Trace context in event metadata is a documented project recipe over the events module's `metadata` function; no Mesh package depends on `@opentelemetry/api` until tracing returns.

## Options considered

1. Chains in the rename map, resolved transitively (OD-1 (b)): needs cycle detection, and a name that is both a key and a value reads wrongly once a declaration comes back.
2. Replay every set-aside event once and resolve counts (OD-2 (b)): retries the later events of a broken cause for nothing, and a `process` handler applies them out of order relative to the one that failed. Rejecting instead of resolving (OD-2 (c)) loses how many were handled.
3. Report through the bus (OD-3 (b)): `localBus`'s `onStopped` takes a `HandlerStoppedError`, which would then mean two things, or a new option per bus. `listFailed` and `forgetFailed` (OD-3 (d)) add public names and a destructive call no application has asked for; they are additive later.
4. The table only on a bus that declares `dead-letters` (OD-4 (b)): a bus switch drops the table and its rows.
5. Per-event rules inside the deleted prefix only (OD-5 (a)): one kept row pins every row above it, so the setting does almost nothing while appearing to work.
6. A handler hook around every body, or `@meshfw/runtime` writing trace context itself (OD-6 (b), (c)): a new module-contract name, or a dependency and a reserved metadata key, before tracing defines what Mesh's own spans need.
7. Periods in milliseconds or as duration strings (OD-7 (b), (c)): ambiguous beside the two string values, or a grammar to parse and document.

## Trade-off analysis

Every event project carries an empty `mesh_outbox_failures` and its `schema.ts` changed once; in return no bus switch can drop a failure. Replaying in order and stopping at the first failure keeps a `process` handler's effects in the order it would have produced them and gives the same shape as a stopped handler; an application that wants every row tried once can ask for an option later without a break. Warning on the console and offering no list or forget call adds no public name and nothing destructive, at the cost that a failure that never succeeds stays until someone deletes it by hand.

## Consequences

- `BusCore` gains `setAside`; a bus that declares `dead-letters` calls it for a `"skip"` handler whose retries are used up and goes on. The bus conformance suite has a dead-letters group for such a bus.
- `CORE_TABLES` gains `mesh_outbox_failures`; `@meshfw/runtime` exports `FailureOperations`, `FailureRow`, `retryFailed` and `RetryFailedResult`, and `@meshfw/runtime/testing` exports `retentionConformance` for the failure operations. SQLite and Postgres implement them.
- `#mesh` exports `retryFailed` and the type `RetryFailedResult` when the bus declares `dead-letters`; a project on another bus keeps its generated files byte for byte.
- [ADR-0079](./0079-commands-events-and-the-outbox.md) gains a pointer to this record for the per-event setting.

## Action items

- [x] The rename map, `events.renamed`.
- [x] `mesh_outbox_failures` and its four data-layer operations on SQLite and Postgres, `core.setAside`, `localBus`'s skip paths and manifest, `retryFailed`, and the `#mesh` exports.
- [ ] Keep periods, `{ days }`, the next pull request.
- [ ] Per-event keep with holes and the hole record, the pull request after it.
- [ ] The trace-context recipe in the user docs.
