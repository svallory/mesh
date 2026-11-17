---
title: "0091. Delivery from several processes: a lease per handler"
description: "Decision record 0091: how events are delivered from several processes on one database (M9): the bus declares multi-process, each handler is held by one process through a lease on its progress row, a handler's registered union only an explicit `mesh events adopt` shrinks, and process rows carry liveness, ownership and the keep in force. Status: Accepted (lead ruling D31, pending operator review)."
---

# 0091. Delivery from several processes: a lease per handler

## Status

Accepted (lead ruling D31, pending operator review). Amends [ADR-0079](./0079-commands-events-and-the-outbox.md): one process delivers per database in M6, and in single mode after it. Supersedes, where they differ, the 2026-10 design note on multi-process delivery, which the reviewed implementation design replaced.

## Date

2026-11-17

## Deciders

lead, delegated: ruling D31 of 2026-11-17 takes every recommendation of the reviewed M9 multi-process design (open decisions Q1 to Q10); it waits for the operator's review with the other rulings of that run.

## Context

M6 built delivery for one process per database: that process holds the database's claim in `mesh_outbox_state`, renews it every 5 seconds, and a second process that tries to deliver fails with `MESH_DELIVERER_TAKEN`. The bus capability `multi-process` ("handlers and subscriptions in every process on the database") was named in the capability table and reserved for later. Three questions had to be answered before several processes could deliver one database: how two processes are kept from running one handler for one event at once; how a deploy, in which two builds with different handler lists run side by side, neither loses an event nor stalls; and what a process records about itself so that the others can tell it is alive.

## Decision

1. **A lease per handler (Q1).** Each handler is held by one process at a time: its progress row in `mesh_handler_progress` records the holder's run id and a generation that rises at each takeover. Every handler transaction locks the row and goes on only when the lease is still this process's; a lost lease is `MESH_HANDLER_LOST`, which a bus treats as the end of that handler in this process, never as a failure. A handler is serial under `ordered-delivery`, so a lease gives the same throughput as every process feeding every handler behind a row lock, without blocking the others on every event and with a way to fence a `listen` body that runs outside any transaction.
2. **The bus's manifest is the switch (Q2).** A binding delivers in multi mode exactly when its bus declares `multi-process`; `localBus({ processes: "many" })` does. No current project's generated output changes, and a capability keeps meaning what the bus does. The mode always comes from the configuration, never from probing the schema.
3. **The union lives in the progress row (Q3).** In multi mode the row's `events` column holds the handler's registered union, every event any build listed for it since the last adoption; a registration only grows it. A process never passes a row of an event in the union that its own list lacks, and yields the handler there instead (`MESH_HANDLER_LOST`, reason `pending`), so a build that lists the event takes it over.
4. **Only an explicit command shrinks the union (Q4).** `mesh events adopt <handler> [--drop <event>]...` (and `adoptHandler` from `#mesh`) keeps every event a live process lists and drops only the events named. It is not a vote among live processes: during a rolling restart a process of the old build may be briefly down, and a vote would drop its event and let the new holder pass rows the old build comes back to. A deploy that removes an event from a handler therefore needs one command, and the delivering processes log the waiting handler, naming it.
5. **Progress by `id` is deferred (Q5)** until a bus without `ordered-delivery` exists; none is planned before brokers.
6. **The first live process takes every free lease (Q6).** Spreading leases evenly needs a stable count of processes and moves leases at every start and stop.
7. **Multi mode runs on SQLite (Q7).** The rules hold under its single writer; processes share one host, so it buys failover, not throughput.
8. **Process rows (Q8).** Each delivering process writes one row in the new table `mesh_delivery_process` (run id, renewal time by the database's clock, host, pid, its `keep`, its handlers and their lists, and the events its build declares), renewed every 5 seconds and lapsing at 15, as the claim does. The rows serve lease liveness, subscription ownership (a `run_id` on `mesh_subscription_progress`), orphan status, fencing of deletion batches, the guard that keeps single-mode and multi-mode processes from delivering one database together (the claim columns hold a nil claim while any row lives), the known declared events and adoption. One row per process is renewed instead of one per lease. The keep in force is recorded in `mesh_outbox_state` and moves only towards `"all"`; `mesh events keep until-delivered` moves it back, and refuses while a live process runs with `"all"`.
9. **A row of an event only another live build declares (Q9)** is judged by the union, passed when the union lacks it, so a deploy that adds an event does not stop the old build's other handlers; a row no live build declares still stops the handler with `MESH_EVENT_UNDECLARED`. A subscription still ends on such a row, naming a process that can open it.
10. **A stopped handler keeps its lease (Q10)** while its process lives, as a stopped handler keeps the claim in single mode, so a poison event does not move from process to process; `resumeHandler` and a restart send it on.

## Options considered

1. Every process feeds every handler, serialised by `SELECT ... FOR UPDATE` in the handler transaction (Q1 (b)): blocks N-1 processes on every event and cannot cover a `listen` body without a marker that is a lease again.
2. `events.requires` or a new configuration key as the switch (Q2 (b), (c)): the first changes Hyper's generated output and turns a build check into a behaviour switch; the second is API the spec does not have.
3. The union as a map in `mesh_outbox_state` (Q3 (b)): one row every registration contends on, duplicating what the deletion pass already reads.
4. Adoption that sets the union to the live processes' lists, or shrinks it automatically (Q4 (b), (c)): the vote the 2026-10 note warned against.
5. Following the spec's undeclared-row rule literally in multi mode (Q9 (b)): every deploy that adds an event would stall every old-build holder.

## Consequences

- One new table and three new columns, present only in a project whose bus declares `multi-process`; every other project's schema and generated code are byte for byte unchanged.
- `MESH_HANDLER_LOST` joins the bus contract: a bus ends that handler for the round and reports nothing.
- Two commands, `mesh events adopt` and `mesh events keep`, and two log lines under the orphan rule (a handler held by none for the lapse time; a recorded `keep: "all"` while a process runs with `"until-delivered"`).
- Postgres has the same operations in its own adapter, with `FOR UPDATE` row locks and one conditional `UPDATE` for each of the deletion pass's moves; at `SERIALIZABLE` a lock wait does not renew the waiter's snapshot, so a waiter that would work from a state the other changed fails with `40001` (a retryable `DatabaseBusyError`) instead.
