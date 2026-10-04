---
title: "Roadmap"
description: "The order in which Mesh is built: ten milestones for v1, then what comes after."
---

# Roadmap

Date: 2026-10-04. This is revision 3 of the implementation plan. It replaces
[plan revision 2 (superseded)](./plan-revision-2.md), which is kept as history.

## 0. What this page is

**Mesh** is a TypeScript framework modelled on Ash, the declarative resource framework for
Elixir. One *resource file* declares a piece of data, the operations on it and the rules around
it; Mesh derives types, handlers and database schema from that file. This page says in what
order Mesh is built: ten milestones for the first release (v1), then what comes after. Each
decision the roadmap rests on has its own decision record, listed in [decision records](../decisions/index.md);
the roadmap cites them as "[ADR-0012](../decisions/0012-expression-semantics.md)".

Sources, with the short names used below:

| Short name | File | What it is |
|---|---|---|
| **Rulings** | [rulings of 2026-10-04](../decisions/rulings-2026-10-04.md) | The decisions of 2026-10-04 by the operator (the project owner, Saulo Vallory). Four parts are cited: the table of eight rulings ("Ruling 4" is row 4), the "Review note", the table "Rulings after the decision review" ("review ruling: Expressions" names a row), and the sections named "Lead decisions": choices made by the team lead, which the project owner may overrule. Where parts disagree, the later one wins. |
| **Synthesis** | [research synthesis](../research/synthesis.md) | Summary of seven research documents on Ash and on TypeScript tools. Its Step 3 (sections 14–19) is the architecture proposal: three rings, an eight-stage build pipeline, an eight-phase action lifecycle, extension points. |
| **Durable engines** | [durable engines](../research/durable-engines.md) | Comparison of eleven workflow and job tools with a proposed adapter interface. Design input for work after v1. It was written when a command-line transport, an in-process runner and Node support were still planned; those premises are superseded ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md), [ADR-0023](../decisions/0023-workflows-and-jobs-deferred.md), [ADR-0025](../decisions/0025-bun-only.md)). |
| **PR #1, PR #2** | <https://github.com/svallory/mesh/pull/1>, <https://github.com/svallory/mesh/pull/2>; report [PR #1](https://github.com/svallory/mesh/pull/1) and its report | The first Mesh code, both merged to `main`: the resource vocabulary as 26 MX tag contracts with their tests, and the adoption of MX's `unknownTags` option. |
| **MX notes** | MX project notes, getting-started, MX project notes, updates | How Mesh consumes MX and what has landed in it. |

Terms:

- **MX** is a separate project that parses Marko-syntax files. Mesh resource files are `.mx`
  files. Mesh calls `parseData` from `@mxlang/data`, which returns a static tree of tags and
  attributes plus diagnostics; nothing in the file is executed (MX notes, getting-started
  section 1). A **tag contract** tells MX which attributes, children and parents a tag allows.
- **Core, adapter, extension** are the three rings ([ADR-0001](../decisions/0001-three-rings.md)). Core is what Mesh cannot work
  without. An adapter is one replaceable implementation of a contract core owns. An extension
  is an optional feature built on core's extension points.
- An **action** is one named operation on a resource (create, read, update, destroy). In v1 an
  action is a generated TypeScript function, and calling that function is the whole interface
  ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)). A **transport** (command line, HTTP) is an optional adapter that calls it for an
  outside caller; none is built in v1.
- The **scope** is the value `{ actor, context }` the caller passes on every action call
  ([ADR-0007](../decisions/0007-scope-is-a-plain-argument.md)): who is calling, and extra data for the call. It is never ambient.
- A **capability** is an optional feature of a data adapter (joins, aggregates, upserts, atomic
  expressions), declared as static data so the build can check it.
- **Drizzle** is an established TypeScript query builder with SQLite and Postgres drivers;
  **drizzle-kit** generates SQL migrations from a Drizzle schema. Mesh's SQL adapters are built
  on both ([ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md)).
- `verify` is the one local script that runs every check. There is no continuous integration
  (CI) until the MX packages are published ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md)).

## 1. Summary

1. **v1 is ten milestones, M0 to M9**: workspace, build skeleton, run skeleton, data-layer
   contract, expressions, action lifecycle, extension host, relationships, policies, and
   migrations with Postgres (review ruling: v1 line; [ADR-0019](../decisions/0019-v1-scope.md)). They are the old plan's M0–M8
   plus M10, renumbered.
2. **The walking skeleton is M0 to M2 and ends in a function call**: a `.mx` file is parsed,
   turned into a model, emitted as committed TypeScript, and a test and a short script call the
   generated functions against SQLite. No command line, no server ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)).
3. **After v1**, in no fixed order yet: bulk actions, identities and upserts; the agent and
   test surface; a command-line adapter generated for agents; outbox, jobs and workflows; HTTP;
   a single binary (section 6).
4. **Bun only** ([ADR-0025](../decisions/0025-bun-only.md)), **established tools first** ([ADR-0030](../decisions/0030-established-tools-first.md)), **no CI yet** ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md)).
5. **Framework code starts when this roadmap and the ADR set are published** (review ruling:
   Order of work).
6. **The resource vocabulary copies Ash's DSL for v1**, names and structure, always in MX
   concise syntax, and is reviewed after v1 (review ruling: Vocabulary; [ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md), [ADR-0041](../decisions/0041-mx-concise-syntax.md)). The
   contracts predated that ruling; the first part of M1 aligned them, following the mapping page
   ([vocabulary mapping](./vocabulary-mapping.md)), and that is done. Tag and attribute names in this
   roadmap are the aligned ones; the names of vocabulary that later milestones add are the mapping page's.
7. **Mesh is open source under the MIT licence** and its docs are public ([ADR-0042](../decisions/0042-open-source-mit.md)).

## 2. Principles every milestone is checked against

1. **Generated code carries the behaviour; the run-time library stays thin** (Ruling 2;
   [ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)). Test: the run-time library never reads the resource model. Ash keeps behaviour in
   the library, so stack traces are unhelpful and coverage of a user's own resource reads 0%
   (Synthesis section 6, item 2).
2. **No silent fallback.** A capability the adapter lacks, a tag the compiler does not
   implement yet, an expression that cannot be translated where it must be: each is a build
   error naming file, line and fix (Ruling 4; Synthesis section 8, "Silent fallbacks").
