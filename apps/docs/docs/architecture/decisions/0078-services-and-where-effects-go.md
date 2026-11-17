---
title: "0078. Effects are split three ways; services follow Vernon's definition and `uses` lists their dependencies"
description: "Decision record 0078: where an effect across entities goes, where service files live, what a service is, the `uses` keyword and the one-entity warning. Status: Accepted (DOM-01, DOM-13, DOM-14, DOM-15, DOM-16); the service construct (DOM-09) and general publish-subscribe (DOM-08), open when written, are decided (amended 2026-10-17). Amended 2026-11-14 (how to read the illustration and item 5: how `uses` is enforced is decided with the service construct, after 1.0) and 2026-11-17 (the cross-aggregate warning built: switchable, write actions only, declared aggregates only; lead ruling D40)."
---

# 0078. Effects are split three ways; services follow Vernon's definition and `uses` lists their dependencies

## Status

> **Amendment, 2026-11-17 (the cross-aggregate warning built).** Decision item 1's "Whether the warning can be switched off is not ruled" is answered by lead ruling D40 (pending operator review), which takes the recommended option of each open decision in the design `notes/architecture/architecture-file-design.md`: the warning is the architecture rule `:action-calls-other-aggregate`, code `MESH_ACTION_CALLS_OTHER_AGGREGATE`, and the architecture file can re-grade it and switch it off (OD7 (a): "Switchable: `disable` and `severity` both apply"). The same ruling fixes which calls it counts and which entities it sees. It counts a call of a write action, `create`, `update` or `destroy`, its own or from `auto=`; a read, `Mesh.privileged(Task).read(...)` included, is never reported (OD8 (a): "Write actions only"). An entity that no aggregate file lists belongs to no aggregate, so a call to or from it is not reported (OD9 (a): "An unlisted entity is in no aggregate; a call to or from it is never reported"). It reads the functions of an entity's actions and `always` blocks written in the `.mesh.mx` file, never a handler body, which is where a later effect on another aggregate goes, nor a helper module's code. The first action item below is done for both warnings.

> **Note, 2026-11-17 (the service construct proposed).** The shape of a service and how `uses` is enforced are proposed in [ADR-0097](./0097-the-service-construct.md) (lead ruling D42, pending operator review): a `service :Name` file of `operation` members with `uses entity=X actions=[...]` lines, checked by the build and at run time. Decision item 5's "`tsc` enforces them" is replaced there. The one-entity warning is `MESH_SERVICE_ONE_ENTITY`.

> **Amendment, 2026-11-14 (how to read the illustration and Decision item 5).** Three statements below are out of date. They are kept as written, and no new decision is made here: each point repeats a ruling that another record already holds.
>
> 1. **The illustration's caption says "DOM-09 is open".** DOM-09 is decided: a service's shape is decided after 1.0 (amendment of 2026-10-17, below).
> 2. **The illustration's `command :complete-task` line is the study's proposal**, in which `command` and `query` are members of a service. A later ruling gave the word another meaning: a `command` declares the fields of a request, in its own file or in an owner's `commands` section, and an action answers it with `on=` ([ADR-0079](./0079-commands-events-and-the-outbox.md), Decision item 1 and its amendment of 2026-10-15). Read the illustration for its three `uses` lines only; what a service's operations are called is part of the shape, decided after 1.0.
> 3. **Decision item 5 says declared dependencies "narrow the handles a service receives, and `tsc` enforces them".** The sentence was written when code received the `actions` and `tx` handles. Both handles are gone, and handles keyed by entity (`actions.Task.complete`, `tx.Task.read`) were rejected ([ADR-0086](./0086-entity-values-privileged-barrels-and-fqns.md), "Options considered", option 1): code now calls an entity value it imports, so no handle is left to narrow and `tsc` enforces nothing here. Declared dependencies stay, as `uses` lines. How Mesh holds a service to them is decided with the service construct, after 1.0, as the amendment of 2026-10-17 below already says ("enforcing `uses` comes with it"). The rest of item 5 (the warning for a service operation that touches one entity, and its switch) is unchanged.

> **Amendment, 2026-10-17 (the events-spec review).** Core has two handler kinds, `process` and `listen`; `project` belongs to the event-sourcing extension ([ADR-0079](./0079-commands-events-and-the-outbox.md), amended). Where the amendment below says the third kind, read the second.

> **Amendment, 2026-10-17.** Both open items are decided. DOM-08 is ruled: the third handler kind is `listen`, so the handler kinds of [ADR-0079](./0079-commands-events-and-the-outbox.md) cover publish-subscribe. DOM-09 is decided: a service's shape is decided after 1.0, and enforcing `uses` comes with it. The "Open" section and the text that calls these items open are kept as history.

Accepted, with two Open items (DOM-08 and DOM-09 below). Amends [ADR-0068](./0068-actions-compose-through-actions-and-tx.md) (what `actions` in an entity file is for).

Rows: DOM-01, DOM-13, DOM-14, DOM-15, DOM-16 (ruled); DOM-08, DOM-09 (open).

