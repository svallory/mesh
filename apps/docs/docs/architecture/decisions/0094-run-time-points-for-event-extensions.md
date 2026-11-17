---
title: "0094. Run-time points for event extensions: contributed handler kinds and the upcast point"
description: "Decision record 0094: core publishes a run-time point through which an extension makes handlers of a kind of its own (first, `project` of @meshfw/event-sourcing), before the extension host exists: the kind decides where a new handler starts and what its progress row records, and its call chain may neither publish nor dispatch; and an upcast point, the events module's `upcast`, applied to every stored row read back. Status: Proposed (lead ruling D46, pending operator review)."
---

# 0094. Run-time points for event extensions: contributed handler kinds and the upcast point

## Status

Proposed (lead ruling D46, pending operator review). Amends [ADR-0020](./0020-extension-contributions-through-declared-points.md) as [ADR-0075](./0075-seams-use-the-extension-hosts-names.md) did: core publishes a run-time point to extensions before the extension host's manifest exists. Adds one consequence to [ADR-0079](./0079-commands-events-and-the-outbox.md). The partial-history rule of `project` (decision 6) came with `@meshfw/event-sourcing`; the upcast point (decision 7) came with the next pull request of the same unit.

## Date

2026-11-17

## Deciders

lead, delegated: ruling D46 of 2026-11-17 takes every recommendation of the reviewed event-sourcing design (open decisions Q0 to Q6); it waits for the operator's review with the other rulings of that run.

## Context

[ADR-0081](./0081-event-sourcing-and-cqrs-are-extensions.md) puts event sourcing and CQRS in extensions, and the spec gives the third handler kind, `project`, to `@meshfw/event-sourcing`, not to core: a `project` handler builds a read model by replaying every event it lists from the beginning of history, its writes commit with its progress, and its body may neither publish nor dispatch, since a read model is rebuilt by running its handler again over history and a rebuild must never re-raise events or re-issue commands. Core's own kinds, `process` and `listen`, start from now, and the events module's loader refused any other key of `handlers`. Core keeps no event versions: a stored row whose payload an event's class no longer accepts stopped every reader with a `FrameworkError`, and the spec gives upcasting to the extension, leaving core the table from FQN to class.

The extension host (milestone M11, after 1.0) is where an extension would declare such a kind, and it does not exist. ADR-0075 set the precedent of building run-time points before the host, with the host's names, so that the host later wraps them instead of replacing them; that ruling was made for the application's seams, so following it for an extension is a decision of its own (Q0).

## Decision

