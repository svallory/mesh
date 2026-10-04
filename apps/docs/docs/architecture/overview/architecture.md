---
title: "Architecture overview"
description: "What Mesh is, its three rings, the build-time and run-time workflows, and a map of the architecture pages."
---

# Architecture overview

Status: design; built across milestones M0 to M9 of the roadmap. M0, the workspace, is done; M1 starts by aligning the vocabulary with Ash's DSL ([roadmap](../roadmap/roadmap.md), M0 and M1). The only framework code is the set of 26 tag contracts with their tests, in `packages/compiler`; the docs site also exists. Everything below describes what the roadmap will build, not what runs now.

## What Mesh is

Mesh is a TypeScript framework modelled on Ash, a declarative resource framework for Elixir. A developer writes one *resource file* that declares a piece of data, the operations on it and the rules around it. Mesh derives types, handlers and database schema from that file ([roadmap](../roadmap/roadmap.md), section 0). Mesh is open source under the MIT licence ([ADR-0042](../decisions/0042-open-source-mit.md)). "The project owner" below is the person who makes the project's final decisions; the decision records call that person the operator.

A resource file is a `.mx` file in MX concise syntax, which is indentation-based ([ADR-0041](../decisions/0041-mx-concise-syntax.md)). MX is a separate project that parses Marko-syntax files. Mesh invents tag names, not syntax, and reads the result as a static tree of tags and attributes ([ADR-0002](../decisions/0002-resource-files-are-mx.md)). MX is a core dependency, not an adapter ([ADR-0043](../decisions/0043-mx-is-core.md)). An *action* is one named operation on a resource (create, read, update, destroy). In v1 an action is a generated TypeScript function, and calling it is the whole interface ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)).

This is the test fixture `post.mx`, quoted exactly (it is the fixture of [vocabulary mapping](../roadmap/vocabulary-mapping.md), section 7):

```mx
resource="post" table="posts" domain="blog"
  attributes
    uuid-primary-key="id"
    attribute="title" type="string" allow-nil=false public
    attribute="body" type="string" public
    attribute="state" type="atom" constraints={ one_of: ["draft", "published"] } default="draft"
    create-timestamp="insertedAt"
    update-timestamp="updatedAt"

  relationships
    belongs-to="author" destination="user"
    has-many="comments" destination="comment"

  actions defaults=["read", "destroy"]

    create="create" accept=["title", "body"]
      change=({ post, actor }) => { post.authorId = actor.id }

    update="publish"
      change=({ post }) => { post.state = "published" }
      validate=({ post }) => post.title.length > 0 message="title required"

    read="published"
      filter=({ post }) => post.state === "published"
      sort=["-insertedAt"]

  policies
    policy=action_type("read")
      authorize-if=({ post }) => post.state === "published"
      authorize-if=({ post, actor }) => post.authorId === actor.id

    policy=action("publish")
      authorize-if=({ post, actor }) => post.authorId === actor.id

  calculations
    calculate="excerpt" type="string"
      value({ post }) {
        return post.body.slice(0, 200)
      }

  aggregates
    count="commentCount" relationship-path="comments"
```

The tag names follow Ash's DSL, spelled in kebab-case with a trailing `?` dropped, and were aligned with it at the start of M1 ([vocabulary mapping](../roadmap/vocabulary-mapping.md)); they are reviewed again after v1 ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)).

## Design goals

Adapted from [research synthesis](../research/synthesis.md) (section 14) and the principles in [roadmap](../roadmap/roadmap.md) (section 2):

1. One declaration per resource; everything else derived.
2. A small hardcoded core; databases, servers and runtimes are adapters; features are extensions.
3. Generated code carries the behaviour: committed, readable TypeScript. Ash keeps behaviour in its library, so stack traces are unhelpful and test coverage of a user's own resource reads 0% ([research synthesis](../research/synthesis.md), section 6, item 2; [ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)).
4. Conservative defaults: accept only listed inputs, atomic unless stated, deny unless allowed once policies exist, scope passed on every call.
5. Predictable execution: one lifecycle, fixed places for permission checks, hard errors instead of silent fallbacks.
6. Legible to coding agents: a machine-readable model, generated rules files, errors that name the fix.

## The three rings

[ADR-0001](../decisions/0001-three-rings.md). Detail in [three-rings.md](../in-depth/three-rings.md).

| Ring | Test | Packages ([roadmap](../roadmap/roadmap.md), section 3) |
|---|---|---|
| Core | Mesh cannot run without it | `model`, `compiler`, `cli` (build time); `runtime` (run time) |
| Adapter | One replaceable implementation of a contract core owns | `data-drizzle`, `data-sqlite`, `data-postgres` |
| Extension | Optional feature built on core's declared extension points | `ext-policies` |

## The two workflows

