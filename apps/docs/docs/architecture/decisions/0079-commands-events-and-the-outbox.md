---
title: "0079. Commands and events are files; `publish` writes to a core outbox; M6 builds it"
description: "Decision record 0079: `command` and `event` files, `on=`, `publish` and the outbox in core, no `after-commit` step, `project` and `process` handlers. Status: Accepted (DOM-02 in part, DOM-05, DOM-06, DOM-17, DOM-18, DOM-19, DOM-25). Amended 2026-10-11 (the outbox keeps its rows), 2026-10-12 and 2026-10-13 (DOM-43: how long it keeps them is configured by the application, and by default a delivered row is deleted) and 2026-10-13 (DOM-05: a read-model handler is `project`, not `apply`) and 2026-10-15 (DOM-17: an action answers a command with `on=`, not `handles=`) and 2026-10-17 (the third handler kind is `listen`)."
---

# 0079. Commands and events are files; `publish` writes to a core outbox; M6 builds it

> **Amendment, 2026-10-17 (outbox pruning and `publish`).** Only core's deliverer deletes outbox rows, and pruning is not a bus capability; this overrides the amendment of 2026-10-12 and 2026-10-13 below, which says whether an adapter can prune rows is one of its capabilities. A `publish` step is a function returning an event instance (`publish=() => new TaskCompleted({ ... })`), as in the specification's section on publishing; the `publish :task-completed` example in Decision item 2 is superseded and kept as history.

> **Amendment, 2026-10-17.** Events have three handler kinds: `project` updates read-model rows, `process` runs commands, and `listen` makes an effect outside the database: its body runs outside any transaction, at least once, with `event.id` as the idempotency key where the service accepts one. "Handler" is the general word and a listener is a `listen` handler. `publish` and `publishes` are the sending side and do not change. Where the text below says "a listener" for an effect after commit, it means a `listen` handler.

> **Amendment, 2026-10-15 (DOM-17).** An action names the command it answers with `on=` and the command's imported identifier, one command per action (`update on=CompleteTask`); `handles=[...]` is not the option. When the action has `on=` and no name, it is named after the command (`update on=CompleteTask` is `completeTask`); `update :complete on=CompleteTask` names it `complete`. A command may also live in an owner's `commands` section, not only in its own file. The Decision item 1 and the illustration below are corrected to `on=`. The operator ruled this on 2026-10-11 and 2026-10-14.

