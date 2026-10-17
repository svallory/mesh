---
title: "0081. Event sourcing and CQRS are two extensions"
description: "Decision record 0081: `@meshfw/event-sourcing` and `@meshfw/cqrs` are extensions, not core. Status: Accepted (DOM-24)."
---

# 0081. Event sourcing and CQRS are two extensions

> **Amendment, 2026-10-17.** The `project` handler kind (a read model built by replaying every event it lists from the beginning of history), the `from` option, the deleted-names record and the partial-history check belong to this extension, not to core. The operator's guidance: design it from Greg Young's work on event sourcing, and expect that it may need a dedicated event store such as Kurrent (formerly EventStoreDB).

## Status

Accepted. Row: DOM-24. No row is open.

## Date

2026-10-11

## Deciders

operator (Saulo Vallory), 2026-10-11.

## Context

Event sourcing keeps events as the source of truth and rebuilds state by folding them; CQRS splits writes from reads and keeps read models. The [study](../research/domain-concepts.md) (D14) asked whether either belongs in core. Core holds only what Mesh cannot run without ([ADR-0001](./0001-three-rings.md)).

## Decision

Event sourcing and CQRS are two extensions, `@meshfw/event-sourcing` and `@meshfw/cqrs` (DOM-24). Core provides domain events and the outbox ([ADR-0079](./0079-commands-events-and-the-outbox.md)); the extensions build on them through declared points ([ADR-0020](./0020-extension-contributions-through-declared-points.md)).

## Options considered

Both in core; both as extensions (chosen); event sourcing as an extension and CQRS as a pattern only; neither.

## Trade-off analysis

Most applications need neither. As extensions they cost nothing to those who do not use them. The price is that the extensions must rely on seams core gives them, so core's event design in M6 has to leave room.

## Consequences

- The `apply` word: the study's event-sourcing sketch folds events into state with `apply`, while [ADR-0079](./0079-commands-events-and-the-outbox.md) first used `apply` for a handler that updates a read-model row. DOM-05 (2026-10-13) settled it: a read-model handler is `project`, and `apply` is kept for folding events into an event-sourced aggregate, so each word has one meaning. The extension still decides its own words.
- Not built. No row dates them. RDM-01 applies: not before the port unless the port needs them, and as many planned constructs as possible before 1.0.

## Action items

- [ ] After M6: design both extensions against the outbox and the seams.