3. **Conservative defaults**: accept only listed inputs; atomic unless stated otherwise; deny
   unless allowed once policies exist (Synthesis section 14, goal 4, and section 6, last
   paragraph, on Ash 3.0 reversing every permissive default).
4. **"It was in the plan" is never a reason to hardcode something** ([ADR-0001](../decisions/0001-three-rings.md)). Every
   package states why it sits in its ring.
5. **Every vocabulary addition copies Ash's DSL** ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)) and follows the PR #1 pattern:
   one closed contract per tag, one negative fixture per rule with exact message, line and
   column. Examples are in MX concise syntax ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).
6. **The committed generated tree is guarded**: `verify` regenerates it and fails on any
   difference (Synthesis section 16, stage 8).
7. **Established tools first** ([ADR-0030](../decisions/0030-established-tools-first.md)): before building anything, look for a
   well-established tool and put it behind a Mesh contract.
8. **No application concerns in core.** How a caller is identified, how a program is exposed
   to the outside, login: the application's business. Core takes a scope and runs an action.
9. **Document what one code file cannot show** (review ruling: Docs site). A milestone that
   adds a contract, a pipeline stage or a cross-package rule updates its Architecture page in
   the same pull request.

## 3. Packages

A bun workspace in `svallory/mesh`. Names (`@mesh/*`, the `mesh` command) are working names;
npm availability was not checked.

```
apps/docs/            the docs site (docmd): Docs for users, Architecture for contributors
packages/
  model/              core       plain-data resource model, vocabulary registries, diagnostics
  compiler/           core       build pipeline (loads .mx through MX), tag contracts, extension host, emitters
  runtime/            core       thin run-time library: scope, errors, contracts, expression functions
  cli/                core       the `mesh` developer command (build, check, inspect, explain); adapters add commands
  data-drizzle/       adapter    shared code of the SQL adapters: Mesh queries and expressions -> Drizzle
  data-sqlite/        adapter    data layer on SQLite (file or in-memory), on Drizzle
  data-postgres/      adapter    data layer on Postgres, on Drizzle
  ext-policies/       extension  authorization rules (first-party, on by default)
examples/blog/        the fixture resources (post, user, comment) and a script that calls them
```

| Package | Ring | Why there |
|---|---|---|
| `model` | core, build time | Every build-time package reads the resource model. Plain JSON-serialisable types, the registries (attribute types, expression functions, check kinds), the diagnostic type. One registry per vocabulary, one plain-data model every tool reads (Synthesis section 8, "Copy from Ash"). |
| `compiler` | core, build time | The build pipeline is what makes Mesh a framework (Synthesis section 16). Owns stage order, the extension host and the emitters every project needs. It is also where MX is used: MX is core, not an adapter ([ADR-0043](../decisions/0043-mx-is-core.md)), so the tag contracts from PR #1 and the load and check-structure stages live here. `compiler` depends on MX; `model` and `runtime` never import it. |
| `cli` | core, build time | The `mesh` command is the only entry to the pipeline. It builds a project; it does not run an application's actions. Commands that belong to an adapter's tool (`db push`, `migrate`) are contributed by that adapter, so `cli` imports no query library. |
| `runtime` | core, run time | What generated code imports: the scope type, error classes, the data-layer contract with the query and expression-tree types, the transaction helper, and the in-memory implementations of the registered expression functions. Split from `compiler` so a deployed program does not carry the compiler. Imports nothing from `model`, `compiler` or Drizzle; the build-time packages may import its contract types, never the reverse. |
| `data-sqlite`, `data-postgres`, `data-drizzle` | adapter | A project picks its database; the contract is Mesh's own (Synthesis section 11); "the query library inside an adapter is that adapter's private choice" (same section), and that choice is Drizzle ([ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md)). Drizzle is imported only here. |
| `ext-policies` | extension | Authorization is "a fixed slot in the core lifecycle, filled by a first-party policy extension" (Synthesis section 10, last paragraph). The slot is core; the rules engine is replaceable. |

Adapter slots of the Synthesis ring table (section 15) with no package in v1: transport
(none needed, [ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)); tracer (generated code calls the OpenTelemetry API directly, [ADR-0029](../decisions/0029-tracing-opentelemetry-api.md));
runtime host (Bun only, [ADR-0025](../decisions/0025-bun-only.md)). Two slots of that table are not adapter slots at all: the
authoring syntax and the expression parser are MX's, and MX is core ([ADR-0043](../decisions/0043-mx-is-core.md)). MX hands each
expression over as a parsed Babel node (MX notes, getting-started section 1). The remaining
slots of that table are not in v1: the actor resolver is dropped ([ADR-0007](../decisions/0007-scope-is-a-plain-argument.md)), the job runner
comes with workflows after v1 ([ADR-0023](../decisions/0023-workflows-and-jobs-deferred.md)), and API protocols come with the HTTP adapter.

## 4. Order

```
M0 workspace (done)
 └ M1 build skeleton ─ M2 run skeleton                 ← walking skeleton ends here
     └ M3 data-layer contract
         └ M4 expressions
             └ M5 action lifecycle, atomic updates
                 ├ M9 migrations, Postgres
                 └ M6 extension host, composed contracts
                     └ M7 relationships, calculations, aggregates
                         └ M8 policies
```

M9 can run alongside M6–M8. **Capability rule across tracks:** a milestone that adds an
optional data-layer capability (M5 atomic expressions, M7 joins and aggregates) implements it
in every data adapter merged when the milestone itself is merged; M9 implements on Postgres
every capability in the conformance suite on the day M9 is merged. Whichever merges second
owes the missing combination. v1 is done when SQLite and Postgres both pass the whole suite.

**Prerequisites that are decisions, not milestones.** M1's vocabulary alignment needs one
answer first: from the operator, on the exceptions listed on the vocabulary mapping page.
(The spelling question is settled: MX accepts `_` in names but never `?`, so Mesh uses Ash's
names in kebab-case with `?` dropped, [ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md).) M4 needs [ADR-0012](../decisions/0012-expression-semantics.md) ruled.

Sizes: **S** one pull request; **M** two to four; **L** five or more, split
into tasks by whoever leads it. Sizes are scope, not time.

## 5. v1 milestones

"Vocabulary" means tag names or attributes added to the resource-file language.

### M0 — Workspace (S, done)

