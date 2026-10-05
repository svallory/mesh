---
title: "0057. One domain per app at `src/domain/`; its folders are modules"
description: "Decision record 0057: where entity files live, what a module is, and the project layout. Status: Accepted."
---

# 0057. One domain per app at `src/domain/`; its folders are modules

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory); the lead, delegated by the operator, for the three details marked below

## Context

Ash, the Elixir framework Mesh is modelled on, groups resources into *domains*: each resource names its domain (`use Ash.Resource, domain: MyApp.Blog`) and an application can have many ([Ash features](../research/ash-features.md), section 1.1 and 1.3). Mesh copied it as an attribute, `resource domain="blog"`, which also set the output folder ([vocabulary mapping](../roadmap/vocabulary-mapping.md), row 1). The project configuration named the folder holding resource files as `resources` ([build pipeline](../in-depth/build-pipeline.md), stage 1).

Writing the user docs showed that the attribute repeated what the folder already said, and that a project had nowhere fixed for entity files, migrations, generated code or project-local extensions.

## Decision

Operator, 2026-10-04 evening, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings on the user docs, layout and terms (2026-10-04 evening, operator)", rows "Project structure" and "Domain and grouping":

> `.mx` files live under `src/domain/<domain>/`; `migrations/` and `.mesh/` at the root; `src/extensions/` for project-local extensions.

> Deviate from Ash: an app (or package) has one domain, `src/domain/`. Inside it, entities are grouped in folders; the folder is the group, and no attribute repeats it in the file. The group is called a **module** (`src/domain/accounts/` is the accounts module).

The details the first row left pending were settled the same evening by the operator: the action context is declared in `src/context.ts` ([ADR-0059](./0059-action-context.md)), and the domain is the folder itself. With [ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md) the files end in `.mesh.mx`:

```text
my-app/
  .mesh/                       generated, committed, imported as "#mesh"
  migrations/                  SQL written by `mesh migrate generate`
  mesh.config.ts
  src/
    domain/
      billing/                 the billing module
        invoice.mesh.mx
        invoice.helpers.ts     hand-written code invoice.mesh.mx imports
      accounts/
        user.mesh.mx
    extensions/                project-local extensions
    context.ts                 declares ActionContext
```

Three further details are the lead's, delegated by the operator ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings after the review of the contributor docs (2026-10-05, lead under delegation)"): the configuration key that names the folder is `domain` (`domain: "src/domain"`) (lead, delegated); two entities with the same name anywhere in the domain fail the build, so names are unique across modules (lead, delegated); an entity file may import only relative files inside the domain folder (lead, delegated). One entity per file.

## Options considered

### Option A: one domain, modules as folders (chosen)

**Pros:** the folder is the only grouping, so a file never disagrees with its location; generated code for a module lands in one place; one fixed layout for agents and newcomers.
**Cons:** an application that wants Ash's several independent domains must split into packages.

### Option B: Ash's domains, named by an attribute

**Pros:** Ash's model; several domains in one app.
**Cons:** the attribute repeats the folder; two sources for one fact.

### Option C: no prescribed layout

**Pros:** flexible.
**Cons:** every project and every agent must be told where things are.

## Trade-off analysis

Option A removes an attribute and a rule, at the cost of Ash's multi-domain applications, which Mesh can serve with one package per domain.

## Consequences

- The `domain=` attribute leaves the vocabulary. The code on `main` still has it and still reads the `resources` configuration key until the realignment task.
- Generated paths follow the module: `.mesh/<module>/<entity>.types.ts` ([ADR-0058](./0058-generated-code-in-mesh-imported-as-hash-mesh.md)).
- Name collisions are checked across the whole domain, not per module: generated functions share one flat namespace.

## Action items

- [ ] Realignment task: drop `domain=`, read `domain` from `mesh.config.ts`, derive the module from the folder.
