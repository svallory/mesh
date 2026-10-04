---
title: "Research synthesis"
description: "Synthesis of the seven fact-checked Ash and TypeScript research documents into a proposed Mesh architecture."
---

# Mesh research synthesis

> This synthesis has no review file of its own; the seven documents it summarises were each reviewed (see the [index](./index.md)).

Date: 2026-10-01. Author: team lead (`mesh-d6`), from seven researcher documents that were each
fact-checked against source by an independent reviewer.

This document answers the two questions asked:

- **Step 1.** What Ash offers, how it is built, where it can be extended, which packages matter,
  and where it is strong and weak — read as input for designing Mesh.
- **Step 2.** Which tools Mesh should stand on, and for each one whether it is hardcoded in the
  core or implemented as an adapter. This part is a **recommendation for you to decide**.
- **Step 3.** A proposed architecture: goals, layers, the build-time and run-time workflows, and
  the extension points. Added on request; not yet reviewed. No implementation plan is included.

Facts below come from the research documents. Design advice is mine and is marked as such
("Recommendation"). Where a claim rests on thin evidence, the text says so.

### How to read the evidence

| # | Document | Words | Reviewer verdict |
|---|---|---|---|
| 01 | [`01-ash-features.md`](./ash-features.md) — feature inventory (ash 3.33.11) | 10,575 | Accept with fixes |
| 02 | [`02-ash-dsl-and-extensions.md`](./ash-dsl-and-extensions.md) — Spark, extensions, Igniter | 16,202 | Accept |
| 03 | [`03-ash-runtime-internals.md`](./ash-runtime-internals.md) — lifecycle, data layer, policies | 16,049 | Accept with fixes |
| 04 | [`04-ash-ecosystem-packages.md`](./ash-ecosystem-packages.md) — top 20 packages | 16,756 | Accept |
| 05 | [`05-ash-strengths-weaknesses.md`](./ash-strengths-weaknesses.md) — 183 verified quotes | 12,509 | Accept |
| 06 | [`06-ts-prior-art.md`](./ts-prior-art.md) — TypeScript projects in the same space | 14,079 | Accept with fixes |
| 07 | [`07-ts-foundation-candidates.md`](./ts-foundation-candidates.md) — foundation tools | 16,255 | Accept with fixes |

Each review ends with a section `### Residual errors (for readers)` in
`notes/team-lead/reviews/<ref>.md`. Those lists are short and were applied to the documents in a
cleanup pass. On fresh citation samples in the final checks, between 56% and 94% of citations
supported the claim at the exact line cited, and 90% to 97% carried a true fact once "right fact,
wrong line" is counted. Treat line numbers as approximate and facts as checked.

The "Implications for Mesh" section at the end of each document is the researcher's opinion and
was not fact-checked. I used those sections as input, not as findings.

---

## Step 1 — Ash

### 1. What Ash offers

Ash is a framework where one module per resource declares the data, the operations and the rules,
and the framework derives everything else: persistence, authorization, APIs, clients, admin UI.

**The resource surface** (document 01):

| Area | What Ash has | In the Mesh plan? |
|---|---|---|
| Resource DSL | 14 sections: `attributes`, `relationships`, `actions`, `code_interface`, `resource`, `identities`, `changes`, `preparations`, `validations`, `pipelines`, `aggregates`, `calculations`, `multitenancy`, `temporal` | 5 of them appear in the plan's example |
| Domain DSL | 4 sections: `domain`, `resources`, `execution`, `authorization` | Named, not detailed |
| Types | 31 built-in types, plus arrays, `NewType` wrappers, embedded resources, enums | Types and constraints named; `NewType` and embedded resources are not |
| Relationships | `belongs_to`, `has_one`, `has_many`, `many_to_many`, join resources, manual relationships, `manage_relationship` | The four kinds named; the rest is not |
| Actions | 5 types (create, read, update, destroy, generic); arguments, `accept`, primary actions, upserts, bulk actions, atomic updates, manual actions, soft destroy, pagination, hooks, transactions | Types, changes, validations, hooks and transactions named; upserts, bulk, atomic, manual, pagination, preparations are not |
| Built-in behaviour | 24 changes, 24 validations, 4 preparations, 22 policy checks | Not enumerated |
| Expressions | 39 functions, 15 operators, 5 templates (`^actor`, `^tenant`, `^arg`, `^context`, `^ref`) | "Translatable arrow functions"; no function list |
| Policies | A separate extension: `policies` and `field_policies`; bypasses, policy groups, three access types (`:strict`, `:filter`, `:runtime`), `Ash.can?`; no matching policy means forbidden | `policies` block named; field policies, bypass, access types, `can?` are not |
| Multitenancy | 2 strategies (`:context`, `:attribute`), 4 per-action overrides | Deferred, open question |
| Errors | 4 classes, 91 leaf error modules (built on Splode) | "Errors name the fix"; no class hierarchy |
| Tooling | 25 mix tasks, 9 generators, formatter, cheat sheets, 18 telemetry events, `usage-rules.md` plus 14 topic files for coding agents | `build`, `watch`, `inspect`, a skill file and an MCP server |