- **Status.** Done: merged to `main` on 2026-10-04 (PR #6, commit `287b90c`).
- **Goal.** A repository later milestones add packages to, with one command that runs every
  check.
- **What it did.** A bun workspace; the tag contracts, tests and fixtures from PR #1 and PR #2
  moved to `packages/compiler` ([ADR-0043](../decisions/0043-mx-is-core.md)); `apps/docs` as a workspace member; `examples/blog`;
  a root `bun run verify` (tests and type check for every package); the `LICENSE` file (MIT,
  [ADR-0042](../decisions/0042-open-source-mit.md)).
- **Out of scope.** New behaviour; CI ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md)).
- **Packages.** `compiler` (core); workspace root.
- **Risks.** With no CI nothing enforces `verify` except running it before every merge.

### M1 — Build skeleton: resource file to model to emitted types (M)

- **Goal.** `mesh build` reads `.mx` files and writes a committed model and TypeScript types:
  build stages 1, 2, 3, 7 and 8 of Synthesis section 16 in their simplest form.
- **In scope.**
  - *Vocabulary alignment first (done).* The contracts, fixtures and tests were changed to follow
    Ash's DSL as the vocabulary mapping page lists ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)), before anything was built on
    them. It rewrote tests that were reviewed four times, so it was reviewed as new code. It is
    done in the `m1-align` pull request.
  - *Load and check structure.* `compiler` calls `parseData(source, file, { customTags,
    structural: "reject", unknownTags: "reject" })` with the contracts imported directly, so a
    stray local tag file cannot change the build. An undeclared tag at any depth is MX's error
    (MX notes, updates, entry for `e65707a0`). One root rule is Mesh's: exactly one `resource`
    per file (PR #1 report, Round 3, item 2). Whether the build also rejects a file written in
    MX's HTML-style form is not decided ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).
  - *Build model.* One plain-data document per resource, source positions kept. In M1:
    resource name, `table`, `domain` (optional grouping; it sets the output directory);
    attributes of the seven types the contracts allow (`string`, `integer`, `float`, `boolean`, `atom`, `uuid`, `datetime`), with `allow-nil`, `constraints` (`one_of` for an atom), `default` and `public`
    (recorded in the model as Ash records `public?`; nothing in v1 reads it, and what it will
    mean for a transport is [ADR-0035](../decisions/0035-meaning-of-public.md));
    `uuid-primary-key`; `create-timestamp` and `update-timestamp`; the four action kinds (create,
    read, update, destroy) with `accept` (not on read); and the `defaults` attribute of `actions`, which
    names the action kinds a resource gets without declaring them.
  - The tag contracts are the source of tag names; value vocabularies (attribute types, later
    expression functions) live in the registries in `model`, and the contract's `type` enum is
    built from the registry, with a test that fails if they differ ([ADR-0037](../decisions/0037-vocabulary-source-of-truth.md), proposed).
  - Cross-file checks: duplicate resource names; `accept` naming a missing attribute.
  - *Project configuration.* One file (`mesh.config.ts`) names where the resource files are
    and where generated files go. M2 adds the data adapter (one per project in v1), M6 the
    enabled extensions. Every build check that depends on "the configured adapter" reads it
    from here.
  - *Emit.* `generated/model.json` (one file holding one document per resource) and a
    `types.ts` per resource. Text from templates, passed
    through an established formatter pinned to an exact version; same input, same bytes.
  - *Guard.* `mesh build --check` regenerates in memory and fails on any difference; `verify`
    runs it. `mesh inspect` prints the model as JSON.
  - **Not-implemented rule** ([ADR-0018](../decisions/0018-not-implemented-is-a-build-error.md)): a tag or attribute the contracts accept but the
    compiler does not handle yet is a build error naming it and the milestone that will. In M1:
    `relationships`, `belongs-to`, `has-many`, `change`, `validate`, `filter`,
    `sort`, `policies`, `policy`, `authorize-if`, `calculations`, `calculate`, `value`,
    `aggregates`, `count`.
- **Out of scope.** Handlers, expressions, the extension host.
- **Packages.** `model`, `compiler`, `cli` (core).
- **Acceptance tests.** (1) A reduced `post.mx` builds; emitted types pass `tsc --noEmit`.
  (2) Two builds give identical bytes. (3) A hand edit to a generated file fails `mesh build
  --check`, which names the file. (4) An empty file, two resources in one file, a duplicate
  resource name and an unknown `accept` name each fail with the expected message and position.
  (5) The full fixture fails with the not-implemented error for its first unsupported tag.
  (6) The registry-against-contract drift test. (7) Every row of the mapping page marked "on main" has a
  contract and a fixture that match it. (8) Import rule checked by `verify`: `@mxlang/*`
  is imported only by packages that declare tag contracts (`compiler` now, extensions from
  M6); never by `model` or `runtime` ([ADR-0043](../decisions/0043-mx-is-core.md)).
- **Example.** A reduced `post.mx`: attributes and the four actions, no expressions,
  relationships or policies.
- **Risks.** `parseData` stops at the first error per file (MX notes, getting-started section 1), so
  Mesh's own checks should report all of theirs at once.

### M2 — Run skeleton: generated handlers on SQLite (M)

- **Goal.** The walking skeleton, end to end. A test and a script of about twenty lines in
  `examples/blog` import the generated functions, create a post, read it back, update it,
  destroy it; the rows are in a SQLite file.
- **In scope.**
  - *Generated handlers.* One file per resource, one exported function per action:
    `createPost(input, scope)`. The body holds the steps in order (validate input, open a
    transaction, call the data layer, commit, return a typed record), written out per action,
    not a call into a generic `runAction` (principle 1).
  - *Scope.* The second argument, `{ actor, context }`, required on every call ([ADR-0007](../decisions/0007-scope-is-a-plain-argument.md)). In
    M2 it is only passed through; M5 and M8 use it.
  - *Input validators.* Generated Zod schemas, seen by the rest of Mesh only through Standard
    Schema ([ADR-0028](../decisions/0028-validation-zod-behind-standard-schema.md)). Only accepted fields pass; an unknown field is an error, not dropped.
  - *Run-time library.* The scope type; a first small data-layer contract (insert, select by
    key, select all, update by key, delete by key, transaction); the first error classes
    (invalid input, not found, framework).
  - *`data-sqlite` on Drizzle.* A build-time half emits the Drizzle table definitions as a
    guarded generated file; a run-time half implements the contract with Drizzle over Bun's
    SQLite driver. The adapter contributes the `mesh db push` command (through a fixed hook in `cli` until M6
    turns it into a manifest entry, as for emitters), which wraps
    drizzle-kit's schema push for development; `cli` itself never imports drizzle-kit.
    Versioned migrations come in M9. Handlers call Mesh's contract and never import Drizzle. Exact
    versions pinned.
- **Out of scope.** Any transport, action registry or command line ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)). `public` has no effect
  ([ADR-0035](../decisions/0035-meaning-of-public.md), proposed). Authorization: nothing checks who calls until M8, and nothing pretends
  to ([ADR-0036](../decisions/0036-deny-by-default-arrives-with-policies.md)). Filters, sorting, expressions, hooks.
