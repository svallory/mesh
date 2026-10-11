---
title: "0084. Architecture rules are core, in an `architecture.mesh.mx` file"
description: "Decision record 0084: built-in invariants no file can remove, and an `architecture :name` file with presets, severity and disable, checked by Mesh's own checker. Status: Accepted (DOM-30); when it is built (DOM-10) is Open."
---

# 0084. Architecture rules are core, in an `architecture.mesh.mx` file

## Status

Accepted, with one Open item (DOM-10, when it is built). Row: DOM-30.

## Date

2026-10-11

## Deciders

operator (Saulo Vallory), 2026-10-10 and 2026-10-11. DOM-10 is open.

## Context

Several rulings above end in "Mesh warns": an entity action that calls another aggregate's action ([ADR-0078](./0078-services-and-where-effects-go.md)), a service that touches one entity, an entity in two aggregates ([ADR-0080](./0080-aggregates-and-concepts.md)), the domain importing a surface. They need one home. The [study](../research/domain-concepts.md) (D21 to D24, section 2.24) proposed rules as an extension on a third-party library such as ts-arch.

## Decision

Architecture rules are core (DOM-30):

- **Built-in invariants** that no file can remove.
- **`architecture.mesh.mx`**, with root `architecture :name`. Presets come through `use :mesh-recommended`; each rule takes a `severity` and can be `disable`d.
- **Mesh's own checker** runs over the import graph and the model, with no third-party library. ts-arch is inspiration only.

```mx "architecture.mesh.mx (illustration; the root, `use`, `severity` and `disable` are ruled)"
architecture :project
  use :mesh-recommended
  disable :service-touches-one-entity
```

## Open

**DOM-10: when the architecture rules are built.** The study's "after 1.0" belonged to the extension option that was rejected. Options: with the first construct that needs a rule (so the warnings above have a home), at the gate, or after 1.0. Not decided.

## Options considered

An extension on a library (rejected), core with a third-party checker (rejected: a dependency for a small graph walk, [ADR-0062](./0062-direct-dependencies-zod-drizzle-opentelemetry.md)), core with Mesh's own checker (chosen).

## Trade-off analysis

Core keeps the rules next to the model they read and keeps the warnings consistent. It adds a file kind and a checker to maintain. Built-in invariants stop a project from disabling what keeps the layers sound.

## Consequences

- The warnings in [ADR-0078](./0078-services-and-where-effects-go.md) and [ADR-0080](./0080-aggregates-and-concepts.md) are switched off here, not in the entity.
- Nothing is built. Until DOM-10 is ruled, those warnings have no date.

## Action items

- [ ] Operator: DOM-10.
