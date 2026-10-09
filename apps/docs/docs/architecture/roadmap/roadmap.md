---
title: "Roadmap"
description: "The order in which Mesh is built: what is done, the move to the documented names, the Jig port, the v1 milestones, and what comes after."
---

# Roadmap

Date: 2026-10-05. This is revision 4 of the implementation plan. Revision 3 (2026-10-04) is in this page's history; [plan revision 2 (superseded)](./plan-revision-2.md) is kept as a page.

## 0. What this page is

**Mesh** is a TypeScript framework modelled on Ash, the declarative framework for Elixir. One *entity file* declares a piece of data, the operations on it and the rules around them; Mesh derives types, input validators, action functions and the database schema from that file. This page says in what order Mesh is built. Each decision it rests on has its own decision record, listed in [decision records](../decisions/index.md) and cited as "[ADR-0050](../decisions/0050-entity-file-syntax.md)".

**Where things stand (2026-10-09).** M0 and M1 are done, and the move to the documented names is done: PR #47 (2026-10-09, `61c8202`) moved the contracts and model to the entity syntax and PR #48 (2026-10-09, `c497438`) the packages, layout, configuration, CLI and runtime. M2 is partly merged: PR #18 (the rulings before M2) and PR #19 (`mx` highlighting on the docs site) are documentation; PR #20 (the run-time library) and PR #21 (input validators and the generated-import check) are framework code. PR #22 (the SQLite adapter on Drizzle) is not on `main`: `@meshfw/data-sqlite` there returns a descriptor only. The MX lowering of the `&` member positions is done (PR #50) and so is the Jig port (PR #51): the `types` and `validators` files are rendered from typed views through Jig templates. Pending: the remaining generators (for the action functions, `schema.ts`, `index.ts`, `mx-contracts.js` and `rules.md`), written as views and templates when M2 resumes ([ADR-0064](../decisions/0064-order-of-work-after-approval.md)).

Sources, with the short names used below:

| Short name | File | What it is |
|---|---|---|
| **Rulings** | [rulings of 2026-10-04](../decisions/rulings-2026-10-04.md) | The operator's dated rulings (the operator is the project owner, Saulo Vallory), with the lead's decisions. "Ruling 4" is row 4 of the first table; other parts are named by their section. Where parts disagree, the later one wins. |
| **Synthesis** | [research synthesis](../research/synthesis.md) | Summary of the first seven research documents. Its Step 3 (sections 14–19) is the architecture proposal: three rings, an eight-stage build pipeline, an eight-phase action lifecycle, extension points. |
| **Durable engines** | [durable engines](../research/durable-engines.md) | Comparison of eleven workflow and job tools with a proposed adapter interface. Design input for work after v1. |
| **Expression language** | [expression language](../research/expression-language.md) | Whether an existing project can carry Mesh's expressions. Input to M4. |
| **Validation library** | [validation library](../research/validation-library.md) | Zod against its alternatives for generated validators. Input to [ADR-0062](../decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md). |
| **MX notes** | MX project notes, getting-started, MX project notes, updates | How Mesh consumes MX and what has landed in it. |

Terms:

- **MX** is a separate project that parses Marko-syntax files. Mesh calls `parseData` from `@mxlang/data`, which returns a static tree of tags and attributes plus diagnostics; nothing in the file is executed (MX notes, getting-started section 1). A **tag contract** tells MX which attributes, children and parents a tag allows. MX is core ([ADR-0043](../decisions/0043-mx-is-core.md)).
- An **entity file** is a `.mesh.mx` file under `src/domain/<module>/` ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md), [ADR-0057](../decisions/0057-one-domain-modules-as-folders.md)). Every declaration in it is `kind #name options` (entity file syntax v2, [ADR-0050](../decisions/0050-entity-file-syntax.md)). The folder under `src/domain/` is the entity's **module**.
- **Core, adapter, extension** are the three rings ([ADR-0001](../decisions/0001-three-rings.md)). Core is what Mesh cannot work without. An adapter is one replaceable implementation of a contract core owns. An extension is an optional feature built on core's extension points.
- An **action** is one named operation on an entity (create, read, update, destroy). It is a generated TypeScript function, and calling it is the whole interface ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)). A **transport** (command line, HTTP) is an optional adapter that calls it for an outside caller; none is built in v1.
- The **action context** is the second argument of every action: one flat object, typed `ActionContext` by the application, whose `actor` key is the one Mesh reads ([ADR-0059](../decisions/0059-action-context.md)). It is never ambient.
- A **capability** is an optional feature of a data adapter (joins, aggregates, upserts, atomic expressions), declared as static data so the build can check it.
- **Drizzle** is an established TypeScript query builder with SQLite and Postgres drivers; **drizzle-kit** generates SQL migrations from a Drizzle schema. Mesh's SQL adapters are built on both ([ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md)).
- **Jig** is the operator's template engine for code generation; Mesh's emitters render through Jig templates ([ADR-0061](../decisions/0061-generators-are-jig-templates.md)).
- `verify` is the one script that runs every check, locally and on every pull request ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md), amended 2026-10-05: the workflow `.github/workflows/verify.yml` runs it now that the `@mxlang` packages are installable from a registry).

## 1. Summary

1. **v1 is ten milestones, M0 to M9**: workspace, build skeleton, run skeleton, data-layer contract, expressions, action lifecycle, extension host, relationships and computed fields, policies, and migrations with Postgres ([ADR-0019](../decisions/0019-v1-scope.md)).
2. **Two tasks come before M2 resumes**: the realignment task (the code takes the names and syntax of 2026-10-04 evening and 2026-10-05; done, PR #47 and PR #48, 2026-10-09) and the Jig port (the existing emitters become Jig templates; done, PR #51, 2026-10-09) ([ADR-0064](../decisions/0064-order-of-work-after-approval.md)).
3. **The walking skeleton is M0 to M2 and ends in a function call**: an entity file is parsed, turned into a model, emitted as committed TypeScript, and a test and a short script call the generated functions against SQLite. No command line, no server ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)).
4. **After v1**, in no fixed order yet: bulk actions, identities and upserts; reusable steps and the planned steps; the agent and test surface; a command-line adapter for agents; outbox, jobs and workflows; HTTP; a single binary (section 6).
5. **Bun only** ([ADR-0025](../decisions/0025-bun-only.md)), **established tools first** ([ADR-0030](../decisions/0030-established-tools-first.md)), **`verify` runs on every pull request** ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md)).
6. **User docs first.** Behaviour is written on a Docs page, in the voice of a released 1.0, before it is built; code follows the page or changes it in the same pull request ([ADR-0063](../decisions/0063-user-docs-first-and-the-hold.md)).
7. **The vocabulary is Mesh's own**, informed by Ash, always in MX concise syntax ([ADR-0049](../decisions/0049-vocabulary-is-meshs-own.md), [ADR-0041](../decisions/0041-mx-concise-syntax.md)). The M1 contracts copied Ash's DSL; PR #47 replaced them. The [Ash-to-Mesh mapping](./vocabulary-mapping.md) says where each Ash concept went.
8. **Mesh is open source under the MIT licence** and its docs are public ([ADR-0042](../decisions/0042-open-source-mit.md)).