- **Packages.** `runtime`, `compiler` (core); `data-sqlite`, `data-drizzle` (adapters).
- **Acceptance tests.** (1) The example script and the test run create, read, update,
  destroy, and a read after destroy throws the not-found error class. (2) A field not in
  `accept` is rejected. (3) A failing validation's stack trace has the generated handler as
  its first frame outside `node_modules` and Mesh packages. (4) Import rule checked by
  `verify`: nothing in `runtime` imports `@mesh/model`, `@mesh/compiler` or Drizzle; no
  generated handler imports them or `model.json`; Drizzle is imported only under
  `packages/data-*` and in the emitted schema file. (5) A call without a scope is a type
  error. (6) The guard covers handlers and the emitted schema. (7) Web-standard check in `verify`
  (review ruling: Runtime): `runtime` imports no `bun:*` module and uses no `Bun` global;
  Bun-specific code lives in adapters.
- **Risks.** Contract shapes change in M3 and M5; unstable until M6. Drizzle v1 is a release
  candidate (section 9, risk 3).

### M3 — Data-layer contract and capabilities (L)

- **Goal.** The contract of Ruling 4 ([ADR-0013](../decisions/0013-data-layer-contract-and-capabilities.md)) on Drizzle, with a test suite every data
  adapter must pass.
- **In scope.** The mandatory set: select, insert, update, delete, transactions, filters,
  sort, pagination. `data-drizzle` turns a Mesh query (plain data) into Drizzle's builder;
  nothing of Drizzle shows through the contract. A **capability manifest** per adapter: static
  data, a closed union of names (joins, aggregates, upserts, atomic expressions), read by the
  build without starting the adapter. The build check for "resource uses a capability the
  adapter lacks" is written here and first used in M5. A **conformance suite**. SQLite's
  in-memory mode for tests, instead of a hand-written in-memory adapter ([ADR-0016](../decisions/0016-in-memory-data-via-sqlite.md)). Read
  actions implement `sort` and gain pagination, offset and keyset (new vocabulary). Filters
  here are plain data (field, operator, literal), also the form a caller passes at run time.
- **Out of scope.** Joins, aggregates, upserts, atomic expressions (declared only); Postgres.
- **Packages.** `runtime`, `compiler` (core); `data-drizzle`, `data-sqlite` (adapters).
- **Acceptance tests.** (1) `data-sqlite` passes the suite in file and in-memory mode. (2) A
  manifest naming a capability outside the union fails the build. (3) A transaction that
  throws leaves no row. (4) Keyset pagination under concurrent inserts returns every row that
  existed at the start exactly once and none twice. (5) No Drizzle type in `runtime`.
- **Risks.** One real implementation until M9; that is why M9 may start right after M5. Ash's
  contract has 46 callbacks and 47 capability names, applied inconsistently (Synthesis section
  2.2): the failure to avoid.

### M4 — Expressions: one tree, two evaluators (L)

- **Goal.** An arrow function in a resource file becomes one expression tree that can run
  both in memory and in SQL (review ruling: Expressions; [ADR-0010](../decisions/0010-one-expression-tree-two-evaluators.md)), or, if it cannot be
  converted, an opaque TypeScript function.
- **In scope.** The tree type (in `runtime`, it crosses the data-layer contract) and the
  registry of functions and operators (in `model`). Conversion from MX's Babel node to the
  tree, in `compiler`. **Translatable** expressions convert fully. **Opaque** ones are
  emitted as TypeScript by slicing the authored text at MX's span (MX notes, getting-started
  section 1). Each translatable expression is written into the generated file twice: as the tree itself,
  a data literal that the data adapter compiles into Drizzle's builder when a query runs
  (queries are assembled at run time from the action's filter, the caller's filter and, later,
  policies); and as its in-memory form, emitted TypeScript (principle 1) that calls the
  registered functions' in-memory implementations in `runtime`. The build checks that every
  function used has a SQL form in the configured adapter. Both follow one definition of the semantics, Mesh's own, which
  matters wherever SQL and JavaScript, or SQLite and Postgres, disagree (nulls, string
  ordering, division); [ADR-0012](../decisions/0012-expression-semantics.md) (proposed) fixes that definition and **must be ruled before M4
  starts**, because the function tables of test 1 are that definition written down. The
  first registry is small and listed in the docs from the registry itself: attribute and
  parameter references (parameters such as the actor are bound from the scope and the input
  when the expression runs), literals, comparison and boolean operators, numeric `+` and `-`,
  string length, and assignment to an attribute as the one node a change may use. Conversion and classification happen while the model is built (stage 3 of Synthesis
  section 16): the tree and its class are part of the model, so transforms and verifiers see
  them, and errors that depend on the class are raised by the checks step (the Verify stage
  from M6). Stage 6, "compile expressions", only produces the forms described above.
  Position rules: `filter` must be translatable; `change` and
  `validate` are *classified* (translatable or opaque) and the class is recorded in the model.
  A translatable expression may use only its parameters and registered functions; a free
  variable is a build error (Synthesis section 8, gap 5). Vocabulary
  that starts working in this milestone: `filter` on read actions, `validate` with its
  `message`, and `change`.
- **Out of scope.** Relationship traversal (M7); folding into statements (M5).
- **Packages.** `model`, `compiler`, `runtime` (core); `data-drizzle`, `data-sqlite`
  (adapters).
