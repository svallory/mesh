---
title: "Plan revision 2 (superseded)"
description: "Revision 2 of the implementation plan, superseded by the roadmap and kept as history."
noindex: true
llms: false
---

# Plan revision 2 (superseded)

::: callout warning "Superseded"
This is revision 2 of the implementation plan, kept as history because superseded decision records cite it. It does not describe what Mesh will build. The current plan is the [roadmap](./roadmap.md).
:::

Date: 2026-10-04. Author: squad leader `impl-plan`, for the lead `mesh-lead` and the operator
(Saulo Vallory). Status: **revision 2**, after the operator's rulings on the plan's questions
(section 9) and two independent reviews (section 11). Nothing here is built yet except PR #1.

## 0. What this document is, and what it rests on

**Mesh** is a planned TypeScript framework modelled on Ash, the declarative resource framework
for Elixir. One *resource file* declares a piece of data, the operations on it and the rules
around it; Mesh derives types, handlers, database schema, a command-line interface and other
outputs from that file. This plan turns the architecture into ordered milestones that a team of
developers (human or agent) can execute and review one at a time.

"The architecture" means the proposal in Step 3 of the Synthesis (below) as amended by the
operator's rulings of 2026-10-04. the project status file (not published), next steps 1 and 2, records
the architecture as agreed on that date. The project's the project's agent instructions (`CLAUDE.md`) still says the proposal "is
not yet agreed"; that sentence predates the rulings.

Every reference below is a path relative to the Mesh space root (`/Users/svallory/work/mesh`),
and links are relative to this file.

| Short name used below | File | What it is |
|---|---|---|
| **Rulings** | [[rulings of 2026-10-04](../decisions/rulings-2026-10-04.md)](../decisions/rulings-2026-10-04.md) | The operator's binding decisions. Three parts are cited: the table of eight answers to the open design questions ("Ruling 4" means row 4), the "Consequences for the proposal" list, and the "Implementation-plan rulings" table, which answers this plan's own questions ("plan ruling Q3"). It also holds the Elysia ruling and one lead decision. |
| **Synthesis** | [[research synthesis](../research/synthesis.md)](../research/synthesis.md) | Summary of seven research documents on Ash and on TypeScript tools. Its Step 3 (sections 14–19) is the proposed architecture: three rings, an eight-stage build pipeline, an eight-phase run-time lifecycle, and the extension points. |
| **Durable engines** | [[durable engines](../research/durable-engines.md)](../research/durable-engines.md) | Comparison of eleven workflow and job tools, ending in a proposed adapter interface (its section 6), adopted as the contract for M11 and M12 by plan ruling Q14. |
| **PR #1** | <https://github.com/svallory/mesh/pull/1>, report [PR #1](https://github.com/svallory/mesh/pull/1) and its report | The only Mesh code so far: the resource vocabulary written as 26 MX tag contracts, with 103 passing tests. Merged to `main` on 2026-10-04 (commit `bd62652`). |
| **MX notes** | MX project notes, getting-started, MX project notes, updates, Mesh's answers to MX on `mx.contracts`, 2026-10-04 | How Mesh consumes MX, what has landed in MX, and what Mesh told the MX lead. |
| **Old plan** | the first plan of 2026-10-01 (not published) | Written 2026-10-01, before the research. Input only; where it disagrees with the Rulings, the Rulings win. |
| **Status** | the project status file (not published), the team status log of 2026-10-04 (not published) | Where the project stands; this plan is step 7 of the project status file (not published). |

Terms used throughout:

- **MX** is a separate project that parses Marko-syntax files. Mesh resource files are `.mx`
  files. Mesh calls `parseData` from the package `@mxlang/data`, which returns a static tree of
  tags and attributes plus a list of diagnostics; nothing in the file is executed (MX notes,
  getting-started section 1). Mesh never parses `.mx` text itself.
- A **tag contract** (`CustomTag`) tells MX which attributes, children and parents a tag name
  allows. With the option `structural: "reject"`, MX also rejects control flow (`<if>`, `<for>`),
  text and comments, so a resource file can only contain declared tags.
- **Core, adapter, extension** are the three rings of the architecture (Synthesis section 15 and
  the definitions at the top of its Step 2). *Core* is what Mesh cannot work without, at build
  time or at run time. An *adapter* is one replaceable implementation of a contract the core
  owns (a database, a transport). An *extension* is an optional feature built on the core's
  extension points.
- An **action** is one named operation on a resource (create, read, update, destroy). A
  **transport** is whatever lets the outside world call an action: a command line, an HTTP
  server, a job runner.
- The **scope** is the explicit value passed on every action call. In core it has two parts:
  the **actor** (who is calling) and a **context** (extra data for the call). It is never
  ambient (Synthesis section 8, "Do differently", row "Ambient actor and tenant"). Core has no
  notion of a tenant: that belongs to a multitenancy extension, which adds to the scope through
  a declared contribution point (Rulings, "Consequences", second bullet).
- An **actor resolver** is the adapter that produces the scope for a call from whatever the
  transport received (command-line arguments and environment, or an HTTP request). Every
  transport gets its scope this way; core defines no flags and no login (same bullet).
- A **capability** is an optional feature of an adapter (joins, upserts, signals) that the
  adapter declares as static data, so the build can check it without starting the adapter.
- **Drizzle** is an established TypeScript query builder with drivers for SQLite and Postgres;
  **drizzle-kit** is its companion tool that generates SQL migrations from a schema. By plan
  ruling Q3, Mesh's SQL adapters are built on both.

## 1. Summary

1. Sixteen milestones, M0 to M15, in dependency order. M0 to M2 are the **walking skeleton**:
   a `.mx` resource file is parsed, turned into a model, emitted as committed TypeScript, and a
   command-line transport runs its actions against SQLite. Everything after widens that path.
2. The first release ("v1") is M0 to M14: command line only, SQLite and Postgres. The HTTP
   transport, the typed client and OpenAPI (M15) come after (plan ruling Q1/Q13).
3. The package layout is a bun workspace with four core packages (three libraries and the `mesh`
   developer command), and one package per adapter and per extension (section 3).
