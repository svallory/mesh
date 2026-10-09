---
title: "Architecture overview"
description: "What Mesh is, its three rings, the build-time and run-time workflows, and a map of the architecture pages."
---

# Architecture overview

Status: design. M0 (the workspace), M1 (the build skeleton), the move to the documented names (merged in PR #47 and PR #48 on 2026-10-09) and the Jig port (PR #51) are done; part of M2 is merged. The operator approved the user docs and lifted the hold on 2026-10-09 ([ADR-0063](../decisions/0063-user-docs-first-and-the-hold.md)); next comes the rest of M2 ([roadmap](../roadmap/roadmap.md)).

::: callout info "What the code does today"
The code on `main` implements the names of the rulings of 2026-10-04 evening and 2026-10-05: `entity` in the entity syntax, `.mesh/` output, `ActionContext`, `meshfw` and `@meshfw/*` (PR #47, PR #48, 2026-10-09). MX lowers the authored `&` member positions (PR #50), and the `types` and `validators` files are rendered from typed views through Jig templates a project can override (PR #51, [ADR-0061](../decisions/0061-generators-are-jig-templates.md)). Pending: the action functions, `schema.ts` and `index.ts` ([ADR-0064](../decisions/0064-order-of-work-after-approval.md)).
:::

## What Mesh is

Mesh is a TypeScript framework modelled on Ash, a declarative framework for Elixir. A developer writes one *entity file* that declares a piece of data, the operations on it and the rules around them. Mesh derives types, input validators, action functions and the database schema from that file. Mesh runs on Bun only ([ADR-0025](../decisions/0025-bun-only.md)) and is open source under the MIT licence ([ADR-0042](../decisions/0042-open-source-mit.md)). The decision records call the project owner the *operator*.

An entity file is a `.mesh.mx` file ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)) in MX concise syntax, which is indentation-based ([ADR-0041](../decisions/0041-mx-concise-syntax.md)). MX is a separate project with its own parser for `.mx` files. Mesh invents tag names, not syntax, and reads the result as a static tree of tags and attributes ([ADR-0002](../decisions/0002-resource-files-are-mx.md)). MX is core, not an adapter ([ADR-0043](../decisions/0043-mx-is-core.md)). The vocabulary is Mesh's own, informed by Ash ([ADR-0049](../decisions/0049-vocabulary-is-meshs-own.md)): every declaration is `kind :name options`; members are `&name`, other entities are imports, and action input is one `input` section ([ADR-0067](../decisions/0067-members-imports-input-static-files.md)).

An *action* is one named operation on an entity (create, read, update, destroy). Each becomes a generated TypeScript function, and calling it is the whole interface ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)). Its second argument is the *action context*, a flat object the application types once and whose `actor` key says who is calling ([ADR-0059](../decisions/0059-action-context.md)).

A short entity file, `src/domain/todo/todo.mesh.mx` (the full reference file is in [ADR-0050](../decisions/0050-entity-file-syntax.md)):

```mx
import { List } from "./list.mesh.mx"

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
    policy :owner
      authorize-if=({ actor }) => &list.ownerId === actor.id
```

From it Mesh generates `createTodo(input, context)`, `completeTodo`, `pendingTodo`, `readTodo` and `destroyTodo`, the `Todo` type, an input validator per action and the `todos` table. Application code imports them from `#mesh` ([ADR-0058](../decisions/0058-generated-code-in-mesh-imported-as-hash-mesh.md)).

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
| Adapter | One replaceable implementation of a contract core owns | `@meshfw/data-drizzle`, `@meshfw/data-sqlite`, `@meshfw/data-postgres` |
| Extension | Optional feature built on core's declared extension points | none first-party in v1; project-local extensions in `src/extensions/` |

Authorization is core: an entity's `policies` section is part of the file, and an entity without one forbids every action ([ADR-0055](../decisions/0055-policies-are-core.md)).

## The two workflows

Mesh has two halves that share little, as Ash does ([research synthesis](../research/synthesis.md), section 2). The build half runs on a developer's machine. The run-time half runs in the deployed program and never reads the model ([ADR-0033](../decisions/0033-core-split-build-time-run-time.md)).

### Build time

Details in [build pipeline](../in-depth/build-pipeline.md) and [how Mesh uses MX](../in-depth/mx-integration.md).

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

One tracing span per phase goes through the OpenTelemetry API ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md)).

## What is in v1 and what is not

v1 is milestones M0 to M9 ([ADR-0019](../decisions/0019-v1-scope.md)), with two tasks inserted before M2 resumes ([ADR-0064](../decisions/0064-order-of-work-after-approval.md)).

| Step | Delivers | State |
|---|---|---|
| M0 | Workspace and `verify` script | done |
| M1 | Build skeleton: model, types, guard, `mesh build` and `inspect` | done (in the old vocabulary) |
| Realignment | Syntax v2 and the new names across contracts, model, compiler, CLI, runtime and example | done (PR #47, PR #48) |
| Jig port | Existing emitters split into a view and a Jig template; `mesh export generators` | done (PR #51) |
| M2 | Generated action functions on SQLite (the walking skeleton ends in a function call) | part merged, rest held |
| M3 | Data-layer contract, capabilities, conformance suite | planned |
| M4 | Expressions: one tree, two evaluators | planned |
| M5 | Action lifecycle, `validate` and `do`, atomic updates | planned |
| M6 | Extension host, composed contracts | planned |
| M7 | Relationships and computed fields | planned |
| M8 | Policies, in core | planned |
| M9 | Migrations and Postgres | planned |

Not in v1 ([roadmap](../roadmap/roadmap.md), section 6): bulk actions, identities and upserts; reusable steps defined in MX; the `lock`, `relate` and `after-commit` steps; a raw-SQL escape hatch; the agent and test surface; a command-line adapter for agents; outbox, jobs and workflows; an HTTP adapter and typed client; a single binary; multitenancy as an extension. Never planned: an MCP server ([ADR-0027](../decisions/0027-no-mcp-agent-surface.md)), Node support ([ADR-0025](../decisions/0025-bun-only.md)), `bypass` policies ([ADR-0055](../decisions/0055-policies-are-core.md)), GraphQL. Until M8 nothing checks who calls an action.

## Map of the Architecture pages

| Page | Answers |
|---|---|
| [three rings](../in-depth/three-rings.md) | Where does new code go? What may import what? |
| [build pipeline](../in-depth/build-pipeline.md) | What happens between a `.mesh.mx` file and a committed file? |
| [how Mesh uses MX](../in-depth/mx-integration.md) | What does MX do for Mesh, and what must Mesh check itself? |
| [generated code and the guard](../in-depth/generated-code-and-guard.md) | What is generated, why, and how is it kept honest? |
| [action lifecycle](../in-depth/action-lifecycle.md) | What happens inside one action call? |
| [expressions](../in-depth/expressions.md) | How does one arrow function run in memory and in SQL? |
| [data layer](../in-depth/data-layer.md) | What must a database adapter provide? |
| [extension host](../in-depth/extension-host.md) | How do extensions add to Mesh? |

Also: the [roadmap](../roadmap/roadmap.md), the [Ash-to-Mesh mapping](../roadmap/vocabulary-mapping.md), the [decision records](../decisions/index.md) and [open questions and findings](../open-questions.md).
