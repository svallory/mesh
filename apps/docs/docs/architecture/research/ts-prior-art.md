---
title: "TypeScript prior art"
description: "Prior art for \"declare the model, derive the rest\" in TypeScript and close neighbours."
---

# Prior art: "declare the model, derive the rest" in TypeScript and close neighbours

> Independent fact-check: [review of this document](./reviews/ts-prior-art-review.md).

Researcher: `ts-prior-art` · round 2 (corrected after fact-check review) · 2026-10-01 · For `mesh`
(an Ash-style declarative resource framework for TypeScript)

Scope note: this document covers *frameworks and platforms* that compete with or resemble Mesh as a
whole. Individual foundation libraries (Drizzle, Kysely, Zod, Hono, Elysia, Temporal …) belong to
`ts-foundations`; everything about Ash itself belongs to the four `ash-*` researchers.

Method: every health number was re-pulled on **2026-10-01** from `https://api.github.com/repos/<repo>`,
`https://api.github.com/repos/<repo>/releases/latest`, `https://registry.npmjs.org/<pkg>` and
`https://api.npmjs.org/downloads/point/last-week/<pkg>`. **Release dates in this document are release
dates** (GitHub `releases/latest.published_at` or the npm `time` field), never a repository
`pushed_at`. Local source paths are under `scratch/ash-src/<repo>/` (shallow clones, read-only).

---

## Summary

- **Nothing in TypeScript derives the *whole* stack from one resource declaration.** ZenStack derives
  types + CRUD + policies; Wasp derives server/client/CRUD plumbing; Keystone and Payload derive CRUD +
  admin; tRPC/oRPC derive the transport. None derives a generic action pipeline (changes, validations,
  calculations, aggregates, policies) over arbitrary resources the way Ash does.
