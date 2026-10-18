---
title: "Architecture overview"
description: "What Mesh is, its three rings, the build-time and run-time workflows, and a map of the architecture pages."
---

# Architecture overview

Status: M0 to M5, M7 and M8 are done, and so is the first half of M6 (the lifecycle seams); of the second half, domain events, `publish` and the outbox are built ([Events](../../docs/events.md)) and the event bus that delivers them is next; the Hyper application track (HA) is in progress, then the port gate (HP), which is Mesh 1.0 ([roadmap](../roadmap/roadmap.md)).

## What Mesh is

Mesh is a TypeScript framework modelled on Ash, a declarative framework for Elixir. A developer writes one *entity file* that declares a piece of data, the operations on it and the rules around them. Mesh derives types, input validators, action functions and the database schema from that file. Mesh runs on Bun only ([ADR-0025](../decisions/0025-bun-only.md)) and is open source under the MIT licence ([ADR-0042](../decisions/0042-open-source-mit.md)). The decision records call the project owner the *operator*.

Mesh relies on established tools wherever it can, behind its own contracts ([ADR-0030](../decisions/0030-established-tools-first.md)). It is built regardless of any measurement of how well coding agents use it; a measurement is not a gate ([ADR-0004](../decisions/0004-no-measurement-gate.md)). The project owner's larger goal is Mesh Start, a meta-framework on Nitro: Mesh for the domain, MX for the user interface, probably Elysia as the glue. Mesh Start does not constrain Mesh's design yet.

An entity file is a `.mesh.mx` file ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)) in MX concise syntax, which is indentation-based ([ADR-0041](../decisions/0041-mx-concise-syntax.md)). MX is a separate project with its own parser for `.mx` files. Mesh invents tag names, not syntax, and reads the result as a static tree of tags and attributes ([ADR-0002](../decisions/0002-resource-files-are-mx.md)). MX is core, not an adapter ([ADR-0043](../decisions/0043-mx-is-core.md)). The vocabulary is Mesh's own, informed by Ash ([ADR-0049](../decisions/0049-vocabulary-is-meshs-own.md)): every declaration is `kind :name options`; members are `&name`, other entities are imports, and action input is one `input` section ([ADR-0067](../decisions/0067-members-imports-input-static-files.md)).

An *action* is one named operation on an entity (create, read, update, destroy). Each becomes a generated TypeScript function, and calling it is the whole interface ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)). Its second argument is the *action context*, a flat object the application types once and whose `actor` key says who is calling ([ADR-0059](../decisions/0059-action-context.md)).

A short entity file, `src/domain/todo/todo.mesh.mx` (the full reference file is in [ADR-0050](../decisions/0050-entity-file-syntax.md)):

```mx
import { List } from "./list.mesh.mx"
import { Mesh } from "meshfw"

entity :Todo table="todos"
  attributes
    uuid :id primary-key
    string :title min=1
    boolean :done default=false
    timestamp :insertedAt on=:create

  relationships
    belongs-to :list entity=List

  computed
    string :label() {
      return (&done ? "[x] " : "[ ] ") + &title
    }

  actions auto=[:read, :destroy]
    create :create
      input
        &title
        &list

    update :complete
      do
        set
          &done=true

    read :pending
      filter=() => &done === false

  policies
    policy :owner types=[:read, :update, :destroy]
      authorize-if=({ actor }) => &list.ownerId === actor.id
    policy :ownerCreates types=[:create]
      authorize-if=async ({ input, actor }) => {
        const [list] = await Mesh.privileged(List).read({ filter: { id: { eq: input.list } } })
        return list?.ownerId === actor.id
      }
```

From it Mesh generates the `Todo` value with `Todo.create(input, context)`, `Todo.complete`, `Todo.pending`, `Todo.read` and `Todo.destroy`, the `Todo` type, an input validator per action and the `todos` table. Application code imports the entity from its folder's barrel, `#mesh/domain/todo` for an entity in `src/domain/todo/`, `connect`, `bind` and `transaction` from `#mesh`, and `Mesh`, whose members are the functions that are the same in every project (`Mesh.privileged`, `Mesh.can`), from `meshfw` ([ADR-0058](../decisions/0058-generated-code-in-mesh-imported-as-hash-mesh.md), amended 2026-10-11 and 2026-10-12, [ADR-0086](../decisions/0086-entity-values-privileged-barrels-and-fqns.md)).

## Design goals