4. **Established tools first** (plan ruling Q3, the operator's standing position). Section 8.1
   lists, for every place this plan builds something itself, the tool it uses instead or the
   one-line reason no tool fits.
5. All fourteen questions of the first version are decided (section 9.1). This revision raises
   four smaller ones for the lead, each with a recommendation (section 9.2).

## 2. Principles that every milestone is checked against

These come from the Rulings and the Synthesis. A reviewer rejects a milestone that breaks one.

1. **Generated code carries the behaviour; the run-time library stays thin** (Ruling 2). The
   test used in this plan: *the run-time library never reads the resource model.* Every decision
   that depends on the model (which fields are accepted, which checks run, in what order) is made
   at build time and written into the generated file. The reason is in Synthesis section 6, item
   2, and section 8, "Do differently", row "Keeps behaviour in the library": because Ash keeps
   behaviour in the library, stack traces are unhelpful and test coverage of a user's own
   resource reads 0%.
2. **No silent fallback.** A feature the chosen adapter lacks, a tag or attribute the compiler
   does not implement yet, an expression the database cannot run: each is a build error that
   names the file, line and fix (Ruling 4; Synthesis section 8, "Silent fallbacks").
3. **Conservative defaults**: deny unless allowed, accept only listed inputs, private unless
   exposed (Synthesis section 14, goal 4), and atomic unless stated otherwise. Ash reversed every
   permissive default in its 3.0 release, "atomic required by default" among them (Synthesis
   section 6, last paragraph).
4. **"It was in the plan" is never a reason to hardcode something** (the project's agent instructions (`CLAUDE.md`), "Architecture
   in brief"). Each package in section 3 states why it sits in its ring.
5. **Every vocabulary addition follows the PR #1 pattern**: one closed contract per tag name,
   one negative fixture per rule, each asserting the exact message, line and column (PR #1
   report, "How verified").
6. **The committed generated tree is guarded**: the `verify` script regenerates it and fails on
   any difference (Synthesis section 16, stage 8, and section 8, gap 8). `verify` runs locally
   until MX is published and continuous integration (CI) becomes possible (plan ruling Q8).
7. **Rely on established tools; keep application concerns out of core.** Before building
   anything, look for a well-established tool and put it behind a Mesh contract (plan ruling
   Q3). Anything an application decides for itself (how a caller is identified, tenants, login)
   is an adapter or an extension, never core (plan ruling Q4).

## 3. Package layout

A bun workspace in the `svallory/mesh` repository (`worktrees/main`). bun is the package manager
by project rule (the project's agent instructions (`CLAUDE.md`), "Commands"). Package names use the scope `@mesh/` and the command
name `mesh` as working names (plan ruling Q9); nothing is published yet and npm availability was
not checked.

```
packages/
  model/              core       plain-data resource model, vocabulary registries, diagnostics
  compiler/           core       build pipeline, extension host, core emitters
  runtime/            core       thin run-time library: scope, errors, contracts, outbox, worker
  cli/                core       the `mesh` developer command (build, check, inspect, explain)
  frontend-mx/        adapter    .mx files -> declarations, via parseData; core tag contracts
  data-drizzle/       adapter    shared code of the SQL adapters: Mesh queries and expressions -> Drizzle
  data-sqlite/        adapter    data layer on SQLite (file or in-memory), on Drizzle
  data-postgres/      adapter    data layer on Postgres, on Drizzle
  transport-cli/      adapter    runs actions from a command line
  transport-http/     adapter    one Fetch handler per action (after v1)
  actor-dev/          adapter    actor resolver for development and tests
  workflow-inprocess/ adapter    job queue and workflow runner inside the app's own database
  ext-policies/       extension  authorization rules (first-party, on by default)
  ext-workflows/      extension  multi-step operations declared in resource files
  ext-agent/          extension  rules files and agent tools generated from the model
  ext-testing/        extension  generated test data builders and a seed path
  ext-client/         extension  typed client, one function per action (after v1)
  ext-openapi/        extension  OpenAPI document (after v1)
examples/
  blog/               the fixture resources (post, user, comment), grown milestone by milestone
```

### 3.1 Core, and why

Core has a build-time half (`model`, `compiler`, `cli`) and a run-time half (`runtime`). A
deployed application contains only the run-time half.

| Package | Why it is core |
|---|---|
| `model` | Every build-time package reads the resource model, so it cannot be replaced. It holds plain data types only (JSON-serialisable): the resource model, the vocabulary registries (attribute types, expression functions, check kinds) and the build diagnostic type. Synthesis section 8, "Copy from Ash": one registry per vocabulary and a plain-data model that every tool reads. No I/O, no dependency on MX. It imports contract types from `runtime` (the query and expression-tree types), never the other way round. |
| `compiler` | The build pipeline (Synthesis section 16) is what makes Mesh a framework instead of a library. It owns the stage order, the extension host and the emitters that every project needs (types and action handlers). It runs only at build time. |
| `cli` | The `mesh` command is the only entry point to the build pipeline; a project cannot be built or guarded without it. It is a thin shell over `compiler`. It is listed apart because it is easy to confuse with the *command-line transport*: `mesh` builds a project; `transport-cli` lets an application's users run its actions. |
| `runtime` | The small library that generated code imports: the scope type (actor and context), the run-time error classes, the contracts (data layer, transport, actor resolver, job queue, workflow) with the query and expression-tree types that cross them, the transaction helper, the outbox and the worker loop. It is split from `compiler` so a deployed binary does not contain the compiler (the Old plan's goal of a small single binary; Synthesis section 10, "Runtime" row). It imports nothing from `model` or `compiler`, and nothing from Drizzle. |

### 3.2 Adapters, and why

| Package | Contract it implements | Why it is an adapter |
|---|---|---|
| `frontend-mx` | "Front end": files in, declarations with source positions out (Synthesis section 16, stage 1) | The Synthesis ring table puts the authoring syntax in the adapter ring, and names TypeScript declarations as a possible second front end (section 10). The code from PR #1 moves here. Only this front end is built. |
| `data-sqlite`, `data-postgres`, with `data-drizzle` | Data layer (Synthesis section 11, "Data access"; Ruling 4) | A project picks its database. The contract is Mesh's own, at the level of resources, because query libraries disagree on filters, joins and aggregates (Synthesis section 11); "the query library inside an adapter is that adapter's private choice" (same section). That choice is Drizzle (plan ruling Q3). `data-drizzle` holds what the two dialects share and is not usable alone. Drizzle is imported only in these three packages. |
| `transport-cli`, `transport-http` | Transport: turn an outside request into `(action, input)`, obtain the scope from the actor resolver, return a typed result or classed error | Ruling 8: Mesh is not tied to web applications, so no transport is core. The command line is first. |
| `actor-dev` | Actor resolver: transport request in, scope out | How a caller is identified is an application decision (plan ruling Q4), so even the simplest resolver is an adapter. This one serves development and tests; real resolvers (a token check, Better Auth for HTTP) are application or later adapters. |
| `workflow-inprocess` | `JobQueueAdapter` and `WorkflowAdapter` (Durable engines section 6.2) | Ruling 7: workflows run behind an adapter interface and the in-process runner is the first adapter. External engines (DBOS, Temporal, pg-boss for jobs) are later adapters. |

Three adapter slots from the Synthesis ring table (section 15) have no package in v1, on
purpose:

- **Runtime host** (Bun or Node): handled by keeping core on web-standard APIs and putting
  runtime-specific drivers inside data adapters; M14 proves it on Node.
- **Expression parser**: filled by MX. `parseData` already hands each expression over as a
  parsed Babel syntax node (MX notes, getting-started section 1, "`node` is a Babel
  `Expression`"), so Mesh needs no parser of its own while `.mx` is the only front end. This
  closes Synthesis section 8, gap 6, for now.
- **Tracer**: no Mesh contract is needed. Generated code calls the OpenTelemetry API, one of
  the four neutral standards the Synthesis says to use as the contract (section 9); that API
  does nothing until an application installs an OpenTelemetry SDK (see N3 in section 9.2).

### 3.3 Extensions, and why

| Package | Why it is an extension |
|---|---|
| `ext-policies` | The Synthesis (section 10, last paragraph, and the ring table in section 15) makes authorization "a fixed slot in the core lifecycle, filled by a first-party policy extension". A project could fill the slot with something else, so the rules engine is not core; the slot is. It is on by default. PR #1 declares the policy tags next to the core ones; M8 moves them here (section 8, decision D3). |
| `ext-workflows` | Most resources have no multi-step operation. The *contract* a runner implements is core (`runtime`); the tags that declare a workflow and the code generated from them are optional. |
| `ext-agent`, `ext-testing`, `ext-client`, `ext-openapi` | Outputs derived from the model that a project can do without. Each is emitters plus verifiers, which is what the extension points offer (Synthesis section 18). The last two need a wire transport and come with M15. |

Other extensions named in the Synthesis ring table (multitenancy, audit trail, event log, state
machine, soft delete, encryption, rate limits) are not scheduled; section 6 lists them.

## 4. Dependency order at a glance

```
M0 workspace
 └ M1 build skeleton ─ M2 run skeleton               ← walking skeleton ends here
     └ M3 data-layer contract
         └ M4 expressions
             └ M5 action lifecycle, atomic updates
                 ├ M10 migrations, Postgres
                 └ M6 extension host, composed contracts
                     ├ M7 relationships, calculations, aggregates
                     │   └ M8 policies
                     │       ├ M9 bulk actions, identities, upserts
                     │       └ M13 agent and test surface
                     └ M11 outbox, notifiers, jobs
                         └ M12 workflows, in-process runner
 M14 Node parity and single binary: last in v1, after every other v1 milestone
 M15 HTTP transport, typed client, OpenAPI: after v1
```

What can run in parallel: M10 alongside M6 and everything after it; after M6, two more tracks
(M7 → M8 → M9 and M13; M11 → M12). M9 and M13 can run side by side once M8 is done.

**Capability rule across tracks.** A milestone that adds an optional data-layer capability (M5
atomic expressions, M7 joins and aggregates, M9 upserts) implements it in every data adapter
that is merged when the milestone itself is merged. M10 implements, on Postgres, every
capability in the conformance suite on the day M10 is merged. Whichever of two parallel
milestones merges second owes the missing combination. Most of each capability lives in
`data-drizzle`, shared by both dialects, which keeps that debt small. M14 closes any gap:
before v1, SQLite and Postgres must each pass the full suite with all four optional
capabilities.

Sizes: **S** is one pull request; **M** is two to four pull requests; **L** is five or more and
gets its own squad leader, who splits it into tasks. No calendar dates: sizes are scope, not
time.

## 5. Milestones

Each milestone lists goal, scope in and out, packages with their ring, acceptance tests, size
and risks. "Vocabulary" means tag names or attributes added to the resource-file language in
that milestone. "`verify`" is the local script from M0; wherever a test says "checked by
`verify`", it moves to CI unchanged once CI exists.

### M0 — Workspace and conventions (S)

- **Goal.** A repository layout the later milestones can add packages to, with one command
  that runs every check.
- **In scope.** Turn the repository into a bun workspace; move PR #1's `packages/compiler/src/contracts.ts`,
  tests and fixtures into `packages/frontend-mx`. The only edits are the ones the move forces:
  the `mx.contracts` and `mx.target` entries in `package.json` follow the file. One `verify`
  script that runs tests and the type check for every package. A project the project's agent instructions (`CLAUDE.md`) section
  with the commands (PR #1 report, "Instructions updated", lists them). Skeleton
  `examples/blog` holding PR #1's `post.mx`.
- **Out of scope.** Any new behaviour. CI: the MX packages are linked from a local checkout
  (`link:@mxlang/data`, MX notes, getting-started section 2), which a hosted runner does not
  have, and the operator ruled out a self-hosted runner (plan ruling Q8). CI is added when MX
  is published; asking for that is the lead's request to the MX lead (the project's agent instructions (`CLAUDE.md`), "Working
  with MX").
- **Packages.** `frontend-mx` (adapter); workspace root.
- **Acceptance tests.** `bun run verify` passes with the same 103 tests PR #1 has, from a
  clean clone with MX linked.
- **Risks.** With no CI, nothing enforces `verify` except the review protocol: the lead's
  verifier runs it once per delivery before a merge. A merge without that run is the failure
  to watch for.

### M1 — Build skeleton: resource file to model to emitted types (M)

- **Goal.** `mesh build` reads `.mx` files and writes a committed model and TypeScript types.
  Build stages 1, 2, 3, 7 and 8 of Synthesis section 16 exist in their simplest form.
- **In scope.**
  - *Load and check structure* (stages 1–2): `frontend-mx` calls
    `parseData(source, file, { customTags, structural: "reject", unknownTags: "reject" })` with the contracts imported
    directly, not discovered by scanning, so a user's stray local tag file cannot change the
    build (MX notes, mesh-answers, request 1). Diagnostics are printed with file, line and
    column.
  - An undeclared tag at any depth is rejected by MX itself: the `unknownTags: "reject"`
    option landed on MX `main` at `e65707a0` (MX notes, updates, entry for `e65707a0`: "an
    authored tag at any depth with no entry in `customTags` is a positioned error"), closing the gap PR #1's report
    lists under "MX gaps", item 1. One root rule stays Mesh's to enforce: exactly one
    `resource` per file (same report, Round 3, item 2).
  - *Build model* (stage 3): one plain-data document per resource, with source positions kept
    for every element. Scope of the model in M1: resource name, `table` and `domain` (an
    optional grouping name, stored in the model; a resource with a domain gets its generated
    files under `generated/<domain>/<resource>/`, one without under `generated/<resource>/`);
    attributes of the six types PR #1's contracts allow (`string`, `number`, `boolean`,
    `enum`, `uuid`, `datetime`) with `required`, `public` and `default`; `uuid-primary-key`;
    `timestamps`; the four action kinds with `accept` and `defaults`.
  - The MX tag contracts are the source of truth for tag names; the value vocabularies live in
    the core registries (plan ruling Q2). The six attribute type names are read from the type
    registry in `model`; the contract's `type` enum in `frontend-mx` is built from that
    registry, and a test fails if the two lists differ.
  - Cross-file checks that need no extension host: duplicate resource names, `accept` naming an
    attribute that does not exist. These run in a plain "checks" step that M6 turns into the
    Verify stage.
  - *Emit* (stage 7): `generated/model.json` and a `types.ts` per resource (record type, public
    record type, one input type per action). Emitters build text from templates and pass it
    through an established formatter, pinned to an exact version, so output is deterministic:
    same input, same bytes.
  - *Guard* (stage 8): `mesh build --check` regenerates in memory and exits non-zero on any
    difference from the committed files; `verify` runs it. `mesh inspect` prints the model as
    JSON (Old plan, "Agent legibility principles").
  - **Not-implemented rule.** A tag or attribute the contracts accept but the compiler does
    not handle yet is a build error that names it and the milestone that will implement it. In
    M1 that covers `relationships`, `belongs-to`, `has-many`, `change`, `validate`, `filter`,
    `sort`, `policies`, `policy`, `authorize-if`, `calculations`, `calculate`, `value`,
    `aggregates` and `count`. Nothing is ever ignored (principle 2).
- **Out of scope.** Handlers, expressions, the extension host.
- **Packages.** `model`, `compiler`, `cli` (core); `frontend-mx` (adapter).
- **Acceptance tests.** (1) A reduced `examples/blog/post.mx` builds; the emitted types pass
  `tsc --noEmit`. (2) Building twice gives byte-identical output. (3) A hand edit to a generated
  file makes `mesh build --check` fail and name the file. (4) An empty file, a file with two
  resources, a duplicate resource name and an unknown `accept` name each fail with Mesh's
  expected message and position; an unknown top-level tag fails with MX's diagnostic. (5) The full PR #1 fixture fails with the
  not-implemented error for its first unsupported tag. (6) The registry-against-contract drift
  test.
- **Risks.** `parseData` stops at the first error in a file (MX notes, getting-started section
  1: "one error, fail-fast"), so an author fixes structural errors one at a time. Mesh's own
  checks should collect all errors per file to offset that. Emitters cannot build output
  through a TypeScript compiler API, because the TypeScript version PR #1 pins (7.x) has none
  that is stable (Synthesis section 10, "Expression parser" row); hence templates plus a
  formatter, with tests type-checking the result through the `tsc` command.

### M2 — Run skeleton: generated handlers, SQLite, command-line transport (L)

- **Goal.** The walking skeleton, end to end: after `mesh build`, a user runs
  `post create`, `post read`, `post update`, `post destroy` from a shell and the rows are in a
  SQLite file.
- **In scope.**
  - *Generated handlers.* One file per resource with one exported function per action. The
    function body contains the steps in order: validate and cast input (only accepted fields
    pass), open a transaction, call the data layer, commit, return a typed result. Written out
    per action, not a call into a generic `runAction` (principle 1; Ruling 2).
  - *Input validators.* Generated per action as schemas of an established validation library,
    and seen by the rest of Mesh only through Standard Schema, the shared validator interface
    the Synthesis recommends as a neutral contract (section 9; section 10, "Validation" row).
    Mesh writes no cast or validation functions of its own (N1 in section 9.2 names the
    library).
  - *Run-time library.* The `Scope` type (actor and context, nothing else); a first,
    deliberately small data-layer contract (insert, select by primary key, select all, update
    by key, delete by key, transaction); the transport contract; the actor-resolver contract;
    the first run-time error classes (invalid input, not found, forbidden, framework).
    Synthesis section 8 lists an error class hierarchy as a v1 need (gap 4).
  - *Transport contract.* A transport receives a generated **action registry** (for each
    action: name, input validator, handler). For each call it hands what it received to the
    configured **actor resolver** and passes the scope that comes back to the handler; a
    transport never builds a scope itself. The registry is generated data, so the transport
    does not read the model either.
  - *Private unless exposed.* A handler called in process returns the full record. A handler
    called through a transport returns only attributes marked `public`; the registry carries
    the public result type. This gives `public` (already in PR #1's contracts) its meaning.
  - *`transport-cli`.* Maps `<resource> <action> --input <json>` to a handler call. It
    defines no flag about the caller: the remaining arguments and the environment go to the
    actor resolver untouched (Rulings, "Consequences", second bullet; plan ruling Q4). It
    prints the result as JSON on standard output and errors on standard error, with one exit
    code per error class; `--help` is generated from the registry. Arguments are parsed with
    the standard library's `parseArgs`, not a parser of Mesh's own.
  - *`actor-dev`.* The first actor resolver: it returns the actor and context named in a file
    the project config points to. It is for development and tests (N4 in section 9.2). With no
    resolver configured, every transport call fails; there is no default actor.
  - *`data-sqlite` on Drizzle* (plan ruling Q3). The adapter has a build-time half, which
    emits the Drizzle table definitions for the project's resources as a guarded generated
    file, and a run-time half, which implements the data-layer contract with Drizzle over
    Bun's built-in SQLite driver. Tables are created in development with drizzle-kit's schema
    push, wrapped as `mesh db push`; versioned migrations wait for M10. Generated handlers call
    the Mesh contract and never import Drizzle. Exact versions of Drizzle and drizzle-kit are
    pinned in the adapter packages.
  - *Default deny, before policies exist.* Until M8, an action runs only when the project
    config sets an explicit `authorization: "none"` flag; otherwise every call fails as
    forbidden. This keeps principle 3 true from the first runnable build.
- **Out of scope.** Filters, sorting, pagination, expressions, hooks, policies, Node.
- **Packages.** `runtime` (core), `compiler` (core: handler and registry emitters),
  `transport-cli`, `actor-dev`, `data-sqlite`, `data-drizzle` (adapters).
- **Acceptance tests.** (1) An end-to-end test spawns the built example as a child process:
  create, read back, update, destroy, read again gives "not found" with the documented exit
  code. (2) A field not in `accept` is rejected, not dropped. (3) A failing input validation
  produces a stack trace in which the generated handler file is the first frame that is neither
  in `node_modules` nor in a Mesh package (`packages/runtime` and the adapters). (4) An import
  rule checked by `verify`: no file in `runtime` imports `@mesh/model`, `@mesh/compiler` or
  Drizzle; no generated handler imports them or `generated/model.json`; Drizzle is imported
  only under `packages/data-*` and in the adapter-emitted schema file (principles 1 and 7).
  (5) Without the `authorization: "none"` flag every action is forbidden. (6) `mesh build
  --check` covers handlers, registry and the emitted Drizzle schema. (7) A non-public attribute
  is absent from command-line output and present in an in-process call. (8) The scope returned
  by a test actor resolver reaches the handler unchanged; with no resolver configured the call
  fails with a classed error; `transport-cli`'s generated `--help` lists no actor, tenant or
  context flag.
- **Risks.** The first contract shapes (data layer, transport, actor resolver) will change in
  M3 and M5; they are marked unstable until M6. `bun:sqlite` ties the skeleton to Bun until
  M14. Drizzle v1 is a release candidate (Synthesis section 12, risk 1); the mitigation is in
  section 10, risk 3.

### M3 — Data-layer contract and capabilities (L)

- **Goal.** The data-layer contract of Ruling 4, implemented on Drizzle, with a shared test
  suite that every data adapter must pass.
- **In scope.** The **mandatory set**: select, insert, update, delete, transactions, filters,
  sort, pagination. `data-drizzle` translates a Mesh query (plain data) into Drizzle's query
  builder; nothing of Drizzle shows through the contract. A **capability manifest**: static
  data published by each adapter listing the optional capabilities it has (joins, aggregates,
  upserts, atomic expressions), as a closed union of names (Synthesis section 8, "A capability
  probe on the data layer"). The build reads the manifest without starting the adapter. The
  check that fails the build when a resource uses a capability the adapter lacks (Ruling 4:
  "never a silent in-memory fallback") is written here, in the checks step from M1, and first
  exercised by a real consumer in M5. A **conformance suite**: one set of tests every data
  adapter must pass. An **in-memory mode** of `data-sqlite` (SQLite's own `:memory:` database)
  for tests and prototypes, in place of a hand-written in-memory adapter (N2 in section 9.2).
  Read actions implement `sort` (already in PR #1's contracts) and gain pagination, offset and
  keyset (new vocabulary on `read`). Filters in M3 are plain data (field, operator, literal),
  which is also the form a caller supplies at run time; filters written as arrow functions
  arrive in M4.
- **Out of scope.** Joins, aggregates, upserts, atomic expressions (declared, not implemented).
  Postgres (M10).
- **Packages.** `runtime` (core: contract and query types), `compiler` (core: capability
  check), `data-drizzle`, `data-sqlite` (adapters).
- **Acceptance tests.** (1) `data-sqlite` passes the conformance suite in file and in-memory
  mode. (2) A manifest that names a capability outside the closed union fails the build; the
  capability check is unit-tested with a test-only requirement. (3) A transaction that throws
  leaves no row behind. (4) Keyset pagination under concurrent inserts: every row that existed
  when paging began is returned exactly once, and no row is returned twice. (5) The M2 import
  rule still passes: no Drizzle type appears in `runtime`'s contract.
- **Risks.** Until M10 the contract has one real implementation, so nothing proves it is not
  shaped by SQLite. That is why M10 may start as soon as M5 is merged. The contract is the most
  expensive thing to change later: Ash's has 46 callbacks and 47 capability names, applied
  inconsistently (Synthesis section 2.2), which is the failure to avoid.

### M4 — Expressions (L)

- **Goal.** Arrow functions in resource files become either a portable expression tree or an
  emitted TypeScript function, decided at build time (Synthesis section 16, stage 6).
- **In scope.** The expression tree type (in `runtime`, because it crosses the data-layer
  contract) and the registry of functions and operators (in `model`). Conversion from the Babel
  node MX supplies to the tree, in `frontend-mx`. Two classes. **Translatable** expressions
  convert fully to the tree. **Opaque** ones are emitted as TypeScript functions by slicing the
  authored text at the span MX reports (MX notes, getting-started section 1: "slice `span` for
  authored text"; this is copying, not re-parsing). Which class each position needs:
  `filter` (and later `authorize-if` and calculations used in queries) must be translatable,
  or the build fails at the offending node; `validate` is opaque; a `change` is *classified*:
  translatable when its body is only assignments of translatable expressions to the record's
  attributes, opaque otherwise. In M4 every change still runs in process; the classification
  is recorded in the model for M5. Scope rule: a translatable expression may only use its
  declared parameters and registered functions; a free variable is a build error (Synthesis
  section 8, gap 5, on closures). `data-drizzle` compiles the tree into Drizzle's SQL builder
  (plan ruling Q3: "Mesh still compiles its own expression tree into Drizzle's SQL builder").
  A translatable expression has SQL's semantics where SQL and JavaScript differ, and the
  documentation says so (plan ruling Q10). There is no second, in-process evaluator of the
  tree: a translatable expression always runs in the database. `filter` on read actions;
  `validate` with `message`; `change`. A first small function list, documented from the
  registry so documentation cannot drift from it (Synthesis section 8, first "Copy" row).
- **Out of scope.** Relationship traversal in expressions (M7); atomic changes (M5).
- **Packages.** `model`, `compiler`, `runtime` (core); `frontend-mx`, `data-drizzle`,
  `data-sqlite` (adapters).
- **Acceptance tests.** (1) Each registered function and operator has a conformance test with
  written-out expected values, including the null cases; every data adapter must produce them.
  (2) A translatable expression using an unsupported construct fails the build pointing at that
  node. (3) A free variable in a filter fails the build. (4) `post read published` from the
  command line returns only published rows. (5) The M4 example resource, which declares every
  attribute it assigns, has one change that is a single assignment and one with a
  multi-statement body; `model.json` records the first as translatable and the second as
  opaque.
- **Risks.** This is the piece nobody else has built in reusable form (Synthesis section 8, gap
  5); it can grow without limit, so the function list is kept small and documented. Because of
  plan ruling Q10, `===` in a `filter` and in a `validate` can disagree on null; that must be
  taught, and a lint for the common cases is worth adding. AshPostgres went the other way,
  making database semantics match Elixir by installing SQL functions, and paid a 30-fold
  slowdown on one filter (Synthesis section 2.2, last bullet).

### M5 — Action lifecycle and atomic updates (L)

- **Goal.** The eight-phase run-time lifecycle of Synthesis section 17, generated per action,
  with the atomic half of Ruling 3.
- **In scope.**
  - Phases in generated code: enter, cast, plan, pre-check, transaction, data layer, commit,
    after commit. A **plan** chosen once at build time per action and printable with
    `mesh explain <resource> <action>` (Synthesis section 8, "Copy from Ash", row "The onion
    lifecycle").
  - Validations collect all errors. Write hooks before and after the data-layer call inside the
    transaction, and after commit (new vocabulary). **Preparations**: read-side hooks that
    adjust a query before it runs (new vocabulary; Synthesis section 8, gap 4, and section 17,
    phase 3). Action arguments: inputs that are not attributes (gap 4).
  - The **authorizer slot**: one place before the transaction for checks that need no data and
    one place inside it for checks that read data; the Synthesis found Ash authorizes writes in
    six places, one with a check-then-act gap (section 2.2). The slot is empty until M8.
  - **Tracing**: generated handlers emit one span per lifecycle phase (Synthesis section 17,
    phase 8, and section 10, "Observability") through the OpenTelemetry API, which does
    nothing unless the application installs an SDK.
  - **Atomic single-record updates.** A change classified translatable in M4 is folded into
    the `UPDATE` statement, using the `atomic-expressions` capability. Update and destroy
    actions are **atomic by default** (principle 3): an action with an opaque change, or with a
    validation that reads the stored record, cannot be folded into one statement and must say
    `atomic=false` (new attribute on `update` and `destroy`); it then reads and writes inside
    one transaction. Without `atomic=false` such an action is a build error, never a silent
    read. The example's `publish` action validates `post.title`, so the example's copy of
    `post.mx` gains `atomic=false` on it in this milestone, as does every update or destroy
    in the examples and test resources from earlier milestones that has an opaque change (the
    M4 example among them). `explain` shows which strategy the action got. A change is never
    run twice (Synthesis section 8, "Do differently", row 2, on Ash bug #2969).
  - The full run-time error class hierarchy. Where a declared rule can fail at run time, the
    generated code carries the resource-file position as data, so the error names the `.mx`
    line. No source maps in v1 (plan ruling Q11).
- **Out of scope.** Bulk actions (M9); policies (M8); notifications (M11).
- **Packages.** `compiler`, `runtime`, `model` (core); `frontend-mx` (adapter: new vocabulary);
  `data-drizzle`, `data-sqlite` (adapters: atomic expressions).
- **Acceptance tests.** (1) Two concurrent atomic increments of one row both apply. (2) An
  update with an opaque change, and one with a validation that reads the record, each fail the
  build without `atomic=false`; with it, the build passes and `explain` says "read then
  write". (3) An atomic change on a fake adapter without the capability fails the build with
  the resource-file position (the first real use of the M3 check). (4) `mesh explain` output
  for every action in the example is committed and guarded like generated code. (5) A hook that
  throws inside the transaction rolls the write back. (6) With a test OpenTelemetry SDK
  installed, one call produces the eight phase spans in order; with none installed, no error.
  (7) A preparation that adds a filter changes the rows a read returns. (8) The M2 import rule
  still passes.
- **Risks.** Ruling 2 is tested hardest here: the temptation is to move the lifecycle into
  `runtime`. Generated handlers will be long; they must stay readable ("generated code is
  boring", Old plan). If a pattern repeats in every handler, the fix is a small pure helper in
  `runtime` that takes values, never the model. Telemetry cost Ash 15–23% of a create
  (Synthesis section 6, item 7); the cost of the spans with no SDK installed must be measured.

### M6 — Extension host and composed contracts (L)

- **Goal.** Extensions can add vocabulary, transform the model, verify it, emit files and
  supply run-time behaviour, through one typed manifest; Ruling 5 and the composed-contracts
  decision are enforced.
- **In scope.**
  - The **manifest** (Synthesis section 18). Build-time points: tags added; model transforms
    and the named phase each runs in; verifiers; emitters; expression functions; attribute
    types; tooling hooks (an extension may add a `mesh` subcommand); what the extension
    requires from adapters; the **contribution points** it publishes and the points of other
    extensions it contributes to. An attribute type entry names its validator and its column
    type per data adapter. An expression function entry names its implementation per data
    adapter; the build wires these into generated code, so no adapter imports `model`, and a
    function with no implementation for the configured adapter is a build error. Run-time
    points: named, reusable changes, validations, preparations and calculations that a
    resource file refers to by name, and notifiers and policy checks (the last two are declared
    here and first used in M11 and M8). Transports, data layers and actor resolvers are
    adapters and are named in the project config, not in a manifest.
  - **Core's own contribution point for the scope.** An extension may declare typed fields it
    adds to the scope's context and the resolver output it needs for them. This is how a
    multitenancy extension will carry a tenant without core knowing the word (plan ruling Q4).
  - **Named phases** with a hard error on a cycle and a printed order (Synthesis section 16,
    stage 4; Ash's silent ordering failures are in section 2.1). The checks step from M1
    becomes the Verify stage; a verifier failure stops the build (stage 5).
  - **Ruling 5**: a transform that writes to a part of the model owned by another extension
    without a declared contribution fails the build.
  - **Composed contracts** (Rulings, "Lead decisions"): the tag contracts handed to `parseData`
    are composed in memory from core plus enabled extensions, and `mesh build` also writes one
    self-contained contracts module for MX tooling, named in `package.json#mx.contracts` (MX
    notes, mesh-answers, Q3 and Q7). Because that module contains `analyze` functions, it is
    produced with an established bundler, not by printing.
  - The core and data-adapter emitters from M1–M5 are re-registered through the same emitter
    interface. Contracts from M2–M5 are declared stable here.
- **Out of scope.** Loading extensions by discovery: an extension takes part only where the
  project config names it (MX notes, mesh-answers, Q10). A strictness setting for verifiers:
  they are always fatal (section 6).
- **Packages.** `compiler`, `model`, `runtime` (core); `frontend-mx` (adapter: composition).
- **Acceptance tests.** (1) A test extension adds a child tag to `resource` through a declared
  contribution point; the composed contract accepts it; with the extension disabled the same
  file fails. (2) An undeclared cross-extension write fails the build and names both
  extensions. (3) A phase cycle fails the build and prints the cycle. (4) The generated
  contracts module loads through MX's own scan and yields the same tag names as the in-memory
  composition (PR #1 has this test for the static module). (5) It is under the guard. (6) A
  test extension supplies a custom attribute type, an expression function and a named change;
  a resource file uses all three and the example runs on `data-sqlite`; against a fake adapter
  the function has no implementation for, the build fails. (7) A test extension adds a typed
  field to the scope through the scope contribution point; a handler reads it with its type; a
  resolver that does not supply it fails the call with a classed error.
- **Risks.** This is the widest milestone; its squad leader should split build-time and
  run-time points into separate tasks. Bundling the contracts module leans on Bun's built-in
  bundler; on Node another bundler is needed (noted for M14). MX's editor support for data
  files is deferred (MX notes, getting-started section 1), so the generated module has no
  consumer until MX ships that; the in-memory composition is what the build depends on.

### M7 — Relationships, calculations, aggregates (L)

- **Goal.** Resources refer to each other, and derived values can be queried.
- **In scope.** `belongs-to`, `has-many` (already in the contracts), `has-one` (new). A
  `belongs-to` adds its foreign-key attribute to the model (the fixture's `authorId`).
  Cross-file verification: unknown resource names and inverse relationships (PR #1 report, "Out
  of scope"), and cycles (Old plan, pipeline stage 4). Loading related records by explicit
  request. Relationship traversal in translatable expressions, using the `joins` capability.
  Mesh compiles relationships to joins itself and does not use Drizzle's relations API, which
  is being replaced (Synthesis section 12, risk 1). `calculate` with a translatable value (in
  the query) or an opaque value (after load, never usable in a filter). `count` and the other
  aggregates, using the `aggregates` capability. Both capabilities implemented in every merged
  data adapter (section 4, capability rule).
- **Out of scope.** `many-to-many` and join resources; managing related records inside a
  write action (section 6).
- **Packages.** `model`, `compiler` (core); `frontend-mx`; data adapters.
- **Acceptance tests.** (1) The example's `post.mx` (PR #1's fixture with `atomic=false` on
  `publish`, see M5) without its `policies` block, plus new `user` and `comment` resources,
  builds with no not-implemented error. (2) Reading a relationship that was not requested is a
  type error in generated code, and a load that cannot be done is a run-time error, never
  silently ignored (Synthesis section 6, item 7). (3) An opaque calculation used in a filter
  fails the build. (4) Aggregates pass the conformance suite on every merged adapter. (5) A
  relationship to an unknown resource fails the build at the tag.
- **Risks.** `has-one` over a many-row match: Ash silently truncates (Synthesis section 6,
  item 7); Mesh must define the rule (an identity on the foreign key, checked at build time).

### M8 — Policies extension, simple tier (L)

- **Goal.** Authorization as declared data, per Ruling 6.
- **In scope.** Move the policy tags (`policies`, `policy`, `authorize-if`) out of the core
  contracts into `ext-policies`, contributed through the M6 mechanism, and add `forbid-if`
  (new vocabulary) so that checks can deny as well as allow. Ordered checks per action or
  action type; no matching policy means forbidden. A verifier that a policy's `action` names a
  real action (PR #1 report, "Out of scope"). **Read policies become query filters**, so a
  forbidden row is simply absent. Write policies run in the M5 authorizer slot; a write check
  that needs the record is run as a query inside the transaction. A **structured breakdown**:
  for any decision, which policies applied, which check decided, and why (Synthesis section
  2.2 calls Ash's breakdown "the best debugging tool in the framework"). A `can` function per
  action that answers "may this actor do this" without doing it. The policy is kept as a
  boolean formula in the model so a solver can be added later (Ruling 6). The M2
  `authorization: "none"` flag stops being needed; it stays as an explicit option.
- **Out of scope.** A solver; field-level policies (Synthesis section 8, gap 4, "likely
  deferrable"); bypass rules, policy groups and Ash's three access types (section 6).
- **Packages.** `ext-policies` (extension); `compiler`, `runtime` (core: slot only).
- **Acceptance tests.** (1) The example's policies: a non-author cannot publish; a reader sees
  only published posts and their own. (2) A resource with no policy for an action forbids it.
  (3) The breakdown for a denied call is asserted as data, not as text. (4) A policy expression
  that cannot be translated to a filter fails the build on a read action. (5) The policy
  formula round-trips through `model.json`. (6) The example's full `post.mx` (PR #1's fixture
  with `atomic=false` on `publish`) now builds with no not-implemented error. (7) A policy
  naming an action that does not exist fails the build.
- **Risks.** The line between a check that needs data and one that does not decides where it
  runs; the build must classify it and `explain` must show it. Established authorization tools
  were inventoried, not compared (Synthesis section 13); Ruling 6 fixes the first tier as
  Mesh's own, and section 8.1 says why.

### M9 — Bulk actions, identities, upserts (M)

- **Goal.** The bulk half of Ruling 3 and the unique-key features the Synthesis lists as v1
  needs (section 8, gap 4).
- **In scope.** Bulk create, update and destroy with the per-record **stream** strategy: each
  record goes through the full lifecycle, with its changes, hooks and policies, and the result
  reports per-record success or error (Synthesis section 2.2: only this strategy keeps
  per-record behaviour). One transaction per record by default, with an explicit
  all-or-nothing option, shown in `explain` (plan ruling Q12). Identities (declared unique
  keys; new vocabulary) and upserts on an identity, using the `upserts` capability. A `--stdin`
  mode in `transport-cli` that streams records in and results out.
- **Out of scope.** The batched-atomic strategy (Ruling 3: "comes later").
- **Packages.** `compiler`, `runtime` (core); `frontend-mx`, `transport-cli`, data adapters.
- **Acceptance tests.** (1) A bulk update of 1,000 rows where 3 fail validation changes 997 and
  reports 3 positioned errors; with the all-or-nothing option it changes none. (2) Policies
  apply per record. (3) An upsert on an adapter without the capability fails the build.
  (4) Streaming 100,000 records: peak memory is within 20% of the peak for 1,000 records.
  (5) An identity produces a unique index in the emitted Drizzle schema, and in a generated
  migration once M10 is merged.
- **Risks.** A long stream of per-record transactions is slow on SQLite; the all-or-nothing
  option is also the fast path, which may tempt users into it for the wrong reason.

### M10 — Migrations and Postgres (M)

- **Goal.** A production database and a safe way to change its schema (Postgres is in v1 by
  plan ruling Q1/Q13). May start as soon as M5 is merged.
- **In scope.** **Migrations by drizzle-kit** (plan ruling Q3): `mesh migrate generate` runs
  drizzle-kit over the adapter-emitted Drizzle schema and commits the SQL migration it writes;
  drizzle-kit owns the snapshot and the diff. Migrations are generated and reviewed, never
  applied automatically (Old plan, "Risks", last row); `mesh migrate apply` is an explicit
  command. Replaces the M2 `mesh db push` shortcut for anything but throwaway databases. One
  Mesh addition on top: before calling drizzle-kit, `mesh migrate generate` compares the old
  and new model and refuses a destructive or ambiguous change (drop a column, change a type,
  rename, make an existing column required) unless a flag names it, because an interactive
  prompt cannot be answered by an agent or a script. `data-postgres` on Drizzle, passing the
  conformance suite as it stands when M10 is merged (section 4, capability rule); almost all of
  it is `data-drizzle` plus a driver and dialect differences.
- **Out of scope.** Data migrations; automatic handling of renames.
- **Packages.** `cli` (core: the `migrate` commands), `data-postgres`, `data-sqlite`,
  `data-drizzle` (adapters).
- **Acceptance tests.** (1) Add an optional column, add a resource: each generates the expected
  migration for both dialects. (2) A destructive or ambiguous change fails with instructions
  unless its flag is given. (3) Postgres passes the conformance suite locally. (4) Applying
  the generated migrations to an empty database gives the same schema as `mesh db push`.
- **Risks.** drizzle-kit is mid-rewrite (Synthesis section 10, "Migrations" row); see section
  10, risk 3, for the mitigation. How drizzle-kit behaves without a terminal on an ambiguous
  change has **not been checked**; the first task of M10 is to test it, and the Mesh pre-check
  above exists so that the answer does not block the milestone. Local Postgres tests need a
  server or an embedded Postgres on the developer's machine; which one is a task for M10's
  squad leader.

### M11 — Outbox, notifiers and jobs (M)

- **Goal.** Events and background work that commit together with the data they describe.
- **In scope.** The **outbox**, in core (plan ruling Q7): a `mesh_outbox` table written in
  the action's transaction and a relay that delivers rows after commit, at least once (Durable
  engines section 6.1, item 4). A row older than the engine's dedupe window is refused with an
  operator error, not delivered (same ruling). Notifiers: after-commit events per action. The
  `JobQueueAdapter` contract in `runtime` (Durable engines section 6.2, adopted by plan ruling
  Q14) and its implementation in `workflow-inprocess`: running an action in the background,
  with retry, delay and a dedupe key. Job capabilities checked at build time like data-layer
  ones. Mesh's own tables are declared to the data adapter like a resource's, so they are in
  the emitted Drizzle schema and in migrations. The **worker loop** (relay plus `work()` of the
  configured adapters) lives in `runtime`, so an application with any transport, or none, can
  run it; `transport-cli` only exposes it as a `worker` command. A job runs under the scope
  that enqueued it, stored with the job; it does not pass through an actor resolver again.
  The in-process job queue declares `enqueueInTransaction: true`, so its enqueues join the
  action's transaction and never pass through the relay (Durable engines section 6.1, item 6).
  The relay exists for adapters that cannot do that, and for notifiers.
- **Out of scope.** Multi-step workflows (M12); external queues (section 6: pg-boss is the
  first candidate).
- **Packages.** `runtime` (core), `workflow-inprocess` (adapter), `transport-cli` (adapter).
- **Acceptance tests.** (1) An action that enqueues a job and then fails leaves no job behind.
  (2) Against a test adapter that declares `enqueueInTransaction: false` and a finite dedupe
  window: a relay killed between delivery and acknowledgement delivers again and the job runs
  once; a row older than the window is refused with an operator error. (3) A job runs with the
  scope that enqueued it. (4) A notifier fires only after commit and not at all on rollback.
- **Risks.** A second process (the worker) sharing a SQLite file needs care with locking. The
  relay's only v1 consumers are notifiers and a test adapter; its real test is the first
  external adapter.

### M12 — Workflows extension and in-process runner (L)

- **Goal.** Multi-step operations declared in resource files, running on the first adapter of
  Ruling 7.
- **In scope.** The `WorkflowAdapter` contract of Durable engines section 6.2 with its rules
  6.1 and 6.3 (plan ruling Q14), with one change: its context type drops the `tenant` field,
  because core has no tenant (plan ruling Q4); a tenant travels as an extension's scope field.
  Workflow tags (new vocabulary, contributed by `ext-workflows`); loops use step families
  only, no `for-each` or `parallel` tags (plan ruling Q5). Generated code: each declared step
  is a top-level named function and the workflow body calls steps by name (Durable engines
  section 6.1, item 2). **Verifier rules** from its section 6.3: step, sleep, signal and child
  names unique and declared; the body deterministic. The in-process runner with its journal
  tables in the app's database; per the document's section 6.4 it declares every capability
  true, including `stepInTransaction`, so a step's writes and its checkpoint commit together.
  **Rule R3** (its section 6.1, item 5) is for adapters that cannot do that: each action a step
  calls records an effect key in a `mesh_step_effects` table inside its own transaction, so a
  step that runs twice applies its effect once. R3 is built in core now, because it shapes the
  generated step code, and tested with a test adapter (plan ruling Q14, option (a)). Workflow
  capabilities checked at build time. The guard hashes each released workflow's generated
  body, step names and step-function inputs (its section 6.6) and fails when the hash changes
  without a **version entry**: a line in a committed file recording the old hash, the new hash
  and what happens to runs in flight. No automated migration of running workflows (plan
  ruling Q6).
- **Out of scope.** DBOS, Temporal and other external adapters.
- **Packages.** `ext-workflows` (extension), `workflow-inprocess` (adapter), `runtime` (core:
  contract, R3).
- **Acceptance tests.** (1) A three-step workflow killed after step two resumes and does not
  re-run steps one and two. (2) Against a test adapter that declares `stepInTransaction:
  false`: a step that calls an action, killed after the action commits and before the step is
  recorded, applies the action once. (3) A workflow using signals built against a fake adapter
  with `signals: false` fails the build. (4) Cancel from a second process stops a running
  workflow between steps. (5) Start from the command line with no HTTP server anywhere
  (Ruling 8). (6) Changing a released workflow's body without a version entry fails
  `mesh build --check`.
- **Risks.** The in-process runner's design is "a design claim; no code exists yet" (Durable
  engines section 6.4), and it is the largest thing in this plan that Mesh builds where
  established engines exist; Ruling 7 orders it first, and section 8.1 records why no engine
  can take its place in v1. Compensation and undo for sagas (Synthesis section 4, "Sagas") are
  not in the adapter interface and need vocabulary design in this milestone.

### M13 — Agent and test surface (M)

- **Goal.** The outputs that make a Mesh project legible to coding agents and easy to test
  (Synthesis section 14, goal 6).
- **In scope.** `ext-agent`: a generated rules file describing the project's resources and the
  Mesh vocabulary, and each action exposed as an agent tool, served with the official Model
  Context Protocol SDK, that obtains its scope from the configured actor resolver like any
  transport, so policies still apply (Synthesis section 5, item 6). `ext-testing`: test data
  builders derived from each resource, built on an established generator library, and a seed
  path that writes rows without running actions (Synthesis section 4, "Testing"). Error
  messages audited against "errors name the fix".
- **Out of scope.** Measuring agent performance: Ruling 1 says the measurement is not a gate.
- **Packages.** `ext-agent`, `ext-testing` (extensions).
- **Acceptance tests.** (1) The rules file is generated, committed and guarded. (2) An agent
  tool call by an actor without permission is denied with the policy breakdown. (3) A generated
  builder produces a record that passes the resource's own validations.
- **Risks.** The agent-tool protocol is a transport in its own right; it must use the M2
  transport and actor-resolver contracts, not a side door.

### M14 — Node parity and single binary (M)

- **Goal.** The runtime adapter promise: Mesh runs on Bun and on Node (the project's agent instructions (`CLAUDE.md`)). Last
  milestone of v1, because it runs every other milestone's tests.
- **In scope.** The whole test suite on Node. A Node SQLite driver inside `data-sqlite`
  (`better-sqlite3` does not run on Bun, so drivers are per runtime: Synthesis section 10,
  "Runtime" row). The build tool on Node, including the contracts bundling step from M6. A
  single-binary build of the example with `bun build --compile`, with its idle memory measured
  (unmeasured so far: Synthesis section 12, risk 5).
- **Out of scope.** Deno and edge runtimes; a memory target (the number is recorded, not
  gated).
- **Packages.** All; mainly `data-sqlite` (adapter) and `cli` (core).
- **Acceptance tests.** (1) `verify` green under Bun and under Node. (2) The compiled binary
  runs the M2 end-to-end test. (3) A `verify` check that `runtime` uses no Bun-only API.
  (4) `data-sqlite` and `data-postgres` each pass the full conformance suite with joins,
  aggregates, upserts and atomic expressions (section 4, capability rule).
- **Risks.** Tests are written for Bun's test runner (PR #1 uses it), which does not run under
  Node; M14 must either run the suites through a runner that works on both or drive a
  Node-built example from Bun's runner. Deciding that at M0 instead would be cheaper; it is
  flagged for the M0 squad. Under Node, MX tools need a restart after a contracts module
  changes unless it is emitted as `.cjs` (MX notes, updates, 2026-10-03 19:51).

### M15 — HTTP transport, typed client, OpenAPI (L, after v1)

- **Goal.** The second transport, built on the generic contract the command line proved.
- **In scope.** `transport-http`: one Fetch handler `(Request) => Response` per action
  (Synthesis section 9). It obtains the scope from the same actor-resolver contract as the
  command line, given the request. Then mounting inside Elysia as an adapter over the same
  handlers (Rulings, "Elysia": a candidate HTTP adapter once the generic contract exists).
  `ext-client`: a typed client with one function per action and per-action permission metadata
  (Synthesis section 8, "Do differently", row "Client with no authorization metadata").
  `ext-openapi`: an OpenAPI document, derived from the generated validators with an established
  converter.
- **Out of scope.** JSON:API, GraphQL, authentication strategies (an actor resolver built on
  an established library such as Better Auth is a later adapter).
- **Packages.** `transport-http` (adapter), `ext-client`, `ext-openapi` (extensions).
- **Acceptance tests.** (1) The M2 end-to-end scenario passes over HTTP with no change to
  generated handlers. (2) The same handlers mounted in Elysia pass it too. (3) The client's
  types reject an input field not in `accept` at compile time. (4) The client's permission
  metadata matches `can` for a sample of actors. (5) The OpenAPI document validates against
  the OpenAPI schema and is guarded.
- **Risks.** Elysia's plugin model was read from documentation, never tested (Synthesis
  section 13).

## 6. Not scheduled

Listed so that their absence is a decision, not an oversight. Each has a one-line reason.

| Item | Source | Why not now |
|---|---|---|
| Batched-atomic bulk strategy | Ruling 3 | The ruling defers it |
| Policy solver | Ruling 6 | The ruling defers it; the formula is kept |
| Bypass rules, policy groups, access types (`strict`, `filter`, `runtime`), field policies | Synthesis sections 1 and 8 | Simple tier first (Ruling 6); access types are a "Copy" recommendation worth revisiting after M8 |
| External workflow adapters (DBOS first, then Temporal) | Durable engines section 7 | DBOS's worker must be tested on Bun before it is chosen |
| pg-boss as a job-queue adapter | Durable engines section 7 | The first external job adapter once Postgres is in; it enqueues in the caller's transaction and documents Bun support. Not in v1 only because v1 must also work on SQLite |
| Multitenancy extension | Synthesis section 15; plan ruling Q4 | An extension; M6 gives it the scope contribution point it needs |
| Generic actions (Ash's fifth action type) | Synthesis section 1; Old plan, open questions | The tag shape is undecided; an opaque step in a workflow covers the first needs |
| `many-to-many`, join-resource options, managing relationships in a write | Synthesis section 1 (relationships row) and section 8, gap 4 | Join-resource options are deferrable per gap 4; the other two depend on them and no v1 example needs them |
| Embedded resources, `NewType`, manual actions | Synthesis section 8, gap 4 | Deferrable per gap 4 |
| Audit trail, event log, state machine, soft delete, encryption, rate limits | Synthesis section 15 | Extensions; none blocks the core |
| A hand-written in-memory data adapter | Synthesis section 10, "Data layer" row | SQLite's in-memory mode covers tests and prototypes (N2) |
| GraphQL, admin interface | Synthesis section 8, "Do not build yet" | Explicitly deferred there |
| JSON:API | Synthesis section 13 | No TypeScript library for it was evaluated; it needs the HTTP transport first |
| A second front end (TypeScript declarations) | Synthesis section 10 | No user for it yet (plan ruling Q2) |
| `mesh watch` | Old plan, compiler pipeline | Convenience; `mesh build` is fast enough to start |
| Verifier strictness as a setting | Synthesis section 8, "Do differently" | Verifiers are always fatal in v1, the strict end of that recommendation |
| Staged migration flags with a named removal version | Synthesis section 8, "Copy" | Needed at the first breaking release, not before |
| Source maps from generated code to resource files | Old plan, pipeline stage 7 | Plan ruling Q11: embedded positions in v1; revisit at M14 |
| Continuous integration | Plan ruling Q8 | Waits for MX to be published |

## 7. Traceability: ruling to milestone

| Ruling (Rulings file) | Where it lands | How it is checked |
|---|---|---|
| 1. No measurement gate | No milestone measures agents; M13 scope says so | Nothing blocks on a measurement |
| 2. As much generated logic as Ash, or more; thin engine | M2 (generated handlers), M5 (generated lifecycle), every later milestone | Import rule (M2 test 4); stack-trace test (M2 test 3) |
| 3. Atomic single-record updates and bulk `stream` in v1; batched-atomic later | M5 (atomic), M9 (bulk stream); section 6 (batched-atomic) | M5 tests 1–3; M9 tests 1–2 |
| 4. Mandatory data-layer set; other capabilities declared; missing one is a build error | M3 (set, manifest, check); M5, M7, M9 (atomic expressions; joins and aggregates; upserts) | Conformance suite; fake-adapter build failures (M5 test 3, M9 test 3) |
| 5. Cross-extension contributions only through declared points | M6 | M6 tests 1–2 |
| 6. Simple policy tier, solver-ready | M8 | M8 tests 1–7; formula kept in the model |
| 7. Workflow adapter interface from the engine comparison; in-process runner first | M11 (outbox, jobs), M12 (interface, runner) | M11 and M12 tests; capabilities checked at build time |
| 8. First transport is a command line; Mesh not tied to web applications | M2 (`transport-cli`, generic transport contract); M12 test 5 | End-to-end test with no HTTP anywhere |
| Elysia is not core; later HTTP adapter | M15, after v1 | M15 test 2 |
| Consequence 1: the first "server and API protocol" adapter is a CLI transport | M2 | M2 test 1 |
| Consequence 2: every transport, the CLI included, obtains the scope through the actor-resolver adapter contract; core defines no flags, no tenant, no login; tenant belongs to the multitenancy extension | M2 (contract, `actor-dev`, scope = actor and context); M6 (scope contribution point); M12 (contract without `tenant`) | M2 test 8; M6 test 7 |
| Consequence 3: the durable-engines research feeds the jobs and workflows adapter contract | M11, M12 | M11 and M12 tests |
| Lead decision: one generated, self-contained `mx.contracts` module from core plus enabled extensions | M6 | M6 tests 1 and 4 |
| Plan ruling Q1/Q13: v1 = M0–M14, command line only, SQLite and Postgres | Section 1; M10; M15 after v1 | M14 test 4 |
| Plan ruling Q3: established tools; Drizzle and drizzle-kit behind the data-layer contract; Mesh compiles its expression tree into Drizzle's builder | M2, M3, M4, M10; section 8.1 | M2 test 4 (isolation); M3 test 5; M10 tests |
| Plan ruling Q4 (withdrawn question): no application concerns in core | Principle 7; M2; M6 | M2 test 8; M6 test 7 |
| Plan ruling Q8: local build and test, no CI until MX is published | M0; principle 6 | M0 test |
| Plan rulings Q2, Q5–Q7, Q9–Q12, Q14 | M1 (Q2); M12 (Q5, Q6, Q14); M11 (Q7, Q14); section 3 (Q9); M4 (Q10); M5 (Q11); M9 (Q12) | The tests of those milestones |

## 8. Decisions made in this plan, and why

These are the squad leader's choices where the inputs left room. The lead or operator may
overrule any of them.

- **D1. The walking skeleton uses a SQLite file.** A command line starts a new process per
  call, so an in-memory store would lose every row between `create` and `read`.
- **D2. Core is split by when the code runs.** `compiler` and `model` at build time, `runtime`
  in the deployed application. Types that cross a run-time contract (scope, errors, query and
  expression tree) live in `runtime`, so the deployed half depends on nothing from the build
  half and the import rule in M2 can be checked mechanically.
- **D3. Policy tags move from the core contracts to `ext-policies` in M8.** The Synthesis
  (sections 10 and 15) makes policies a first-party extension. Moving real tags through the
  contribution mechanism is also the best test of that mechanism.
- **D4. The extension host comes after the lifecycle (M6 after M5), not first.** Building the
  host before there is a pipeline to extend would mean guessing its needs. The cost is that
  M1–M5 contracts are unstable until M6, which is stated in M2.
- **D5. A tag or attribute that is valid but not implemented is a build error.** PR #1's
  contracts already accept the whole vocabulary; the compiler grows into it milestone by
  milestone. Silently ignoring a `policies` block would be the worst kind of fallback.
- **D6. Default deny holds from M2**, through an explicit opt-out flag, instead of arriving
  with policies in M8.
- **D7. Opaque expressions are emitted by slicing authored text at MX's span.** MX documents
  this use. It is not re-parsing, which the project forbids.
- **D8. Relationships come before policies (M7 before M8).** The example's policies compare
  `post.authorId` with the actor, and `authorId` exists only through `belongs-to`.
- **D9. Updates and destroys are atomic by default**, with `atomic=false` as the stated
  exception. It follows principle 3 and the direction Ash 3.0 took.
- **D10. `public` means "may leave through a transport".** In-process callers get the full
  record. This is the smallest reading of "private unless exposed" that can be tested in M2.
- **D11. Drizzle is confined to the `data-*` packages and the schema file they emit.**
  Generated handlers call Mesh's contract. A project can change database, or Mesh can change
  query library, without touching handlers; the import rule enforces it.
- **D12. Postgres stays in M10 but may start after M5**, so the data-layer contract meets its
  second dialect as early as the team can staff it.
- **D13. Mesh does not use Drizzle's relations API.** Relationships compile to joins in
  `data-drizzle`. The relations API is the part of Drizzle being rewritten.

### 8.1 Build or reuse

Plan ruling Q3 asks for established tools wherever possible. For each thing this plan could
have built itself:

| Need | Decision | Tool, or the one-line reason to build |
|---|---|---|
| SQL queries, drivers, type mapping | **Reuse** | Drizzle (plan ruling Q3) |
| Schema migrations: snapshot and diff | **Reuse** | drizzle-kit (plan ruling Q3); Mesh adds only a refusal of destructive changes without a flag |
| In-memory database for tests | **Reuse** | SQLite's `:memory:` mode through `data-sqlite` (N2); was a hand-written adapter in revision 1 |
| Input validation and casting | **Reuse** | An established validation library behind Standard Schema (N1); was Mesh's own cast functions in revision 1 |
| Tracing | **Reuse** | OpenTelemetry API (N3); was a Mesh tracer contract in revision 1 |
| Formatting emitted code | **Reuse** | An established formatter, pinned; was a Mesh printer in revision 1 |
| Command-line argument parsing | **Reuse** | The standard library's `parseArgs` |
| Bundling the contracts module | **Reuse** | Bun's bundler; another established bundler on Node |
| Agent tools | **Reuse** | The official Model Context Protocol SDK |
| Test data generation | **Reuse** | An established generator library under the generated builders |
| OpenAPI document | **Reuse** | A converter from the validation library's schemas |
| Parsing `.mx` and expressions | **Reuse** | MX (`parseData`, Babel nodes) |
| Test runner, type checker | **Reuse** | Bun's test runner, `tsc` |
| Expression tree and its compilation to Drizzle | **Build** | Nothing reusable exists (Synthesis section 8, gap 5); plan ruling Q3 says Mesh compiles its own tree |
| Build pipeline, extension host, emitters, guard | **Build** | This is Mesh itself; Synthesis section 16 |
| Generated action lifecycle | **Build** | Ruling 2: the behaviour must be in generated code |
| Policy engine, simple tier | **Build** | Ruling 6 fixes the tier; it must turn a policy into a query filter over Mesh's own expression tree, which needs the tree, not an external rule engine. Established authorization tools were inventoried, not compared (Synthesis section 13) |
| Outbox and relay | **Build** | It must commit in the action's own transaction through Mesh's data-layer contract; small (one table, one loop) |
| In-process job queue and workflow runner | **Build** | Ruling 7 orders the in-process runner first. No compared engine runs on SQLite without a server: DBOS and pg-boss need Postgres, the rest need a server or a cloud (Durable engines section 3). They come as adapters after v1 |
| Conformance suite, capability manifest | **Build** | They test and describe Mesh's own contract |

## 9. Questions

### 9.1 Decided

All fourteen questions of revision 1 are answered in the Rulings, "Implementation-plan rulings".

| # | Question | Decision | By |
|---|---|---|---|
| Q1, Q13 | Where is the v1 line; is Postgres in v1? | v1 = M0–M14, command line only, SQLite and Postgres; HTTP (M15) after | Operator |
| Q2 | Source of truth for the tag vocabulary | The MX contracts, for tag names; value vocabularies in the core registries, with a drift test | Lead (recommended option) |
| Q3 | Drizzle, or SQL printed by Mesh? | **Reversed from the plan's recommendation.** Drizzle for queries, drizzle-kit for migrations, behind Mesh's contract; established tools wherever possible | Operator |
| Q4 | How does the command line establish actor, tenant and context? | **Withdrawn.** The question itself put application concerns in core. Scope = actor and context, from an actor-resolver adapter; no flags, tenant or login in core | Operator |
| Q5 | Loops in workflows | Step families only | Lead (recommended option) |
| Q6 | Running workflows when code changes | The guard fails without a version entry; no automated migration | Lead (recommended option) |
| Q7 | Outbox placement; stale relay rows | Core; stop and alert | Lead (recommended option) |
| Q8 | CI without a published MX | No CI until MX is published; build and test locally | Operator |
| Q9 | Names `@mesh/*` and `mesh` | Kept as working names | Lead (recommended option) |
| Q10 | Expression semantics where SQL and JavaScript differ | SQL's, documented | Lead (recommended option) |
| Q11 | Source maps or embedded positions | Embedded positions in v1; revisit at M14 | Lead (recommended option) |
| Q12 | Bulk transaction default | Per record, all-or-nothing as an option | Lead (recommended option) |
| Q14 | Adopt Durable engines section 6.2 as the contract | Adopted as is; R3 and the relay built now | Lead (recommended option) |

### 9.2 Raised by this revision, for the lead

Reworking the plan for plan rulings Q3 and Q4 forced four choices. Each has a recommendation,
which is the working assumption; none blocks M0 or M1.

| # | Question | Options | Recommendation | Blocks |
|---|---|---|---|---|
| N1 | Which validation library do generated validators use? | (a) Zod; (b) Valibot; (c) keep Mesh's own cast functions | **(a)**: the most established of the three, and the rest of Mesh sees only Standard Schema, so it can be swapped. (b) is smaller, which matters for the single binary; M14 measures that. Not checked: the size of either in a compiled binary. | M2 |
| N2 | Drop the hand-written in-memory data adapter in favour of SQLite's in-memory mode? | (a) drop it; (b) keep a separate evaluator | **(a)**: it removes a second implementation of expression semantics that Mesh would have to keep identical to SQL's by hand. Cost: the contract has a single implementation until Postgres lands, hence D12. The Synthesis listed "in-memory" among the first adapters (section 10). | M3 |
| N3 | May generated code depend directly on the OpenTelemetry API package? | (a) yes; (b) keep a Mesh tracer contract with OpenTelemetry as an adapter | **(a)**: the Synthesis names that API as a neutral standard to use as the contract (section 9). Cost: one small dependency in every generated application. | M5 |
| N4 | What is the development actor resolver? | (a) `actor-dev` reads actor and context from a file named in the project config; (b) no shipped resolver, each application writes its own from the first day | **(a)**: the walking skeleton and every test need some resolver, and a file keeps "who is calling" out of the command line's own flags. It must be plainly unfit for production (it trusts the file). | M2 |

## 10. Risks across milestones

1. **PR #1's vocabulary is partly inferred.** M0 starts from it. Its vocabulary rules include
   several the dev inferred (PR #1 report, "Conditional rules", "Inferred by me"); they should
   be confirmed when M1 builds the model on them.
2. **MX is consumed from `main` with nothing pinned** (MX notes, getting-started section 5). A
   breaking MX change stops Mesh the same day. The conformance and contract tests are the
   alarm.
3. **Drizzle v1 is a release candidate, its relations API is being replaced, and drizzle-kit
   is mid-rewrite** (Synthesis section 12, risk 1; section 10, "Migrations" row). Mitigation,
   not avoidance: exact version pins in the `data-*` packages; Drizzle imported nowhere else
   (M2 test 4), so an upgrade touches three packages; an upgrade is its own pull request and
   must pass the conformance suite; Mesh does not use the relations API (D13); committed
   migrations are plain SQL files, so they survive a drizzle-kit change.
4. **No CI** (plan ruling Q8). Every gate in this plan runs through the local `verify` script,
   so a skipped run is invisible. The lead's verifier runs it once per delivery; the guard
   (`mesh build --check`) is part of it.
5. **Thin engine against readable output.** Ruling 2 pushes logic into generated files; if they
   become unreadable, the benefit is lost. M5 is where to watch.
6. **Scope of v1 is large**: fifteen milestones, eight of them L. The parallel tracks after M5
   and M6 are where calendar time is recovered, and each L needs its own squad leader.
7. **The workflow interface is unproven**, and the in-process runner is the largest thing Mesh
   builds itself where established engines exist.
8. **The vocabulary is what a coding agent has not seen before** (Synthesis section 7), so
   every new tag should come with a generated rules-file entry from M13 onward.
9. **New vocabulary is spread over many milestones** (pagination, hooks, preparations,
   arguments, `atomic`, `has-one`, `forbid-if`, identities, workflow tags). A vocabulary owner
   should review them together so the language keeps "one way to do each thing" (Old plan,
   "Agent legibility principles").

## 11. Review

Review file for every round: the review of plan revisions 1 and 2 (not published).
The squad leader's report is the report on plan revision 1 (not published).

**Revision 1** (reviewed by a separate Opus agent, three rounds, 2026-10-04):

- Round 1: accept with fixes; 2 high, 12 medium, 7 low. All applied: dependency graph redrawn
  from the acceptance tests (relationships before policies; M9 and M13 after M8; M14 last);
  preparations, tracing and run-time extension points scheduled; `public` and `domain` given a
  meaning; five decisions moved into the question table; error classes and scope placed in
  `runtime` with a concrete import rule; M3 tests corrected; change classification and the
  atomic default defined; in-process capability manifests stated; the worker loop moved to
  `runtime`; counts and eight citations corrected.
- Round 2: all 21 confirmed fixed; 5 medium and 7 low new findings, all applied (self-contained
  M4 example; atomic rule covers validations that read the record; capability rule keyed to
  merge time and closed by an M14 test; index test moved to M9; extension types and functions
  name their per-adapter half; seven wording and citation fixes).
- Round 3: eleven of twelve confirmed fixed, the twelfth fixed when the report was written;
  three new low findings applied.

**Revision 2** (this text; changes after the operator's rulings on the plan):

- Plan ruling Q3: `data-sqlite` and `data-postgres` are built on Drizzle, migrations on
  drizzle-kit, with a shared `data-drizzle` package; M2, M3, M4 and M10 reworked; M10 is now
  size M and may start after M5; the Drizzle risk is recorded with its mitigation (section 10,
  risk 3). Section 8.1 "Build or reuse" is new; five things revision 1 built are now reused
  (in-memory database, input validation, tracing, code formatting, argument parsing).
- Plan ruling Q4: the scope is actor and context; the actor-resolver contract and `actor-dev`
  arrive in M2; `transport-cli` defines no caller flags; tenant is left to a multitenancy
  extension through a scope contribution point in M6; the workflow contract drops `tenant`.
- Plan ruling Q8: CI removed from M0; every "CI check" is a `verify` check.
- Questions: Q1–Q14 moved to "Decided" (section 9.1); four new ones for the lead (N1–N4).
- Review of revision 2: recorded in the review file under "Revision 2".