> **Amendment, 2026-10-13 (DOM-05).** A handler that updates a read-model row is `project`, not `apply`; a handler that runs commands is still `process`. `apply` is kept for folding events into an event-sourced aggregate (the extension's word, [ADR-0081](./0081-event-sourcing-and-cqrs-are-extensions.md)), so each word has one meaning. Item 7 below, and the last consequence, say `apply` for a read-model handler; read them as `project`. The operator ruled this on 2026-10-11 and confirmed it on 2026-10-13. The body is kept as history.

> **Amendment, 2026-10-12 and 2026-10-13 (DOM-43).** How long the outbox keeps its rows is configured by the application. The amendment of 2026-10-11 below argued from Hyper that a row is never deleted once delivered; keeping every row is now one setting, the one Hyper's application chooses for itself because `events.read` reads the whole log back, not the rule for every application. The default is to delete a row after it is delivered, the usual behaviour of a transactional outbox. The setting lives in `mesh.config.ts` only; a per-event setting can be added later without breaking anything. The delivery adapter honours the setting, and whether an adapter can prune rows is one of its capabilities. The operator ruled the principle on 2026-10-12 and the default and the place on 2026-10-13. The body below, and the amendment of 2026-10-11, are kept as history.

> **Amendment, 2026-10-11 (the outbox is a permanent log).** In item 4 below, the outbox is core, and it is a permanent, ordered log of the events, not the table the transactional-outbox pattern usually describes, which is emptied after delivery. It replaces Hyper's event table (DOM-06, DOM-18), and Hyper reads the whole log back, in order, from any cursor (`events.read`, `PROTOCOL.md` section 8, in the Hyper specification repository, branch `feat/protocol-phases`, commit `ccc00f9`), so a row is never deleted once delivered. The decisions below do not change.

## Status

Accepted. Amends [ADR-0023](./0023-workflows-and-jobs-deferred.md) (the outbox is not after 1.0), [ADR-0053](./0053-validate-then-do.md) (no `after-commit` step), [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) (M6 builds domain events and the outbox) and [ADR-0075](./0075-seams-use-the-extension-hosts-names.md) (the `afterCommit` seam is not the route for after-commit effects).

Rows: DOM-17, DOM-18, DOM-19, DOM-02 (the `publish` half; `publishes` is in [ADR-0077](./0077-surfaces-and-file-kinds.md)), DOM-05, DOM-06, DOM-25, and DOM-43 (the amendment of 2026-10-12 and 2026-10-13).

## Date

2026-10-11

## Deciders

operator (Saulo Vallory), 2026-10-11 (DOM-02, DOM-05, DOM-06 at 06:40 and 07:07; the rest the same day).

## Context

Hyper's engine keeps an event table by hand and delivers events from application code. [ADR-0023](./0023-workflows-and-jobs-deferred.md) put jobs, workflows and a provisional outbox after 1.0, and [ADR-0053](./0053-validate-then-do.md) listed an `after-commit` step as planned. The [study](../research/domain-concepts.md) (D7 to D9, D15, D16) asked what a command and an event are, how they are declared and raised, and where delivery lives.

## Decision

1. **`command` and `event` declarations live in their own files**, and an action names the command it answers with `on=` (DOM-17). A command is a serialised request to run a write action; a query is a serialised read request.
2. **Declaring and raising are separate syntax** (DOM-19). An action raises an event with `publish :task-completed` (superseded, 2026-10-17: see the amendment at the top).
3. **`publish` writes the event to the outbox**, in the action's transaction, and an event bus delivers it from there (DOM-02, DOM-06). A surface lists what it sends out with `publishes` ([ADR-0077](./0077-surfaces-and-file-kinds.md)).
4. **The outbox is core** (DOM-06). It is a permanent, ordered log of the events, not a table emptied after delivery (see the amendment at the top). It comes with domain events in M6 (DOM-18), so [ADR-0023](./0023-workflows-and-jobs-deferred.md)'s "after 1.0" no longer covers it. Jobs and workflows stay after 1.0 (ARC-14).
5. **HA's hand-written event table is dropped** (DOM-18). HA keeps `@meshfw/jsonrpc` with a hand-written method table ([ADR-0077](./0077-surfaces-and-file-kinds.md)).
6. **There is no `after-commit` step**, and the `afterCommit` seam is not used for it either (DOM-25). An effect after commit is a `publish` and a listener.
7. **Handler words** (DOM-05): a handler that updates a read-model row is `apply`; a handler that runs commands is `process`.

An illustration. The files, `on=` and `publish` are ruled; the lines inside them are the study's sketch:

```mx "An event file and an action that raises it (illustration)"
event :task-completed
  &taskId
  &workspaceId
```

The `publish :task-completed` step in the next example is superseded (amendment of 2026-10-17): a `publish` step is `publish=() => new TaskCompleted({ ... })`.

```mx "src/domain/work/task.mesh.mx (illustration)"
import { CompleteTask } from "./complete-task.mesh.mx"

entity :Task
  actions
    update :complete on=CompleteTask
      do
        publish :task-completed
```

## Options considered

The study's D7 (a command in core): (a) generated only, as `Command` and `Query` unions with a `dispatch()` per surface; (b) a `command` declaration per entity action. The ruling is closer to (b): commands are declared in their own files and an action names its command with `on=`. D8 (domain events): the form, (a) an `events` section and an `emit` step, (b) an `emits=` option on the action line, (c) application code on seams only; the timing, (i) after 1.0 with Hyper keeping its table, (ii) before the gate. The ruling is before the gate (M6) and, per DOM-19, declaring and raising are separate syntax. D9 (seam payloads now): (a) reserve an `events` field on `afterWrite` and `afterCommit`; (b) declared events get their own seam later; (c) decide later. (a) was not taken: with events delivered from the outbox, the seams need no `events` field (a consequence, not a ruling; the payloads are settled in M6's design). D15 (outbox): (a) an extension; (b) core (chosen). D16 (after-commit): (a) drop the `after-commit` step; (b) keep it for one-off side effects (the ruling is (a), and the `afterCommit` seam is not the route either).

## Trade-off analysis

An outbox written in the action's transaction means an event exists if and only if the write committed, which an after-commit step cannot promise. Delivery from an outbox is usually at least once, so a listener should tolerate repeats; that is a design assumption of this record, not a ruling. Core owns the table, so the Hyper port does not carry its own. The cost is a core table and a bus contract in M6, which the roadmap size does not yet reflect.

## Consequences

- [ADR-0023](./0023-workflows-and-jobs-deferred.md) is amended: the outbox is not deferred.
- [ADR-0053](./0053-validate-then-do.md) is amended with [ADR-0082](./0082-named-checks-and-mixins.md): no `after-commit` step.
- [ADR-0075](./0075-seams-use-the-extension-hosts-names.md): its note that Hyper's typed events are an application table is replaced by the outbox. The `afterCommit` seam stays as built; it is not the route for effects after commit (DOM-25).
- The roadmap's M6 becomes "domain events and the outbox", and HA drops its event table. The roadmap size for M6 is unchanged here; it is probably too small.
- `apply` names state folding in the study's event-sourcing sketch, [ADR-0081](./0081-event-sourcing-and-cqrs-are-extensions.md) leaves that to the extension, which may use another word.

## Action items

- [ ] M6: the event and command files, `publish`, the outbox table and the bus contract.
- [ ] Revisit the M6 size.