1. **Build the point now (Q0 (a)).** Core publishes a contributed-kind point from `@meshfw/runtime` before the host exists. When the host is built, it requires a package that contributes a kind to be listed in `mesh.config.ts` `extensions: [...]`, and core then refuses an unlisted contributed kind with a message that names the line to add: a one-line migration, refused loudly, never changed silently. Until then an extension works without being listed.
2. **The kind is carried on each handler (Q2 (a)).** A handler an extension's helper makes carries its `HandlerKind` under the runtime-owned symbol `HANDLER_KIND`, and the events module lists it under `handlers.<kind name>`. Nothing changes in `mesh.config.ts`, the generated code or the model. A key of `handlers` other than `process` and `listen` is accepted only when every handler under it carries a kind of that name; an empty group under such a key, a handler with no kind there, a handler under another kind's key and a kind named like a core kind are `FrameworkError`s when the module loads.
3. **What a kind decides.** A kind has a name (one lowercase word), an owner (the package, for messages) and four functions core calls: `check` at start, before core's own option checks and before anything is claimed, so the kind's message wins; `start`, in the registration transaction, for a handler with no progress row, giving the position it starts after (from the deleted-through position to the highest; anything else is a `FrameworkError`); `adopt`, in the same transaction, for a handler whose row exists, with the events its list gained, which may refuse; and `stored`, the progress row's stored kind (`name`, or `name:` and one lowercase word, such as `project:now`), so a kind can record how its row started. Core reads the registration through `Registration`: the deleted-through position, whether any row has ever been deleted, the highest position, the `keep` in force and `firstRow`, one indexed query of the outbox. Both claim strategies (one claim per database, and delivery from several processes) reach these through the one Registration function, `handlerStart`.
4. **A refusal fails the whole start (Q6 (a)).** A throw from `check`, `start`, `adopt` or `stored` rejects `connect()`, `startDelivery()` or `deliver()` and rolls the registration transaction back: the claim's generation is not raised and no progress row is written, as for `MESH_HANDLER_OPTION`. One case has no start left to reject: in delivery from several processes, a `renamedFrom` move that waits until no live process registers the former name runs from a later renewal of the leases, after `connect()` resolved. A refusal there rolls that move's transaction back, leaving the former row as it was, and stops delivery with `MESH_DELIVERER_LOST`, whose message names the move.
5. **A contributed kind runs as `process` does, with a quiet call chain.** Its body runs in the handler transaction and its progress is written in it. Until the handler call settles, a publish by any action of its call chain (the body, every action it calls at any depth, and every action a seam starts for one of them, the handler transaction's own `afterCommit` included) and a `dispatch` anywhere in it are `FrameworkError`s with `retryable: false`, so the handler stops at its first attempt. A call started after the chain settled (a timer that fires later) begins a new chain and is not refused. Seams still run for a quiet chain; only a publish or a dispatch from them is refused.

6. **`project`'s history rule counts any deletion (Q3 (a)).** `@meshfw/event-sourcing` decides, through `start` and `adopt`, that a `project` handler whose `from` is `"beginning"` starts at position 0, or takes on an added event, only while `Registration.deletedAny` is false; otherwise the start fails with `MESH_HANDLER_HISTORY`, whose remedies never include `keep: "all"`, which cannot bring back a deleted row. An added event is also refused when a kept row of it lies at or below the handler's position. Through `stored`, the progress row records whether the handled history is complete (`project`) or not (`project:now`: started from now, taken over from another kind, or grown under `from: "now"`), and a `from: "beginning"` handler refuses any row that is not `project`. The spec's deleted-names record in `mesh_outbox_state`, which would let an event no deletion touched start from history, is not built: it needs a core column and a write in core's deletion pass for an extension's check, and adding it later only relaxes a refusal.
7. **Upcasting is one core point, the events module's `upcast` (Q5 (a)).** The events module may export `upcast(stored)`, which returns the fields the stored row's event accepts today. Core calls it for every stored row it turns into an event record (handlers of every kind, live subscriptions, `readEvents`, the dead-letter replay of `retryFailed`), after the rename map has given the row its declared name and before dates are revived and the class is built; `published()` is not upcast. No version is stored: steps tell a shape by its fields. `@meshfw/event-sourcing` composes the export from per-event steps (`upcasters(upcaster(Event, ...steps))`), but the point is the application's, as `metadata` and `context` are, so a hand-written function works too. `readEvents` now loads the events module, so a process that only reads history imports it, and a failing `load` fails that read: the alternative, upcasting only when something else had loaded the module, would give one row two shapes.

## Options considered

1. Wait for the host (Q0 (b)): no read model built from history and no upcasting until after M11, which has no date; applications would write them by hand over `readEvents` and `process` handlers, which the spec's "Later" section exists to replace.
2. Build only the upcasting point now (Q0 (c)): the `project` kind would wait for the host.
3. Declare kinds in `mesh.config.ts` `extensions` with a run-time part (Q2 (b)): needs a template change to pass it from `connect()`, so generated output changes, and it decides the host's manifest shape, which the extension-host page leaves open.
4. `project` as a third core kind (Q2 (c)): contradicts the spec and ADR-0081.
5. A refused start registers the other handlers and reports the one (Q6 (b)): needs a "not registered" state and a report channel, and leaves a read model silently stale in production.
6. The deleted-names record (Q3 (b)): a `deleted_names` column on `mesh_outbox_state` written by every deletion batch, so a database that has deleted rows of some events can still start a read model of the others from history. Its cost is a core column and a core write path for an extension's check; databases that deleted rows before it existed could not know what they deleted.
7. A stored schema version per row (Q5 (b)), an outbox column or a key written into `metadata`, with `upcast from=N` steps: a core column, or an extension writing into the project's own `metadata`, and the declared version needs `version=` on the `event` tag, which needs the host. Versions can be added later as a step that reads one.
8. No core point (Q5 (c)), the extension wrapping each event class: generated classes are not the extension's to wrap, and `readEvents` and subscriptions build records from core's FQN table.

## Trade-off analysis

The point costs one published core contract that the host must wrap rather than replace, and one migration line per project when the host requires the listing. In return it adds nothing to the `.mesh.mx` language and nothing to generated code, so a project that uses no contributed kind keeps its `model.json`, generated files and schema byte for byte, and its run-time behaviour. Carrying the kind on the handler object, as `DECLARATION` is carried on generated classes, means a project with two copies of `@meshfw/runtime` would not recognise the other copy's kinds; [ADR-0060](./0060-meshfw-package-scope.md)'s peer-dependency rule keeps one copy installed.

## Consequences

- `RegisteredHandler.kind` and `HandlerProgressRow.kind` are any string: `process`, `listen`, a contributed kind's name, or what its `stored` returned. The `mesh_handler_progress.kind` column was already opaque text and stays so on every adapter, Postgres included.
- A bus feeds a contributed kind as any handler; the bus conformance suite checks it.
- [ADR-0079](./0079-commands-events-and-the-outbox.md) gains one consequence: the body of a handler of a contributed kind is quiet (decision 5).

## Action items

- [x] The contributed-kind point in core: `HANDLER_KIND`, `HandlerKind`, `KindHandler`, `Registration`, start, adopt and stored at registration, the quiet call chain.
- [x] `@meshfw/event-sourcing` with `project`, `from` and the partial-history check (`MESH_HANDLER_HISTORY`).
- [x] The events module's `upcast` point, with `upcaster()` and `upcasters()` in `@meshfw/event-sourcing`.
- [ ] When the extension host is built: require `extensions: [...]` for a package that contributes a kind.