- **Wasp deleted its own DSL in v0.25.0 (2026-07-27).** A `.wasp` file is now a hard error: *"Defining
  your app with the Wasp DSL (`main.wasp`) is no longer supported"*
  (`scratch/ash-src/wasp/waspc/src/Wasp/Project/WaspFile.hs:36-42`). The reasons the CEO gives are
  positioning, adoption friction, IDE-tooling cost and low value of the syntax ergonomics
  (https://wasp.sh/blog/2026/05/13/new-language-for-web-dev-was-a-mistake, Matija Sosic, 2026-05-13).
  **LLM training data is not among them** — see the verbatim quotes in §1.3.
- **Wasp's own token benchmark ran on the DSL it then deleted, and the DSL app used fewer tokens**
  (2,505,796 vs 4,049,413).
  2,505,796 vs 4,049,413 total tokens, 66 vs 96 API calls, 52 vs 66 tool uses, 12 vs 15 files read,
  $2.87 vs $5.17 — n=1 per arm, vendor-run, no correctness outcome reported
  (https://wasp.sh/blog/2026/03/26/nextjs-vs-wasp-40-percent-less-tokens-same-app, Vince Canger,
  2026-03-26). The measured Wasp codebase is `wasp/main.wasp`
  (https://github.com/vincanger/token-compare-nextjs-wasp/tree/main/wasp).
- **A second quantitative source exists: Convex.** "These curated set of rules increase the success
  rate of AI writing Convex code by about 20%" (Claude 3.7 Sonnet, GPT-4o), with a public leaderboard
  split into no-guidelines and with-guidelines tracks
  (https://stack.convex.dev/convex-evals, 2025-03-19; https://www.convex.dev/llm-leaderboard).
  It measures *guidance on a TypeScript API*, not DSL-vs-TypeScript.
- **"Compile the arrow function to SQL" exists in TypeScript, in three inspectable libraries.**
  Tinqer (`Function.toString` + `oxc-parser`, 24★, 228 dl/wk, 1 contributor) and Typhex (TS
  transformer or runtime parser, 1★, 5 dl/wk) are the only ones with readable source; lambdaorm
  (187 dl/wk) has a 404 GitHub repo and an obfuscated npm build and **cannot be inspected**.
  A fourth, jsmql (5★, `@koresar/jsmql` 67 dl/wk), does the same for **MongoDB MQL, not SQL**.
  Orange ORM (1,017★, **15,978 dl/wk**) is real adoption but a different technique: a proxy builder
  whose callbacks call methods (`customer.isActive.eq(true)`), not operators. Every runtime-parsing
  library loses closures, so values must go through an explicit `params` object; the only one that
  captures them needs a compiler hook.
- **ZenStack's SQL is produced at run time on every query, not at compile time.** ZModel → `Expression`
  IR is the build-time half; a Kysely plugin rewrites each query node per request
  (`scratch/ash-src/zenstack/packages/plugins/policy/src/plugin.ts:28-31`,
  `.../policy-handler.ts:71`, `.../expression-transformer.ts:174-896`).
- **TypeScript 7.0 ships no programmatic compiler API.** "While TypeScript 7.0 is here, it does not
  ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API"; the 6.0 API
  ships as `@typescript/typescript6` (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/,
  2026-07-08). Any build-time arrow-function compiler must pick TS 6, oxc or SWC today.
- **Authorization push-down is normal, not exceptional.** Keystone filter access, Payload access
  functions returning a `Where`, CASL's first-party `@casl/prisma` (194,893 dl/wk), Remult
  `apiPrefilter`, Platformatic DB `checks` and ZenStack `@@allow` all become query filters.
  **Hasura does not use row-level security** (permission rules become constraints in one generated
  SQL query) and **PostGraphile does not generate policies** (you write `CREATE POLICY` yourself).
- **"Permissions as query filters" fits only Triplit.** InstantDB uses a separate CEL rule language;
  Zero has no first-class permission system at all. §1.14, §3.6.
- **TypeSpec's `emitter-framework` is a code-*rendering* library (Alloy JSX, 0.21.0); the IR-transform
  package is `mutator-framework` (0.17.1).** Both pre-1.0. Diagnostics map back to `.tsp` through
  `getSourceLocation`, but emitted output does not. §4.1.
- **Prisma 8 is a contract-first TypeScript rewrite**: "Only PSL to IR to types emission happens at
  build time — query compilation happens at runtime", plus an extension SPI and Plan hooks
  (https://github.com/prisma/orm/blob/main/ARCHITECTURE.md). §4.3.
- **Effect's `makeRepository` is not new**: it is in `@effect/sql@0.12.0`, published 2024-09-15.
  v4 moved it into the `effect` package as `SqlModel` and added soft delete. §1.16.

---

## 1. Project profiles

### 1.1 ZenStack v2 (Prisma-based) and v3 (Kysely-based)

**Version examined.** `zenstackhq/zenstack` 2,948 stars, latest release `v3.9.7` (2026-09-30). The v2
line ships as npm `zenstack` **2.22.3 (2026-06-06)**, 54,081 dl/wk; v3 ships as `@zenstackhq/orm`
**3.9.7 (2026-09-30)**, 28,158 dl/wk. A standalone `zenstackhq/zenstack-v3` repo exists but is
**archived** (99★, pushed 2026-02-10).

**Declares.** One schema file in ZModel. The README describes it as a *"Modern schema-first ORM that's
compatible with Prisma's schema and API"* (`scratch/ash-src/zenstack/README.md:29`) — it does **not**
claim to be zod-inspired or a superset of Prisma (round-1 wording, corrected).

**Derives.** Prisma-compatible client types, CRUD API, Zod schemas, access control, CRUD HTTP APIs
with framework adapters, TanStack Query hooks (`README.md:37-47`). In v3: "It replaced Prisma ORM with
its own ORM engine built on top of Kysely while keeping a Prisma-compatible query API"
(`README.md:52-56`).

**Authorization and where it runs.** `@@allow` / `@@check` rules per model and operation — the closest
thing in TypeScript to Ash's `policies` block. **Two stages, and only the first is build time.**
(1) A language-level validator rejects anything outside the translatable grammar with node-anchored
errors such as `comparison between models is not supported` and `Collection predicate binding cannot
be used without a member access`
(`scratch/ash-src/zenstack/packages/language/src/validators/expression-validator.ts:86,240,245`).
(2) At run time, `PolicyPlugin.onKyselyQuery` constructs a `PolicyHandler`, which
`extends OperationNodeTransformer` and rewrites every Select/Insert/Update/Delete node
(`.../plugins/policy/src/plugin.ts:28-31`, `.../policy-handler.ts:71`). `ExpressionTransformer` maps
each IR kind to Kysely `OperationNode`s (`.../expression-transformer.ts:174-896`); some sub-expressions
are evaluated in memory by `ExpressionEvaluator` (`.../expression-transformer.ts:396,534`); an
unimplemented function throws `Function not implemented: <name>` at run time
(`.../expression-transformer.ts:754`). Writes get pre-create/pre-update checks and a **post-update
re-read** with id-matching (`.../policy-handler.ts:125-150,345-420`); updating an id field under a
post-update policy is unsupported (`.../policy-handler.ts:378`).

**IR.** A closed 10-kind `Expression` union (`scratch/ash-src/zenstack/packages/schema/src/expression.ts:1-69`):
`literal | array | field | member | call | unary | binary | binding | this | null`, with binary
operators `&& || == != < <= > >= ? ! ^ in`.

**Extension model.** Plugins in the v3 monorepo (`packages/plugins`, `packages/sdk`) plus first-party
tRPC and TanStack Query adapters. `[unverified]` — the plugin API surface was not read in round 2.

**Codegen vs reflection.** v2 generated a Prisma client used behind `$extends` middleware; v3 markets
*"More TypeScript type inference, less code generation"* (`README.md:59-63`), keeping a Langium
grammar (`packages/language/src/zmodel.langium`) for parsing and validation. Generated-code commit
policy: `[unverified]`.

**Known complaints.** Open-issue signal: `#717` "[Feature Request] Generate supabase RLS policies on migration based on Zmodel" — a **feature request** (14 comments) and `#563` "[Feature Request] ZenStack for API integration" (10) are the two most-discussed open issues. Round-2 version signal: v2 last published 2026-06-06, v3 last 2026-09-30, so v2 is in maintenance while two npm packages carry the same product.

### 1.2 Remult

**Version.** `remult/remult` 3,210★, release `v3.3.15` (2026-07-10); npm `remult` **3.3.18
(2026-08-30)**, **3,401 dl/wk**. Legacy `@remult/core` stalls at 2.5.6 (2021), 87 dl/wk.

**Declares / derives.** *Code-first*: TypeScript classes decorated with `@Entity<Task>("tasks", …)`.
Remult derives CRUD, an admin UI and REST/GraphQL APIs from those classes.

**Authorization — pushes down, as object filters.** `@Entity<Task>("tasks", { apiPrefilter: () => {
return { owner: remult.user!.id }; } })`; the docs state that *"`apiPrefilter` adds a filter to all
CRUD API requests"* and that it *"does not affect backend queries, such as those executed through
backend methods"*, which is why `backendPrefilter` / `backendPreprocessFilter` exist separately
(https://github.com/remult/remult/blob/main/docs/docs/access-control.md:58-125). Access control is
described as "Entity-level (`allowApi*`), row-level (`apiPrefilter`), and field-level
(`includeInApi`, `allowApiUpdate`) authorization patterns" (same file, front-matter).

**Health reading.** ~3.2k★ and ~3.4k dl/wk after years — flat, small, but shipped.


**Known complaints.** `remult/remult#570` "deleteMany Method - Unexpectedly Deletes All Records in Collection" (8 comments) and `#712` "Live query should send updates if a field of a related entity gets changed" (5).

### 1.3 Wasp

**Version.** `wasp-lang/wasp` **18,754★**; GitHub latest release `v0.25.0` **2026-07-27** (not
2026-09-30 — that was a push). npm `@wasp.sh/wasp-cli` **0.25.0 (2026-07-27)**, 5,150 dl/wk; the
Wasp Spec package `@wasp.sh/spec` 0.25.0 (2026-07-27), 80 dl/wk.

**Declares.** Not a DSL any more. The app is defined in **`main.wasp.ts`** — TypeScript importing
`@wasp.sh/spec` (`app.page(...)`, `app.route(...)`, `app.query(...)`, `app.job(...)`,
`export default app`). Timeline: the TS config shipped as a *preview* in **0.15.0**
(`scratch/ash-src/wasp/waspc/ChangeLog.md:610-612`); **0.24.0** renamed it "Wasp Spec" and moved the
import from `wasp-config` to `@wasp.sh/spec` (`ChangeLog.md:93-99`); reading `.wasp` files was removed
by PR #4334 (merged 2026-06-22), the DSL parser by PR #4369 (2026-06-25), and the language server by
PR #4335. In **0.25.0** a `.wasp` file is a hard error (`WaspFile.hs:36-42`).

**Derives.** Auth (multiple providers), routing, queries/actions/jobs, database (via Prisma
`schema.prisma`, which is still the data model), cron, email, React client. Pipeline now: Haskell
`analyzeWaspTsFile` runs a Node script against `main.wasp.ts`, receives JSON declarations and merges
them with entities parsed from `schema.prisma` (`waspc/src/Wasp/Project/WaspFile/TypeScript.hs`).
AppSpec, the `Generator` monad, `FileDraft` and the checksum sync are unchanged.

**Authorization — there is none.** The docs say: *"they are not aware of the authorization rules …
In the future, we will be adding role-based authorization to Wasp"*
(`scratch/ash-src/wasp/web/docs/features/data/crud.md:438`). What exists is `authRequired` on pages
and `context.user` in operations.

**Codegen vs reflection.** Build-time codegen from Haskell. **Output goes to `.wasp/out`, which Wasp's
own starter `.gitignore` excludes** (`waspc/src/Wasp/Project/Common.hs:87,93`;
`waspc/data/Cli/starters/skeleton/gitignore:1` → `.wasp/`). Generated code is **not committed**.

**Health note.** 18.7k★, still 0.x after five years, "raised over $5M in total" (self-reported), one
major architecture reversal, and no authorization model after five years.

**Why the DSL was dropped — the CEO's stated reasons, verbatim** (Sosic, 2026-05-13):

> "Developers resonated with the problem Wasp was solving, but the language was a tough sell. "Lang"
> in the name made them think our aim was to replace JavaScript (it wasn't) and were skeptical of how
> it'd work with their tooling."
>
> "Many developers loved Wasp once they gave it a try. But getting them to try it out was the hard
> part."
>
> "Adoption still grew, but as we kept pushing towards 1.0 we realised the "language" concern wasn't
> going away. Also, maintaining a good IDE experience for a custom language proved to be way harder
> than expected."
>
> "We ended up developing our own language server and a VS Code extension for it, but since Wasp used
> Prisma's DSL as an embedded language and had many references to React & Node.js files, we still only
> reached 80% of where we wanted to be."
>
> "Finally, the ergonomics we aimed for with the language didn't turn out to be as important as we
> thought. Developers are perfectly happy using TypeScript, a language they are familiar with, even if
> it requires a few extra lines and braces."
>
> "Language was never the moat. It's having a high-level understanding of your entire app at compile
> time."
>
> "We only swapped the "front end" of the compiler, or how you define a high-level app spec in Wasp."

Not one of these concerns LLM training data. The post's only AI-adjacent lines are anecdotal:
*"With AI and developers reviewing generated code less frequently, this became even more valuable…"*
and *"We repeatedly hear from developers using Wasp that it is the stack that works best with AI"*.


**Known complaints.** `wasp-lang/wasp#1088` "Have Wasp support producing mobile (smartphone) client app" — a **feature request** (28 comments) and `#954` "Better user account merging logic" (25) are the two most-discussed open issues. No issue about the DSL removal itself — the reversal was announced, not debated.

### 1.4 RedwoodJS and its successors

**Version.** `@redwoodjs/core` **8.9.0 (2025-10-21)**, 4,941 dl/wk — the last release in that repo was
`redwoodjs/graphql` **v8.9.0, 2025-10-21**, 17,595★ (the API path `redwoodjs/redwood` 301-redirects
there). The live successor product is `redwoodjs/sdk` (**RedwoodSDK**), 1,712★, release `v1.7.4`
(2026-09-23). Classic RedwoodJS and the RSC/edge SDK are separate products with separate repos.

**Declares / derives.** SDL GraphQL queries plus a directory layout; Redwood derives the cell, the
loader, the test stub and the story. v8 cell API `[unverified]` — not re-read in round 2.


**Known complaints.** `redwoodjs/graphql#8861` "[Bug?]: dbAuth authentication fails with 'Request path contains unescaped characters' error" (24 comments) and `redwoodjs/sdk#632` "React7.createContext is not a function" (8).

### 1.5 KeystoneJS

**Version.** `keystonejs/keystone` 9,981★, latest release 2026-08-31; npm `@keystone-6/core`
**8.1.0 (2026-08-31)**, 18,277 dl/wk.

**Declares / derives.** A declarative `keystone.ts` list of lists and fields (Prisma-shaped schema in
TS) from which Keystone derives the GraphQL API, the API routes, the Admin UI and session scaffolding.
Schema-first, admin-first; its centre of gravity is the admin UI, not a resource action pipeline.

**Authorization — pushes down.** Field-level access is `access`; **filter-level access control**
"lets you restrict which items can be operated on by providing a function which returns a GraphQL
filter. For mutations, the access control filter will be combined with the unique identifier"
(https://keystonejs.com/docs/config/access-control). The filter is *combined with the query filter*,
so it constrains rows in the database query, not in memory.


**Known complaints.** `keystonejs/keystone#8774` "Starting or Building Keystone with NODE_ENV set production fails." (18 comments) and `#7617` "Building static pages fails with prerendering errors" (19).

### 1.6 Payload CMS

**Version.** `payloadcms/payload` **45,047★**, latest release `v3.90.2` **2026-09-23** (npm `payload`
3.90.2, same day), **1,060,642 dl/wk** — many patch releases per week.

**Declares / derives.** A `collections` config (TS objects) with `fields`, plus `globals`; Payload
derives GraphQL + REST APIs, the admin panel, generated TS types and migration tooling.

**Authorization — pushes down.** An `access: ({ req }) => …` function per operation may return a
boolean or a Query: *"Return a Query to limit the Documents to only those that match the constraint.
This can be helpful to restrict users' access to specific documents"*
(https://payloadcms.com/docs/access-control/collections). That Query becomes a database `where`.


**Known complaints.** `payloadcms/payload#7312` "Payload with getPayloadHMR don't close or spams db connections during Static Site Generation" (60 comments) and `#11177` "foreign keys with cascade delete" (36).

### 1.7 Encore

**Version.** `encoredev/encore` 12,406★, latest release `v1.58.6` **2026-10-01** (GitHub; npm
`encore.dev` 1.58.6 published 2026-09-18), **34,645 dl/wk**. The round-1 "`@encore.dev/cli`
not found" was a wrong package name — the published CLI package is `encore.dev`.

**Declares / derives.** An `encore.app` TS config declaring services and APIs; Encore derives the
service runtime, deployment manifests and secrets/env handling. Axis: *infrastructure*, not resource
modelling. Auth model `[unverified]`.


**Known complaints.** `encoredev/encore#1641` "Endpoints not working as expected - Intermitent 500 errors + ghost endpoints" (9 comments); the most-discussed open issue is `#153` "Dart/Flutter client generation (DIO)" (10).

### 1.8 Convex

**Version.** `get-convex/convex-backend` 12,632★; npm `convex` client 1.46.0 (2026-09-16),
**1,788,402 dl/wk** (round 1 recorded "not found" — the endpoint works, the document's query did not).

**Declares / derives.** Server functions plus table definitions via a schema helper; Convex derives
the reactive query layer, generated types, dashboard and deployment. The differentiator is that a
mutation invalidates dependent queries automatically. Positioning line (verbatim,
https://www.convex.dev/, 2026-10-01): *"All gas, no breakages. Convex is the reactive backend platform
that keeps up with you and your agents."* Table helper shape `[unverified]`.


**Known complaints.** `get-convex/convex-backend#96` "Local dev server fails to start" (34 comments) and `#75` "Support at+jwt auth token" (32).

### 1.9 AdonisJS (Lucid + Bouncer)

**Version.** `adonisjs/core` 19,139★, release `v7.5.2` (2026-09-23). `@adonisjs/lucid` 22.4.2,
**174,367 dl/wk**; `@adonisjs/bouncer` 4.0.1 (2026-08-21), **39,936 dl/wk**.

**Declares / derives.** Lucid: model classes and column definitions, migrations in TS, derived query
building and relations. Bouncer: a *standalone* authorization package — **Ability** (what an entity
can do, with scopes/fields) and **Policies** (how it is checked per resource/method) — evaluated in
process. Adonis is the one mainstream Node framework that ships first-class authorization as a
separately versioned package. Whether Bouncer pushes a filter into a Lucid query: `[unverified]` —
not checked in round 2.


**Known complaints.** Lucid: `adonisjs/lucid#1153` "Advisory lock for migrations acquires and releases on different pool connections, causing E_UNABLE_RELEASE_LOCK" (4 comments) — the most-discussed open Lucid issue found in this pass. Core: `adonisjs/core#4510` "Pluralization is broken" (20 comments). No Bouncer-specific complaint found.

### 1.10 NestJS (with nestjs-query and CASL)

**Version.** `nestjs/nest` 76,775★, release `v12.1.1` **2026-09-28**; npm `@nestjs/core` 12.1.2
(2026-09-30), **17,940,374 dl/wk** — the largest npm footprint here. `doug-martin/nestjs-query` 842★
(last tagged release 2021-09-30); the active package is `@ptc-org/nestjs-query-core` **11.0.0-alpha.1
(2026-09-20)**, 45,696 dl/wk — and that is a **fork** (`TriPSs/nestjs-query`, 196★), not an org rename;
the original repo still exists. `stalniy/casl` 7,090★, `@casl/ability` 7.0.1, **2,027,217 dl/wk**.

**Declares / derives.** NestJS is annotation-and-convention based; the framework derives the DI graph,
routing and request validation. nestjs-query derives a CRUD + GraphQL/REST surface from decorated DTO
classes. CASL derives nothing — it is a runtime ability engine.

**SQL push-down — this is where CASL is strong, and it is first-party.** `@casl/prisma` **2.0.2
(2026-07-06)**, **194,893 dl/wk**, maintained in `stalniy/casl/packages/casl-prisma`:
`accessibleBy(ability).ofType('Post')` "returns an object aggregated from permission rules
`WhereInput`" (https://github.com/stalniy/casl/blob/master/packages/casl-prisma/README.md:90-100).
`@casl/mongoose` is also first-party. Round 1's claim that there is "no widely-used, well-maintained
ability → SQL compiler for Node ORMs" was wrong; `@casl/prisma` is that thing, and the round-1
"thin community adapter" evidence (`casl-drizzle`, 17★) was beside the point.


**Known complaints.** `doug-martin/nestjs-query#1538` "Is this project still Alive ?" (20 comments) — the fork/alpha reset is itself the complaint. `stalniy/casl#8` "sql & sequelize support" (68 comments) is the most-discussed issue in the CASL repo. `nestjs/nest#1006` **discussion** "Who is using Nest in production?" (391 c).

### 1.11 Platformatic DB

**Version.** `platformatic/platformatic` 2,060★, release `v3.71.0` (2026-09-29); npm
`@platformatic/db` 3.71.0, 3,667 dl/wk.

**Declares / derives — DB-first, not app-config-first.** "The Database Service … automatically
generates GraphQL and REST APIs from your database schema"; it works by "automatically
introspecting your database schema to create type-safe, fully-featured APIs", and "works out of the box with an **existing
database** … no migrations are required" (https://github.com/platformatic/platformatic/blob/main/docs/reference/db/overview.md:8-16).
Migrations are optional and only for letting Platformatic manage schema changes.

**Authorization — pushes down.** Rules use `checks` such as `{ "userId": "X-PLATFORMATIC-USER-ID" }`,
and "It's possible to specify more complex rules using all the supported where clause operators"
(docs/reference/db/authorization/rules.md:55-81). Roles come from `X-PLATFORMATIC-ROLE` by default.


**Known complaints.** `platformatic/platformatic#5042` "runtime: child stderr is lost when a worker fails during startup, making the real error undiagnosable".

### 1.12 Amplication

**Version.** `amplication/amplication` 16,016★. **Last commit on the default branch 2026-04-02**
(v3.15.0, released 2026-04-02) — about six months of silence, not three (round 1 used the repo's
`pushed_at`, which counts all branches). npm `@amplication/plugin-*` packages stopped publishing in
2024.

**Declares / derives.** The most "Ash-shaped" by intent: you describe a data model and a stack in the
Amplication UI and it generates entities, DTOs, Prisma schema, controllers, services and tests into a
real repo you can iterate on.

**Extension model — corrected.** The plugins README says plugins let you "do almost anything you want
with the generated code" (https://github.com/amplication/plugins): these are **hooks on generated
code**, not transforms of the entity model. Round 1's "plugins mutate the entity model before code
generation" had no source behind it and is withdrawn.


**Known complaints.** `amplication/amplication#4654` "As User - I want to have an updated and visually appealing design for the topics page in the Message Broker" — a **feature request** (26 comments) and `#6170` (28) — both feature requests against a codebase whose last default-branch commit was 2026-04-02.

### 1.13 Hasura and PostGraphile (Graphile Crystal)

**Version.** `hasura/graphql-engine` 32,130★, release `v2.50.3` **2026-09-09** (2026-09-21 was the
last push). `graphile/crystal` 12,933★, latest release `grafserv@1.0.2` (2026-09-04).

**Declares / derives.** Both database-first: you write the SQL schema (Hasura tracks migrations;
PostGraphile introspects an existing database) and they derive the GraphQL API by reflecting over the
catalog.

**Authorization — both push down, but not the way round 1 said.** Hasura: *"Hasura converts incoming
GraphQL requests into a single SQL query which includes constraints derived from the permission
rules"* (https://hasura.io/docs/2.0/auth/authorization/permissions/). Those are **WHERE constraints in
the generated SQL**, not Postgres row-level security — the word RLS does not appear on that page.
PostGraphile: "PostgreSQL introduced much more granular permissions in the form of Row-Level
Security (RLS) policies in PostgreSQL 9.5", and its docs then show the developer writing one —
`create policy update_if_author on comments for update using ("userId" = current_user_id())`
(https://postgraphile.org/postgraphile/next/security) — **the developer writes them**; PostGraphile
passes identity through `pgSettings`.
Smart tags control schema exposure, not policies. Neither is TypeScript-first: Hasura's engine is
Haskell; PostGraphile's is TypeScript but only reads Postgres.


**Known complaints.** `hasura/graphql-engine#9592` "Memory leak" (68 comments) and `#1573` "update nested object" (67). `graphile/crystal#2564` "Could PostGraphile use (more) CTEs/JOINs instead of subqueries?" (24).

### 1.14 Triplit, InstantDB, Zero — three different answers, only one of them "permissions as queries"

**Versions.** `instantdb/instant` 10,536★, npm `@instantdb/core` 1.0.67 (2026-08-31), 254,339 dl/wk.
`@rocicorp/zero` 1.9.0 (2026-08-14), 282,872 dl/wk; the repo is **`rocicorp/mono`, 3,397★**
(`rocicorp/zero` 404s). `@triplit/db` 1.1.10 (2025-07-31), 203,175 dl/wk; repo `aspen-cloud/triplit`
3,116★, last push 2026-01-19.

**Triplit — genuinely permissions-as-query-filters.** Rules are written with the query language's own
filter tuples and identity variables:

```ts
permissions: {
  authenticated: {
    insert: { filter: [['authorId', '=', '$token.sub']] },
  },
},
```

(https://github.com/aspen-cloud/triplit/blob/main/packages/docs/src/pages/schemas/permissions.mdx:45-62).
The server checks that the set of filter clauses is satisfied. **Both halves of the default:**
"By default, there are no access controls on the database and they must be configured by adding a
`permissions` definition to the schema"; but "Once a permissions object is defined … If no rules for an
operation are provided, the operation not be allowed by default"
(https://github.com/aspen-cloud/triplit/blob/main/packages/docs/src/pages/schemas/permissions.mdx:150).
So the schema is **open with no `permissions` object**, and **deny-per-operation once one exists**. Health: co-founder Matt Linkous joined Supabase
on **2025-10-08**, and Supabase states its focus "isn't to directly integrate Triplit into our
platform" (https://supabase.com/blog/triplit-joins-supabase).

**InstantDB — a separate CEL rule language.** Rules are strings in CEL evaluated per object, e.g.

```ts
const rules = {
  todos: { allow: {
    view: "auth.id != null",
    create: "isOwner",
    update: "isOwner && isStillOwner",
  } },
} satisfies InstantRules;
```

(https://www.instantdb.com/docs/permissions). Docs: *"Inside each rule, you can write CEL code that
evaluates to either true or false."*

**Zero — no first-class permission system.** "Zero does not have (or need) a first-class permission
system like RLS" (https://zero.rocicorp.dev/docs/permissions); permissions are ordinary TypeScript
written inside `defineQuery` / `defineMutator`.


**Known complaints.** `aspen-cloud/triplit#196` "`HttpClient` does not update fields of type `S.Optional(S.Set(S.String))`" (8 comments) and `#36` "Native Mobile Support" (6). `instantdb/instant#2546` "Support required relation constraints in schema" (5). `rocicorp/zero` 404s on the GitHub API; Zero's issues live in `rocicorp/mono` (157 open, incl. PRs); no dominant open issue found in this pass.

### 1.15 TypeSpec

**Version.** `microsoft/typespec` 5,877★, release `typespec-stable@1.16.0` (2026-09-09); npm
`@typespec/compiler` 1.16.0, 314,963 dl/wk. Microsoft-backed and past 1.0.

**Declares / derives.** A dedicated language (`.tsp`) for HTTP, messaging and event APIs; emitters
derive OpenAPI 3, JSON Schema, protobuf, and clients and servers in six languages. The largest, most
mature emitter ecosystem in TypeScript. Architecture in §4.


**Known complaints.** `microsoft/typespec#2463` "POC TypeSpec to AsyncAPI" — a **feature request** (33 comments) and `#4903` ".NET Client Patterns: Simple service description should generate client following unbranded .NET client patterns" (20).

### 1.16 Effect (Schema, SQL, Platform, Cluster)

**Version.** `Effect-TS/effect` 16,327★; npm `effect` **4.0.0 published 2026-10-01T03:11:28Z — the
day this document was written**. The **47,965,603 weekly downloads are not 4.0.0 downloads**: the
download window is 2026-09-23 → 2026-09-29, entirely before 4.0.0 existed, so they are v3 downloads.

**Not new: the derived CRUD layer dates from 2024.** `makeRepository` is in `@effect/sql@0.12.0`,
published **2024-09-15**, documented there as "Create a simple CRUD repository from a model"
(https://unpkg.com/@effect/sql@0.12.0/src/Model.ts:605-612), and is still in `@effect/sql` 0.52.1.
What v4 changed is the *location*: `SqlModel.makeRepository` now lives in the core `effect` package
(`scratch/ash-src/effect/packages/effect/src/sql/SqlModel.ts:1-31`) and adds soft delete. Files in
`packages/effect/src/sql/`: `SqlModel.ts` (362 lines), `SqlSchema.ts` (181), `SqlResolver.ts` (415),
`SqlClient.ts` (520), `Statement.ts` (1,593), `Migrator.ts` (464).

**The limit that matters for Mesh.** The SQL is a tagged template, not a compiled expression.
`statement()` walks `strings`/`args` of a `TemplateStringsArray` and turns every non-fragment
interpolation into a bound parameter
(`scratch/ash-src/effect/packages/effect/src/sql/Statement.ts:670-701`); fragments are a `Segment[]`
IR with `and`/`or`/`join`/`in` helpers (`:718-753`). Effect gives parameterisation, dialects and
batching, but no arrow-function compiler. Whether a higher-level query DSL sits above `src/sql/` is
`[unverified]`.


**Known complaints.** `Effect-TS/effect#6378` "Lens created with Schema.toIso throws synchronously on check error" (10 comments) and `#6353` "McpServer: no first-class support for MCP Apps" (8).

### 1.17 tRPC and oRPC

**Versions.** `trpc/trpc` 40,682★, `v11.19.0` (2026-09-16); `@trpc/server` 11.19.0, 6,140,518 dl/wk.
oRPC is at `middleapi/orpc`, 5,659★, `v1.15.4` (2026-09-23); `@orpc/server` 1,753,881 and
`@orpc/client` 2,016,298 dl/wk.

**Declares / derives.** Both derive the **wire contract** from TypeScript types — `.query(input => output)`
or `.input(schema).handler(fn)` — and from it the client type, runtime validation and (for oRPC)
OpenAPI. They deliberately derive nothing about the database, the domain model or authorization.


**Known complaints.** `trpc/trpc#3297` "feat: Support RSC & App Layouts" — a **feature request** (62 comments); `middleapi/orpc#1389` "Feature request: allow full customization of URL search params and body serialization" (8).

### 1.18 Additional projects

| Project | Health (2026-10-01) | One line | Relevance | Known complaints |
| --- | --- | --- | --- | --- |
| Prisma 8 | `prisma/orm` 47,686★; npm `prisma` **8.0.0-rc.19 (2026-09-29)**; `@prisma/client` 7.10.0 | Contract-first rewrite: PSL → IR → types at build time, query compilation at runtime (§4.3) | The baseline; also agent-first by design | `#1798` spatial types (162 c) |
| Drizzle ORM | `drizzle-team/drizzle-orm` 35,928★; 0.45.3 (2026-09-21), **29,472,576 dl/wk** | TS table definitions → thin typed SQL | Mesh's planned SQL substrate | `#376` error wrapping (58 c) |
| Kysely | `kysely-org/kysely` 14,253★; 0.29.6 (2026-09-16), **20,470,848 dl/wk** | Query builder, no schema layer | The substrate ZenStack v3 chose | **discussion** "Are you using Kysely in production?" (43 c) |
| Zod | `colinhacks/zod` 44,051★; 4.6.5 (2026-09-13) | Runtime schema + static types | The common "declare once" primitive | `#475` `nonNullable` (18 c) |
| PocketBase | `pocketbase/pocketbase` 61,230★, 19 open issues, pushed 2026-09-28 | Go, but "API Rules are your collection access controls and data filters … Each collection has 5 rules, corresponding to the specific API action: listRule viewRule createRule updateRule deleteRule" (https://pocketbase.io/docs/api-rules-and-filters/) | A direct policy-as-filter precedent (`ts-foundations` scope boundary: Go, not TS) | **feature request** (singleton content, 16 c) |
| Medusa v2 | `medusajs/medusa` 36,542★, 168 open issues, pushed 2026-10-01 | A documented Data Model Language (https://docs.medusajs.com/resources/references/data-model) inside a commerce backend | `[unverified]` — `model.define` itself not re-fetched | `#8548` image delete (74 c) |
| Directus | `directus/directus` 38,005★; v12.4.1 (2026-09-23) | DB- or schema-driven admin + GraphQL | Second proof of the admin-UI market | `#7237` create checked against update perms (43 c) |
| Strapi | `strapi/strapi` 73,269★; v5.56.0 (2026-09-30) | Content-type driven CMS + admin | Same, with a plugin ecosystem | `#20870` dynamic import failure (56 c) |
| NocoDB | `nocodb/nocodb` 65,149★; 2026.09.1 (2026-09-29) | Spreadsheet UI over a DB | Admin-first, DB-first | `#14048` Google OAuth (22 c) |
| LoopBack 4 | `loopbackio/loopback-next` 5,108★, 335 open issues, pushed 2026-10-01 | Model-driven REST/OpenAPI | Long-running model-first framework | `#2043` HABTM relations (43 c) |
| Feathers | `feathersjs/feathers` 15,259★, 118 open issues, pushed 2026-10-01 | Schema + resolvers + hooks | The "hooks over generated services" shape | `#1337` refresh tokens (65 c) |
| Blitz.js | `blitz-js/blitz` 14,126★, 90 open issues, **last push 2025-11-21** | Full-stack React framework | Named in Wasp's post as a peer; faded | `#586` cache invalidation (16 c) |
| Deepkit | `marcj/deepkit` 3,543★, last push 2026-02-11 | TypeScript-first framework with runtime types and DI | Last push 2026-02-11, i.e. quiet for ~7 months | `#562` serialize<T> circular import (33 c) |
| Pothos | `hayes/pothos` 2,619★ | Schema-first GraphQL builder, plugin API | Type-level emitter without codegen | **feature request** (EdgeDB plugin, 14 c) |
| Gel | `geldata/gel` 14,171★; v7.0 (2025-11-05), last push 2025-12-24 | Schema language + access policies, own DB | Closest to Ash anywhere; see §6 and §7 | `#3946` slow migration of huge schemas (15 c) |
| Cerbos | `cerbos/cerbos` 4,604★; v0.56.0 (2026-09-30) | PDP sidecar, YAML + CEL conditions | Authorization as a service | **feature request** (unprivileged image, 7 c) |
| Casbin | `apache/casbin` 20,409★; v3.11.0 (2026-08-20) | Model file + adapters that **load and save policy**; enforcement runs in process | Authorization as a config file; see §3.6 | `#710` BatchEnforce performance (15 c) |
| OPA | `open-policy-agent/opa` 12,299★; v1.21.1 (2026-09-29) | Rego policy engine | Same lesson at scale | **feature request** (decision labels, 33 c) |
| Appsmith | `appsmithorg/appsmith` 40,984★; v2.4.3 (2026-09-30) | Internal-tool builder | Declarative widgets, different domain | **epic / feature request** (reusable queries, 54 c) |

## 2. Comparison table

`Push` = does the authorization rule become part of the database query. `Hlth` = release recency.

| Project | Declared in | Derives | Auth model | Push | Extension model | Codegen vs reflection | Generated code committed? | Known complaints | Hlth |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ZenStack v2 | ZModel file (Prisma-compatible) | Client, CRUD, Zod, APIs, hooks | `@@allow` per model/op | **Yes** (run time, Prisma `where`) | Plugins | Codegen + `$extends` | `[unverified]` | #717 **feature request** (Supabase RLS codegen, 14 c) | v2 2026-06-06 |
| ZenStack v3 | ZModel file | Kysely ORM, client, Zod, APIs, tRPC plugin | `@@allow`, IR → Kysely nodes | **Yes**, per query | Plugins + adapters | Langium parse + type inference | `[unverified]` | #717 **feature request** (Supabase RLS codegen, 14 c) | v3.9.7 2026-09-30 |
| Remult | TS classes + decorators | CRUD, admin UI, REST/GraphQL | `allowApi*` / `apiPrefilter` / `backendPrefilter` | **Yes**, object filters | Decorators | Runtime | No | `#570` deleteMany deletes all (8 c) | 3.3.18 2026-08-30 |
| Wasp | **TS spec** `main.wasp.ts` (`@wasp.sh/spec`) | Server, client, routes, auth, DB, jobs, email | **None** (`authRequired`, `context.user`); roles are future work | No | Generator plugins `[unverified]` | **Build-time codegen (Haskell)** | **No — `.wasp/out` is gitignored** | #1088 **feature request** (mobile client, 28 c) | v0.25.0 2026-07-27 |
| RedwoodJS (GraphQL) | SDL + directory layout | Cells, loaders, tests, API | Directive-based `[unverified]` | No | SDL parts | Codegen | Partly | `#8861` dbAuth (24 c) | v8.9.0 2025-10-21 |
| RedwoodSDK | TS config | RSC app, routing, deploy | `[unverified]` | No | — | Codegen | `[unverified]` | `#632` React7.createContext (8 c) | v1.7.4 2026-09-23 |
| Keystone | `keystone.ts` list/field objects | GraphQL, REST, Admin UI, sessions | `access` functions incl. **filter** access | **Yes**, GraphQL filter | Hooks | Runtime + some codegen | No | `#8774` NODE_ENV build fails (18 c) | 8.1.0 2026-08-31 |
| Payload | `collections` config objects | GraphQL, REST, Admin UI, types, migrations | `access` returning `boolean \| Where` | **Yes**, Query | Plugins | Codegen + runtime | Generated types usually committed `[unverified]` | `#7312` HMR db leaks (60 c) | v3.90.2 2026-09-23 |
| Encore | `encore.app` TS config | Services, deploy manifests, secrets | `[unverified]` | No | Service definitions | Codegen + runtime | No | `#1641` intermittent 500s (9 c) | v1.58.6 2026-10-01 |
| Convex | TS schema helpers + server functions | Reactive queries, dashboard, deploy | Per-function checks `[unverified]` | Own storage engine | — | Runtime | No | `#96` local dev won't start (34 c) | convex 1.46.0 2026-09-16 |
| AdonisJS Lucid | TS model classes | ORM, migrations, relations | — | No | — | Runtime | No | Lucid `#1153` advisory lock on a different pool connection (4 c) | 22.4.2 |
| AdonisJS Bouncer | Abilities + Policies | — | **Ability/Policy, first-class** | `[unverified]` | Ability/Policies | Runtime | No | none found in this pass | 4.0.1 2026-08-21 |
| NestJS + nestjs-query | Decorated DTOs | DI, routes, CRUD GraphQL/REST | Guards | No | Modules/providers | Runtime | No | `#1538` "Is this project still Alive ?" (20 c) | v12.1.1 2026-09-28 |
| NestJS + CASL | `Ability` + `can()` | — | Ability rules | **Yes** via first-party `@casl/prisma` | Adapters | Runtime | No | `#8` sql & sequelize support (68 c) | @casl/prisma 2.0.2 |
| Platformatic DB | **Existing DB schema** (introspected) | GraphQL, REST, OpenAPI, subscriptions | `checks` per operation/role | **Yes**, where-clause operators | Config | Codegen + introspection | No | `#5042` worker stderr lost | 3.71.0 2026-09-29 |
| Amplication | UI-described entities + stack | Whole services, DTOs, Prisma, tests | Roles `[unverified]` | No | **Hooks on generated code** | **Codegen** | Generated into a real repo | #4654 **feature request** (Message Broker UI, 26 c) | v3.15.0 2026-04-02 |
| Hasura | SQL schema (migrations) | GraphQL API, console | Permission rules → **SQL constraints** | **Yes, in the generated SQL** (not RLS) | Haskell plugins | DB reflection | No | `#9592` memory leak (68 c) | v2.50.3 2026-09-09 |
| PostGraphile / Crystal | Postgres schema + smart tags | GraphQL API, SQL functions | **Developer-written RLS policies**; identity via `pgSettings` | **Yes, if you write the policies** | Smart tags (exposure only) | **DB reflection** | No | `#2564` subqueries not CTEs (24 c) | grafserv@1.0.2 2026-09-04 |
| Triplit | TS schema + `permissions` objects | Sync engine, clients | **Filters in the query language** (`$token`, `$role`) | Query-language evaluation | `[unverified]` | Runtime | No | `#196` Set fields not updated (8 c) | 1.1.10 2025-07-31 |
| InstantDB | Schema + rules | Sync, queries, client | **Separate CEL rule language** | Rules evaluated server-side | `[unverified]` | Runtime | No | `#2546` required relations (5 c) | 1.0.67 2026-08-31 |
| Zero | Schema + TS queries/mutators | Sync engine, server | **No first-class permission system** | n/a | — | Runtime | No | `rocicorp/mono`; no dominant open issue found in this pass | 1.9.0 2026-08-14 |
| TypeSpec | `.tsp` language | OpenAPI, JSON Schema, protobuf, 6 langs | **Not modelled** (`@typespec/security`) | N/A | **Emitter packages** | **Codegen** | Output is the artifact | #2463 **feature request** (AsyncAPI, 33 c) | 1.16.0 2026-09-09 |
| Effect Schema/SQL | Effect Schema `Model` (since 2024) | Repos, CRUD, batching, dialects | `Authorization` in `@effect/platform` `[unverified]` | Yes (parameterised SQL) | Schema/Context layers | **Runtime** | No | `#6378` Schema.toIso lens (10 c) | 4.0.0 2026-10-01 |
| tRPC | Procedure + Zod schema | Client types, validation, transport | None | N/A | Middleware | Runtime + types | No | #3297 **feature request** (RSC & App Layouts, 62 c) | v11.19.0 2026-09-16 |
| oRPC | Contract + schemas | Client, OpenAPI, RPC | None | N/A | Middleware | Runtime + types | No | `#1389` body serialization (8 c) | v1.15.4 2026-09-23 |

## 3. Expression-to-SQL in TypeScript

Every approach below is profiled with: mechanism, where the translation happens, the supported subset,
how unsupported constructs are reported, and maturity. **This section draws no verdict**; analysis is
in the final section.

### 3.1 Own grammar → IR, with SQL produced at run time: ZenStack v3

**Mechanism.** ZModel parses `@@allow` rules into a closed 10-kind `Expression` union
(`scratch/ash-src/zenstack/packages/schema/src/expression.ts:1-69`). A validator rejects anything
outside the translatable grammar with node-anchored errors
(`.../expression-validator.ts:86,240,245`). At **run time, on every query**, a Kysely plugin rewrites
the query: `PolicyPlugin.onKyselyQuery` → `PolicyHandler extends OperationNodeTransformer` →
`ExpressionTransformer`, which maps each IR kind to Kysely `OperationNode`s
(`.../plugins/policy/src/plugin.ts:28-31`, `.../policy-handler.ts:71`,
`.../expression-transformer.ts:174-896`).

**Where the translation happens.** Compile time for ZModel → IR; **run time per query** for IR → SQL.
Writes add pre-create/pre-update checks plus a post-update re-read with id-matching
(`.../policy-handler.ts:125-150,345-420`); updating an id field under a post-update policy is
unsupported (`.../policy-handler.ts:378`).

**Subset.** `CallExpression.function` is a bare string resolved from a registry. Some sub-expressions
are evaluated in memory rather than pushed down (`.../expression-transformer.ts:396,534`).

**Unsupported constructs.** Throw at run time: `Function not implemented: <name>`
(`.../expression-transformer.ts:754`). Non-CRUD Kysely queries are rejected unless
`dangerouslyAllowRawSql` is set (`.../policy-handler.ts:83-88`).

**Maturity.** `v3.9.7` (2026-09-30), 2,948★, `@zenstackhq/orm` 28,158 dl/wk plus v2's `zenstack`
54,081 dl/wk.

### 3.2 TypeScript AST → SQL at build time: Typhex

**Mechanism.** Two modes, from the README: "Typhex compiles those predicates to safe, parameterized
SQL through either a TypeScript transformer or a runtime parser" — *"Compile-time mode: The
transformer auto-captures closure variables and avoids runtime parsing"*; *"Runtime fallback: Plain
JavaScript and direct `tsx` scripts work with explicit closure variables"*
(https://github.com/kalyvasio/typhex). Transformer setup is
`compilerOptions.plugins: [{ transform: "typhex/transformer" }]` plus `ts-patch`.

**Where the translation happens.** Build time in transformer mode (via the TS compiler transformer
API, i.e. the TS 6 line — see §3.8); run time otherwise.

**Supported and unsupported constructs — the most concrete published TS-subset list in this
document.** From the README (https://github.com/kalyvasio/typhex/blob/main/README.md:243-255):
supported are comparisons `===`, `!==`, `==`, `!=`, `>`, `>=`, `<`, `<=`; logical `&&`, `||`, `!`;
member access, literals, array literals and `in`; string methods `.startsWith()`, `.endsWith()`,
`.includes()`; aggregates `count()`, `sum()`, `avg()`, `min()`, `max()`, `distinct(...)` in
`.select()`/`.having()`; relation predicates `department.employees.some((e) => …)` and
`.every((e) => …)`; relation query chains in `.select()`; and — per the Expressions guide — ternary,
arithmetic, bitwise and null-check expressions. **Not supported in runtime mode:** unsigned right shift
(`>>>`), optional chaining, nullish coalescing, arbitrary function calls, loops, assignments, `await`,
`new`, `instanceof`. Scalar subqueries in `.select()`, `.where()` comparisons and `.orderBy()` are
**transformer-only** (same file, `:225`).

**Unsupported constructs.** No diagnostic catalogue is documented; the runtime parser rejects what it
cannot parse.

**Maturity — a design sketch, not a precedent.** 1★, **one human contributor** (`kalyvasio`, 49
commits), **0 open issues** and 3 open dependabot PRs (GitHub's `open_issues_count` = 3 counts
PRs), created 2026-02-12, pushed 2026-09-14; npm `typhex` **0.1.0-alpha.1 (2026-06-15)**, **5 dl/wk**.

### 3.3 Runtime `Function.prototype.toString` parsing: Tinqer, lambdaorm, Typhex runtime mode, jsmql

**Tinqer — read from README and source.** README: *"A type-safe query builder for TypeScript. Queries
are expressed as inline arrow functions, parsed into an expression tree, and compiled into SQL for
PostgreSQL or SQLite. The API is similar to DotNet's LINQ-based frameworks"*
(https://github.com/tinqerjs/tinqer). Shape:

```ts
(q, params: { minAge: number }) =>
  q.from("users").where((u) => u.age >= params.minAge)
```

**How the lambda is obtained and parsed.** `packages/tinqer/src/parser/parse-query.ts:82-83` is the
whole mechanism: `const fnString = queryBuilder.toString();`. That string goes to `parseJavaScript()`
in `src/parser/oxc-parser.ts`, which calls `parseSync("query.ts", code, { sourceType: "module" })`
from **`oxc-parser` 0.150.0** — its only runtime dependency (`packages/tinqer/package.json:22-24`) —
and then `convertAstToQueryOperationWithParams` turns the AST into a `QueryOperation`. Results go
through `parse-cache.ts`, so a repeated identical query is not re-parsed.

**Supported expression subset** (README, "Expression Support"): comparisons `===`, `!==`, `>`, `>=`,
`<`, `<=`; logical `&&`, `||`, `!`; arithmetic `+ - * / %`; string `.includes()`, `.startsWith()`,
`.endsWith()`, `.toLowerCase()`, `.toUpperCase()`; null handling `??` and `?.`; array `.includes()` for
`IN`; case-insensitive helpers `helpers.functions.iequals/istartsWith/iendsWith/icontains`; window
functions `helpers.window(row).partitionBy(...).rowNumber()`, `.rank()`, `.denseRank()`; and opt-in
full-text search `helpers.fts.match(...)` / `.rank(...)` via `withFts`.

**How unsupported constructs are reported — specific internally, generic to the caller.** The visitor
does throw specific errors, e.g. ``Unsupported AST node type: ${type}`` (`visitors/index.ts:131`) and
``Unknown identifier '${name}'. Variables must be passed via params object or referenced as table
parameters.`` (`visitors/common/identifier.ts:59-62`). But `parseQuery` wraps the whole parse in
`try/catch`, logs `console.error("Failed to parse query:", error)` and **returns `null`**
(`parse-query.ts:153-159`). The plan layer then throws a **generic** error — "Failed to parse query"
(`plans/select-plan.ts:415-416`), "Failed to parse update builder or not an update operation", and the
corresponding delete and insert messages. **So the specific reason never reaches the caller** except
through console output. Separately, *"UPDATE requires a WHERE clause or explicit
allowFullTableUpdate() / allowFullTableDelete()"* is an **adapter-side SQL-generator safety check**
(`pg-promise-adapter/src/generators/update.ts:71`, `delete.ts:25`), not a report of an unsupported
construct. **There are no source spans anywhere** — at run time there is no source file in scope.

**The parse cache is keyed on source text.** `parseCache.set(fnString, frozen)` — the LRU is keyed by
the lambda's own source text, **enabled by default with capacity 1024**, configurable through
`setParseCacheConfig`, and results are deep-frozen (`parse-query.ts:86-94,145-149`;
`parse-cache-config.ts:28-29`). Consequence: it is a speed-up only, and two lambdas with identical
text but different closure bindings are indistinguishable to it.

**Only arrow-function builders parse.** The visitor dispatches on `"ArrowFunctionExpression"`
(`visitors/index.ts:116`) and the top-level builder must parse as a single expression statement
(`parse-query.ts:103-115`). `[read from code, not tested]` So a builder transpiled from an arrow to
`function` (ES5 targets) would fail to parse; and any tool injecting code into function bodies —
Istanbul coverage instrumentation is the obvious example — makes `toString()` return foreign
identifiers the visitor rejects. `[read from code, not tested]`

**Parameters and closures — stated by the project, not inferred.** "External variables must be passed
via the params object - closure variables are not supported"
(https://github.com/tinqerjs/tinqer/blob/main/docs/guide.md:1749; also README:598, "Lambdas cannot
capture external variables; use params object"). The code enforces it: an unrecognised identifier
throws (`visitors/common/identifier.ts:59-62`). Literals found in the lambda are auto-extracted into
`autoParams` (`parse-query.ts:23`) and bound.

**Row filters fail closed when no context is bound.** `row-filters.ts:88,486,530` throw "Row filters
require context binding. Call schema.withContext(context)." Context must be read by **direct property
access** — "Row filter context parameters must use direct property access (ctx.key)"
(`row-filters.ts:673`) — and a missing key throws `Row filter context is missing required key "<key>"`
(`:904`).

**Row filters — the closest existing analogue of Mesh's "policy = filter for reads".** README:

> "Row filters let you attach row-level predicates to a schema so that **SELECT/UPDATE/DELETE**
> automatically include them (useful for authorization scoping). This is enforced at plan finalization
> time and **fails closed** if you forget to bind context."

```ts
const rowFilteredSchema = dangerousUnrestrictedSchema.withRowFilters<ScopeContext>({
  users: (u, ctx) => u.orgId === ctx.orgId,
  posts: (p, ctx) => p.orgId === ctx.orgId,
});
const schema = rowFilteredSchema.withContext({ orgId: 7 });
```

with the notes: *"Filters must be provided for every table (set a table's filter to `null` to opt
out)"*; *"Row filters are not automatically applied to INSERT statements"*; and *"Unrestricted access
is done by using the base schema (`dangerousUnrestrictedSchema`) directly"*. Source:
`packages/tinqer/src/policies/row-filters.ts`. **Coverage is SELECT/UPDATE/DELETE, not INSERT.**

**Databases.** PostgreSQL (`@tinqerjs/pg-promise-adapter`) and SQLite
(`@tinqerjs/better-sqlite3-adapter`); the README notes SQLite's `executeInsert`/`executeUpdate` ignore
`RETURNING` at run time.

**Maturity.** 24★, **one contributor** (`jeswin`, 405 commits), **0 open issues**, MIT, created
2025-09-20, pushed 2026-09-28; 8 npm versions from 0.0.21 (2025-10-28) to 0.0.28 (2026-09-28),
npm only, no GitHub releases. Downloads per week: **228** core, **214**
`@tinqerjs/pg-promise-adapter`, **243** `@tinqerjs/better-sqlite3-adapter`.

**lambdaorm (λORM) — not inspectable.** The npm page shows the lambda syntax and
`orm.execute(query, params)`, but the GitHub repo linked from the org (`lambda-orm/lambdaorm`)
**returns 404** and the npm `package.json` has **no `repository` field**. The 2.3.15 tarball ships
obfuscated JS (javascript-obfuscator style, e.g.
`operand/application/services/operandBuilderCacheDecorator.js`), whose builder takes an expression
*string*. Its parser is the **`3xpr`** dependency (`"3xpr": "^1.15.27"`). `[unverified — obfuscated
build, no public source; the mechanism is inferred from the npm page only and is not counted as an
inspectable precedent.]` **2.3.15 (2025-06-02)**, **187 dl/wk** — the last release is over a year
before this document.

**jsmql.** Arrow-function form `jsmql(({ $ }) => …)` plus a tagged-template form, compiled to **MongoDB
MQL JSON, not SQL** (https://github.com/flash-oss/jsmql). 5★, 0 open issues, pushed 2026-09-27; npm
`@koresar/jsmql` **0.5.0 (2026-09-19)**, **67 dl/wk**.

**Where the translation happens.** Run time, every call. **Unsupported constructs.** See the Tinqer
account above for how these are reported — specific internally, generic to the caller, no spans.

**Also in this family, and not SQL-producing.** `LinqBox` (150★, `@sinclair/linqbox` 0.7.4, 1 dl/wk)
puts LINQ syntax inside a tagged template and parses it to ESTree, but it runs **in memory**, not
against SQL; `sqlizer` (18★, last push 2019) is an abandoned proof of concept; `ts-sql-query`
(318★, active) is a typed *builder*, not lambdas; `LinqToTypeScript` (157★) is in-memory LINQ.
(Stars and dates re-verified in round 3; the one-line classifications are the claim.)

### 3.4 Proxy / callback capture: Orange ORM, Drizzle relational, Convex

**Mechanism.** The callback receives a typed proxy or builder; every method call records a path that
becomes a filter AST. **Orange ORM** (https://github.com/alfateam/orange-orm) is the largest shipped
example — the README's example is
`where: x => x.customer(customer => customer.isActive.eq(true)…)`
(`README.md:711,723`). 1,017★, pushed 2026-10-01; npm `orange-orm` **5.5.0 (2026-09-05)**,
**15,978 dl/wk**.

**Same pattern elsewhere.** Drizzle relational queries take `where: (users, { eq }) => eq(users.id, 1)`
— callback-plus-builder. Convex queries take `.filter(q => q.eq(q.field('x'), 1))`.

**Subset.** Builder *methods* (`.eq`, `.startsWith`, `.and`), **not JavaScript operators** — so
`customer.isActive === true` does not work; you write `customer.isActive.eq(true)`. This is the price
of not needing a parser.

**Unsupported constructs.** Type errors and method-not-found at call time; there is no diagnostic
catalogue and no source span. **Where:** run time, as the filter object is built.

### 3.5 Builder DSLs and tagged templates

| Approach | Mechanism | Where | Push | Notes |
| --- | --- | --- | --- | --- |
| Kysely `sql` + `eb` | Tagged template (interpolations become bound params); `eb` builds expression trees | Run time | Yes | 14,253★, 20.5M dl/wk. The most-used escape hatch |
| Drizzle | Expression objects (`eq`, `and`) + `sql` template | Run time | Yes | 29.5M dl/wk |
| Prisma | Typed `where` object literal + `$queryRaw` | Run time | Yes | Prisma 8 compiles queries at runtime from the contract IR |
| Effect `sql` | `statement()` walks `TemplateStringsArray`; `Segment[]` IR with `and`/`or`/`join`/`in` | Run time | Yes | `scratch/ash-src/effect/packages/effect/src/sql/Statement.ts:670-701,718-753` |
| Prisma `TypedSQL` / ZenStack v2 `sql` | Hand-written SQL checked against the schema | Build time | Yes | Escape hatch when the DSL runs out |
| Sequelize / TypeORM `FindOptions` | Object literal | Run time | Yes | Older style |

Error quality is the weak point of this family: a wrong operator is a TypeScript error at most, and a
runtime error at worst — there is no mapping back to the query DSL that produced it.

### 3.6 Policy languages, and "permissions as queries"

- **ZModel rules (ZenStack)** — §3.1.
- **Triplit** — permissions *are* query-language filters:
  `filter: [['authorId', '=', '$token.sub']]`, resolved against a role or token
  (https://github.com/aspen-cloud/triplit/blob/main/packages/docs/src/pages/schemas/permissions.mdx:45-62).
  The query language is the policy language; there is no second compiler.
- **CEL** — the interchange format. **InstantDB** evaluates CEL strings per object
  (`"view": "auth.id != null"`, https://www.instantdb.com/docs/permissions). **Cerbos** policies are
  YAML with CEL conditions, evaluated by a sidecar PDP (4,604★, v0.56.0). OPA's Rego is the same move
  with different syntax. Both need explicit host integration before a condition can become SQL, which
  is the usual reason apps end up with a second, divergent, database-level auth layer.
- **Casbin — not a push-down example.** "Casbin loads and saves policy through adapters. The
  enforcer calls `LoadPolicy()` to load rules and, when supported, `SavePolicy()` to persist them"
  (https://casbin.apache.org/docs/adapters). Casbin does ship SQL, XORM, GORM and Ent adapters, but
  they are *policy storage*: MySQL, PostgreSQL, SQL Server, SQLite3, Oracle, TiDB. `Enforce()` walks
  the in-memory model; the adapters do not turn a policy into a query filter.
- **PostGraphile / Supabase RLS** — the developer writes `CREATE POLICY` by hand; the database
  enforces it. See §6.

### 3.7 Non-TypeScript precedents

C# LINQ expression trees, Scala Quill and the Python Pony ORM are the established precedents for
compiling a host-language expression to SQL. `[unverified — named as pointers; not re-fetched in
round 2. No claim is made here about their current state.]`

### 3.8 The platform constraint: TypeScript 7.0 has no compiler API

From the announcement (2026-07-08, https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/):

> "While TypeScript 7.0 is here, it does not ship with an API. We expect TypeScript 7.1 to ship with a
> new (and different) API, but until then we have made it a priority to ensure TypeScript can be run
> side-by-side with TypeScript 6.0 for utilities that still need some programmatic access to the
> compiler (such as typescript-eslint)."

> "As part of the 6.0/7.0 transition process, we've published a new compatibility package,
> `@typescript/typescript6`." … `npm install -D typescript@npm:@typescript/typescript6`

**What exists today.**

| Option | Package / version (2026-10-01) | Used by | Notes |
| --- | --- | --- | --- |
| TS 6 compiler API | `@typescript/typescript6` **6.0.2 (2026-07-06)** | Typhex transformer (via `ts-patch`) | Installed as `typescript@npm:@typescript/typescript6` |
| TS 7 compiler API | `typescript` 7.0.2 (2026-07-08) | — | **Does not ship one**; a new API is expected in 7.1 |
| oxc | `oxc-parser` **0.152.0** | **Tinqer** (pinned 0.150.0) | JS/TS parser, fast; ESTree-shaped output |
| SWC | `@swc/core` **1.16.13** | — | Rust-based; used by much of the bundler ecosystem |
| Langium | `langium` **4.4.0** | ZenStack (own grammar) | For an owned grammar, not TS source |
| `3xpr` (npm dep `^1.15.27`) | expression *string* parser | lambdaorm (build obfuscated, unverified) | `[unverified]` — obfuscated build, no public source |
| hand-written | own parser | jsmql | MongoDB MQL only, **not SQL** |

This matters directly to the Mesh plan's "TS AST to SQL compiler" and its stated fallback of
re-parsing expression text with the TypeScript compiler API: **that fallback is not available from
the `typescript` package as of 7.0**. It must go through `@typescript/typescript6`, or through oxc or
SWC.

### 3.9 Comparison table

| Approach | Input | Translation point | Parser | Subset | Unsupported → | Project | Version / size |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Own grammar → IR → SQL | ZModel `@@allow` | IR at build time; **SQL per query at run time** | Langium (own grammar) | 10 IR kinds, registry of functions | Node-anchored compile error; `Function not implemented` at run time | ZenStack v3 | 3.9.7, 2,948★, 28.2k dl/wk |
| TS AST → SQL (build time) | `.where((u) => …)` | Build time via TS transformer | TS 6 API + `ts-patch` | Published supported/unsupported list (README:243-255) | Runtime parser rejection | Typhex | 0.1.0-alpha.1, 1★, 1 contributor, 5 dl/wk |
| `toString` + parser | inline arrow functions | **Run time, every call** | `oxc-parser` 0.150.0 | Published expression list; row filters on SELECT/UPDATE/DELETE only | Specific visitor error caught, `console.error` logged, generic "Failed to parse query" thrown; **no source spans** | Tinqer | 0.0.28, 24★, 1 contributor, 228 dl/wk |
| `toString` + parser | lambda chain | Run time | `3xpr` (npm dep) | `[unverified]` — obfuscated build, no public source | Throw at run time | lambdaorm | 2.3.15, repo 404, 187 dl/wk |
| Proxy / callback capture | builder methods on a proxy | Run time as the filter is built | none needed | builder methods, **not JS operators** | Type error / method missing | Orange ORM | 5.5.0, 1,017★, 16.0k dl/wk |
| Builder DSL / tagged template | typed objects or template | Run time | n/a | whatever the builder has | Type error or runtime throw | Kysely, Drizzle, Prisma, Effect | hundreds of millions of dl/wk |
| Policy language | ZModel / CEL / Rego / Casbin model | Compile or load time, engine-specific | own | per language | Engine error | ZenStack, Cerbos, Casbin, InstantDB | mature |
| Query language as policy language | `where` tuples with `$token`/`$role` | Interpreted per query | own | query language | Open with no `permissions` object; deny per operation once one exists | Triplit | 1.1.10 |

## 4. DSL-to-code emitters

### 4.1 TypeSpec — the reference architecture

**IR.** A `Program` and `TypeChecker` built by the compiler core; emitters read types, not text. The
extension surface is `createTypeSpecLibrary`
(`scratch/ash-src/typespec/packages/compiler/src/core/library.ts:64`), which is how an emitter
registers its name, its diagnostics and its lifecycle handler; the `$onEmit` hook's options type is
`EmitOptionsFor<C>` (`.../core/types.ts:2925`).

**Plugin API.** `emitter-framework` is **a code-rendering library, not an IR-transform pipeline.**
`packages/emitter-framework/package.json` is version **0.21.0**, depends on
`@alloy-js/core|typescript|python|csharp` and builds with `alloy build` — it renders code through JSX
components. **TypeSpec's IR-transform package is `packages/mutator-framework`, at 0.17.1.** Both are
pre-1.0, so "shared framework removes the third-party-breaks-on-core-upgrade problem" is not
established by their version numbers.

**Diagnostics and error mapping.** Emitters declare a diagnostic catalogue up front (e.g.
`typescript-unsupported-type` at `severity: "error"`,
`typespec/.../emitter-framework/src/typescript/lib.ts:1-40`). The mapping back to the DSL is
`getSourceLocation(target)` in `typespec/packages/compiler/src/core/diagnostics.ts:119-131`, working
on `SourceLocation` / `DiagnosticTarget` (`.../core/types.ts:2309,2328`): an emitter reports a
diagnostic **against a Type or Node**, and the compiler resolves that to a `.tsp` position.
**There is no mapping from emitted output back to `.tsp`** — that is the gap, not an unknown.

### 4.2 Wasp — codegen into a gitignored tree

**Structure.** Haskell (`waspc/src/Wasp/`). `Wasp.AppSpec` is the parsed, validated specification.
`Wasp.Generator` orchestrates `genDb`, `genServer`, `genWebApp`, `genSdk`, `genDockerFiles`,
`genWaspLibs`, `genTypeAugmentation`, `validateExternalConfigsWithAppSpec`
(`Generator.hs:16-36`). `Wasp.Generator.FileDraft` is a sum type of draft kinds
(`FileDraftTemplateFd | FileDraftCopyFd | FileDraftCopyDirFd | FileDraftTextFd |
FileDraftCopyAndModifyTextFd | FileDraftCopyLibFd`), every kind sharing a `Writeable` class supplying
`write`, `getChecksum`, `getDstPath` (`Generator/FileDraft.hs:37-66`).
`WriteFileDrafts.synchronizeFileDraftsWithDisk` reads the checksum file, **deletes the whole generated
directory** if it is missing or corrupt, deletes the checksum file first so a crash cannot leave a
stale-but-valid manifest, writes only drafts whose checksum changed, deletes leftovers, then rewrites
the manifest (`Generator/WriteFileDrafts.hs:35-61`).

**Where the output goes.** `.wasp/out` (`Wasp/Project/Common.hs:87,93`), and Wasp's own starter
`.gitignore` starts with `.wasp/`
(`waspc/data/Cli/starters/skeleton/gitignore:1`). **The generated tree is not committed.** The
checksum mechanism therefore makes *incremental writes into a build directory* safe, not a committed
tree. It also compares new draft checksums with the *recorded* checksums rather than with the bytes on
disk (`WriteFileDrafts.hs:36-61`), so it would not notice hand edits to the output.

**Source mapping.** None. Wasp writes text files from templates; there is no map from a generated file
back to a spec line.

### 4.3 Prisma — the generator protocol (v7) and the contract IR (v8)

**v7: out-of-process generators.** A generator is declared in the schema
(`generator client { provider = "prisma-client-js"; output = "../generated/client" }`); `prisma
generate` launches it and hands it the **DMMF**, a JSON document model produced from the schema, and
the generator writes files. The third-party generator ecosystem exists because any language can speak
the protocol. The v7 helper package is `@prisma/generator-helper` (7.10.0, 2026-08-25). DMMF type
definitions and the JSON-RPC layer were **not re-read in round 2** — `[unverified]` at that level of
detail; the mechanism is documented in Prisma's generator docs.

**v8: contract-first.** `prisma` latest on npm is **8.0.0-rc.19 (2026-09-29)**, and the repo
describes it as "a contract-first model, where the schema is a stable, versioned artifact describing
the database structure — not fuel for codegen, but a data contract"
(https://github.com/prisma/orm/blob/main/ARCHITECTURE.md):

> "Deterministic JSON contract plus TypeScript types replace heavy runtime codegen"
> "Only PSL to IR to types emission happens at build time — query compilation happens at runtime"
> "Contract JSON is consumable by tools and agents"
> "First-class hook system for Plan lifecycle events (`beforeCompile`, `afterExecute`, `onError`)"
> "Extension packs for domain-specific capabilities (vector search, geospatial, etc.)"

**Agent-facing by design.** "Modern developer agents (Cursor, Windsurf, Claude Code) increasingly
read, reason about, and modify codebases. Prisma 8 is designed to be natively accessible to these
tools: 1. PSL as explicit contract — The IR is a deterministic JSON artifact: machine-readable,
diffable, and stable. 2. Stable query DSL — Queries are typed, composable ASTs that agents can
statically analyze or synthesize. 3. Runtime integration surface." And "Agents can read the schema
(IR), generate valid queries (DSL), and verify them (runtime) — all through open, structured artifacts
with no black-box client to reverse engineer."

**How the three compare.** Prisma's v7 protocol is the most *extensible* (any language, any author)
and the least *ergonomic* (JSON IR, no spans back to the DSL). TypeSpec's is the most *ergonomic*
(rich IR, in-process, diagnostics with `.tsp` spans) and the least decentralising. Wasp's sits in
between and is build-time, whole-tree, checksum-managed — but its output is gitignored.

**The missing piece in all three**, and the one Mesh's plan explicitly promises: **mapping from
emitted output back to the DSL**. TypeSpec maps diagnostics back; Wasp and Prisma do not.

## 5. The LLM angle

Evidence only. Three lists — §5.1 for, §5.2 against, §5.3 neutral — and no conclusion.
§7 and the final analysis carry the reading.

### 5.1 Evidence that structured or schema-first stacks help agents

- **Convex evals and leaderboard.** Seven eval categories — "fundamentals, data modeling, queries,
  mutations, actions, idioms, and clients" — combined with a scoring function over test cases. Result:
  "These curated set of rules increase the success rate of AI writing Convex code by about 20%",
  footnote: *"These results are for Claude 3.7-Sonnet and GPT-4o"*. Published with public
  no-guidelines and with-guidelines leaderboard tracks (https://stack.convex.dev/convex-evals,
  2025-03-19; https://www.convex.dev/llm-leaderboard; repo `get-convex/convex-evals`, 128★, pushed
  2026-10-01). **What is measured:** pass rate on a TypeScript API with and without curated guidance.
  **Limits:** it measures guidance and context, not DSL-vs-TypeScript; vendor-run; two models.
  Follow-up: "Convex Chef model comparison", 2025-04-28.
- **Prisma 8's design claims.** Deterministic JSON IR "consumable by tools and agents", a stable
  typed query DSL, runtime hooks, and `SKILL.md` files installed for agents (README, ARCHITECTURE.md).
  **What is measured:** nothing — these are design claims, not a benchmark.
- **ZenStack vendor posts.** "Code as Doc: Automate by Vercel AI SDK and ZenStack for Free"
  (https://zenstack.dev/blog/code-as-doc) argues LLMs handle declarative schema better than imperative
  code for doc generation; "How to Build AI Agents…"
  (https://zenstack.dev/blog/ai-agent). **What is measured:** nothing — qualitative vendor claims.
- **Wasp's own anecdote.** "We repeatedly hear from developers using Wasp that it is the stack that
  works best with AI" (Sosic, 2026-05-13), and "With AI and developers reviewing generated code less
  frequently, this became even more valuable".
### 5.2 Evidence against, or cutting the other way

- **Wasp's benchmark ran on the DSL.** The published comparison repo's Wasp app is
  `wasp/main.wasp` — `app saasStarter { wasp: { version: "^0.21.0" } … auth: { userEntity: User, …`
  (https://github.com/vincanger/token-compare-nextjs-wasp/tree/main/wasp) — i.e. the custom DSL, not
  the TypeScript spec the blog illustrates. In that run the DSL app still used **2,505,796 vs
  4,049,413 total tokens (38% fewer), 66 vs 96 API calls (31% fewer), 52 vs 66 tool uses (21%
  fewer), 12 vs 15 files read, $2.87 vs $5.17 (44% cheaper)**, with output tokens ~equal (5,416 vs
  5,395), duration 14.9m vs 15.0m (Vince Canger, 2026-03-26). **What is measured:** token and cost
  accounting for one Claude Code session per framework. **Limits:** n=1 per arm, no variance, no
  correctness or quality outcome reported, vendor-run with the vendor doing the conversion, repo at
  0★ last pushed 2026-03-25, README/post inconsistencies (45% vs 44%; output tokens reversed; the
  post's prose cache figures $2.15/$0.97 and $1.14/$0.67 do not match its own table). The vendor
  concedes a confound: "Claude has seen far more Next.js training data (advantage: Next.js)".
  Note the metric labels: **31% is API calls and 21% is tool uses**; files read is 12 vs 15 (the repo
  README says 20).
- **AutoCodeBench.** Tencent Hunyuan's 2025-08 benchmark (https://arxiv.org/abs/2508.09101) reported
  Elixir — a niche language — scoring highest of 20 languages in its results. **What is measured:**
  code generation over "3,920 problems evenly distributed across 20 programming languages"
  (https://arxiv.org/abs/2508.09101, 2025-08-12). **Limits:** a general-purpose language, not a DSL,
  and per-language figures are `[unverified]` here — read the paper's tables before quoting any
  number.
- **Wasp's stated reasons for dropping the DSL do not include LLMs.** They are positioning ("Lang" in
  the name), adoption friction, IDE-tooling cost ("we still only reached 80% of where we wanted to
  be"), and the low value of the syntax ergonomics (Sosic, 2026-05-13). No LLM or training-data
  reason appears in the post. (What to make of that is in `## Implications for mesh`.)
- **No independent, non-vendor comparison found** of agents on schema-first versus imperative
  JavaScript backends. `[unverified — negative result]`

### 5.3 Cold-start and difficulty evidence (neutral — not for or against)

These three show that generating code in a DSL or a low-resource language is **hard**, and what moves
the needle. They do not bear on whether a framework should have a DSL; they bear on how a DSL would
perform.

- **Wu et al., *A Survey on LLM-based Code Generation for Low-Resource and Domain-Specific
  Programming Languages*, ACM TOSEM 2025** (https://arxiv.org/abs/2410.03981): 111 papers; DSL/LRPL
  generation "remains a critical challenge" and has no standard benchmark. **Measured:** a survey, not
  a benchmark. **Limits:** nothing is JavaScript and nothing is a web framework.
- **Cassano et al., *Knowledge Transfer from High-Resource to Low-Resource Programming Languages for
  Code LLMs*** (MultiPL-T, revised 2024-09-22, https://arxiv.org/abs/2308.09895): measurable gains for
  low-resource languages from synthetic training data. **Measured:** translation and code-gen accuracy
  on MultiPL-E. **Limits:** full programming languages, not DSLs; data generation is itself costly.
- **Chand et al., *Leveraging LLMs for Multi-File DSL Code Generation: An Industrial Case Study***,
  2026-04-27 (https://arxiv.org/abs/2604.24678): on 7B models, fine-tuning gives the largest gains and
  one-shot in-context learning gives "smaller but consistent improvements". **Measured:** pass rates
  on an industrial multi-file DSL task. **Limits:** one industrial DSL, 7B models, not frontier models.

## 6. Other-language peers (brief)

- **Django + DRF** (`encode/django-rest-framework`, 30,197★, 3.18.1 2026-09-07) — models declare
  fields and relations; DRF derives serializers, viewsets, routers, filters, pagination and the
  browsable API. Authorization is a separate layer; query push-down is opt-in per filter backend.
  *Lesson: a derived API surface is not the hard part.*
- **Rails** (`rails/rails`, 58,786★, v8.1.4 2026-09-24) — ActiveRecord derives persistence,
  validations and associations. **Rails has no built-in admin generator** (round 1 said it did); admin
  comes from third-party gems. *Lesson: the pipeline (cast → validate → authorize → persist →
  respond) is what a resource framework sells.*
- **Laravel** — `laravel/framework` **34,943★**, latest release **v13.34.0 (2026-09-29)**; the
  `laravel/laravel` skeleton is 85,039★ (round 1 cited the skeleton for framework stars). Eloquent models plus Form Requests, Policies and Resources
  derive validation, authorization and API representation. *Lesson: policies as a first-class
  per-model, per-ability concept is the closest non-Elixir precedent to Ash's `authorize-if`.*
- **API Platform** (`api-platform/core`, 2,577★, v5.0.1 2026-09-25) — PHP attributes on Doctrine
  entities derive REST/GraphQL, an admin and OpenAPI. *Lesson: metadata on existing classes beats a
  separate DSL file.*
- **Gel / EdgeDB** (`geldata/gel`, 14,171★, v7.0 2025-11-05, last push 2025-12-24) — a schema
  language plus access policies compiled into the database engine. **The company is gone**: "Gel Data
  Inc. is shutting down, and our amazing team is joining Vercel"; Gel Cloud "will be fully shut down
  on Jan 31 of next year" (2026-01-31) (https://www.geldata.com/blog/gel-joins-vercel, 2025-12-02).
  *Lesson: the closest thing to Ash anywhere — and it required owning the database, and the company
  behind it still did not survive.*
- **Supabase RLS** (`supabase/supabase`, 110,980★) — authorization is `CREATE POLICY` expressions
  enforced by Postgres. *Lesson: strongest enforcement, worst ergonomics.*

## 7. Why none became "Ash for TypeScript" (facts only)

1. **ZenStack covers the resource layer best but stops there.** Its README feature list (schema-first
   ORM, query API, access control, polymorphism, CRUD APIs, TanStack hooks, Zod) contains no
   action-pipeline vocabulary (`scratch/ash-src/zenstack/README.md:37-47`).
2. **Wasp covers the app layer, abandoned its language, and still has no authorization model**
   (`web/docs/features/data/crud.md:438`), five years and 18,754★ in, at 0.25.0 with 5,150 weekly CLI
   downloads.
3. **Amplication is the only project whose stated goal was Ash-like generation, and it stalled.**
   16,016★, last default-branch commit 2026-04-02, npm plugins last published 2024.
4. **Prisma, Drizzle, Kysely and Zod are layers, not frameworks.** Between them they are the
   100M-400M-weekly-download substrate a resource framework would sit on; none attempts actions,
   policies-as-resources or a code-generation pipeline.
5. **The full-stack codegen projects are meta-frameworks, not resource frameworks.** Wasp, Redwood,
   Encore, Amplication and RedwoodSDK all start from *an app*; none starts from *a domain* with
   actions, changes and policies as first-class declarations.
6. **Push-down into SQL is not a differentiator.** Keystone, Payload, CASL, Remult, Platformatic,
   ZenStack and Triplit all do it. What separates them is *where the rule is authored*: an
   ORM filter object, a DSL, or the query language itself.
7. **The database-first projects require owning or tightly integrating the database**, and Hasura's
   engine is Haskell. PostGraphile is TypeScript but only reads Postgres, and its RLS policies are
   hand-written.
8. **The authorization packages derive no queries by default**; where they do (CASL), it is an ORM
   adapter maintained by the authorization vendor, not a general compiler.
9. **The RPC projects deliberately derive exactly one thing** — the wire contract — and treat the
   database as the developer's problem.
10. **Two of the closest projects lost their companies.** Gel Data Inc. shut down and joined Vercel
    (2025-12-02); Triplit's co-founder joined Supabase (2025-10-08) and Supabase says it does not plan
    to integrate Triplit. Blitz.js last pushed 2025-11-21. Redwood split into Redwood GraphQL and
    RedwoodSDK.

## Revision log (round 4)

Final check: ACCEPT-WITH-FIXES, no further revision round planned. Tinqer was re-read from a clone at
commit `41598b3` (`scratch/ts-prior-art-review/tinqer`, read-only). Nothing else in the document
changed.

| # | Sev | Change |
| --- | --- | --- |
| 1 | high | **Tinqer error reporting corrected** (§3.3 and the §3.9 "Unsupported →" cell). The visitor does throw specific errors — ``Unsupported AST node type: ${type}`` (`visitors/index.ts:131`), ``Unknown identifier '${name}'. Variables must be passed via params object or referenced as table parameters.`` (`visitors/common/identifier.ts:59-62`) — but `parseQuery` wraps the parse in `try/catch`, logs `console.error("Failed to parse query:", error)` and **returns `null`** (`parse-query.ts:153-159`), so the plan layer throws only a generic "Failed to parse query" (`plans/select-plan.ts:415-416`) and the specific reason never reaches the caller. The previous claim that "UPDATE requires a WHERE clause…" reports an unsupported construct was wrong: it is an **adapter-side SQL-generator safety check** (`pg-promise-adapter/src/generators/update.ts:71`, `delete.ts:25`). |
| 1a | med | **Added from the verified account**: the parse cache is keyed on the lambda's **source text**, on by default, **LRU capacity 1024**, configurable, results deep-frozen (`parse-query.ts:86-94,145-149`, `parse-cache-config.ts:28-29`); **errors carry no source spans**; **only arrow-function builders parse** (visitor dispatches on `"ArrowFunctionExpression"`, `visitors/index.ts:116`; single-statement builder, `parse-query.ts:103-115`) — stated as read-from-code, not tested; **row filters fail closed** with no context bound (`row-filters.ts:88,486,530`), context read only by direct property access (`:673`) and a missing key throwing (`:904`); current stars 24 and 228 dl/wk. |
| 2 | med | **Tables fixed.** §1.18 header (5 cells) and §2 header (10 cells) had shorter delimiter rows, so neither rendered; both delimiters now match. The split Payload cell `` `boolean \| Where` `` is now escaped. |
| 3 | med | **§3.8 parser table**: the `3xpr` and "hand-written" rows had been pasted from §3.9 and had 8 cells under a 4-column header; both rewritten as proper 4-cell rows. |
| 4 | low | **Duplicated Summary figures removed** — the token totals now appear once, with the per-metric detail folded into the following sentence. |
| 5 | low | **§5 ordering fixed**: §5.2 and §5.3 were swapped (the neutral list sat before the "against" list), and the intro said "Two lists" when there are three. |
| 6 | low | **Typhex count corrected**: 0 open issues and 3 open dependabot PRs (GitHub's `open_issues_count` = 3 counts PRs); one human contributor (`kalyvasio`, 49 commits). |
| 7 | low | **Complaint cells labelled by kind.** Twelve cells that are feature requests or discussions — zenstack #717, wasp #1088, typespec #2463, trpc #3297, amplication #4654, nest #1006, kysely #320, pocketbase #159, pothos #534, appsmith #1911, opa #6559, cerbos #2574 — are now marked **feature request**, **epic** or **discussion**. The column heading semantics are "most-discussed open issue", not "defect". |
| 8 | low | `autoParams` line corrected from `parse-query.ts:22` to `:23`. |
| 9 | low | **Zero complaints filled**: `rocicorp/mono` is searchable (157 open, including PRs); `rocicorp/zero` 404s. |
| 10 | low | **Lucid row fixed**: it cited an `adonisjs/core` issue. Replaced with `adonisjs/lucid#1153` (advisory lock released on a different pool connection, 4 comments); the core issue is still cited in the profile, where it belongs. |
| 11 | low | The `[unverified]` tag on LinqBox / sqlizer / ts-sql-query / LinqToTypeScript removed — their stars and dates were verified. |
| 12 | — | **All markdown tables in the document re-validated**: a script now checks that every table's delimiter row and every body row has the same cell count as its header, treating `\|` as an escape. Result: **0 mismatches** across the whole file. |

## Revision log (round 3)

The round-2 re-verification moved the verdict to ACCEPT-WITH-FIXES; this entry records what changed.

| # | Sev | Change |
| --- | --- | --- |
| 1 | high | **Casbin removed from every push-down list** (§1.18, §3.6, §7). Quoted the docs: "Casbin loads and saves policy through adapters. The enforcer calls `LoadPolicy()` to load rules and, when supported, `SavePolicy()` to persist them" (https://casbin.apache.org/docs/adapters). SQL/XORM/GORM/Ent adapters are *policy storage*; `Enforce()` runs in process. Confirmed against the adapter table on that page. |
| 2 | med | Summary corrected: **three** inspectable libraries compile arrow functions to SQL (Tinqer, Typhex, lambdaorm); jsmql does the same for **MongoDB MQL, not SQL**; Orange ORM is a **proxy builder** taking method calls, not operators. "None has adoption" replaced with per-project numbers, including Orange ORM's 15,978 dl/wk. |
| 3 | med | lambdaorm: the GitHub repo `lambda-orm/lambdaorm` 404s and the npm `package.json` has no `repository` field; the 2.3.15 tarball is obfuscated. Mechanism marked `[unverified — obfuscated build, no public source]`, parser identified as the `3xpr` dependency, and it is **not counted as an inspectable precedent**. |
| 4 | med | PostGraphile misquote replaced with the real page text ("PostgreSQL introduced much more granular permissions in the form of Row-Level Security (RLS) policies in PostgreSQL 9.5") plus the `create policy update_if_author on comments for update using ("userId" = current_user_id())` example. |
| 5 | med | Triplit default corrected to **both** halves: open with no `permissions` object, deny-per-operation once one exists (`permissions.mdx:150`). |
| 6 | med | **Tinqer deepened**: `parse-query.ts:82-83` (`queryBuilder.toString()`) → `oxc-parser.ts` `parseSync` → `convertAstToQueryOperationWithParams`; the published expression-support list; run-time error behaviour (`parseJavaScript` returns `null` + `console.error`; visitor throws e.g. *"UPDATE requires a WHERE clause…"*); the project's own closure statement (`docs/guide.md:1749`) instead of an inference; row filters quoted from the README with `withRowFilters<ScopeContext>` and the three notes (**SELECT/UPDATE/DELETE only, not INSERT**; every table must have a filter or `null`; unrestricted via the base schema); Postgres + SQLite adapters; **1 contributor, 0 open issues**. |
| 7 | med | **Typhex deepened** with the README's published supported/unsupported lists (README:243-255), and re-framed as what it is: **a design sketch** — 1★, one contributor, 1 open issue, 0.1.0-alpha.1, 5 dl/wk. |
| 8 | low | Summary "the DSL app still won" → "the DSL app used fewer tokens (2,505,796 vs 4,049,413)". |
| 9 | med | Analysis removed from §§5.2, 4.3, 1.15 and 1.18 and moved into `## Implications for mesh`, with a note saying so. |
| 10 | med | The three academic papers moved out of §5.1 ("evidence that structured stacks help agents") into a new neutral **§5.3 Cold-start and difficulty evidence**, each with what was measured and its limits. |
| 11 | low | The invented "Bander" parser row deleted; lambdaorm's parser row now says `3xpr`, jsmql's says hand-written. |
| 12 | low | Platformatic quote made exact: "automatically introspecting your database schema to create type-safe, fully-featured APIs". |
| 13 | low | Remult typo fixed to `backendPrefilter` / `backendPreprocessFilter`. |
| 14 | low | AutoCodeBench: "repository-level" and the unexplained `50.9%` removed; replaced with the abstract's own wording, "3,920 problems evenly distributed across 20 programming languages" (2025-08-12). |
| 15 | low | The unsupported clause "the search performed is recorded in Sources" deleted (Sources records no queries). |
| 16 | low | PocketBase and Medusa given primary doc URLs; `model.define` itself marked `[unverified]`. |
| 17 | low | ZenStack v2 row: "Prisma `where`" (Kysely arrived with v3). |
| 18 | low | Laravel health restored: `laravel/framework` 34,943★, v13.34.0 (2026-09-29); skeleton 85,039★. |
| 19 | low | jsmql given npm data: `@koresar/jsmql` 0.5.0 (2026-09-19), 67 dl/wk. |
| 20 | med | **"Known complaints" added for all 17 profiles** (one sourced open issue each, title + comment count, from the GitHub search API on 2026-10-01), plus new **Known complaints columns** in the §2 comparison table (25 rows) and the §1.18 table (19 rows). |

**Not fixed / left open in round 3.** (a) `model.define` in Medusa is marked `[unverified]` — the
Data Model Language resource is cited, the symbol was not re-fetched. (b) Zero's issues are not
searchable at `rocicorp/zero` (404); the complaints cell says so rather than inventing one.
(c) Adonis Bouncer still has no sourced push-down or complaint. (d) The `Writeable` class name in
§4.2 is Wasp's own spelling (`FileDraft.hs:3,26,45`), not a typo here. (e) §3.9's lambdaorm and jsmql
rows now duplicate the §3.8 parser table's granularity; left in place rather than restructured.

## Revision log (round 2)

Each row of the review's error table, and what changed. Sources were re-fetched before writing.

| # | Sev | Change |
| --- | --- | --- |
| 1 | high | Removed "a DSL agents have no training data for is a liability" from §Summary and §5; §1.3 now quotes the four stated reasons verbatim; added that Wasp's benchmark ran on the DSL. |
| 2 | med | Metric labels fixed: **31% is API calls, 21% is tool uses**, files read 12 vs 15 (README says 20). |
| 3 | high | Added Convex evals, leaderboard, Chef comparison, repo; "exactly one benchmark" and "no independent evidence" deleted. |
| 4 | high | §3 rebuilt: ZenStack is the precedent for *policy rules in a separate DSL*, not for predicates; Tinqer, Typhex, lambdaorm, Orange ORM, jsmql added; push-down projects added to §2. |
| 5 | high | ZenStack lowering corrected to run-time per query via a Kysely plugin, with file:line for `plugin.ts:28-31`, `policy-handler.ts:71`, `expression-transformer.ts:174-896,754`. |
| 6 | high | Effect: `makeRepository` dated to `@effect/sql@0.12.0` (2024-09-15); v4 = moved into core, not "gained". |
| 7 | med | Effect downloads labelled v3 (window 2026-09-23→29 predates 4.0.0). |
| 8 | high | Keystone, Payload, CASL, Remult, Platformatic corrected to push-down, each with a docs quote. "Never both" claim deleted. |
| 9 | med | "Push-down projects all use role/session context" deleted; ZenStack's per-field `@@allow` rules noted. |
| 10 | high | `@casl/prisma` 2.0.2, 194,893 dl/wk, first-party in the CASL monorepo — replaces "no widely-used ability → SQL compiler". |
| 11 | high | Hasura: permission rules → constraints in one SQL query, **not RLS** (new doc URL). PostGraphile: developer-written policies; smart tags are exposure only. |
| 12 | high | §1.14 and §3.6 rewritten: only Triplit is permissions-as-query; InstantDB is CEL; Zero has no permission system. |
| 13 | low | Zero repo resolved: `rocicorp/mono`, 3,397★. |
| 14 | med | Triplit's last publish now explained by the Supabase acquisition post (2025-10-08); moved to §7. |
| 15 | high | Wasp auth: none — the docs' own "we will be adding role-based authorization" line is quoted; the comparison table row changed. |
| 16 | high | Wasp output: `.wasp/out`, gitignored by Wasp's starter; the checksum manifest is described as making incremental writes into a *build directory* safe; the "adopt it for committed code" recommendation is withdrawn in the analysis section. |
| 17 | low | Wasp release date corrected to 2026-07-27 (GitHub `releases/latest`). |
| 18 | med | Wasp TS spec timeline added (0.15.0 preview, 0.24.0 rename, PRs #4334/#4369/#4335, hard error in 0.25.0) with `WaspFile.hs:36-42`. |
| 19 | low | "$5M raised, not spent" and "started back in 2021 when we went through Y Combinator". |
| 20 | high | `emitter-framework` corrected to a 0.21.0 Alloy JSX rendering library; `mutator-framework` (0.17.1) named as the IR-transform package; "solves breakage" withdrawn. |
| 21 | med | TypeSpec error mapping settled: `diagnostics.ts:119-131` `getSourceLocation`, `types.ts:2309,2328`; explicitly *no* output→`.tsp` mapping. |
| 22 | high | Prisma: v7 generator protocol + `@prisma/generator-helper`; Prisma 8 contract IR added with quotes from ARCHITECTURE.md; the DMMF `[unverified]` flag is narrowed to the type-definition level. |
| 23 | med | Prisma row updated to "contract-first, agent-friendly by default" and reused as §5.1 evidence. |
| 24 | high | TS 7.0 "does not ship with an API" quoted; `@typescript/typescript6` 6.0.2 and the parser table added (§3.8). |
| 25 | high | Proxy capture: Orange ORM documented from its README; Drizzle relational and Convex `.filter` named as the same pattern. |
| 26 | high | LINQ family replaced with real profiles: Tinqer, lambdaorm, Typhex, jsmql, plus LinqBox/sqlizer/ts-sql-query/LinqToTypeScript `[unverified]` pointers removed or kept only where sourced. |
| 27 | high | `Function.toString` parsing: the negative result deleted; Tinqer's `oxc-parser` dependency verified from `package.json`. |
| 28 | low | "shipping node-anchored errors since 2022" removed (no source). |
| 29 | low | ZModel described with the README's actual words ("compatible with Prisma's schema and API"); "zod-inspired"/"superset" removed. |
| 30 | low | Encore package corrected to `encore.dev` 1.58.6, 34,645 dl/wk; release date 2026-10-01. |
| 31 | med | Convex downloads 1,788,402 dl/wk. |
| 32 | low | Payload release date 2026-09-23. |
| 33 | low | NestJS release date 2026-09-28. |
| 34 | low | Hasura release date 2026-09-09. |
| 35 | low | nestjs-query: described as a fork (`TriPSs/nestjs-query`, 196★), not an org rename. |
| 36 | low | Redwood redirect named: `redwoodjs/graphql` ("Redwood GraphQL", 17,595★, v8.9.0 2025-10-21). |
| 37 | med | Platformatic DB corrected to DB-first with introspection; `checks` documented as a push-down. |
| 38 | med | Amplication: last commit 2026-04-02 (~6 months); plugins described as hooks on generated code, with the README quote. |
| 39 | med | Remult `apiPrefilter` / `backendPrefilter` documented from `docs/docs/access-control.md`. |
| 40 | med | Gel shutdown and Vercel acquisition recorded (§6, §7). |
| 41 | low | Rails admin claim removed. |
| 42 | low | `laravel/framework` vs `laravel/laravel` distinguished. |
| 43 | low | "Habra" typo fixed; PostGraphile claim corrected. |
| 44 | med | Opinion removed from fact sections and moved to the final analysis section. |

**Not fixed / left open.** (a) TypeSpec's `mutator-framework` was not read beyond its package version
— its actual transform API is `[unverified]`. (b) Prisma 7's DMMF type definitions and JSON-RPC layer
were not re-read; flagged inline. (c) Medusa v2, LoopBack 4, Feathers, Deepkit and Pothos are named with
health data but not profiled (time budget). (d) C# LINQ / Scala Quill / Pony ORM are pointers only,
marked `[unverified]`. (e) Adonis Bouncer's query-level push-down remains `[unverified]`. (f) The
AutoCodeBench Elixir figure was not read from the paper and is left `[unverified]`.

## Implications for Mesh (researcher's analysis)

This section is my reading, not sourced fact.

**Moved here from the fact sections in round 3.** Four readings were removed from §§1.15, 1.18, 4.3
and 5.2 so those sections stay factual: (a) TypeSpec "is the best reference for Mesh's compiler
architecture"; (b) Medusa's `model.define` is "the closest modern TS model DSL"; (c) Deepkit is
"architecturally closest to Mesh's ambitions"; (d) Prisma v8 is "the one to read first if Mesh's
emitted code is meant to be agent-facing", and Wasp's checksum story "does not transfer to a
committed tree"; and (e) Wasp's four stated DSL-removal reasons "do not support the DSL-is-a-liability
reading, and Wasp's own DSL benchmark points the other way". I still hold all five, and here they are.

**Wasp's reversal is real but it is not the argument round 1 made it into.** The stated reasons were
positioning, adoption, IDE tooling and ergonomics — developer-experience problems, none of them
"agents cannot learn this language". And Wasp's own benchmark put the `.wasp` DSL app 38% ahead of
Next.js on tokens. What the reversal shows is narrower: **a custom language carries a permanent
tooling tax, paid in editors, not in tokens.** Mesh's dialect inherits that tax; the plan's Phase 0
(plain TypeScript objects, no parser) is the right control experiment, and I would keep it.

**The density question is unanswered, and that is the finding.** Every quantitative source measures
context size (Wasp, n=1) or guidance (Convex, +20% pass rate). None measures "declarative
declaration versus the same thing in plain TypeScript". Mesh's Phase 0 is novel, not redundant.

**Where I now think the biggest risk sits.** Not the syntax — the syntax is a surface. It is that the
arrow-function-to-SQL path has no precedent at scale, and the platform just moved: TypeScript 7.0 ships
no compiler API. Every shipped library in §3.9 either lost closures to `toString` (Tinqer, lambdaorm,
Typhex runtime) or needs a compiler hook that depends on the TS 6 line (Typhex transformer). The
largest of them, Orange ORM, gave up on operators and uses builder methods. I would treat "the lambda
lost its variables" as the constraint to solve first — an explicit `params` object, a transformer, or a
documented function table — and pick the parser (`@typescript/typescript6`, oxc, or SWC) as an early,
replaceable decision rather than a commitment.

**What did not survive from round 1, stated plainly.** "ZenStack is the exactly one serious production
precedent for compiling predicates to SQL" — it is the one serious precedent for compiling a *DSL's*
predicates to SQL. "There is no widely-used ability→SQL compiler for Node ORMs" — `@casl/prisma` is
one, with 194,893 weekly downloads. "Authorization is either in-process or pushed down, never both,
and the push-down projects all use role context" — push-down is the majority pattern here. And "the
checksum manifest is the cheap, correct way to make a committed generated tree safe" — Wasp's manifest
guards a **gitignored** directory and would not notice hand edits to the output. The manifest *idea*
(delete the tree when the manifest is unreadable; delete the manifest first) is still transferable;
the "committed tree" premise was wrong, and a committed tree needs a different mechanism.

**What is now the strongest transferable idea.** Prisma 8's contract IR: a deterministic JSON
artifact, diffable and machine-readable, plus a stable typed query AST and runtime hooks — a contract
agents can read and check, with no black-box client to reverse-engineer. TypeSpec's
`getSourceLocation` is still the best available answer for error mapping, but note what it does *not*
do: nothing maps emitted output back to the DSL.

**Prisma 8 is the closest published precedent to "IR + JSON artifact + runtime query compilation"**,
so it is the one to read first if Mesh's emitted tree is meant to be agent-facing. Wasp's checksum
mechanism does not transfer to a committed tree for the reason given in §4.2: it guards a gitignored
directory and compares against recorded checksums, not bytes on disk.

**TypeSpec remains the best available reference for an emitter architecture** (rich IR, in-process
plugins, diagnostics with `.tsp` spans) — with the caveat that its shared rendering framework is
pre-1.0. On the JS "model DSL" question, Medusa v2's Data Model Language and Deepkit are the two
worth a profile each before any decision is made.

**On the LLM section.** The evidence is thin, vendor-heavy and bidirectional. Convex's +20% is the most
rigorous number available and it is about *curated guidance*, not language choice. AutoCodeBench's
Elixir result, if it holds, undercuts "training-data volume decides"; Wasp's DSL benchmark undercuts
"a bespoke DSL is a liability". I would not build a strategy on either horn.

## Open questions

1. **TypeSpec's `mutator-framework` API surface.** Confirmed to exist at 0.17.1 as the IR-transform
   package; its plugin contract was not read. This is Mesh's closest "IR transforms" precedent.
2. **Prisma 7's DMMF and generator JSON-RPC layer.** The protocol's shape is documented; the type
   definitions and the exact handshake were not re-read.
3. **ZenStack's plugin API** and the full v2 `$extends` vs v3 lowering path. IR and validators
   verified; the plugin surface was not.
4. **Adonis Bouncer's** Lucid-level push-down. Still `[unverified]`.
5. **Medusa v2, LoopBack 4, Feathers, Deepkit, Pothos** are named with health data only. Each deserves
   a profile; none was profiled in round 2.
6. **AutoCodeBench's per-language table** should be read directly before any figure from it is quoted.
7. **Non-TypeScript precedents** (C# LINQ expression trees, Scala Quill, Pony ORM) are pointers only.
8. **Wasp's unreleased 0.26.0** changelog (`wasp show spec --json`) was noted in the review but not
   verified against a release.

## Sources

**Local (shallow clones, read-only, under `scratch/ash-src/`)**

- `zenstack/README.md`, `packages/schema/src/expression.ts`,
  `packages/language/src/validators/expression-validator.ts`,
  `packages/plugins/policy/src/plugin.ts`, `policy-handler.ts`, `expression-transformer.ts`
- `effect/packages/effect/src/sql/Statement.ts`, `SqlModel.ts`, `SqlSchema.ts`, `SqlResolver.ts`,
  `SqlClient.ts`, `Migrator.ts`
- `typespec/packages/compiler/src/core/library.ts`, `types.ts`, `diagnostics.ts`;
  `typespec/packages/emitter-framework/src/typescript/lib.ts`, `packages/emitter-framework/package.json`
- `wasp/waspc/src/Wasp/Generator.hs`, `Generator/FileDraft.hs`, `Generator/WriteFileDrafts.hs`,
  `Project/Common.hs`, `Project/WaspFile.hs`, `Project/WaspFile/TypeScript.hs`,
  `data/Cli/starters/skeleton/gitignore`, `web/docs/features/data/crud.md`, `waspc/ChangeLog.md`

**URLs**

- Wasp: https://wasp.sh/blog/2026/05/13/new-language-for-web-dev-was-a-mistake (Sosic, 2026-05-13,
  footer "Last updated on Sep 30, 2026"); https://wasp.sh/blog/2026/03/26/nextjs-vs-wasp-40-percent-less-tokens-same-app
  (Canger, 2026-03-26); https://wasp.sh/sitemap.xml; https://github.com/vincanger/token-compare-nextjs-wasp/tree/main/wasp
- TypeScript: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ (2026-07-08)
- Authorization: https://keystonejs.com/docs/config/access-control;
  https://payloadcms.com/docs/access-control/collections;
  https://github.com/stalniy/casl/blob/master/packages/casl-prisma/README.md;
  https://github.com/remult/remult/blob/main/docs/docs/access-control.md;
  https://github.com/platformatic/platformatic/blob/main/docs/reference/db/overview.md and
  `docs/reference/db/authorization/rules.md`; https://hasura.io/docs/2.0/auth/authorization/permissions/;
  https://postgraphile.org/postgraphile/next/security;
  https://github.com/aspen-cloud/triplit/blob/main/packages/docs/src/pages/schemas/permissions.mdx;
  https://www.instantdb.com/docs/permissions; https://zero.rocicorp.dev/docs/permissions
- Lambda-to-SQL: https://github.com/tinqerjs/tinqer (+ `packages/tinqer/package.json`,
  `src/policies/row-filters.ts`); https://github.com/kalyvasio/typhex; https://www.npmjs.com/package/lambdaorm;
  https://github.com/flash-oss/jsmql; https://github.com/alfateam/orange-orm
- Emitters: https://github.com/prisma/orm/blob/main/ARCHITECTURE.md; https://github.com/prisma/orm
- LLM: https://stack.convex.dev/convex-evals (2025-03-19); https://stack.convex.dev/chef-model-exploration
  (2025-04-28); https://www.convex.dev/llm-leaderboard; https://github.com/get-convex/convex-evals;
  https://zenstack.dev/blog/code-as-doc; https://zenstack.dev/blog/ai-agent;
  https://arxiv.org/abs/2410.03981; https://arxiv.org/abs/2308.09895; https://arxiv.org/abs/2604.24678;
  https://arxiv.org/abs/2508.09101; https://www.convex.dev/
- Company events: https://www.geldata.com/blog/gel-joins-vercel (2025-12-02);
  https://supabase.com/blog/triplit-joins-supabase (2025-10-08)
- APIs: https://api.github.com/repos/<repo>, `/releases/latest`, `/commits`; `/contents`;
  `https://registry.npmjs.org/<pkg>`; `https://api.npmjs.org/downloads/point/last-week/<pkg>`
  for {wasp-lang/wasp, payloadcms/payload, encoredev/encore, nestjs/nest, hasura/graphql-engine,
  rocicorp/mono, aspen-cloud/triplit, alfateam/orange-orm, tinqerjs/tinqer, kalyvasio/typhex,
  flash-oss/jsmql, get-convex/convex-backend, get-convex/convex-evals, medusajs/medusa,
  loopbackio/loopback-next, feathersjs/feathers, blitz-js/blitz, pocketbase/pocketbase,
  marcj/deepkit, hayes/pothos, redwoodjs/graphql} and {encore.dev, @wasp.sh/spec, @tinqerjs/tinqer,
  typhex, lambdaorm, orange-orm, @casl/prisma, prisma, effect, @effect/sql, @triplit/db,
  @rocicorp/zero, @typescript/typescript6, typescript, oxc-parser, @swc/core, langium}

**Version notes.** All observations are 2026-10-01. Effect 4.0.0 was published the same day
(2026-10-01T03:11:28Z). Release dates come from GitHub `releases/latest` or the npm `time` field.