Honest measure of density: the official tutorial resource uses 3 of the 14 sections, and a dense
real-world resource (`Tunez.Music.Album`, 146 lines) uses 8. The plan's own example uses 5. "One
file declares everything" is true in Ash, but a typical resource uses about half the vocabulary.

### 2. Architecture

Ash has two halves that share almost nothing: a compile-time DSL engine and a run-time action
engine.

#### 2.1 Compile time (document 02)

- **Spark** is a generic DSL toolkit; Ash is one user of it. Every Ash DSL is a list of section
  and entity declarations with typed option schemas.
- A DSL compiles to a **plain map** keyed by section path. There are no run-time DSL objects; the
  map is baked into functions on the module. Introspection reads that map.
- Three hook kinds run in order: **transformers** (may rewrite the whole map), **persisters**
  (cache derived values), **verifiers** (read-only checks, run after the module compiles).
  `Ash.Resource` registers 20, 8 and 27 of them.
- Two behaviours matter for Mesh:
  - Transformer errors abort the build. **Verifier errors only print warnings.**
  - Ordering between transformers uses `before?`/`after?` against module names. A contradictory
    pair is dropped silently, and cycles are broken silently. Ash has live casualties: AshArchival
    orders itself against two modules that no longer exist, and two Ash core transformers
    contradict each other.

#### 2.2 Run time (document 03)

- **The write lifecycle is a nested onion**: `around_transaction` → `before_transaction` →
  [transaction opens] → `around_action` → `before_action` → data layer → `after_action` →
  post-action authorization → [transaction closes] → `after_transaction`. Hooks are anonymous
  functions stored on the changeset.
- **Changes and validations run when the changeset is built**, not when the action runs. The
  request object and the command object are the same thing.
- **"Atomic" is an expression-rewriting protocol.** A change returns expressions, and the data
  layer folds them into one UPDATE. A single-record update runs `change/3` at build time, then
  rebuilds the changeset and runs `atomic/3`. The rebuild dropped filters added by the action's own
  changes: bug #2969, fixed on 2026-09-26. The atomic and non-atomic paths can disagree.
- **Write authorization happens in six different places**, depending on action type, check type
  and whether the action transacts. One of them — filter checks on non-atomic update and destroy —
  is a SELECT that runs before the transaction opens, which is a check-then-act gap.
- **Bulk actions** have three strategies (`:atomic`, `:atomic_batches`, `:stream`). Only `:stream`
  keeps per-record changes and hooks.
- **The data layer contract** is one behaviour with 46 callbacks, 44 optional, plus a `can?/2`
  capability probe with 47 feature names. Core asks `can?` and degrades, but inconsistently:
  sometimes an exception, sometimes a string, sometimes a silent in-memory fallback.
- **Expressions** are a two-stage tree. The same tree can run in memory or compile to SQL.
- **Policies** compile to a boolean formula solved by a SAT solver. Read policies become query
  filters, so a forbidden read looks like "not found". The policy breakdown output is the best
  debugging tool in the framework.
- **Notifications** queue in the process dictionary until the outermost transaction commits.
- **AshPostgres** installs SQL functions so Elixir semantics hold in the database. That has a
  measured cost: a filter written with `&&` ran in ~3,400 ms against ~110 ms with `and`, because
  the function call defeats the index.

### 3. Extension points

Document 02 catalogues 44. They fall into five groups:

| Group | What an extension can do | Examples |
|---|---|---|
| Add vocabulary | New DSL sections, entities, option schemas; add entities to another extension's section | AshStateMachine `state_machine`, AshArchival `archive` |
| Rewrite the resource | Transformers can add attributes, actions, changes, relationships, or generate whole new resources | AshPaperTrail generates a version resource per resource |
| Run-time behaviours | Data layer, authorizer, notifier, change, validation, preparation, policy check, calculation, custom type, custom expression, custom aggregate, manual action, manual relationship, tracer | AshPostgres, `Ash.Policy.Authorizer` |
| Tooling hooks | `codegen`, `migrate`, `setup`, `install` callbacks called by mix tasks; Igniter installers that edit the project's source | `mix ash.codegen`, `mix igniter.install` |
| Free tooling | Formatter, cheat sheets, editor autocomplete, generated module docs, test helper for verifier errors | `mix spark.cheat_sheets` |

Three facts shape what Mesh should copy:

1. **A basic extension is small.** AshArchival is 430 lines. PaperTrail is 3,827 and AshOban is
   5,196, because transformers become the dumping ground for anything hard.
2. **Extensions write into each other with no contract.** PaperTrail inserts entities straight
   into AshPostgres's `references` section. It works, and nothing checks it.
3. **The tooling callbacks are duck-typed.** `Ash.Extension` has seven optional callbacks and no
   module in the ecosystem declares that it implements the behaviour.

### 4. The packages that matter

Ranked by domain relevance first, adoption second (document 04, hex.pm downloads fetched
2026-10-01):

| # | Package | Area | One line |
|---|---|---|---|
| 1 | `reactor` | Sagas | Step graph with compensation and undo; the saga engine |
| 2 | `ash_paper_trail` | Auditing | A version resource per resource, four tracking modes, actor attribution |
| 3 | `ash_events` | Auditing, event log | One central event log with replay |
| 4 | `usage_rules` | Agent tooling | Collects each dependency's rules file into `AGENTS.md` |
| 5 | `ash_authentication` | Security | Authentication strategies and tokens |
| 6 | `ash_oban` | Background work | Actions as background jobs, triggers, cron |
| 7 | `ash_state_machine` | Domain | Attribute-backed state machine tied into policies |
| 8 | `ash_ai` | Agent tooling | Actions exposed as LLM and MCP tools; policies still apply |
| 9 | `ash_archival` | Domain | Soft delete with a default filter |
| 10 | `ash_cloak` | Domain | Attribute encryption |
| 11 | `ash_money` | Domain | Money type |
| 12 | `ash_rate_limiter` | Cross-cutting | Per-actor, per-action rate limits |
| 13 | `ash_typescript` | Client codegen | Typed TypeScript client, one function per action |
| 14 | `ash_double_entry` | Domain | Double-entry accounting |
| 15 | `ash_onetime` | Domain | Idempotency keys (community, new) |
| 16 | `ash_postgres` | Storage | The production data layer |
| 17 | `ash_phoenix` | Transport | Forms and LiveView integration |
| 18 | `ash_json_api` | Transport | JSON:API server |
| 19 | `ash_admin` | Admin UI | Generated admin dashboard |
| 20 | `ash_graphql` | Transport | GraphQL server |

The four areas you asked about:

- **Sagas.** Reactor is a real saga executor. Its best idea is the split between `compensate`
  ("this step failed: retry, continue or give up?") and `undo` ("this step succeeded but a later
  one failed: roll it back"). The step order is inferred from declared arguments, and cycles are a
  compile error. **Durable workflows are not solved**: people hand-assemble Reactor + AshOban +
  AshStateMachine. Persisted runs are fragile because Spark names inline functions by a hash of
  their code, so editing a step changes its identity.
- **Auditing.** Two different shapes. PaperTrail records versions per resource. AshEvents records
  every write in one log and can replay it. PaperTrail cannot hydrate an old version back into a
  record, does not support bulk actions and does not scrub sensitive inputs.
- **Testing.** First-party, not a package: generators derived from the resource (`Ash.Generator`),
  a seed path that bypasses actions (`Ash.Seed`), four assertion helpers, `Ash.can?` for policy
  tests, and in-memory data layers. The community factory package deprecated itself in favour of
  these.
- **Event sourcing and CQRS.** Thin. AshEvents is an event log with replay; whether that is event
  sourcing is disputed, because the tables stay the source of truth. The only CQRS binding
  (`ash_commanded`, third-party) has 880 downloads and a published release that does not work.
  The evidence says this is a niche in the Ash world.

`ash_typescript` deserves a note because Mesh generates the same thing: one typed function per
action over two endpoints, field selection, Zod or Valibot schemas. Its known gap is that the
client carries **no authorization metadata**, so a UI cannot ask "may this user do X" without a
hand-written action.

### 5. Strengths, ranked

From 183 verified quotes (document 05):

1. **Derived operations arrive complete.** Filtering, sorting, pagination, authorization and
   calculations come attached to every generated function. This is the benefit users name most.
2. **It replaces the bespoke in-house framework** every large app grows anyway. The common
   argument for Ash is consistency, not speed.
3. **Escape hatches are layered and real**: action → manual action → generic action → plain
   Elixir → Ecto. Every resource is also an Ecto schema, so leaving is possible.
4. **Authorization as data.** Policies that become query filters, with a readable breakdown.
5. **One declaration feeds many surfaces**: JSON:API, GraphQL, typed TypeScript client, admin UI,
   agent tools.
6. **The agent surface is deliberate**: rules files shipped in every package, actions exposed as
   MCP tools under the caller's own identity.

### 6. Shortcomings, ranked

1. **Learning curve and concept overload.** The maintainers say this first. The sharpest version:
   four overlapping ways to express one rule (policies, filter checks, preparations, expression
   calculations).
2. **Errors and stack traces.** Behaviour lives in the library, so traces are unhelpful and test
   coverage of your own resource reads 0%.
3. **Lock-in, proven by an exit.** A team of ten with ~200k lines and a paid support contract
   removed Ash after two years: "it should not be the default choice for any team".
4. **Compile cost.** One resource: 11,260 ms with a code interface, 2,270 ms without. Ash itself
   has 185 compile cycles.
5. **Bus factor.** One person wrote 79% of human commits (5,315 of 6,719).
6. **Documentation**, by the maintainers' own repeated admission.
7. **Run-time surprises**: six authorization placements, atomic and non-atomic paths that diverge,
   silent in-memory fallbacks, loads that are silently ignored, `has_one` silently truncated,
   telemetry costing 15–23% of a create.
8. **Fragile extension machinery**: silent ordering failures, verifier errors as warnings,
   editor autocomplete that does not work in the new official Elixir language server.

One pattern is worth more than any single item: **every safety default that Ash 3.0 changed moved
from permissive to conservative** (`accept` instead of `reject`, empty default accept list,
attributes private by default, atomic required by default, ambient actor and tenant removed).
Ash 3.0 had other breaking changes too, mostly renames; the safety defaults all moved one way.
The maintainers paid for permissive defaults and reversed them.

### 7. What the evidence says about the plan's premise

The plan's theory is that the declarative resource model, not Elixir, produced the agent win.
Being blunt about what the research found:

- **Nobody has measured this.** No source compares a declarative spec against the same thing in
  plain TypeScript. Wasp's benchmark (DSL app 2.5M tokens against 4.0M) is one run per arm, run by
  the vendor, with no correctness measure. Convex's +20% pass rate measures curated rules files,
  not language design.
- **The one controlled study cuts both ways** (arXiv 2602.11198: ten Python agent frameworks, one
  task). It blames "declarative novelty" — abstractions missing from training data — and its top
  scorer is itself declarative but convention-aligned.
- **Field reports conflict.** Your experiment favours Ash. The team that removed Ash reports that
  frontier models "struggle with Ash" and fall into anti-patterns they avoid with Ecto.
- **The syntax is not new, the vocabulary is.** Mesh resource files use Marko, an existing
  language with its own parser and editor tooling; only the tag names are new. The off-distribution
  risk for a coding agent is the tag vocabulary, not the syntax.
- **Wasp deleted its DSL** in July 2026. The stated reasons were positioning, adoption friction
  and editor-tooling cost — not agents. A custom language carries a permanent editor-tooling tax;
  Mesh avoids it by reusing Marko.

Conclusion: the plan's Phase 0 spike is not a formality. It is the only experiment anyone will
have run on this question, and it should gate everything after it.

### 8. Recommendations for the design

All of this section is my recommendation.

#### Copy from Ash

| Idea | Why |
|---|---|
| One registry per vocabulary (types, checks, functions), read by compiler, docs and errors | Ash's own docs drift from its registries: 39 registered functions, about 30 documented |
| Plain-data IR that every tool reads | Already in the plan; Ash's map-based DSL state proves it scales to 20+ extensions |
| The onion lifecycle | The phases are right. Make it an explicit, printable plan (`explain`) instead of closures |
| Access types (`strict`, `filter`, `runtime`) | Maps directly onto the plan's translatable and opaque split |
| Default deny, and conservative defaults everywhere | Ash reversed every permissive default in 3.0 |
| Structured policy breakdowns | Best debugging tool Ash has |
| A capability probe on the data layer | Right shape; make the feature list a closed union and define what happens when a feature is missing |
| Compensate and undo as separate saga concepts; step order from arguments | Cleanest design in the ecosystem |
| Generators, a seed path, `can()` and an in-memory data layer for tests | The community converged here and abandoned factories |
| Typed client with one function per action and field selection | Proven by `ash_typescript` |
| Rules files and MCP tools generated from the IR | The best-evidenced agent aid (Convex +20%, and the Ash maintainer credits it) |
| Staged migration flags with a named removal version | How Ash shipped the 3.0 flips |

#### Do differently

| Ash does | Mesh should | Reason |
|---|---|---|
| Authorizes writes in six places, one with a check-then-act gap | Authorize every write in one place, inside the transaction | The plan's pipeline puts authorization (step 4) before the transaction (step 5): that reproduces the gap for any check that needs the record |
| Runs changes at build time, then again on the atomic rebuild | Plan the write once, pick one strategy, never run a change twice | Bug #2969 |
| Orders transformers by `before?`/`after?` on module names, failing silently | Named phases, a hard error on cycles, and a printed order | Three live mis-orderings in Ash |
| Turns verifier errors into warnings | Make strictness a deliberate setting, strict in CI | Ash had to build a test helper to recover the lost signal |
| Lets extensions write into each other's sections unchecked | Decide the rule up front: either forbidden, or declared in the extension manifest | PaperTrail into AshPostgres |
| Seven optional duck-typed tooling callbacks | One typed extension manifest: sections, transforms, phases, codegen hooks, docs | Readers cannot tell which callbacks matter |
| Keeps behaviour in the library | Emit committed TypeScript that contains the logic | Ash's 0% coverage and poor stack traces share this root |
| Ambient actor and tenant (removed in 3.0) | Explicit context value on every call, like `Ash.Scope` | Removed for "subtle bugs" |
| Silent fallbacks (in-memory filter, ignored loads, dropped filters) | Hard errors | Already a plan principle; Ash shows how many places it leaks |
| Step identity by content hash | Stable, declared step names | Persisted sagas break on redeploy |
| Client with no authorization metadata | Generate per-action capability metadata with the client | Cheap at build time, costly to retrofit |
| Four overlapping ways to express a rule | Hold the plan's "one way to do each thing" | The most specific learning-curve complaint |

#### Do not build yet

- A SAT-based policy solver. Start with a simpler tier; keep the structured breakdown.
- Event sourcing, CQRS, projections. Ship an event log later if asked.
- GraphQL, an admin UI, a durable workflow engine. Design the seams (stable step identity,
  events committed in the same transaction as state) and stop there.
- Ash's breadth. Two users say the value appears only at scale; the team that left was at scale.

#### Gaps in the plan that need a decision

1. **Where behaviour lives.** The plan says "generated code does the heavy lifting" and also
   defines a shared `core` pipeline. If generated handlers are thin calls into `core`, Mesh
   inherits Ash's coverage and stack-trace problems. Decide how much logic is emitted per resource.
2. **Write authorization placement** (see above).
3. **Atomic updates and bulk actions.** The plan has neither. Without them, concurrent updates
   race, and batch work has no story. This is the largest piece of the runtime the plan omits.
4. **Things the plan does not name** and probably needs in v1: identities (unique keys), upserts,
   preparations (read-side hooks), action arguments, pagination, an error class hierarchy,
   generated test generators. Likely deferrable: embedded resources, `NewType`, field policies,
   manual actions, join-resource options.
5. **Closures in translatable expressions.** Every TypeScript library that parses arrow functions
   at run time loses captured variables. A build-time compiler avoids that, but Mesh must write it:
   nothing reusable exists (the closest, Tinqer, has one maintainer, ~230 downloads a week, and no
   source spans in errors).
6. **Which parser the expression compiler uses.** TypeScript 7.0 ships no compiler API. The
   choice is the TypeScript 6 package, oxc or SWC, and it should be swappable. Step 2 covers this.
7. **Extension ordering and cross-extension writes** (see above). The plan says extensions are IR
   transforms; it does not say how they are ordered or what they may touch.
8. **Guarding the committed generated tree.** Wasp's checksum manifest protects a gitignored
   directory and would not catch hand edits to a committed one. Mesh needs its own check: regenerate
   in CI and fail on any difference.

---

## Step 2 — Foundation tools

Revised on 2026-10-01 after review by the operator. The first version of this section classed
tools as "integral" when their names would appear in generated code, and called Bun integral. That
was the wrong test. The definitions that apply:

- **Hardcoded (integral):** part of the core. Only what Mesh cannot run without.
- **Adapter (replaceable):** an implementation of a contract the core owns.
- **Extension:** an optional feature built on the core's extension points.

Anything a project can do without, and anything most projects do not use, is an adapter or an
extension. Facts below are from document 07 (and 06 for the parser and syntax questions). The
classification is a recommendation.

### 9. Neutral standards

Four neutral contracts exist today and should be used as the contract wherever they fit: the Fetch
handler `(Request) => Response` (standardized by Ecma TC55), Standard Schema, SQL, and the
OpenTelemetry API.

### 10. Every layer is an adapter

| Layer | What the core owns | First adapters, and what the research found |
|---|---|---|
| Runtime | Web-standard APIs only; no runtime-specific calls | Bun and Node. Bun compiles to one binary for eight targets and ships SQLite and Postgres drivers. `better-sqlite3` does not run on Bun, so drivers are per-runtime adapters |
| Authoring syntax | The resource model every front end produces | Marko files with Mesh tags (an existing syntax; only the tag names are new). TypeScript declarations as a second front end |
| Expression parser | The expression tree | oxc, or the TypeScript 6 compiler. TypeScript 7's programmatic API is marked unstable and changes in 7.1 |
| Data layer | A query and write contract plus a capability list | Postgres, SQLite, in-memory. Drizzle suits the SQL adapters; Kysely has no documented `bun:sqlite` dialect |
| Server | One Fetch handler per action | Elysia, Hono, `Bun.serve`. Both frameworks accept Standard Schema and both need an adapter package on Node |
| API protocol | Action and type metadata | Typed client, OpenAPI, JSON:API, GraphQL and agent tools, each an emitter |
| Validation | Validators generated from the model, exposed as Standard Schema | Zod or Valibot emitted for clients. Standard Schema is opaque to a compiler |
| Authentication | "Resolve an actor from a request" | Better Auth. Auth.js is in maintenance under the same team |
| Jobs and workflows | Multi-step operations with stable step names | In-process runner first. Durable engines were inventoried, not compared |
| Observability | One event per lifecycle phase | OpenTelemetry API; any logger |
| Migrations | A snapshot of the resource model | drizzle-kit to start; it is mid-rewrite |

Authorization is a fixed slot in the core lifecycle, filled by a first-party policy extension, as
in Ash.

### 11. Two cases worth spelling out

**A web framework as the core (Elysia).** Elysia is more than a router: plugins with scoped
lifecycle and typed dependency injection, macros (declarative per-route options), 12 official
plugins, 96 community plugins and 16 documented integrations (counted from `elysiajs.com` on
2026-10-01; the plugin model was read from the documentation, not tested). Its limit is that
everything hangs off an HTTP request (ten request phases), while Mesh actions must also run with
no request: jobs, tests, agent tools, daemons. One person wrote 86% of its commits and it had one
release in the last 90 days. Recommendation: Elysia as the first-class server adapter (Mesh mounts
as an Elysia plugin and the ecosystem stays available), not as the core.

**Data access.** A contract across Drizzle, Kysely, TypeORM and Prisma can cover select, insert,
update, delete, transactions and raw SQL. Filters, joins and aggregates have four different
shapes. Relation loading, schema ownership, migrations and pooling cannot be covered. So the
contract has to be Mesh's own, at the level of resources, as Ash's is (46 callbacks, 44 optional,
plus a capability list). The query library inside an adapter is that adapter's private choice.

### 12. Risks the research surfaced

1. Drizzle v1 is a release candidate and relations v2 is a mandatory upgrade.
2. Bun 1.4 is the first release written in Rust.
3. Bun's `findSourceMap` always returns `undefined`; run-time error mapping needs a prototype.
4. `AsyncLocalStorage` does not propagate into `Worker` or `MessagePort` events in Bun.
5. Idle memory of a Bun server with SQLite is unmeasured, and single-binary builds are unchecked
   for every candidate except Elysia.
6. Most candidates have 60–97% of commits from five people.

### 13. What the research did not cover

- Job, workflow, event-sourcing and authorization tools were inventoried, not compared.
- No JSON:API library for TypeScript was evaluated.
- Marko's compiler, including whether it hands expressions over as a syntax tree.
- Elysia's plugin and macro model in practice.

---

## Step 3 — Proposed architecture

A proposal, not a finding, and not yet reviewed. The implementation plan comes after this is
agreed. The slide deck shows the same content as diagrams.

### 14. Design goals

1. One declaration per resource; everything else derived.
2. A small hardcoded core; databases, servers, runtimes and syntax are adapters; features are
   extensions.
3. Generated code carries the behaviour: committed, readable TypeScript.
4. Conservative by default: deny unless allowed, accept only listed inputs, private unless exposed,
   context passed on every call.
5. Predictable execution: one lifecycle, fixed places for permission checks, hard errors instead
   of silent fallbacks.
6. Legible to coding agents: a machine-readable model, generated rules files, conventional output,
   errors that name the fix.

### 15. Three rings

| Core (hardcoded) | Adapters (one per choice) | Extensions (optional features) |
|---|---|---|
| Resource model as plain data | Front end (Marko by default) | Policies (first-party, on by default) |
| Vocabulary registries | Expression parser | Audit trail, event log |
| Compiler pipeline and phases | Data layer and driver | State machine, soft delete |
| Expression tree | Runtime host | Multitenancy |
| Action engine and lifecycle | Server and API protocol | Encryption, rate limits |
| Extension host and manifests | Actor resolver | Multi-step operations (sagas) |
| Error classes, explicit scope | Tracer, job runner | Typed client, OpenAPI, agent tools |

### 16. Build-time workflow

| # | Stage | What happens | Extension point |
|---|---|---|---|
| 1 | Load | Resource files written in Marko are read into declarations with source positions | Front end |
| 2 | Check structure | Nesting, options and types checked against the registered vocabulary | Vocabulary, types |
| 3 | Build model | One plain-data document per resource | Core |
| 4 | Transform | Extensions rewrite the model in named phases; a cycle is a hard error; the order is printed | Model transforms |
| 5 | Verify | Read-only checks across resources; a failure stops the build | Verifiers |
| 6 | Compile expressions | Each expression becomes a tree, marked for the database or in-process | Expression functions, parser |
| 7 | Emit | Types, handlers, schema, migrations, routes, client, rules files, as committed files | Emitters |
| 8 | Guard | CI regenerates and fails on any difference; errors point at resource files | Core |

### 17. Run-time workflow (one action call)

| # | Phase | What happens | Extension point |
|---|---|---|---|
| 1 | Enter | A route, job, agent tool or direct call supplies actor, tenant, context | Transports, actor resolver |
| 2 | Cast input | Only accepted fields pass; values cast and constrained | Types |
| 3 | Plan | Changes, validations and hooks ordered; one strategy chosen; printable | Changes, validations, preparations |
| 4 | Pre-check | Checks that need no data run first | Authorizer |
| 5 | Transaction | Opens; before hooks; checks that read data run inside it | Policy checks |
| 6 | Data layer | One contract; atomic changes fold into the statement; reads get a policy filter | Data layer |
| 7 | Commit | After hooks run inside the transaction, then it closes | Hooks |
| 8 | After commit | Notifications; typed result or classed error; one tracing event per phase | Notifiers, tracer |

### 18. Extension points

Build time: front end, vocabulary, model transform, verifier, expression function, emitter,
tooling hook. Run time: data layer, authorizer and checks, change and validation, preparation and
calculation, notifier, transport, runtime host and tracer. One typed manifest per extension
declares which points it uses and what it requires from adapters.

### 19. Open design questions

1. Does the hypothesis hold? Build one application from Mesh resources and from hand-written
   TypeScript, and measure a coding agent on both.
2. How much logic is generated per resource, and how much stays in the shared engine?
3. Atomic and bulk writes: scope of the first version.
4. Which data-layer capabilities are mandatory?
5. May extensions contribute to each other's part of the model? Proposed: only through
   contributions declared in the manifest.
6. Policy engine depth: a simple tier first, or a solver from the start.
7. Durable workflows: which engine, if any.
8. First server adapter: Elysia, Hono, or both.