## 2. Principles every milestone is checked against

1. **Generated code carries the behaviour; the run-time library stays thin** (Ruling 2; [ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)). Test: the run-time library never reads the model. Ash keeps behaviour in the library, so stack traces are unhelpful and coverage of a user's own resource reads 0% (Synthesis section 6, item 2).
2. **No silent fallback.** A capability the adapter lacks, a tag the compiler does not implement yet, an expression that cannot be translated: each is a build error naming file, line and fix (Ruling 4; Synthesis section 8, "Silent fallbacks").
3. **Conservative defaults**: accept only listed inputs; required unless `nullable`; forbidden unless a policy allows, including an entity with no policies ([ADR-0055](../decisions/0055-policies-are-core.md)).
4. **"It was in the plan" is never a reason to hardcode something** ([ADR-0001](../decisions/0001-three-rings.md)). Every package states why it sits in its ring.
5. **One way to write each thing, few rules to remember** ([ADR-0050](../decisions/0050-entity-file-syntax.md)). Every vocabulary addition follows the `kind #name options` shape and the PR #1 pattern: one closed contract per tag, one negative fixture per rule with exact message, line and column. Examples are in MX concise syntax.
6. **The committed generated tree is guarded**: `verify` regenerates `.mesh/` and fails on any difference (Synthesis section 16, stage 8).
7. **Established tools first** ([ADR-0030](../decisions/0030-established-tools-first.md)): before building anything, look for a well-established tool and put it behind a Mesh contract.
8. **No application concerns in core.** How a caller is identified, how a program is exposed, login: the application's business, carried in its own `ActionContext` keys. Core takes an action context and runs an action.
9. **Docs first, then code** ([ADR-0063](../decisions/0063-user-docs-first-and-the-hold.md)). A milestone that adds behaviour updates its Docs page; one that adds a contract, a pipeline stage or a cross-package rule updates its Architecture page, in the same pull request.

## 3. Packages

A bun workspace in `svallory/mesh`. Packages are published as `@meshfw/*`, the CLI package is `meshfw` and the command is `mesh` ([ADR-0060](../decisions/0060-meshfw-package-scope.md)); the workspace packages on `main` carry those names since PR #48.

```
apps/docs/            the docs site (docmd): Docs for users, Architecture for contributors
packages/
  model/              core       plain-data entity model, vocabulary registries, diagnostics
  compiler/           core       build pipeline (loads .mesh.mx through MX), tag contracts, extension host, emitter views and Jig templates, policy verifier
  runtime/            core       thin run-time library: ActionContext, errors, contracts, policy engine, expression functions
  cli/                core       the `mesh` command (build, check, inspect, explain, export generators); adapters add commands
  mx-host/            core       the MX host package named `mesh` (after MX decision 148)
  data-drizzle/       adapter    shared code of the SQL adapters: Mesh queries and expressions -> Drizzle
  data-sqlite/        adapter    data layer on SQLite (file or in-memory), on Drizzle
  data-postgres/      adapter    data layer on Postgres, on Drizzle
examples/blog/        the example entities and a script that calls them
```

| Package | Ring | Why there |
|---|---|---|
| `model` | core, build time | Every build-time package reads the model. Plain JSON-serialisable types, the registries (attribute types, which are also tag names; step kinds; expression functions), the diagnostic type. |
| `compiler` | core, build time | The build pipeline is what makes Mesh a framework (Synthesis section 16). Owns stage order, the extension host and the emitters every project needs, each a typed view plus a Jig template. It is also where MX is used: MX is core ([ADR-0043](../decisions/0043-mx-is-core.md)), so the tag contracts and the load and check-structure stages live here. `compiler` depends on MX; `model` and `runtime` never import it. |
| `cli` | core, build time | The `mesh` command is the only entry to the pipeline. It builds a project; it does not run an application's actions. Commands that belong to an adapter's tool (`db push`, `migrate`) are contributed by that adapter, so `cli` imports no query library. |
| `runtime` | core, run time | What generated code imports: the `ActionContext` type, error classes, the data-layer contract with the query and expression-tree types, the transaction helper, the policy engine's run-time half, and the in-memory implementations of the registered expression functions. Imports nothing from `model`, `compiler` or Drizzle. |
| MX host `mesh` | core, tooling | Makes `.mesh.mx` resolve in MX tooling and carries Mesh's `defaultTag` settings ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)). Its folder name is a working name; its package name is fixed by MX. |
| `data-sqlite`, `data-postgres`, `data-drizzle` | adapter | A project picks its database; the contract is Mesh's own (Synthesis section 11), and the query library inside an adapter is that adapter's private choice, Drizzle ([ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md)). Drizzle is imported only here and in the emitted schema. |

Policies are core, not an extension: there is no `ext-policies` package ([ADR-0055](../decisions/0055-policies-are-core.md)). Adapter slots of the Synthesis ring table (section 15) with no package in v1: transport ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)); tracer (generated code calls the OpenTelemetry API directly, [ADR-0029](../decisions/0029-tracing-opentelemetry-api.md)); runtime host (Bun only, [ADR-0025](../decisions/0025-bun-only.md)). The authoring syntax and the expression parser are MX's. The actor resolver is dropped ([ADR-0059](../decisions/0059-action-context.md)); the job runner comes with workflows after v1 ([ADR-0023](../decisions/0023-workflows-and-jobs-deferred.md)).

## 4. Order

```
M0 workspace (done)
 └ M1 build skeleton (done)
     └ [hold: user docs approved]
         └ Realignment
             └ Jig port
                 └ M2 run skeleton (part merged)        ← walking skeleton ends here
                     └ M3 data-layer contract
                         └ M4 expressions
                             └ M5 action lifecycle, atomic updates
                                 ├ M9 migrations, Postgres
                                 └ M6 extension host, composed contracts
                                     └ M7 relationships, computed fields
                                         └ M8 policies
```

M9 can run alongside M6–M8. **Capability rule across tracks:** a milestone that adds an optional data-layer capability (M5 atomic expressions, M7 joins and aggregates) implements it in every data adapter merged when the milestone itself is merged; M9 implements on Postgres every capability in the conformance suite on the day M9 is merged. Whichever merges second owes the missing combination. v1 is done when SQLite and Postgres both pass the whole suite.

**Prerequisites that are decisions or outside work, not milestones.** The realignment task needs MX decisions 145 (per-parent `defaultTag`) and 146 (`#name` after a space, `:label`) and the `imports: "pass"` option, or it writes the glued `kind#name` form until they land ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)). M4 needs [ADR-0012](../decisions/0012-expression-semantics.md) ruled.

Sizes: **S** one pull request; **M** two to four; **L** five or more, split into tasks by whoever leads it. Sizes are scope, not time.

## 5. v1 milestones and tasks

"Vocabulary" means tag names or attributes added to the entity-file language.

### M0 — Workspace (S, done)

