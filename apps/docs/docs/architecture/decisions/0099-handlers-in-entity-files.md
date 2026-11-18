---
title: "0099. Handlers in entity files"
description: "Decision record 0099: an entity or aggregate file may hold one `handlers` section of `process` and `listen` lines (`listen :receipt [on=InvoicePaid] async ({ event, context }) { ... }`); each is generated into `<owner>.handlers.ts`, keyed `<owner FQN>.<name>`, handed to `bindDomain` by the generated `bind` and registered beside the events module's handlers. Events leave the application through an outlet over `subscribe`, Redis first. Status: Accepted (lead ruling D44, pending operator review)."
---

# 0099. Handlers in entity files

## Status

Accepted (lead ruling D44, pending operator review). The `handlers` section is built: its syntax, checks and model came first, then the generated files and their registration. The Redis outlet (decision 6) is not built yet. Amends [ADR-0079](./0079-commands-events-and-the-outbox.md), whose amendment of 2026-10-17 says "handlers are registered in TypeScript": they may now also be declared in a `.mesh.mx` file.

## Date

2026-11-17

## Deciders

lead, delegated: ruling D44 of 2026-11-17 takes every recommendation of the reviewed handlers design (`notes/architecture/handlers-design.md`, open decisions Q1 to Q13); it waits for the operator's review with the other rulings of that run.

## Context

The events specification placed handlers in a separate `handlers` section of the `.mesh.mx` files, "after 1.0; until then handlers are registered in TypeScript", and wrote nothing more about it: no line form, scope or name rule. Until this record a project wrote every handler in its events module (`src/events.ts`, loaded by `events.load`), away from the entity whose events it handles and whose actions it calls. The same request asked for broker adapters and fan-out across machines; delivery from several processes on one Postgres database is the `multi-process` capability, built by its own units, so this record decides only what reaches handlers from a `.mesh.mx` file and how events leave for other applications.

## Decision

1. **The section (Q1, Q9, Q10).** An entity or an aggregate holds at most one `handlers` section. Its lines are `process` and `listen` (core's two kinds; `project` belongs to the event-sourcing extension), each with a name atom, `on=` naming one event or a non-empty list of them (`on=InvoicePaid`, `on=[InvoicePaid, billing.PaymentRecorded]`), and a body written as the line's default option, one function of `{ event, context }`. A handler's name is unique in its section, across both kinds, and may equal the name of any member of its owner: a handler is never reached as `&name` or as a method.
2. **The key (Q2, Q3).** A section handler is registered and its progress row stored under `<owner FQN>.<name>` (`billing.Invoice.receipt`), unique by construction. `renamed-from=:old` names a former handler of the same owner, whose row (`billing.Invoice.old`) moves to the new key; moving a handler between owners, or from the events module into a section, does not carry progress, and the docs say so.
3. **The body (Q4, Q5, Q11).** A body is always plain TypeScript; its scope roots are `event` (the `EventRecord` of one of the listed events, so `event.payload` is typed by their union) and `context` (what the events module's `context(event)` returns, by default `{ system: true }`). Reading `self`, `input`, `actor`, `before`, a member `&x` or `%.now`/`%.today` there is `MESH_HANDLER_SCOPE`. A body calls the actions of its owner and of the entities its file imports; `dispatch` is reached through a helper module, and `Mesh` gains no member for it.
4. **Generation and registration.** The build writes `<owner>.handlers.ts` beside the owner's generated files for each owner whose section has a line, exporting `$handlers`: one record per kind, each handler made with `Mesh.handler` from the listed event classes and the printed body, and where each line is written. The generated `bind` imports every such file and passes `mergeHandlers([...])` to `bindDomain` as a fifth argument, so every binding that delivers registers them, with or without `events.load`. Core checks them with the events module's handlers in `declaredHandlers`, through the same checks: claim, registration, `runHandler`, retries, deletion and leases see ordinary handlers. A module handler and a section handler with one key, or a `renamedFrom` across the two sources that names a registered handler or that both name, is `MESH_HANDLER_OPTION` at start, and the message names both sources. A project with no section generates what it did, byte for byte.
5. **Capabilities (Q12).** A section handler is in the model, so the build checks the configured bus's `ordered-delivery` at each handler line (`MESH_CAPABILITY`); the start check stays.
6. **Events that leave (Q6, Q7, Q8, Q13).** Events reach another application through an outlet: a subscription that copies the events a surface `publishes` to a broker, starting with a Redis stream (`redisOutlet`, a package of its own, with a required `events` list, no `metadata`, and a required `maxLength`). No broker bus adapter, partitioned delivery or handler placement is built.

## Consequences

- A handler lives beside the entity whose actions it calls, and its key says where it is written; the events module stays the place for handlers that span the domain, for `metadata`, `context` and `upcast`.
- Renaming or moving an entity changes its handlers' keys: each needs `renamed-from=` or starts from now, leaving the old rows as orphans (`mesh events forget`).
- One more generator, `handlers` (`handlers.ts.jig`, `HandlersView`), which a project can override like the others.
- The outlet, when built, needs no core change: retention, restart and ownership across processes are a subscription's.