Mesh has two halves that share little, as Ash does ([research synthesis](../research/synthesis.md), section 2). The build half runs on a developer's machine. The run-time half runs in the deployed program and never reads the model ([ADR-0033](../decisions/0033-core-split-build-time-run-time.md)).

### Build time

Details in [build-pipeline.md](../in-depth/build-pipeline.md) and [mx-integration.md](../in-depth/mx-integration.md).

1. Load: `.mx` files become declarations with source positions.
2. Check structure: tags, attributes and nesting are checked against the vocabulary.
3. Build model: one plain-data document per resource.
4. Transform: extensions rewrite the model in named phases.
5. Verify: read-only checks across resources.
6. Compile expressions: each translatable expression is written out as a tree literal and as in-memory TypeScript. Conversion to a tree, and classification as translatable or opaque, already happened while the model was built (step 3, from M4).
7. Emit: types, handlers, schema and other files are written as committed files.
8. Guard: regenerate and fail on any difference.

```text
post.mx --> [1 load] --> [2 structure] --> [3 model] --> [4 transform]
                                                              |
  committed files <-- [8 guard] <-- [7 emit] <-- [6 expressions] <-- [5 verify]
```

([research synthesis](../research/synthesis.md), section 16.) Not all stages exist at once; the pipeline page says which milestone builds each.

### Run time: one action call

Phase names from [research synthesis](../research/synthesis.md) (section 17), as adopted by M5. The plan, meaning the order of steps and the write strategy, is fixed at build time and printed by `mesh explain <resource> <action>`; at run time the generated handler simply performs it ([action-lifecycle.md](../in-depth/action-lifecycle.md)).

1. Enter: the caller invokes the generated function with input and a scope `{ actor, context }` ([ADR-0007](../decisions/0007-scope-is-a-plain-argument.md)).
2. Cast: only accepted fields pass; an unknown field is an error.
3. Plan: the handler follows the steps and strategy chosen at build time.
4. Pre-check: checks that need no data (the authorizer slot, empty until M8).
5. Transaction: opens; before-hooks; checks that read data run inside it.
6. Data layer: one contract; atomic changes fold into the statement.
7. Commit: after-hooks run inside the transaction, then it closes.
8. After commit: typed result or classed error.

```text
caller --> generated handler: enter > cast > plan > pre-check
                |-- transaction --> data layer (adapter) --> commit
                '-- after commit --> typed record, or error with .mx position
```

One tracing span per phase goes through the OpenTelemetry API ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md)).

## What is in v1 and what is not

v1 is milestones M0 to M9 ([roadmap](../roadmap/roadmap.md), section 1; [ADR-0019](../decisions/0019-v1-scope.md)).

| Milestone | Delivers |
|---|---|
| M0 | Workspace and `verify` script (done) |
| M1 | Vocabulary aligned with Ash's DSL ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)); build skeleton: model and types |
| M2 | Generated handlers on SQLite (the walking skeleton ends in a function call) |
| M3 | Data-layer contract, capabilities, conformance suite |
| M4 | Expressions: one tree, two evaluators |
| M5 | Action lifecycle, atomic updates |
| M6 | Extension host, composed contracts |
| M7 | Relationships, calculations, aggregates |
| M8 | Policies extension |
| M9 | Migrations and Postgres |

Not in v1 ([roadmap](../roadmap/roadmap.md), section 6): bulk actions, identities and upserts; the agent and test surface; a command-line adapter for agents; outbox, jobs and workflows; an HTTP adapter and typed client; a single binary; `public` attributes; multitenancy. Never planned: an MCP server ([ADR-0027](../decisions/0027-no-mcp-agent-surface.md)), Node support ([ADR-0025](../decisions/0025-bun-only.md)), a policy solver, GraphQL. Until M8 nothing checks who calls an action ([ADR-0036](../decisions/0036-deny-by-default-arrives-with-policies.md)).

## Map of the Architecture pages

| Page | Answers |
|---|---|
| [three-rings.md](../in-depth/three-rings.md) | Where does new code go? What may import what? |
| [build-pipeline.md](../in-depth/build-pipeline.md) | What happens between a `.mx` file and a committed file? |
| [mx-integration.md](../in-depth/mx-integration.md) | What does MX do for Mesh, and what must Mesh check itself? |
| [generated-code-and-guard.md](../in-depth/generated-code-and-guard.md) | What is generated, why, and how is it kept honest? |
| [action-lifecycle.md](../in-depth/action-lifecycle.md) | What happens inside one action call? |
| [expressions.md](../in-depth/expressions.md) | How does one arrow function run in memory and in SQL? |
| [data-layer.md](../in-depth/data-layer.md) | What must a database adapter provide? |
| [extension-host.md](../in-depth/extension-host.md) | How do extensions add to Mesh? |

Also: the roadmap ([roadmap](../roadmap/roadmap.md)), the vocabulary mapping ([vocabulary mapping](../roadmap/vocabulary-mapping.md)) and the decision index ([decision records](../decisions/index.md)).