- **Status.** Done: merged to `main` on 2026-10-04 (PR #6).
- **What it did.** A bun workspace; the tag contracts, tests and fixtures from PR #1 and PR #2 moved to `packages/compiler` ([ADR-0043](../decisions/0043-mx-is-core.md)); `apps/docs` as a workspace member; `examples/blog`; a root `bun run verify`; the MIT `LICENSE` ([ADR-0042](../decisions/0042-open-source-mit.md)).

### M1 — Build skeleton: entity file to model to emitted types (M, done)

- **Status.** Done on 2026-10-04, in the vocabulary of that morning, which copied Ash's DSL ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md), since superseded; renamed to the entity syntax by PR #47 and PR #48, 2026-10-09): the vocabulary alignment (PR #11, PR #13), load and model (PR #12, with the model package in PR #9), the emitters for `model.json` and types (PR #15), the `mesh` command with `build`, `build --check` and `inspect` (PR #16), and the blog example guarded by `verify` (PR #17).
- **What it did.** Build stages 1, 2, 3, 7 and 8 of Synthesis section 16 in their simplest form: `parseData` with the contracts imported directly, `structural: "reject"` and `unknownTags: "reject"`; one root tag per file; a plain-data model with source positions; duplicate-name, missing-primary-key and unknown-`accept` checks; `model.json` and a types file per entity, from templates through a pinned formatter, byte-for-byte deterministic; the guard; the not-implemented rule ([ADR-0018](../decisions/0018-not-implemented-is-a-build-error.md)); the MX import boundary.
- **Acceptance tests (as passed).** (1) A reduced example builds; emitted types pass `tsc --noEmit`. (2) Two builds give identical bytes. (3) A hand edit to a generated file fails `mesh build --check`, which names the file. (4) An empty file, two root tags in one file, a duplicate name and an unknown `accept` name each fail with the expected message and position. (5) The full fixture fails with the not-implemented error for its first unsupported tag. (6) The registry-against-contract drift test. (7) Every row of the [mapping page](./vocabulary-mapping.md) marked "on main" has a contract and a fixture that match it. (8) `@mxlang/*` is imported only by packages that declare tag contracts.
- **What changed later.** The realignment task rewrote the vocabulary, the configuration key and the output folder (PR #47, PR #48); tests 4, 5 and 7 keep their meaning with the new names. Test 7 reads the section 3 examples of the mapping page, now in the v4 spelling.

### Realignment — the code takes the current names and syntax (L, after the docs are approved)

The acceptance tests of this task and of the Jig port below are the lead's design, delegated by the operator, pending the operator's review; the order of the two tasks is [ADR-0064](../decisions/0064-order-of-work-after-approval.md).

- **Status.** Merged on 2026-10-09 in two pull requests: PR #47 (`61c8202`): MX `0.1.0-alpha.11` (target `tree`), the closed entity contracts and the entity model; PR #48 (`c497438`): `meshfw` and `@meshfw/*`, `src/domain`, `.mesh/`, the `{ domain, output, data, extensions? }` configuration, the CLI and the runtime contracts. Not part of it: the `&` member positions, which waited for MX's lowering (21 `test.todo`s), and the emitters, which still write only `types` and `validators` per entity, with the rest not built yet. The `&` positions landed with PR #50 (2026-10-09, MX alpha.13).
- **Goal.** Everything on `main` uses the names and syntax of [ADR-0049](../decisions/0049-vocabulary-is-meshs-own.md) to [ADR-0062](../decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md), so that M2 onward is built once ([ADR-0064](../decisions/0064-order-of-work-after-approval.md)).
- **In scope.**
  - *Contracts.* Entity file syntax v2 ([ADR-0050](../decisions/0050-entity-file-syntax.md)): `entity`; attribute-type tags generated from the type registry ([ADR-0037](../decisions/0037-vocabulary-source-of-truth.md) ruled first); the attribute types `uuid`, `string`, `integer`, `float`, `decimal`, `boolean`, `enum`, `date`, `datetime`, `timestamp`; `nullable`, `primary-key`, `unique`, `default`, `min`, `max`, `match`, `on`; relationship tags with the destination as value; `computed`; `actions` with `auto` and `on:load`, typed actions with `#name`, `arguments`; `validate` with `require` and `check`; `do` with `set`, `when`, `load`, `run`; `always`; `policies` with `policy #name types=[...] actions=[...]`, `authorize-if`, `forbid-if`. Tags whose semantics come later stay behind the not-implemented rule.
  - *Model and checks.* `entity` everywhere; `#name` uniqueness within each scope; the module from the folder; required by default.
  - *Configuration and layout.* `domain` replaces `resources` in `mesh.config.ts`; `.mesh.mx` discovery under `src/domain/` (plain `.mx` accepted until MX decision 148 lands); output `.mesh/`; the `#mesh` entry in `package.json#imports`; `.gitattributes` with `linguist-generated` ([ADR-0057](../decisions/0057-one-domain-modules-as-folders.md), [ADR-0058](../decisions/0058-generated-code-in-mesh-imported-as-hash-mesh.md)).
  - *Run-time library.* `ActionContext` replaces `Scope` ([ADR-0059](../decisions/0059-action-context.md)). Done in PR #48 (2026-10-09).
  - *Packages.* Every workspace package renamed to `@meshfw/*`, with the import rules in `verify` ([ADR-0060](../decisions/0060-meshfw-package-scope.md)).
  - *Example.* `examples/blog` rewritten in syntax v2 under `src/domain/blog/`, with a `src/context.ts`.
  - *Docs checks.* The Docs-page sample check parses blocks rooted at `entity` instead of deferring them.
  - *Mapping.* The "Contract check" column of the [mapping page](./vocabulary-mapping.md) and M1 test 7 move to the v2 spelling in the same pull request.
- **Out of scope.** New behaviour; the Jig port; MX host package (after MX decision 148).
- **Acceptance tests.** (1) The reference file of [ADR-0050](../decisions/0050-entity-file-syntax.md) parses with zero diagnostics against the new contracts, in the glued form until MX 146 lands. (2) A grep of `packages/` and `examples/` finds no `@mesh/`, no `resource` as a tag or a type name, and no `generated/` path. (3) M1 tests 1 to 8 pass with the new names. (4) Two attributes named `#id` in one entity, and two actions named `#pay`, each fail at the second name. (5) A complete Docs-page sample rooted at `entity` is parsed, not deferred, and none is deferred. (6) The example's `.mesh/` tree is regenerated, committed and guarded. (7) A call to a generated input type with the old `scope` shape does not compile.
- **Risks.** MX 145, 146 and `imports: "pass"` may land after the task starts; the task then uses the glued form and a follow-up switches it.

### Jig port — emitters become a view and a Jig template (M, after realignment)

- **Status.** Done in PR #51 (2026-10-09): `@jig-lang/jig` 1.0.1 pinned exactly in `@meshfw/compiler`; the `types` and `validators` generators (a view in `packages/compiler/src/views/` plus a template in `packages/compiler/templates/`); the per-template `.mesh-generators/` lookup with `MESH_TEMPLATE_READ` and `MESH_TEMPLATE_RENDER`; `mesh export generators`. The example's `.mesh/` bytes did not change. Matching MX diagnostics by code instead of message text waits for MX to expose diagnostic codes.
- **Goal.** The existing emitters (types, validators) are split into a typed TypeScript view and a Jig template, and projects can override templates ([ADR-0061](../decisions/0061-generators-are-jig-templates.md)).
- **In scope.** A view per emitter: a pure function from the model and configuration to a typed object holding exactly what the file needs. A Jig template per emitter that only renders the view. Jig pinned to an exact version as a build-time dependency of `compiler`. `mesh export generators` copying Mesh's templates into the project; per-template lookup (the project's copy wins when it exists). The emitter interface the extension host will register in M6 is "a view plus a template".
- **Out of scope.** Named hooks inside templates; new emitters.
- **Acceptance tests.** (1) The example's `.mesh/` bytes are identical before and after the port. (2) The view functions are unit-tested without rendering. (3) `mesh export generators` writes every template; running it twice is a no-op or a clear error, never a silent overwrite. (4) An overridden template changes the output of only the files it renders; `mesh build --check` then passes against the new committed output. (5) No template contains a conditional that a view test does not cover (reviewed, not automated). (6) Jig is not imported by `runtime` or by any generated file.
- **Risks.** The view types become a contract with projects that override templates; changing one is a breaking change.

### M2 — Run skeleton: generated action functions on SQLite (M, part merged, held)

- **Status.** Merged: the run-time library with the scope type, errors and data-layer contract v0 (PR #20), input validators and the generated-import check (PR #21). Open and held: the SQLite adapter on Drizzle with its schema emitter (PR #22); it is rebased onto the realigned names before it merges ([ADR-0064](../decisions/0064-order-of-work-after-approval.md)).
- **Goal.** The walking skeleton, end to end. A test and a script of about twenty lines in `examples/blog` import the generated functions from `#mesh`, create an entity, read it back, update it, destroy it; the rows are in a SQLite file.
- **In scope.**
  - *Generated action functions.* One file per entity, one exported function per action: `createPost(input, context)`. The body holds the steps in order (validate input, open a transaction, call the data layer, commit, return a typed record), written out per action (principle 1).
  - *Action context.* The second argument, typed `ActionContext`, required on every call ([ADR-0059](../decisions/0059-action-context.md)). In M2 it is only passed through; M5 and M8 use it.
  - *Binding.* `.mesh/index.ts` exports `bind(dataLayer)`, `connect()` and `disconnect()`; top-level exports delegate to the default binding ([ADR-0047](../decisions/0047-actions-are-bound-to-a-data-layer.md)).
  - *Input validators.* Generated Zod 4 schemas, seen by the rest of Mesh only through Standard Schema ([ADR-0028](../decisions/0028-validation-zod-behind-standard-schema.md), [ADR-0062](../decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md)). Only accepted fields pass; an unknown field is an error. (Merged in PR #21.)
  - *Run-time library.* The `ActionContext` type; data-layer contract v0; the first error classes (invalid input, not found, framework). (Merged in PR #20.)
  - *`data-sqlite` on Drizzle.* A build-time half emits the Drizzle table definitions as a guarded generated file; a run-time half implements the contract with Drizzle over Bun's SQLite driver; `mesh db push` contributed by the adapter. Exact pins `drizzle-orm@0.45.3`, `drizzle-kit@0.31.11` ([ADR-0048](../decisions/0048-schema-inside-the-process-for-tests.md)). (PR #22, held.)
  - New emitters are written as a view and a Jig template.
- **Out of scope.** Any transport. Authorization: nothing checks who calls until M8. Filters, sorting, expressions, `validate` and `do`.
- **Packages.** `runtime`, `compiler` (core); `data-sqlite`, `data-drizzle` (adapters).
- **Acceptance tests.** (1) The example script and the test run create, read, update, destroy, and a read after destroy throws the not-found error class. (2) A field not in `accept` is rejected. (3) A failing input validation's stack trace has the generated action function as its first frame outside `node_modules` and Mesh packages. (4) Import rule checked by `verify`: nothing in `runtime` imports `@meshfw/model`, `@meshfw/compiler` or Drizzle; no generated file under `.mesh/` imports them or `model.json`; Drizzle is imported only under `packages/data-*` and in the emitted schema file. (5) A call without an action context is a type error. (6) The guard covers the action functions and the emitted schema. (7) `runtime` imports no `bun:*` module and uses no `Bun` global. (8) Application code imports only `#mesh`; a test binds its own in-memory database with `bind`.
- **Risks.** Contract shapes change in M3 and M5; unstable until M6. Drizzle v1 is a release candidate (section 9, risk 3).

### M3 — Data-layer contract and capabilities (L)

- **Goal.** The contract of Ruling 4 ([ADR-0013](../decisions/0013-data-layer-contract-and-capabilities.md)) on Drizzle, with a test suite every data adapter must pass.
- **In scope.** The mandatory set: select, insert, update, delete, transactions, filters, sort, pagination. `data-drizzle` turns a Mesh query (plain data) into Drizzle's builder; nothing of Drizzle shows through the contract. A **capability manifest** per adapter: static data, a closed union of names (joins, aggregates, upserts, atomic expressions), read by the build without starting the adapter. The build check for "an entity uses a capability the adapter lacks" is written here and first used in M5. A **conformance suite**. SQLite's in-memory mode for tests ([ADR-0016](../decisions/0016-in-memory-data-via-sqlite.md)). Read actions implement `sort` and gain pagination, offset and keyset (new vocabulary). Filters here are plain data (field, operator, literal), also the form a caller passes at run time.
- **Out of scope.** Joins, aggregates, upserts, atomic expressions (declared only); Postgres.
- **Packages.** `runtime`, `compiler` (core); `data-drizzle`, `data-sqlite` (adapters).
- **Acceptance tests.** (1) `data-sqlite` passes the suite in file and in-memory mode. (2) A manifest naming a capability outside the union fails the build. (3) A transaction that throws leaves no row. (4) Keyset pagination under concurrent inserts returns every row that existed at the start exactly once and none twice. (5) No Drizzle type in `runtime`.
- **Risks.** One real implementation until M9; that is why M9 may start right after M5. Ash's contract has 46 callbacks and 47 capability names, applied inconsistently (Synthesis section 2.2): the failure to avoid.

### M4 — Expressions: one tree, two evaluators (L)

- **Goal.** A function in an entity file whose body is one expression (an arrow, or a method body that is a single `return`) becomes one expression tree that runs both in memory and in SQL; anything else is plain code ([ADR-0010](../decisions/0010-one-expression-tree-two-evaluators.md), [ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)).
- **First task.** Read Greffon first and report what to copy (<https://github.com/PhenX/Greffon>, the one project with the same design, found by the fact-check of the [expression-language research](../research/expression-language.md)), and whether depending on it later is realistic.
- **In scope.** The tree type (in `runtime`, it crosses the data-layer contract) and the registry of functions and operators (in `model`). Conversion from MX's Babel node to the tree, in `compiler`, for bodies that are one expression. Where SQL is required (a filter, a sort, a policy), an unsupported construct is an error at that node, in the build and through the contracts' `analyze` hook for the editor; elsewhere (a computed field, a `check`, a `when`, a `set` value) it is not an error and the expression runs in memory. Plain code is emitted as TypeScript by slicing the authored text at MX's span. Each translated expression is written into the generated file twice: as the tree, a data literal the adapter compiles into Drizzle's builder when a query runs, and as its in-memory form, emitted TypeScript. The build checks that every function used has a SQL form in the configured adapter. A sub-expression that does not read `self` is evaluated before the query and bound as a parameter. Both evaluators follow one definition of the semantics, Mesh's own ([ADR-0012](../decisions/0012-expression-semantics.md), **must be ruled before M4 starts**). The first registry is small and listed in the docs from the registry itself: references to `self`, `input`, `actor` and `context`, literals, comparison and boolean operators, numeric `+` and `-`, string length. Vocabulary that starts working: `filter` on reads, `check`'s `that`, `set` values.
- **Out of scope.** Relationship traversal (M7); folding into statements (M5); the raw-SQL escape hatch (after v1).
- **Packages.** `model`, `compiler`, `runtime` (core); `data-drizzle`, `data-sqlite` (adapters).
- **Acceptance tests.** (1) Every registered function and operator has one table of inputs and expected outputs, null cases included, run through the in-memory form and through every merged SQL adapter; all give the table's answer. (2) An unsupported construct in a `filter`, a `sort` or a policy fails the build at that node, with the same message the `analyze` hook gives; the same construct in a `check`'s `that` or a `set` value builds, runs in memory, and `mesh explain` names it as the reason the action is read-then-write. (3) A free variable fails the build. (4) A read with a `filter` returns only matching rows. (5) A multi-statement body in a `filter` fails the build; one in a `set` value is emitted as plain code; a computed field written as a single translatable `return` is translated, and one calling a helper on `self` runs in memory without an error, as `mesh explain` shows. (6) `isStaff(actor)` inside a translated `filter` is evaluated once and bound as a parameter. (7) The Greffon report is in `notes/` or the research section before the translator is designed.
- **Risks.** Two execution paths can diverge; test 1 guards the answers, and M5's rule that a step never runs twice guards the lifecycle (Synthesis section 2.2, bug #2969). AshPostgres installed SQL functions to force Elixir semantics on the database and one filter ran 30 times slower, which bears on [ADR-0012](../decisions/0012-expression-semantics.md).

### M5 — Action lifecycle, `validate` and `do`, atomic updates (L)

- **Goal.** The eight-phase lifecycle of Synthesis section 17, generated per action, with the action body of [ADR-0053](../decisions/0053-validate-then-do.md) and the atomic half of Ruling 3 ([ADR-0017](../decisions/0017-atomic-by-default-and-classification.md)).
- **In scope.**
  - Phases in generated code: enter, cast, plan, pre-check, transaction, data layer, commit, after commit. The plan is chosen at build time and printed by `mesh explain <entity> <action>`.
  - `validate` (`require`, `check :label [ that code message ]`, nested `when`) before `do`, for rules across fields or about stored state; rules about one field (`min`, `max`, `match`) are checked at cast. In `validate`, `self` is the record with the accepted input applied (stored values, or defaults on a create, for fields not sent); nothing from `do` has run ([ADR-0053](../decisions/0053-validate-then-do.md)). Every failed check is collected into one `InvalidInputError` whose `code` is `invalid_input`, one issue per check with its label, declared `code`, path, message and position.
  - Input: accepted fields and `arguments` share one object; a create requires every accepted field that is required and has no default, an update requires none ([ADR-0052](../decisions/0052-actions-auto-and-on-load.md)).
  - `do` steps in written order: `set`, `when`, `load`, `run`. Each step sees the record as the earlier steps left it.
  - `always` blocks under `actions`, applied to every action in their scope, before the action's own body.
  - `arguments` on actions (cast like attributes, reaching `input`).
  - The **authorizer slot**: one place before the transaction for checks needing no stored record, one inside it for checks that read it. Empty until M8.
  - **Tracing**: one span per phase through the OpenTelemetry API ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md)).
  - **The write strategy, inferred** ([ADR-0054](../decisions/0054-write-strategy-is-inferred.md)). A create always runs as one statement (one `INSERT`). An update or destroy runs as one statement when its `check` and `when` conditions read only `input`, `actor` and `context` and its `set` values translate; a `check` or `when` that reads `self` makes it read the row first (locked, in the same transaction) and then write. Folding a translated `self` condition into the statement's `WHERE` is after v1 ([ADR-0044](../decisions/0044-folding-record-reading-validations.md)). A `run` step, and a `check`, `when` or `set` value that cannot be translated, also make the action read first; none of these is an error. Reading first uses a "read for update" call in the data-layer contract; `validate` and `do` then run in memory and the row is written, all in one transaction. `explain` names the line or expression that made an action read-then-write. A step never runs twice.
  - The run-time error class hierarchy. A failed `check` reports its `code`, `message` and its `.mesh.mx` position, carried as data in the generated code ([ADR-0039](../decisions/0039-run-time-error-positions.md), proposed).
- **Example.** The blog entities gain `filter`, `validate` and `do`; one update is atomic (`set` with a literal) and one is read-then-write (a `check` on `self`).
- **Out of scope.** Bulk actions; policies; `lock`, `relate`, `after-commit` and reusable steps.
- **Packages.** `compiler`, `runtime`, `model` (core); `data-drizzle`, `data-sqlite` (adapters: atomic expressions).
- **Acceptance tests.** (1) Two concurrent atomic increments (`#count=({ self }) => self.count + 1`) both apply. (2) An update whose `check` on `self` fails returns the check's `code` and `message` and writes nothing; on a missing row it reports not found. (2b) Two concurrent calls of a read-then-write action on one row: the second sees the first's write. (2c) `explain` reports "atomic" for an update with only literal and input `set` values, and "read then write" naming the line for one whose `check` reads `self`. (2d) A `run` step that counts its own calls runs exactly once per action call. (3) An update with a `run` step is read-then-write. (4) An atomic action against a fake adapter lacking the capability fails the build at the action. (5) `explain` output for the example is committed and guarded. (6) A `run` step that throws rolls the write back. (7) With a test OpenTelemetry SDK, one call gives eight spans in order; with none, no error. (8) An `always` check applies to every action in its scope and to no other. (9) The M2 import rule passes. (10) A failed `check` carries the file and line of its `check` tag in the entity file. (11) Two failing checks are both reported.
- **Risks.** Ruling 2 is tested hardest here; a repeated pattern becomes a small pure helper in `runtime` that takes values, never the model. Telemetry cost Ash 15–23% of a create (Synthesis section 6, item 7); measure the spans with no SDK.

### M6 — Extension host and composed contracts (L)

- **Goal.** Extensions add vocabulary, transform and verify the model, emit files and supply run-time behaviour through one typed manifest ([ADR-0020](../decisions/0020-extension-contributions-through-declared-points.md), [ADR-0021](../decisions/0021-composed-contracts-module.md)).
- **In scope.** The **manifest** (Synthesis section 18): tags; transforms and their named phase; verifiers; emitters (a view plus a Jig template); expression functions (each with its in-memory implementation and its SQL form per data adapter); attribute types (a new type tag, validator, column type per adapter); context keys read ([ADR-0059](../decisions/0059-action-context.md)); tooling hooks; adapter requirements; contribution points published and used. An extension package has a build-time entry and a run-time entry; the run-time entry follows the `runtime` import rule. **Named phases**, a hard error on a cycle, the order printed. The M1 checks become the Verify stage. **Ruling 5**: an undeclared write to another extension's part of the model fails the build. **Composed contracts**: the contracts handed to `parseData` are composed in memory from core plus enabled extensions; `mesh build` also writes `.mesh/mx-contracts.js` for MX tooling, produced with Bun's bundler because it contains `analyze` functions. Core and data-adapter emitters re-register through the same interface; M2–M5 contracts are declared stable.
- **Out of scope.** Loading extensions by discovery. A strictness setting for verifiers. Reusable steps (planned after v1).
- **Packages.** `compiler`, `model`, `runtime` (core).
- **Acceptance tests.** (1) A test extension adds a section to `entity` through a declared point; disabled, the same file fails. (2) An undeclared cross-extension write fails and names both extensions. (3) A phase cycle fails and prints the cycle. (4) The generated contracts module loads through MX with the same tag names as the in-memory composition, and is guarded. (5) A test extension supplies an attribute type, an expression function and a named check; an entity uses all three; the function gives the same answers in memory and in SQL; a fake adapter with no SQL form for it fails the build. (6) The import rule of M2 test 4 covers the run-time entry of every extension. (7) Two test extensions that both declare they read `tenantId` fail the build and name both.
- **Risks.** The widest milestone. The generated contracts module has no consumer until MX ships editor support for data files.

### M7 — Relationships and computed fields (L)

- **Goal.** Entities refer to each other; derived values can be queried.
- **In scope.** `belongs-to=Customer #customer`, `has-many=InvoiceLine #lines`, `has-one=Payment #payment` ([ADR-0050](../decisions/0050-entity-file-syntax.md)). A `belongs-to` adds its foreign-key attribute, the relationship's name plus `Id` (`belongs-to=List #list` creates `listId`); `nullable` makes a relationship optional. Cross-file verification: unknown entities, inverses, cycles. Loading related records on request, and through `on:load` when Mesh loads an entity through a relationship ([ADR-0052](../decisions/0052-actions-auto-and-on-load.md)); `on:load` naming a read the entity does not have is a build error, and an entity loaded through a relationship with neither `on:load` nor an auto read fails the build. Relationship traversal in expressions, compiled to joins by `data-drizzle` (not Drizzle's relations API). The `computed` section: a field whose body is a single `return` Mesh can translate is translated (usable in filters, sorts and policies, and computed in memory on a loaded record); otherwise it runs after load, which is not an error, and using it in a filter, a sort, a policy or another translated expression is a build error naming the field and the part that could not be translated. Rollups `count`, `sum`, `avg`, `min`, `max`, with `of=` a path checked against generated path types. Capabilities `joins` and `aggregates` in every merged adapter. The `load` step.
- **Out of scope.** Many-to-many, join entities, managing related records in a write (`relate` is planned after v1).
- **Packages.** `model`, `compiler` (core); `data-drizzle`, `data-sqlite`, and `data-postgres` if M9 is merged (adapters).
- **Acceptance tests.** (1) The reference file of [ADR-0050](../decisions/0050-entity-file-syntax.md), with its `policies` section removed and `Customer`, `InvoiceLine` and `Payment` added, builds with no not-implemented error. (2) Reading a relationship or computed field that was not loaded is a type error; a load that cannot be done is a run-time error, never ignored. (3) A computed field that runs in memory (the reference file's `#label`) builds; used in a `filter`, a `sort` or a policy it fails the build, naming the field and the untranslatable part. (4) Rollups pass the suite on every merged adapter. (5) A relationship to an unknown entity fails at the tag. (6) A translated computed field gives the same value computed in the query and in memory. (7) `of="lines.amont"` fails the build at the attribute with a did-you-mean. (8) A relationship load uses the `on:load` read's filter; `on:load` naming a missing read fails the build. (9) `belongs-to=List #list` creates `listId`, required unless the relationship is `nullable`.
- **Limit in v1.** A `has-one` and a `has-many` over the same foreign key is a build error ([ADR-0045](../decisions/0045-has-one-uniqueness.md)).
- **Risks.** `has-one` over many rows: Ash truncates silently (Synthesis section 6, item 7). For v1 Mesh emits a unique index on the foreign key of a `has-one` target; [ADR-0045](../decisions/0045-has-one-uniqueness.md) (proposed).

### M8 — Policies, in core (L)

- **Goal.** Authorization as declared data in the entity file ([ADR-0022](../decisions/0022-policies-simple-tier-as-extension.md), [ADR-0055](../decisions/0055-policies-are-core.md)); deny by default from here on.
- **In scope.** `policy #name` with `types=[...]`, `actions=[...]` or neither (every action); `authorize-if` and `forbid-if`, combined without order: a policy passes when none of its `forbid-if` holds and, if it has any `authorize-if`, at least one holds ([ADR-0055](../decisions/0055-policies-are-core.md), which narrows Ruling 6's "ordered"). Every policy covering an action must pass; an action no policy covers, and every action of an entity without `policies`, is forbidden, with an error naming the missing policy and how to write an open one. No `bypass`. A verifier that every `actions=` item names a real action. Read policies become query filters. Write policies run in the M5 slot: a check that needs no stored record runs in memory before the transaction; a record-reading check is folded into an atomic statement as a filter (a denied row reports not found, the working assumption of [ADR-0046](../decisions/0046-denied-atomic-write-outcome.md), proposed) or evaluated on the locked row of a read-then-write action (a denial reports forbidden). A create policy sees the proposed record; a related record is queried inside the transaction before the insert. A record-reading check written as plain code on a read or an atomic action is a build error. A **structured breakdown** of every decision, as data. A `can` function per action. The policy kept as a boolean formula in the model so a solver can be added later.
- **Out of scope.** A solver; field policies; `bypass`; policy groups; access types.
- **Packages.** `compiler`, `runtime` (core).
- **Acceptance tests.** (1) A non-staff caller cannot pay an invoice; a customer reads only their own invoices. (2) An action no policy covers is forbidden; an entity with no `policies` section forbids every action, and the error names the entity and shows an open policy. (3) The breakdown of a denial is asserted as data, from `can` and from a call denied by a check that needs no stored record. (4) A read policy written as plain code fails the build. (5) The formula round-trips through `model.json`. (6) The full reference file builds with no not-implemented error. (7) A policy whose `actions=` names a missing action fails the build. (8) For a loaded record and no concurrent writer, `can` gives the same decision as the action then makes. (9) An atomic update by a caller a record-reading policy excludes reports not found and changes nothing. (10) Moving a policy, or a check inside a policy, does not change any decision. (11) The reference file's forbid-only `#neverDestroyPaid` forbids destroying a paid invoice and allows destroying an unpaid one (with `#staffWrites` passing).
- **Risks.** Until M8 nothing restricts a caller; a project built on M2–M7 must not be exposed.

### M9 — Migrations and Postgres (M)

- **Goal.** A second database and a safe way to change a schema. May start once M5 is merged.
- **In scope.** `mesh migrate generate` runs drizzle-kit over the emitted Drizzle schema and writes the SQL into `migrations/`; drizzle-kit owns snapshot and diff. Never applied automatically; `mesh migrate apply` is explicit. Before calling drizzle-kit, Mesh compares old and new model and refuses a destructive or ambiguous change (drop, type change, rename, a column becoming required, which in syntax v2 includes removing `nullable`) unless a flag names it. `data-postgres` on Drizzle, passing the suite as it stands when M9 merges.
- **Out of scope.** Data migrations; automatic renames.
- **Packages.** `data-postgres`, `data-sqlite`, `data-drizzle` (adapters; they contribute the `migrate` commands, so `cli` does not import drizzle-kit).
- **Acceptance tests.** (1) Adding a `nullable` attribute and adding an entity each generate the expected migration for both dialects. (2) A destructive change fails with instructions unless flagged. (3) Postgres passes the suite locally. (4) Migrations applied to an empty database give the same schema as `mesh db push`. (5) The M4 function tables pass on Postgres.
- **Risks.** drizzle-kit is mid-rewrite (Synthesis section 10, "Migrations" row). How it behaves without a terminal on an ambiguous change is **not checked**; M9's first task is to test it. Local Postgres tests need a server or an embedded Postgres.

## 6. After v1

Not ordered and not sized; each gets its own plan when it is picked up.

| Item | What | Notes |
|---|---|---|
| Bulk actions, identities, upserts | Per-record `stream` bulk; declared unique keys; upserts | Moved out of v1 by the review ruling "After v1". Batched-atomic later still. |
| Reusable steps | `step #name` files in `.mesh.mx` under `src/domain/`, used as tags; also contributed by extensions | [ADR-0053](../decisions/0053-validate-then-do.md). |
| Planned steps | `lock="version"`, `relate=...`, `after-commit(...) { }`; further declared steps (`increment` and others) if the operator adds them | [ADR-0053](../decisions/0053-validate-then-do.md). |
| Raw-SQL escape hatch | Like Ash's `fragment` | [ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md). |
| Agent and test surface | `.mesh/rules.md` describing the project's entities and the vocabulary; test data builders; a seed path | No MCP server ([ADR-0027](../decisions/0027-no-mcp-agent-surface.md)). |
| Command-line adapter for agents | A CLI generated from the action list, built for agents to call | [ADR-0027](../decisions/0027-no-mcp-agent-surface.md). It builds an action context from its own input. |
| Outbox, jobs, workflows | Events and background work that commit with the data; multi-step operations | [ADR-0023](../decisions/0023-workflows-and-jobs-deferred.md). Durable engines is the design input. |
| HTTP adapter, typed client, OpenAPI | One Fetch handler per action; Elysia as a mount | Elysia is not core ([ADR-0038](../decisions/0038-elysia-is-not-core.md)). |
| Single binary | `bun build --compile` of an example, idle memory measured | Unmeasured so far (Synthesis section 12, risk 5). |
| Which attributes may leave through a transport | What `public` meant in Ash; syntax v2 has no such flag | [ADR-0035](../decisions/0035-meaning-of-public.md), proposed; decided with the first transport. |
| Multitenancy | An extension that reads a declared `ActionContext` key | [ADR-0059](../decisions/0059-action-context.md). |
| Named hooks in templates | A smaller escape hatch than overriding a whole template | Considered in [ADR-0061](../decisions/0061-generators-are-jig-templates.md). |

Not planned at all, with reasons: a policy solver (Ruling 6 defers it); `bypass` policies (they fail open, [ADR-0055](../decisions/0055-policies-are-core.md)); many-to-many, embedded entities, manual and generic actions (deferrable per Synthesis section 8, gap 4); audit trail, event log, state machine, soft delete, encryption, rate limits (extensions, none blocks core); GraphQL, an admin interface (Synthesis section 8, "Do not build yet"); a second authoring syntax (MX is core, [ADR-0043](../decisions/0043-mx-is-core.md)); `mesh watch`; Node, Deno and edge runtimes ([ADR-0025](../decisions/0025-bun-only.md)).

## 7. Build or reuse

| Need | Decision | Tool, or why Mesh builds it |
|---|---|---|
| SQL queries, drivers, type mapping | Reuse | Drizzle, stable pin ([ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md), [ADR-0062](../decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md)) |
| Migrations: snapshot and diff | Reuse | drizzle-kit; Mesh adds only the refusal of unflagged destructive changes |
| In-memory database for tests | Reuse | SQLite `:memory:` ([ADR-0016](../decisions/0016-in-memory-data-via-sqlite.md)) |
| Input validation | Reuse | Zod 4 behind Standard Schema ([ADR-0028](../decisions/0028-validation-zod-behind-standard-schema.md), [ADR-0062](../decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md)) |
| Tracing | Reuse | OpenTelemetry API ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md)) |
| Rendering generated files | Reuse | Jig templates ([ADR-0061](../decisions/0061-generators-are-jig-templates.md)) |
| Formatting emitted code | Reuse | Prettier, pinned |
| Bundling the contracts module | Reuse | Bun's bundler |
| Parsing `.mesh.mx` and expressions | Reuse | MX (`parseData`, Babel nodes); a core dependency ([ADR-0043](../decisions/0043-mx-is-core.md)) |
| Highlighting `mx` on the docs site | Reuse | MX's tree-sitter highlighter ([ADR-0065](../decisions/0065-mx-highlighting-on-the-docs-site.md)) |
| Test runner, type checker | Reuse | Bun's test runner, `tsc` |
| Docs site | Reuse | docmd ([ADR-0032](../decisions/0032-docs-site-and-decision-records.md)) |
| Expression tree, its two evaluators | Build | No established project; Greffon, the one with the same design, is too young ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)) |
| Build pipeline, extension host, views, guard | Build | This is Mesh |
| Generated action lifecycle | Build | Ruling 2 |
| Policy engine, simple tier | Build | It must turn a policy into a filter over Mesh's own tree |
| Conformance suite, capability manifest | Build | They describe Mesh's own contract |

