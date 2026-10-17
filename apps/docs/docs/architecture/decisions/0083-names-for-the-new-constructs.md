---
title: "0083. Names for the new constructs: the name-clash table is accepted"
description: "Decision record 0083: the accepted name-clash resolutions for the port, and the words changed from the study. Status: Accepted (DOM-29). Amended 2026-10-17 (the third handler kind is `listen`)."
---

# 0083. Names for the new constructs: the name-clash table is accepted

> **Amendment, 2026-10-17.** The third handler kind is `listen`, beside `project` and `process` ([ADR-0079](./0079-commands-events-and-the-outbox.md)). Where the table below says "a listener", it means a `listen` handler.

## Status

Accepted. Row: DOM-29. The handler words (DOM-05) are in [ADR-0079](./0079-commands-events-and-the-outbox.md). No row is open.

## Date

2026-10-11

## Deciders

operator (Saulo Vallory), 2026-10-11.

## Context

The new constructs reuse words that already mean something: `policy`, `service`, `event`, `app`. The rule is obvious names: the word a user would guess, one word per meaning.

## Decision

The study's name-clash table (section 5) is accepted for the port, with the words that rulings changed:

| Word | Resolution |
|:--|:--|
| policy | Authorization only. The study's `react` is `publish` plus a listener; a read-model handler is `project` (first ruled as `apply`; DOM-05, 2026-10-13), a command runner `process` ([ADR-0079](./0079-commands-events-and-the-outbox.md)) |
| repository | A pattern; no construct ([ADR-0080](./0080-aggregates-and-concepts.md)) |
| app | The file kind is `surface` ([ADR-0077](./0077-surfaces-and-file-kinds.md)); "application" stays the user's program |
| service | A domain service as Vernon defines it ([ADR-0078](./0078-services-and-where-effects-go.md)); the dependency keyword is `uses` |
| command | A serialised request to run a write action ([ADR-0079](./0079-commands-events-and-the-outbox.md)) |
| event and change | A change is a row write; an event is a declared domain event |
| aggregate | DDD's; Ash's aggregates are rollups |
| context | The action context; write "bounded context" in full |
| domain | One bounded context's model |
| adapter and port | Name nothing "port" |
| step | The `do` step; no step files ([ADR-0082](./0082-named-checks-and-mixins.md)); the workflow word is decided with workflows |
| on | `on=:create` and `on:load` only; no `on` for reactions |
| check | Mesh validation and named checks; Hyper's checks map to checks, policies and named checks |
| value | `concept` ([ADR-0080](./0080-aggregates-and-concepts.md)) |

## Options considered

Keep the DDD names, rename to avoid every clash, or accept a clash where the shared word is accurate (chosen, per row).

## Trade-off analysis

Users guess one word per idea; where DDD's word clashes with Mesh's own older word, Mesh's own word stays, and the new word takes the obvious name of the new thing.

## Consequences

The [vocabulary mapping](../roadmap/vocabulary-mapping.md) needs the clash table for Ash users once the constructs ship. No existing record is superseded.

## Action items

- [ ] Add the aggregate, concept and service rows to the vocabulary mapping when built.
