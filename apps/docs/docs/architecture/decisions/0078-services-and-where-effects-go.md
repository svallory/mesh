---
title: "0078. Effects are split three ways; services follow Vernon's definition and `uses` lists their dependencies"
description: "Decision record 0078: where an effect across entities goes, where service files live, what a service is, the `uses` keyword and the one-entity warning. Status: Accepted (DOM-01, DOM-13, DOM-14, DOM-15, DOM-16); the service construct itself (DOM-09) and general publish-subscribe (DOM-08) are Open."
---

# 0078. Effects are split three ways; services follow Vernon's definition and `uses` lists their dependencies

## Status

Accepted, with two Open items (DOM-08 and DOM-09 below). Amends [ADR-0068](./0068-actions-compose-through-actions-and-tx.md) (what `actions` in an entity file is for).

Rows: DOM-01, DOM-13, DOM-14, DOM-15, DOM-16 (ruled); DOM-08, DOM-09 (open).

## Date

2026-10-11

## Deciders

operator (Saulo Vallory): DOM-13 and DOM-14 on 2026-10-10; DOM-16 on 2026-10-10 and 2026-10-11; DOM-01 on 2026-10-11 (06:40); DOM-15 on 2026-10-11. DOM-08 and DOM-09 are open.

## Context

[ADR-0068](./0068-actions-compose-through-actions-and-tx.md) let an action call other actions and use `tx`. That works for an entity's own parts. Hyper's "complete task" shows the other case: it touches a Task, a Dependency and a Notification, which belong to different aggregates. The [study](../research/domain-concepts.md) (sections 2.3 to 2.6 and 3.3) asked where such an effect lives, what a service is, and what a service's dependency line is called.

## Decision

1. **Effects are split three ways** (DOM-15):
   - The root writes its own parts in the entity file, through `actions`.
   - An effect across aggregates goes in a service. Until services exist, it is plain code that uses `transaction` from `#mesh`.
   - An effect that may happen later uses `publish` and a listener ([ADR-0079](./0079-commands-events-and-the-outbox.md)).
   - A core architecture rule ([ADR-0084](./0084-architecture-rules-are-core.md)) **warns** when an entity action calls another aggregate's action. It is a warning, not a restriction: `architecture.mesh.mx` can switch it off.
2. **Where service files live** (DOM-13): domain services in their module folder (`src/domain/<module>/`), application services with their surface (`src/surfaces/<name>/services/`). The domain never imports a surface.
3. **What a service is** (DOM-14), after Vernon: a domain service is stateless, cross-entity domain logic; an application service coordinates use cases (transactions, security, orchestration).
4. **The dependency line is `uses`** (DOM-01). It replaces the study's `call`, because the line also lists entities that are only read.
5. **Declared dependencies stay** (DOM-16). They narrow the handles a service receives, and `tsc` enforces them. Mesh warns when a service operation touches only one entity (it belongs on that entity), and `architecture.mesh.mx` can switch that warning off.

An illustration (the service construct is Open, so the member names are the study's proposal, and only `uses` is ruled):

```mx "A service (illustration; DOM-09 is open)"
service :Work
  uses Task, Dependency, Notification
  command :complete-task
```

## Open

- **DOM-09: the shape of the service construct and when it is built.** The study proposed `service :Name` with `command` and `query` members after 1.0. [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) bars new constructs before the port unless the port needs one. Options: (a) as proposed, after 1.0; (b) built before the gate if the Hyper port needs it; (c) never a construct, plain code over `transaction` for good. Not decided.
- **DOM-08: whether Mesh supports publish-subscribe in general**, beyond what Hyper needs. Not decided. M6 builds only what Hyper needs ([ADR-0079](./0079-commands-events-and-the-outbox.md)).

## Options considered

The study's D3 (where service files live): by module and surface (chosen) or one `services/` folder. D4 (what a service is): Vernon's split (chosen), one undifferentiated kind, or no service concept. D5 (cross-aggregate effects): actions that call actions (rejected as the answer for cross-aggregate effects), a service, publish and listen (chosen: all three, by case). D6 (the dependency line): `call`, `uses` (chosen), `needs`, or none with a runtime check.

## Trade-off analysis

Three homes for an effect keep each aggregate's invariants in one place and make a cross-aggregate write visible. The price is that a beginner must pick among three. A warning, not a ban, because actions that call actions across aggregates are sometimes right, and a lead-set rule that cannot be switched off would not be Mesh's habit.

## Consequences

- [ADR-0068](./0068-actions-compose-through-actions-and-tx.md) is amended: `actions` in an entity file is for the root writing its own parts. [ADR-0074](./0074-write-policies-may-read-through-tx.md) is not changed.
- Services are not built. Until they are, the plain-code route is the supported one, and [Using your domain](../../docs/using-your-domain.md) already shows it.
- DOM-09 stays Open, so no row says when services arrive; the roadmap keeps them after 1.0 (RDM-01).

## Action items

- [ ] Operator: DOM-08 and DOM-09.
- [ ] When the architecture rules are built ([ADR-0084](./0084-architecture-rules-are-core.md)): the "entity action calls another aggregate's action" warning and the "service touches one entity" warning.