## 8. Traceability: ruling to ADR to milestone

| Ruling | ADR | Milestone |
|---|---|---|
| Ruling 1: no measurement gate | [ADR-0004](../decisions/0004-no-measurement-gate.md) | none |
| Ruling 2: generated code carries the behaviour | [ADR-0003](../decisions/0003-generated-code-carries-behaviour.md) | M2, M5; import rule in M2 |
| Ruling 3, atomic half | [ADR-0017](../decisions/0017-atomic-by-default-and-classification.md), amended by [ADR-0054](../decisions/0054-write-strategy-is-inferred.md) | M5 |
| Ruling 3, bulk half: moved after v1 | [ADR-0019](../decisions/0019-v1-scope.md) | after v1 |
| Ruling 4: mandatory set, declared capabilities | [ADR-0013](../decisions/0013-data-layer-contract-and-capabilities.md) | M3; M5, M7 |
| Ruling 5: contributions only through declared points | [ADR-0020](../decisions/0020-extension-contributions-through-declared-points.md) | M6 |
| Ruling 6: simple policy tier, solver-ready | [ADR-0022](../decisions/0022-policies-simple-tier-as-extension.md), amended by [ADR-0055](../decisions/0055-policies-are-core.md) | M8 |
| Ruling 7: replaced; workflows after v1 | [ADR-0023](../decisions/0023-workflows-and-jobs-deferred.md) | after v1 |
| Ruling 8, corrected: no transport is first | [ADR-0005](../decisions/0005-core-interface-is-a-function-call.md) | M2 ends in a function call |
| Elysia is not core | [ADR-0038](../decisions/0038-elysia-is-not-core.md) | after v1 |
| Three rings; entity files read through MX; MX is core | [ADR-0001](../decisions/0001-three-rings.md), [ADR-0002](../decisions/0002-resource-files-are-mx.md), [ADR-0043](../decisions/0043-mx-is-core.md) | all; M1 |
| Review rulings: expressions, v1 line, Bun only, MCP, CI, docs site, licence | [ADR-0010](../decisions/0010-one-expression-tree-two-evaluators.md), [ADR-0019](../decisions/0019-v1-scope.md), [ADR-0025](../decisions/0025-bun-only.md), [ADR-0027](../decisions/0027-no-mcp-agent-surface.md), [ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md), [ADR-0032](../decisions/0032-docs-site-and-decision-records.md), [ADR-0042](../decisions/0042-open-source-mit.md) | M4; sections 5 and 6; all; M0 |
| Operator's standing position: established tools | [ADR-0030](../decisions/0030-established-tools-first.md), [ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md) | M2, M3, M9 |
| Rulings before M2: binding; columns named like attributes | [ADR-0047](../decisions/0047-actions-are-bound-to-a-data-layer.md), [ADR-0048](../decisions/0048-schema-inside-the-process-for-tests.md) | M2 |
| 2026-10-04 evening: `entity`; one domain, modules; `.mesh` and `#mesh`; the action context; `@meshfw`; docs voice and the hold | [ADR-0049](../decisions/0049-vocabulary-is-meshs-own.md), [ADR-0057](../decisions/0057-one-domain-modules-as-folders.md), [ADR-0058](../decisions/0058-generated-code-in-mesh-imported-as-hash-mesh.md), [ADR-0059](../decisions/0059-action-context.md), [ADR-0060](../decisions/0060-meshfw-package-scope.md), [ADR-0063](../decisions/0063-user-docs-first-and-the-hold.md) | Realignment |
| 2026-10-05: entity file syntax v2; `.mesh.mx`; actions; `validate` and `do`; policies; expressions; generators; direct dependencies | [ADR-0050](../decisions/0050-entity-file-syntax.md), [ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md), [ADR-0052](../decisions/0052-actions-auto-and-on-load.md), [ADR-0053](../decisions/0053-validate-then-do.md), [ADR-0055](../decisions/0055-policies-are-core.md), [ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md), [ADR-0061](../decisions/0061-generators-are-jig-templates.md), [ADR-0062](../decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md) | Realignment; Jig port; M4, M5, M7, M8 |
| Lead, delegated by the operator (2026-10-05): inferred write strategy; order of work; highlighting | [ADR-0054](../decisions/0054-write-strategy-is-inferred.md), [ADR-0064](../decisions/0064-order-of-work-after-approval.md), [ADR-0065](../decisions/0065-mx-highlighting-on-the-docs-site.md) | M5; section 4; docs task |
| Lead and roadmap author: Zod and OpenTelemetry; SQLite in-memory; not-implemented rule; core split; composed contracts | [ADR-0028](../decisions/0028-validation-zod-behind-standard-schema.md), [ADR-0029](../decisions/0029-tracing-opentelemetry-api.md), [ADR-0016](../decisions/0016-in-memory-data-via-sqlite.md), [ADR-0018](../decisions/0018-not-implemented-is-a-build-error.md), [ADR-0033](../decisions/0033-core-split-build-time-run-time.md), [ADR-0021](../decisions/0021-composed-contracts-module.md) | M2, M5; M3; M1; M6 |
| Open | [ADR-0012](../decisions/0012-expression-semantics.md), [ADR-0035](../decisions/0035-meaning-of-public.md), [ADR-0037](../decisions/0037-vocabulary-source-of-truth.md), [ADR-0039](../decisions/0039-run-time-error-positions.md), [ADR-0044](../decisions/0044-folding-record-reading-validations.md), [ADR-0045](../decisions/0045-has-one-uniqueness.md), [ADR-0046](../decisions/0046-denied-atomic-write-outcome.md) (all proposed) | M4; after v1; realignment; M5; after v1; M7; M8 |

