---
title: "0084. Architecture rules are core, in an `architecture.mesh.mx` file"
description: "Decision record 0084: built-in invariants no file can remove, and an `architecture :name` file with presets, severity and disable, checked by Mesh's own checker. Status: Accepted (DOM-30, DOM-10). Amended 2026-10-15 (DOM-30: a preset is imported and included as a mixin is; DOM-10: ruled, built after 1.0)."
---

# 0084. Architecture rules are core, in an `architecture.mesh.mx` file

> **Amendment, 2026-10-15 (DOM-30, DOM-10).** A preset is imported and included as a mixin is (DOM-33): `import { MeshRecommended } from "meshfw/architecture"` at the top of the file, then `use preset=MeshRecommended`. There is no atom form. The Decision section and the example now show this form; the options below name the first ruling (`use :mesh-recommended`) as history. DOM-10 is ruled: the architecture rules are built after 1.0, so the item that was Open is answered and nothing is left for the operator. The operator ruled DOM-30's form on 2026-10-15 and DOM-10 on 2026-10-11 and 2026-10-13.

## Status

Accepted. Row: DOM-30; DOM-10 (when it is built) is ruled and says after 1.0 (see the amendment at the top).

## Date

2026-10-11

## Deciders

operator (Saulo Vallory), 2026-10-10 and 2026-10-11; DOM-10, 2026-10-11 and 2026-10-13; DOM-30 amended, 2026-10-15.

## Context

Several rulings need a place to check them: Mesh warns when an entity action calls another aggregate's action ([ADR-0078](./0078-services-and-where-effects-go.md), DOM-15) and when a service operation touches one entity (DOM-16, switchable in `architecture.mesh.mx`); the domain never imports a surface (DOM-13, absolute). The [study](../research/domain-concepts.md) (D21 to D24, section 2.24) proposed an extension, `@meshfw/architecture`, with Mesh's own checker over the import graph and the model (ts-arch was inspiration, not a dependency), the built-in invariants staying in core. DOM-30 moved the whole of it into core.

A lead proposal, for operator review and not ruled: a warning for an entity that belongs to two aggregates ([ADR-0080](./0080-aggregates-and-concepts.md)).

## Decision

Architecture rules are core (DOM-30):

- **Built-in invariants** that no file can remove.
- **`architecture.mesh.mx`**, with root `architecture :name`. Presets come through `use preset=MeshRecommended`, imported from `meshfw/architecture`; each rule takes a `severity` and can be `disable`d.
- **Mesh's own checker** runs over the import graph and the model, with no third-party library. ts-arch is inspiration only.

```mx "architecture.mesh.mx (illustration; the import, the root, `use`, `severity` and `disable` are ruled)"
import { MeshRecommended } from "meshfw/architecture"

architecture :project
  use preset=MeshRecommended
  disable :service-touches-one-entity
```

## When it is built

**DOM-10: the architecture rules are built after 1.0** (ruled, operator, 2026-10-11 and 2026-10-13). The study's "after 1.0" belonged to the extension option that was not taken; the ruling keeps that date for the core option.

## Options considered

The study's D21: (a) built-in invariants in core, and the rule language, engine and presets as an extension, after 1.0; (b) everything in core (chosen by DOM-30). Either way the checker is Mesh's own, with no third-party rule library. D22 (file name and root): `architecture.mesh.mx` with root `architecture :name` (chosen), `arch.mesh.mx`, or a `rule-set` root. D23 (presets): `use :mesh-recommended` (amended to `use preset=MeshRecommended`) with per-rule `severity` and `disable` (chosen), or a pre-filled copy in the project. D24 (tiers): built-in errors no file can remove plus a file of recommendations (chosen), or every rule changeable.

## Trade-off analysis

Core keeps the rules next to the model they read and keeps the warnings consistent. It adds a file kind and a checker to maintain. Built-in invariants stop a project from disabling what keeps the layers sound.

## Consequences

- Rules are switched off or re-graded here, not in the entity. Which rules are built-in invariants and which can be disabled is ruled only for the one-entity service warning (DOM-16, switchable); the others are not yet ruled.
- Nothing is built. DOM-10 puts the rules after 1.0.

## Action items

None open.