Adapted from [research synthesis](../research/synthesis.md) (section 14) and the principles in [roadmap](../roadmap/roadmap.md) (section 2):

1. One declaration per entity; everything else derived.
2. A small hardcoded core; databases and transports are adapters; optional features are extensions.
3. Generated code carries the behaviour: committed, readable TypeScript. Ash keeps behaviour in its library, so stack traces are unhelpful and test coverage of a user's own resource reads 0% ([research synthesis](../research/synthesis.md), section 6, item 2; [ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)).
4. Conservative defaults: accept only listed inputs; required unless `nullable`; atomic where the body allows; forbidden unless every covering policy allows ([ADR-0055](../decisions/0055-policies-are-core.md)).
5. Predictable execution: one lifecycle, a write strategy fixed at build time, hard errors instead of silent fallbacks.
6. One way to write each thing, and few rules to remember ([ADR-0050](../decisions/0050-entity-file-syntax.md)).
7. Legible to coding agents: a machine-readable model, a generated rules file, errors that name the fix.

## The three rings

[ADR-0001](../decisions/0001-three-rings.md). Detail in [three rings](../in-depth/three-rings.md).

| Ring | Test | Packages ([roadmap](../roadmap/roadmap.md), section 3) |
|---|---|---|
| Core | Mesh cannot run without it | `@meshfw/model`, `@meshfw/compiler`, `meshfw` (CLI, build time); `@meshfw/runtime` (run time); the MX host `mesh` |
| Adapter | One replaceable implementation of a contract core owns | `@meshfw/data-drizzle`, `@meshfw/data-sqlite`, `@meshfw/data-postgres`, `@meshfw/bus-local` |
| Extension | Optional feature built on core's declared extension points | none first-party in 1.0; project-local extensions in `src/extensions/` |

Application concerns never enter Mesh's architecture: core defines no feature flags, no tenant and no login. How a caller is identified is the application's business, carried in its own `ActionContext` keys. Elysia is not core; it stays a candidate HTTP adapter once the generic transport contract exists ([ADR-0038](../decisions/0038-elysia-is-not-core.md)). Extensions add to each other's part of the model only through contribution points that the owning extension publishes and the contributor declares; anything else is a build error ([ADR-0020](../decisions/0020-extension-contributions-through-declared-points.md)).

Authorization is core: an entity's `policies` section is part of the file, and an entity without one forbids every action ([ADR-0055](../decisions/0055-policies-are-core.md)).

## The two workflows

Mesh has two halves that share little, as Ash does ([research synthesis](../research/synthesis.md), section 2). The build half runs on a developer's machine. The run-time half runs in the deployed program and never reads the model ([ADR-0033](../decisions/0033-core-split-build-time-run-time.md)).

### Build time

Details in [build pipeline](../in-depth/build-pipeline.md) and [the contract between Mesh and MX](../in-depth/mx-integration.md).

1. Load: every `.mesh.mx` file under `src/domain/` is parsed by MX into a tree with source positions.
2. Check structure: tags, attributes and nesting are checked against the tag contracts.
3. Build model: one plain-data document per entity; each function whose body is one expression is converted to a tree, and anything else is kept as plain code.
4. Transform: extensions rewrite the model in named phases.
5. Verify: read-only checks across entities.
6. Compile expressions: each translated expression is written out as a tree literal and as in-memory TypeScript.
7. Emit: a TypeScript view of the model per file, rendered by a Jig template ([ADR-0061](../decisions/0061-generators-are-jig-templates.md)), into `.mesh/`.
8. Guard: regenerate and fail on any difference.

```text
invoice.mesh.mx --> [1 load] --> [2 structure] --> [3 model] --> [4 transform]
                                                                     |
  .mesh/ (committed) <-- [8 guard] <-- [7 emit] <-- [6 expressions] <-- [5 verify]
```

([research synthesis](../research/synthesis.md), section 16.) Not all stages exist yet; the pipeline page says which milestone builds each.

### Run time: one action call

Phase names from [research synthesis](../research/synthesis.md) (section 17). The plan (the order of steps and the write strategy) is fixed at build time and printed by `mesh explain <entity> <action>`; at run time the generated function performs it ([action lifecycle](../in-depth/action-lifecycle.md)).