## 9. Risks

1. **The code and the docs differ by what is not built.** PR #47 and PR #48 (2026-10-09) moved the code to the documented names; the MX lowering (PR #50) and the Jig port (PR #51) followed; the remaining generators are pending. Every Architecture page that describes design the code does not implement says so in a callout; the Docs pages state the target.
2. **MX is pre-release** (MX notes, getting-started section 5). `packages/compiler` pins `@mxlang/core` and `@mxlang/data` to exact pre-release versions, so nothing resolves a range and a breaking change stops Mesh when the pin moves, not the day MX pushes. Syntax v2 also waits on MX decisions 145, 146 and 148 and on `imports: "pass"`.
3. **Drizzle v1 is a release candidate, its relations API is being replaced, drizzle-kit is mid-rewrite** (Synthesis section 12, risk 1; section 10). M2 uses the stable pair `drizzle-orm@0.45.3` / `drizzle-kit@0.31.11` ([ADR-0048](../decisions/0048-schema-inside-the-process-for-tests.md), [ADR-0062](../decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md)). Mitigation: exact pins; Drizzle imported only in `data-*`; an upgrade is its own pull request and must pass the suite; Mesh does not use the relations API.
4. **CI runs `verify` and nothing more** ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md), amended 2026-10-05). A green run says the checks in `verify` passed, not that a change is correct; the review protocol still carries that.
5. **Two evaluators can disagree** (M4). The shared function tables cover registered functions, not their combinations.
6. **Thin engine against readable output.** If generated action functions become unreadable, the point of Ruling 2 is lost. Watch M5.
7. **No authorization until M8.** Milestones M2 to M7 produce runnable actions with no access control; this is stated in M2 and M8.
8. **The inferred write strategy can change silently** ([ADR-0054](../decisions/0054-write-strategy-is-inferred.md)). A `check` that starts reading `self` turns an atomic update into read-then-write; only the committed `explain` output and review catch it.
9. **Overridden templates fork** ([ADR-0061](../decisions/0061-generators-are-jig-templates.md)). A project that overrides a template stops receiving fixes to it, and the view types become a public contract.
