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

Several rulings need a place to check them: Mesh warns when an entity action calls another aggregate's action ([ADR-0078](./0078-services-and-where-effects-go.md), DOM-15) and when a service operation touches one entity (DOM-16, switchable in `architecture.mesh.mx`); the domain never imports a surface (DOM-13, absolute). The [study](../research/domain-concepts.md) (D21 to D24, section 2.24) proposed an extension, `@meshfw/architecture`, with Mesh's own checker over the import graph and the model (ts-arch was inspiration, not a dependency), the built-in invariants staying in core. DOM-30 moved the whole of it into core.

A lead proposal, for operator review and not ruled: a warning for an entity that belongs to two aggregates ([ADR-0080](./0080-aggregates-and-concepts.md)).

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

**DOM-10: when the architecture rules are built.** The study's "after 1.0" belonged to the extension option that was not taken. Not decided; RDM-01 (no new construct before the port unless the port needs it; as many planned constructs as possible before 1.0) is the general rule.

## Options considered

The study's D21: (a) built-in invariants in core, and the rule language, engine and presets as an extension, after 1.0; (b) everything in core (chosen by DOM-30). Either way the checker is Mesh's own, with no third-party rule library. D22 (file name and root): `architecture.mesh.mx` with root `architecture :name` (chosen), `arch.mesh.mx`, or a `rule-set` root. D23 (presets): `use :mesh-recommended` with per-rule `severity` and `disable` (chosen), or a pre-filled copy in the project. D24 (tiers): built-in errors no file can remove plus a file of recommendations (chosen), or every rule changeable.

## Trade-off analysis

Core keeps the rules next to the model they read and keeps the warnings consistent. It adds a file kind and a checker to maintain. Built-in invariants stop a project from disabling what keeps the layers sound.

## Consequences

- Rules are switched off or re-graded here, not in the entity. Which rules are built-in invariants and which can be disabled is ruled only for the one-entity service warning (DOM-16, switchable); the others are not yet ruled.
- Nothing is built. Until DOM-10 is ruled, the rules have no date.

## Action items

- [ ] Operator: DOM-10.