1. Enter: the caller invokes the generated function with input and the action context.
2. Cast: only accepted fields and declared arguments pass; an unknown field is an error.
3. Plan: the function follows the strategy chosen at build time, atomic or read-then-write ([ADR-0054](../decisions/0054-write-strategy-is-inferred.md)).
4. Pre-check: policy checks that need no stored record.
5. Transaction: opens; the row is read with a lock if the plan needs it; `validate` runs, then the `do` steps ([ADR-0053](../decisions/0053-validate-then-do.md)).
6. Data layer: one contract; an atomic update is one statement.
7. Commit: the transaction closes.
8. After commit: typed result or classed error.

```text
caller --> generated function: enter > cast > plan > pre-check
                |-- transaction: validate > do > data layer (adapter) > commit
                '-- after commit --> typed record, or error with its .mesh.mx position
```

After Mesh 1.0, one tracing span per phase will go through the OpenTelemetry API ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md), [ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)).

## What is in Mesh 1.0 and what is not

Mesh 1.0 ships only when the Hyper engine can be written fully in Mesh; any number of 0.x betas may ship before ([ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)). No new construct is added before the port unless the port needs it, and as many planned constructs as possible are added before 1.0. A documented construct that is not built yet fails with a not-implemented error naming its milestone, at build time where the build can tell ([ADR-0018](../decisions/0018-not-implemented-is-a-build-error.md)).

| Step | Delivers | State |
|---|---|---|
| M0 | Workspace and `verify` script | done |
| M1 | Build skeleton: model, types, guard, `mesh build` and `inspect` | done |
| M2 | Generated action functions on SQLite (the walking skeleton ends in a function call) | done |
| M3 | Data-layer contract, capabilities, conformance suite | done |
| M4 | Expressions, in memory | done |
| M7 | Relationships and computed fields, the part Hyper uses | done |
| M5 | Action lifecycle and action composition | done |
| M6 | Lifecycle seams, domain events and the outbox | seams, events, `publish` and the outbox done; event bus next |
| M8 | Policies, in core | done |
| HA | The Hyper application, in `examples/hyper` | in progress |
| HP | The port gate: Mesh 1.0 | after M6 |

After 1.0, in no fixed order: M9 (Postgres and migrations), M10 (SQL translation and atomic updates), M11 (the extension host).

Not in 1.0 ([roadmap](../roadmap/roadmap.md), section 6): bulk actions, identities and upserts; step files and reusable steps (dropped: reuse is a TypeScript helper or a `mixin`, [ADR-0082](../decisions/0082-named-checks-and-mixins.md)); the `lock` and `relate` steps (there is no `after-commit` step: an effect after commit is a `publish` and a listener, [ADR-0079](../decisions/0079-commands-events-and-the-outbox.md)); a raw-SQL escape hatch; the agent and test surface; a command-line adapter for agents (a reader of a `surface`, [ADR-0077](../decisions/0077-surfaces-and-file-kinds.md)); jobs and workflows (until then the workflow adapter interface stays a design document; the outbox is core, in M6); an HTTP adapter and typed client; a single binary; multitenancy as an extension. Never planned: an MCP server (the agent surface is the generated rules file, and later a command-line adapter generated from the action list, [ADR-0027](../decisions/0027-no-mcp-agent-surface.md)), Node support ([ADR-0025](../decisions/0025-bun-only.md)), `bypass` policies ([ADR-0055](../decisions/0055-policies-are-core.md)), GraphQL. Since M8a every action checks who calls it, and an action no policy covers is denied ([roadmap](../roadmap/roadmap.md), M8).

## Map of the Architecture pages

| Page | Answers |
|---|---|
| [three rings](../in-depth/three-rings.md) | Where does new code go? What may import what? |
| [build pipeline](../in-depth/build-pipeline.md) | What happens between a `.mesh.mx` file and a committed file? |
| [the contract between Mesh and MX](../in-depth/mx-integration.md) | What does MX do for Mesh, and what must Mesh check itself? |
| [generated code and the guard](../in-depth/generated-code-and-guard.md) | What is generated, why, and how is it kept honest? |
| [action lifecycle](../in-depth/action-lifecycle.md) | What happens inside one action call? |
| [expressions](../in-depth/expressions.md) | How does one arrow function run in memory and in SQL? |
| [data layer](../in-depth/data-layer.md) | What must a database adapter provide? |
| [extension host](../in-depth/extension-host.md) | How do extensions add to Mesh? |

Also: the [roadmap](../roadmap/roadmap.md), the [Ash-to-Mesh mapping](../roadmap/vocabulary-mapping.md), the [decision records](../decisions/index.md) and [open questions and findings](../open-questions.md).
