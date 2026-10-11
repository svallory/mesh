---
title: "0079. Commands and events are files; `publish` writes to a core outbox; M6 builds it"
description: "Decision record 0079: `command` and `event` files, `handles=`, `publish` and the outbox in core, no `after-commit` step, `apply` and `process` handlers. Status: Accepted (DOM-02 in part, DOM-05, DOM-06, DOM-17, DOM-18, DOM-19, DOM-25)."
---

# 0079. Commands and events are files; `publish` writes to a core outbox; M6 builds it

## Status

Accepted. Amends [ADR-0023](./0023-workflows-and-jobs-deferred.md) (the outbox is not after 1.0), [ADR-0053](./0053-validate-then-do.md) (no `after-commit` step), [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) (M6 builds domain events and the outbox) and [ADR-0075](./0075-seams-use-the-extension-hosts-names.md) (the `afterCommit` seam is not the route for after-commit effects).

Rows: DOM-17, DOM-18, DOM-19, DOM-02 (the `publish` half; `publishes` is in [ADR-0077](./0077-surfaces-and-file-kinds.md)), DOM-05, DOM-06, DOM-25. None is open.

## Date

2026-10-11

## Deciders

operator (Saulo Vallory), 2026-10-11 (DOM-02, DOM-05, DOM-06 at 06:40 and 07:07; the rest the same day).

## Context

Hyper's engine keeps an event table by hand and delivers events from application code. [ADR-0023](./0023-workflows-and-jobs-deferred.md) put jobs, workflows and a provisional outbox after 1.0, and [ADR-0053](./0053-validate-then-do.md) listed an `after-commit` step as planned. The [study](../research/domain-concepts.md) (D7 to D9, D15, D16) asked what a command and an event are, how they are declared and raised, and where delivery lives.

## Decision

1. **`command` and `event` declarations live in their own files**, and an action names the commands it answers with `handles=[...]` (DOM-17). A command is a serialised request to run a write action; a query is a serialised read request.
2. **Declaring and raising are separate syntax** (DOM-19). An action raises an event with `publish :task-completed`.
3. **`publish` writes the event to the outbox**, in the action's transaction, and an event bus delivers it from there (DOM-02, DOM-06). A surface lists what it sends out with `publishes` ([ADR-0077](./0077-surfaces-and-file-kinds.md)).
4. **The outbox is core** (DOM-06). It comes with domain events in M6 (DOM-18), so [ADR-0023](./0023-workflows-and-jobs-deferred.md)'s "after 1.0" no longer covers it. Jobs and workflows stay after 1.0 (ARC-14).
5. **HA's hand-written event table is dropped** (DOM-18). HA keeps `@meshfw/jsonrpc` with a hand-written method table ([ADR-0077](./0077-surfaces-and-file-kinds.md)).
6. **There is no `after-commit` step**, and the `afterCommit` seam is not used for it either (DOM-25). An effect after commit is a `publish` and a listener.
7. **Handler words** (DOM-05): a handler that updates a read-model row is `apply`; a handler that runs commands is `process`.

An illustration (the files are the study's proposal; the ruled words are `command`, `event`, `handles=`, `publish`, `apply` and `process`):

```mx "An event file and an action that raises it (illustration)"
event :task-completed
  &taskId
  &workspaceId
```

```mx "src/domain/work/task.mesh.mx (illustration)"
entity :Task
  actions
    update :complete handles=[:complete-task]
      do
        publish :task-completed
```

## Options considered

D7 (commands): inside the action, a separate file (chosen), or none. D8 (when): M6 (chosen), after 1.0 with a hand-written table. D9 (declaring and raising): one syntax that does both, or two (chosen: reading ii). D15 (outbox): core (chosen), an extension, or after 1.0. D16 (after-commit): a step, the `afterCommit` seam, or `publish` plus a listener (chosen).

## Trade-off analysis

An outbox written in the action's transaction means an event exists if and only if the write committed, which an after-commit step cannot promise. Delivery is at least once, so a listener must tolerate repeats. Core owns the table, so the Hyper port does not carry its own. The cost is a core table and a bus contract in M6, which the roadmap size does not yet reflect.

## Consequences

- [ADR-0023](./0023-workflows-and-jobs-deferred.md) is amended: the outbox is not deferred.
- [ADR-0053](./0053-validate-then-do.md) is amended with [ADR-0082](./0082-named-checks-and-mixins.md): no `after-commit` step.
- [ADR-0075](./0075-seams-use-the-extension-hosts-names.md): its note that Hyper's typed events are an application table is replaced by the outbox. The `afterCommit` seam stays as a seam for extensions; it is not how effects after commit are written.
- The roadmap's M6 becomes "domain events and the outbox", and HA drops its event table. The roadmap size for M6 is unchanged here; it is probably too small.
- `apply` also names state folding in the study's event-sourcing sketch. [ADR-0081](./0081-event-sourcing-and-cqrs-are-extensions.md) leaves that to the extension, which may use another word.

## Action items

- [ ] M6: the event and command files, `publish`, the outbox table and the bus contract.
- [ ] Revisit the M6 size.