## Date

2026-10-11

## Deciders

operator (Saulo Vallory): DOM-13 and DOM-14 on 2026-10-10; DOM-16 on 2026-10-10 and 2026-10-11; DOM-01 on 2026-10-11 (06:40); DOM-15 on 2026-10-11. DOM-08 and DOM-09 were open when this was written; both are decided (amendment, 2026-10-17).

## Context

[ADR-0068](./0068-actions-compose-through-actions-and-tx.md) let an action call other actions and use `tx`. That works for an entity's own parts. Hyper's "complete task" shows the other case: it touches a Task, a Dependency and a Notification, which belong to different aggregates. The [study](../research/domain-concepts.md) (sections 2.3 to 2.6 and 3.3) asked where such an effect lives, what a service is, and what a service's dependency line is called.

## Decision

1. **Effects are split three ways** (DOM-15):
   - The root writes its own parts in the entity file, through `actions`.
   - An effect across aggregates goes in a service. Until services exist, it is plain code that uses `transaction` from `#mesh`.
   - An effect that may happen later uses `publish` and a listener ([ADR-0079](./0079-commands-events-and-the-outbox.md)).
   - An architecture rule ([ADR-0084](./0084-architecture-rules-are-core.md), DOM-30) **warns** when an entity action calls another aggregate's action. It is a warning, not a restriction. Whether the warning can be switched off is not ruled.
2. **Where service files live** (DOM-13): domain services in their module folder (`src/domain/<module>/`), application services with their surface (`src/surfaces/<name>/services/`). The domain never imports a surface.
3. **What a service is** (DOM-14), after Vernon: a domain service is stateless, cross-entity domain logic; an application service coordinates use cases (transactions, security, orchestration).
4. **The dependency line is `uses`** (DOM-01). It replaces the study's `call`, because the line also lists entities that are only read.
5. **Declared dependencies stay** (DOM-16). They narrow the handles a service receives, and `tsc` enforces them. Mesh warns when a service operation touches only one entity (it belongs on that entity), and `architecture.mesh.mx` can switch that warning off.

An illustration (the service construct is Open, so the members are the study's proposal, and only the keyword `uses` is ruled; the line shape follows the study's `call` line):

```mx "A service (illustration; DOM-09 is open)"
service :Work
  command :complete-task
    uses entity=Task actions=[:complete]
    uses entity=Dependency actions=[:release]
    uses entity=Notification actions=[:create]
```

## Open

- **DOM-09: the shape of the service construct and when it is built.** The study's section 3.4 gave four options: A, nothing new (cascades plus application code over `transaction`); B, `service :Name` with `command` and `query` members, grouping allowed; C, as B but one `command` or `query` per file with no `service` word; D, a `service` that groups any operations, single-entity ones included. DOM-16 (Mesh warns when a service operation touches one entity) excludes D. The study recommended A for 1.0 and B after. The roadmap principle (RDM-01) is that no new construct is added before the port unless the port needs it, and that as many planned constructs as possible are added before 1.0. So the open part is the shape (B or C) and the milestone. Not decided.
- **DOM-08: whether Mesh supports publish-subscribe in general**, beyond what Hyper needs. Not decided. M6 builds only what Hyper needs ([ADR-0079](./0079-commands-events-and-the-outbox.md)).

## Options considered

The study's D3 (where services live): (a) `src/domain/services/` for domain services and `src/apps/<name>/services/` for application services; (b) domain services in their module folder and application services with their surface, the domain never importing a surface (chosen). D4: options A to D above (the ruling fixes Vernon's definition, and the construct is Open). D5 (cascade or service): (a) an operation whose core is a write to one entity's own row is that entity's action with cascades, and one with no leading row or a non-record result is a service command; (b) service commands for every cross-entity write; (c) no rule. The ruling replaced these with the three-way split above. D6 (the single-entity check): (a) a warning computed from the dependency lines; (b) an error; (c) no check (the ruling is (a), switchable in `architecture.mesh.mx`).

## Trade-off analysis

Three homes for an effect keep each aggregate's invariants in one place and make a cross-aggregate write visible. The price is that a beginner must pick among three. The rule is a warning, not a ban.

## Consequences

- [ADR-0068](./0068-actions-compose-through-actions-and-tx.md) is amended: `actions` in an entity file is for the root writing its own parts. [ADR-0074](./0074-write-policies-may-read-through-tx.md) is not changed.
- Services are not built. Until they are, the plain-code route is the supported one, and [Using your domain](../../docs/using-your-domain.md) already shows it.
- DOM-09 stays Open, so no row says when services arrive. RDM-01 applies: not before the port unless the port needs them, and as many planned constructs as possible before 1.0.

## Action items

- [ ] Operator: DOM-08 and DOM-09.
- [x] When the architecture rules are built ([ADR-0084](./0084-architecture-rules-are-core.md)): the "entity action calls another aggregate's action" warning and the "service touches one entity" warning (both built, 2026-11-17 amendment).