- **Acceptance tests.** (1) Every registered function and operator has one table of inputs
  and expected outputs, null cases included, run through the in-memory form and through every
  merged SQL adapter; all must give the table's answer. (2) An unsupported construct in a
  filter fails the build at that node. (3) A free variable fails the build. (4) A read with a
  `filter` returns only matching rows. (5) An example resource with a single-assignment
  change, a multi-statement change, a validation built from registered functions and one
  calling an imported helper: `model.json` records them as translatable, opaque, translatable,
  opaque.
- **Risks.** Nothing reusable exists for this (Synthesis section 8, gap 5). The same rule now
  has two execution paths, and paths diverge: in Ash an update runs its changes once when the
  changeset is built and again when it is rebuilt for the atomic path, and that rebuild dropped
  filters (bug #2969, Synthesis section 2.2). That was a lifecycle bug, not a disagreement
  between evaluators, so test 1 does not guard against its kind; M5's rule that a change is
  never run twice does. Test 1 guards the other risk, the two forms giving different answers.
  AshPostgres installed SQL functions to force Elixir semantics on the database and one
  filter ran 30 times slower (same section), which bears on [ADR-0012](../decisions/0012-expression-semantics.md).

### M5 — Action lifecycle and atomic updates (L)

- **Goal.** The eight-phase lifecycle of Synthesis section 17, generated per action, with the
  atomic half of Ruling 3 ([ADR-0017](../decisions/0017-atomic-by-default-and-classification.md)).
- **In scope.**
  - Phases in generated code: enter (the function is called with its input and scope), cast,
    plan, pre-check, transaction, data layer, commit, after commit. The plan is chosen at build time and printed by `mesh explain <resource>
    <action>`.
  - Validations collect all errors. Hooks inside the transaction and after commit; read-side
    **preparations**; action **arguments** (new vocabulary; Synthesis section 8, gap 4).
  - The **authorizer slot**: one place before the transaction for checks needing no data, one
    inside it for checks that read data (Synthesis section 2.2: Ash has six places and a
    check-then-act gap). Empty until M8.
  - **Tracing**: one span per phase through the OpenTelemetry API, which does nothing unless
    the application installs an SDK ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md)).
  - **Atomic single-record updates** ([ADR-0017](../decisions/0017-atomic-by-default-and-classification.md)). Update and destroy are atomic by default: one
    statement, no read first. The opt-out is Ash's `require_atomic?` set to false, spelled
    `require-atomic=false` in Mesh (Ash's names in kebab-case, `?` dropped: [ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)).
    - A translatable change folds into the `UPDATE` statement's assignments when its right-hand
      side reads nothing stored except the column it assigns (a literal, an input value, an
      increment of the column itself).
    - A translatable validation that reads only the input runs in memory before the
      statement, on either path.
    - A change or validation that is opaque, or that reads the stored record beyond that,
      makes the action non-atomic: it must say `require-atomic=false`, as in Ash, and without it the build
      fails. The action then reads the row with a write lock (a row lock on Postgres, an
      immediate transaction on SQLite; a "read for update" call in the data-layer contract),
      runs changes and validations in memory with the in-memory forms, collecting every
      validation error, and writes, all in one transaction, so two such calls cannot both act
      on the same stale row.
    - The example's `publish` action validates `post.title`, which is stored, so it says
      `require-atomic=false`.
    - A change is never run twice.
    Folding record-reading validations into the statement is not in v1; [ADR-0044](../decisions/0044-folding-record-reading-validations.md) (proposed)
    keeps the design for it.
  - The run-time error class hierarchy. A declared rule that fails at run time reports its
    `.mx` position, carried as data in the generated code ([ADR-0039](../decisions/0039-run-time-error-positions.md), proposed, on source maps).
- **Example.** `post.mx` with `filter`, `change` and `validate` (from M4), no relationships
  or policies. The fixture's `create` change, which sets `authorId`, waits for M7, where
  `belongs-to` creates that attribute; until then the example's changes assign declared
  attributes only.
- **Out of scope.** Bulk actions; policies; notifications.
- **Packages.** `compiler`, `runtime`, `model` (core); `data-drizzle`, `data-sqlite`
  (adapters: atomic expressions).
- **Acceptance tests.** (1) Two concurrent atomic increments both apply. (2) `publish` on a
  post with an empty title fails with the validation's message, and on a missing post with
  not-found. (2b) Two concurrent calls of a `require-atomic=false` action on one row: the
  second sees the first's write. (2c) An update whose validation reads the stored record fails
  the build without `require-atomic=false`. (2d) A change that counts its own calls runs exactly
  once per action call, on the atomic and on the non-atomic path; the same update declared
  both ways leaves the same row. (3) An update with an opaque change fails the build without `require-atomic=false`; with
  it, `explain` says "read then write". (4) An atomic change against a fake adapter lacking
  the capability fails the build at the resource-file position. (5) `explain` output for the
  example is committed and guarded. (6) A hook that throws rolls the write back. (7) With a
  test OpenTelemetry SDK, one call gives eight spans in order; with none, no error. (8) A
  preparation that adds a filter changes what a read returns. (9) The M2 import rule passes. (10) A failed declared
  validation's error carries the file and line of its `validate` tag in the resource file.
- **Risks.** Ruling 2 is tested hardest here; a repeated pattern becomes a small pure helper
  in `runtime` that takes values, never the model. Telemetry cost Ash 15–23% of a create
  (Synthesis section 6, item 7); measure the spans with no SDK.

### M6 — Extension host and composed contracts (L)

- **Goal.** Extensions add vocabulary, transform and verify the model, emit files and supply
  run-time behaviour through one typed manifest ([ADR-0020](../decisions/0020-extension-contributions-through-declared-points.md), [ADR-0021](../decisions/0021-composed-contracts-module.md)).
- **In scope.** The **manifest** (Synthesis section 18): tags; transforms and their named
  phase; verifiers; emitters; expression functions (each with its in-memory implementation
  and its SQL form per data adapter; generated wiring registers both with `runtime` and the
  adapter when the program starts); attribute types (validator, column type per adapter);
  tooling hooks (a `mesh` subcommand); adapter requirements; contribution points published
  and used. Run-time points: named, reusable changes, validations, preparations, calculations
  and policy checks a resource file refers to by name. An extension package has a build-time
  entry and a run-time entry; the run-time entry follows the same import rule as `runtime` (no
  `model`, `compiler` or MX), so a deployed program never carries the compiler. **Named phases**, a hard error on a
  cycle, the order printed (Synthesis section 16, stage 4). The M1 checks become the Verify
  stage. **Ruling 5**: an undeclared write to another extension's part of the model fails the
  build. **Composed contracts**: the contracts handed to `parseData` are composed in memory
  from core plus enabled extensions; `mesh build` also writes one self-contained module for
  MX tooling (`package.json#mx.contracts`), produced with Bun's bundler because it contains
  `analyze` functions. Core and data-adapter emitters re-register through the same interface;
  M2–M5 contracts are declared stable.
- **Out of scope.** Loading extensions by discovery. A strictness setting for verifiers. A
  way for extensions to add to the scope: whether a tenant is core or an extension is open
  ([ADR-0009](../decisions/0009-tenancy-placement.md), proposed).
- **Packages.** `compiler`, `model`, `runtime` (core).
- **Acceptance tests.** (1) A test extension adds a child tag to `resource` through a
  declared point; disabled, the same file fails. (2) An undeclared cross-extension write
  fails and names both extensions. (3) A phase cycle fails and prints the cycle. (4) The
  generated contracts module loads through MX's scan with the same tag names as the in-memory
  composition, and is guarded. (5) A test extension supplies an attribute type, an expression
  function and a named change; a resource uses all three; the function gives the same answers
  in memory and in SQL; a fake adapter with no SQL form for it fails the build. (6) The import rule of M2 test 4 covers the run-time entry
  of every extension.
- **Risks.** The widest milestone. The generated contracts module has no consumer until MX
  ships editor support for data files (MX notes, getting-started section 1).

### M7 — Relationships, calculations, aggregates (L)

- **Goal.** Resources refer to each other; derived values can be queried.
- **In scope.** `examples/blog` gains `user.mx` and `comment.mx`. `belongs-to`, `has-many`,
  `has-one` (new). A `belongs-to` adds its foreign-key
  attribute (the fixture's `authorId`). Cross-file verification: unknown resources, inverses,
  cycles. Loading related records on request. Relationship traversal in expressions, compiled
  to joins by `data-drizzle` (not Drizzle's relations API, [ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md)). `calculate`: a
  translatable value can be used in queries and computed in memory on a loaded record; an
  opaque one runs after load and cannot be used in a filter. `count` and the other
  aggregates. Capabilities `joins` and `aggregates` in every merged adapter.
- **Out of scope.** `many-to-many`, join resources, managing related records in a write.
- **Packages.** `model`, `compiler` (core); `data-drizzle`, `data-sqlite`, and
  `data-postgres` if M9 is merged (adapters).
- **Acceptance tests.** (1) The example's `post.mx` without its `policies` block, plus `user`
  and `comment`, builds with no not-implemented error. (2) Reading a relationship that was
  not requested is a type error; a load that cannot be done is a run-time error, never
  ignored (Synthesis section 6, item 7). (3) An opaque calculation in a filter fails the
  build. (4) Aggregates pass the suite on every merged adapter. (5) A relationship to an
  unknown resource fails at the tag. (6) A translatable calculation gives the same value
  computed in the query and in memory.
- **Limit in v1.** A `has-one` and a `has-many` over the same foreign key is a build error;
  Ash's `from_many?` option, which allows it, is not in v1 ([ADR-0045](../decisions/0045-has-one-uniqueness.md)).
- **Risks.** `has-one` over many rows: Ash truncates silently (Synthesis section 6, item 7).
  For v1 Mesh emits a unique index on the foreign key of a `has-one` target, with no new
  vocabulary; this deviates from Ash and is [ADR-0045](../decisions/0045-has-one-uniqueness.md) (proposed). Declared identities stay after
  v1 (review ruling: After v1).

### M8 — Policies extension, simple tier (L)

- **Goal.** Authorization as declared data (Ruling 6; [ADR-0022](../decisions/0022-policies-simple-tier-as-extension.md)); deny by default from here on.
- **In scope.** The policy tags (`policies`, `policy`, `authorize-if`) move from the core
  contracts into `ext-policies` through the M6 mechanism; `forbid-if` is added. Ordered checks
  per action or action type. With the extension enabled, an action with no matching policy is
  forbidden. A verifier that a policy's `action` names a real action. Read policies become
  query filters. Write policies run in the M5 slot. A check that
  needs no record runs in memory before the statement. A check that reads the record is
  folded into the statement's condition as a filter for an atomic action, so a row the caller
  may not change is treated as not found, as for reads (Ash also compiles the check into
  the statement, as an expression that raises: [ADR-0022](../decisions/0022-policies-simple-tier-as-extension.md)); on a `require-atomic=false` action it is
  evaluated in memory on the locked row and a denial is reported as forbidden. A write policy
  that is not translatable on an atomic action is a build error. The same denied write
  therefore reports not found on an atomic action and forbidden on a `require-atomic=false`
  action; that asymmetry is the working assumption ([ADR-0046](../decisions/0046-denied-atomic-write-outcome.md), proposed; Ash reports forbidden in both
  cases), and `can` is the way to ask why. The example's
  `policies` block is extended so that every action of every example resource has a policy,
  and the example gains one atomic update guarded by a record-reading policy (an author
  renaming a post from input). A **structured
  breakdown** of every decision, as data. A `can` function per action. The policy kept as a
  boolean formula in the model so a solver can be added later.
- **Out of scope.** A solver; field policies; bypass rules, policy groups, access types.
- **Packages.** `ext-policies` (extension); `compiler`, `runtime` (core: slot).
- **Acceptance tests.** (1) A non-author cannot publish; a reader sees only published posts
  and their own. (2) No policy for an action: forbidden. (3) The breakdown of a denial is
  asserted as data, from `can` and from a call denied by a check that needs no record. (4) A read policy that is not translatable fails the build. (5) The
  formula round-trips through `model.json`. (6) The full example `post.mx` builds with no
  not-implemented error. (7) A policy naming a missing action fails the build. (8) For a loaded record and no
  concurrent writer, `can` gives the same allow-or-deny decision as the action then makes
  (decisions are compared, not error classes). (9) An atomic update by a caller the
  policy excludes reports not found and changes nothing.
- **Risks.** Until M8 nothing restricts a caller; a project built on M2–M7 must not be exposed.

### M9 — Migrations and Postgres (M)

- **Goal.** A second database and a safe way to change a schema. May start once M5 is merged.
- **In scope.** `mesh migrate generate` runs drizzle-kit over the emitted Drizzle schema and
  commits the SQL it writes; drizzle-kit owns snapshot and diff. Never applied automatically;
  `mesh migrate apply` is explicit. Before calling drizzle-kit, Mesh compares old and new
  model and refuses a destructive or ambiguous change (drop, type change, rename, making a
  column required) unless a flag names it. `data-postgres` on Drizzle, passing the suite as
  it stands when M9 merges.
- **Out of scope.** Data migrations; automatic renames.
- **Packages.** `data-postgres`, `data-sqlite`, `data-drizzle` (adapters; they contribute the
  `migrate` commands, so `cli` does not import drizzle-kit).
- **Acceptance tests.** (1) Adding an optional column and adding a resource each generate the
  expected migration for both dialects. (2) A destructive change fails with instructions
  unless flagged. (3) Postgres passes the suite locally. (4) Migrations applied to an empty
  database give the same schema as `mesh db push`. (5) The M4 function tables pass on
  Postgres.
- **Risks.** drizzle-kit is mid-rewrite (Synthesis section 10, "Migrations" row). How it
  behaves without a terminal on an ambiguous change is **not checked**; M9's first task is to
  test it. Local Postgres tests need a server or an embedded Postgres.

## 6. After v1

Not ordered and not sized; each gets its own plan when it is picked up.

| Item | What | Notes |
|---|---|---|
| Bulk actions, identities, upserts | Per-record `stream` bulk; declared unique keys; upserts | Was in v1 by Ruling 3; moved out by the review ruling "After v1". Batched-atomic later still. |
| Agent and test surface | A generated rules file describing the project's resources and the vocabulary; test data builders; a seed path | No MCP server ([ADR-0027](../decisions/0027-no-mcp-agent-surface.md)). |
| Command-line adapter for agents | A CLI generated from the action list, built for agents to call | [ADR-0027](../decisions/0027-no-mcp-agent-surface.md). It will need a way to obtain a scope, which is that adapter's design, not core's. |
| Outbox, jobs, workflows | Events and background work that commit with the data; multi-step operations | [ADR-0023](../decisions/0023-workflows-and-jobs-deferred.md). Durable engines is the design input; a spike "DBOS worker on Bun" comes before any engine choice. |
| HTTP adapter, typed client, OpenAPI | One Fetch handler per action; Elysia as a mount | Elysia is not core ([ADR-0038](../decisions/0038-elysia-is-not-core.md)). |
| Single binary | `bun build --compile` of an example, idle memory measured | Unmeasured so far (Synthesis section 12, risk 5). |
| `public` attributes | What may leave through a transport | [ADR-0035](../decisions/0035-meaning-of-public.md), proposed; decided when the first transport is. |
| Multitenancy | Tenant in core or as an extension | [ADR-0009](../decisions/0009-tenancy-placement.md), proposed. |

Not planned at all, with reasons: a policy solver (Ruling 6 defers it); `many-to-many`,
embedded resources, `NewType`, manual and generic actions (deferrable per Synthesis section 8,
gap 4; generic actions have no agreed tag shape); audit trail, event log, state machine, soft
delete, encryption, rate limits (extensions, none blocks core); GraphQL, an admin interface
(Synthesis section 8, "Do not build yet"); JSON:API (no library evaluated, Synthesis section
13); a second authoring syntax (MX is core, [ADR-0043](../decisions/0043-mx-is-core.md)); `mesh watch`; Node, Deno and edge runtimes ([ADR-0025](../decisions/0025-bun-only.md)).

## 7. Build or reuse

| Need | Decision | Tool, or why Mesh builds it |
|---|---|---|
| SQL queries, drivers, type mapping | Reuse | Drizzle ([ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md)) |
| Migrations: snapshot and diff | Reuse | drizzle-kit; Mesh adds only the refusal of unflagged destructive changes |
| In-memory database for tests | Reuse | SQLite `:memory:` ([ADR-0016](../decisions/0016-in-memory-data-via-sqlite.md)) |
| Input validation | Reuse | Zod behind Standard Schema ([ADR-0028](../decisions/0028-validation-zod-behind-standard-schema.md)) |
| Tracing | Reuse | OpenTelemetry API ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md)) |
| Formatting emitted code | Reuse | An established formatter, pinned |
| Bundling the contracts module | Reuse | Bun's bundler |
| Parsing `.mx` and expressions | Reuse | MX (`parseData`, Babel nodes); a core dependency, not behind an adapter contract ([ADR-0043](../decisions/0043-mx-is-core.md)) |
| Test runner, type checker | Reuse | Bun's test runner, `tsc` |
| Docs site | Reuse | docmd ([ADR-0032](../decisions/0032-docs-site-and-decision-records.md)) |
| Expression tree, its two evaluators | Build | Nothing reusable exists (Synthesis section 8, gap 5) |
| Build pipeline, extension host, emitters, guard | Build | This is Mesh |
| Generated action lifecycle | Build | Ruling 2 |
| Policy engine, simple tier | Build | It must turn a policy into a filter over Mesh's own tree; authorization tools were inventoried, not compared (Synthesis section 13) |
| Conformance suite, capability manifest | Build | They describe Mesh's own contract |

## 8. Traceability: ruling to ADR to milestone

| Ruling | ADR | Milestone |
|---|---|---|
| Ruling 1: no measurement gate | [ADR-0004](../decisions/0004-no-measurement-gate.md) | none; nothing waits on a measurement |
| Ruling 2: generated code carries the behaviour | [ADR-0003](../decisions/0003-generated-code-carries-behaviour.md) | M2, M5; import rule in M2 |
| Ruling 3, atomic half | [ADR-0017](../decisions/0017-atomic-by-default-and-classification.md) | M5 |
| Ruling 3, bulk half: moved after v1 | [ADR-0019](../decisions/0019-v1-scope.md) | after v1 |
| Ruling 4: mandatory set, declared capabilities | [ADR-0013](../decisions/0013-data-layer-contract-and-capabilities.md) | M3; M5, M7 |
| Ruling 5: contributions only through declared points | [ADR-0020](../decisions/0020-extension-contributions-through-declared-points.md) | M6 |
| Ruling 6: simple policy tier, solver-ready | [ADR-0022](../decisions/0022-policies-simple-tier-as-extension.md) | M8 |
| Ruling 7: in-process runner first: replaced | [ADR-0023](../decisions/0023-workflows-and-jobs-deferred.md) (supersedes [ADR-0024](../decisions/0024-in-process-runner-first.md)) | after v1 |
| Ruling 8, corrected: Mesh serves any program; no transport is first | [ADR-0005](../decisions/0005-core-interface-is-a-function-call.md) (supersedes [ADR-0006](../decisions/0006-cli-first-transport.md)) | M2 ends in a function call |
| Elysia is not core | [ADR-0038](../decisions/0038-elysia-is-not-core.md) | after v1 |
| Decided before the rulings of 2026-10-04: three rings; resource files are `.mx` read through MX | [ADR-0001](../decisions/0001-three-rings.md), [ADR-0002](../decisions/0002-resource-files-are-mx.md) | all; M1 |
| Review ruling: MX (not replaceable; core, not an adapter) | [ADR-0043](../decisions/0043-mx-is-core.md) | M0, M1; section 3 |
| Review ruling: Expressions | [ADR-0010](../decisions/0010-one-expression-tree-two-evaluators.md) (supersedes [ADR-0011](../decisions/0011-sql-only-expressions.md)) | M4, M5, M7, M8 |
| Review ruling: v1 line, After v1 | [ADR-0019](../decisions/0019-v1-scope.md) | sections 5 and 6 |
| Review ruling: Runtime (Bun only) | [ADR-0025](../decisions/0025-bun-only.md) (supersedes [ADR-0026](../decisions/0026-node-parity.md)) | all |
| Review ruling: MCP | [ADR-0027](../decisions/0027-no-mcp-agent-surface.md) | after v1 |
| Review ruling: CI | [ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md) | M0 |
| Review ruling: Order of work (framework code starts once the roadmap and decision records are published) | no record of its own | section 1, item 5 |
| Review ruling: Docs site, Research, Architecture process | [ADR-0032](../decisions/0032-docs-site-and-decision-records.md) | principle 9 |
| Operator's standing position: established tools | [ADR-0030](../decisions/0030-established-tools-first.md), [ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md) (supersedes [ADR-0015](../decisions/0015-sql-printed-by-mesh.md)) | M2, M3, M9; section 7 |
| Lead: scope is a plain argument | [ADR-0007](../decisions/0007-scope-is-a-plain-argument.md) (supersedes [ADR-0008](../decisions/0008-actor-resolver-adapter.md)) | M2 |
| Lead: composed contracts module | [ADR-0021](../decisions/0021-composed-contracts-module.md) | M6 |
| Lead: validations classified like changes; in v1 a change or validation that reads the stored record makes the action non-atomic | [ADR-0017](../decisions/0017-atomic-by-default-and-classification.md) (folding them: [ADR-0044](../decisions/0044-folding-record-reading-validations.md), proposed) | M4, M5 |
| Lead: Zod; OpenTelemetry API | [ADR-0028](../decisions/0028-validation-zod-behind-standard-schema.md), [ADR-0029](../decisions/0029-tracing-opentelemetry-api.md) | M2, M5 |
| Roadmap author (the lead may overrule): SQLite in-memory for tests; not-implemented rule; core split by when code runs | [ADR-0016](../decisions/0016-in-memory-data-via-sqlite.md), [ADR-0018](../decisions/0018-not-implemented-is-a-build-error.md), [ADR-0033](../decisions/0033-core-split-build-time-run-time.md) | M3; M1; M2 |
| Lead: deny by default arrives with policies | [ADR-0036](../decisions/0036-deny-by-default-arrives-with-policies.md) | M8 |
| Review ruling: Vocabulary (copy Ash's DSL; MX concise syntax) | [ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md), [ADR-0041](../decisions/0041-mx-concise-syntax.md) | M1 alignment; every later vocabulary addition |
| Review ruling: Licence and visibility | [ADR-0042](../decisions/0042-open-source-mit.md) | M0 |
| Open: tenant; expression semantics; `public`; vocabulary source of truth; source maps; package names | [ADR-0009](../decisions/0009-tenancy-placement.md), [ADR-0012](../decisions/0012-expression-semantics.md), [ADR-0035](../decisions/0035-meaning-of-public.md), [ADR-0037](../decisions/0037-vocabulary-source-of-truth.md), [ADR-0039](../decisions/0039-run-time-error-positions.md), [ADR-0040](../decisions/0040-package-and-command-names.md) (all proposed) | M6; M4; after v1; M1; M5; publishing |
| Open: folding record-reading validations into the atomic statement; `has-one` uniqueness; what a denied atomic write reports | [ADR-0044](../decisions/0044-folding-record-reading-validations.md), [ADR-0045](../decisions/0045-has-one-uniqueness.md), [ADR-0046](../decisions/0046-denied-atomic-write-outcome.md) (proposed) | after v1; M7; M8 |

## 9. Risks

1. **The vocabulary copies Ash's DSL and is not yet aligned** ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)). The 26 tag contracts
   on `main` were copied from an MX test fixture and several rules were inferred during
   development and review (PR #1 report, "Inferred by me" and rounds 1–4). M1 aligns them
   with Ash using the mapping page. Ash's names come from Elixir and may read oddly in MX;
   the review after v1 is a breaking change for every resource file written by then.
2. **MX is consumed from `main`, nothing pinned** (MX notes, getting-started section 5). A
   breaking change stops Mesh the same day.
3. **Drizzle v1 is a release candidate, its relations API is being replaced, drizzle-kit is
   mid-rewrite** (Synthesis section 12, risk 1; section 10). Mitigation: exact pins; Drizzle
   imported only in `data-*` (M2 test 4); an upgrade is its own pull request and must pass the
   suite; Mesh does not use the relations API; migrations are plain SQL files.
4. **No CI** ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md)): a skipped `verify` run is invisible.
5. **Two evaluators can disagree** (M4). The shared function tables are the only guard, and
   they cover only registered functions, not their combinations.
6. **Thin engine against readable output.** If generated handlers become unreadable, the
   point of Ruling 2 is lost. Watch M5.
7. **No authorization until M8.** Six milestones produce runnable actions with no access
   control; this is stated in M2 and M8 and must be stated in the user docs.
8. **Six of ten milestones are L.** Only M9 runs in parallel with anything.
9. **New vocabulary arrives in M3, M5, M7 and M8** (pagination, hooks, preparations,
   arguments, `require-atomic`, `has-one`, `forbid-if`). One owner should review it together so the
   language keeps one way to do each thing.
