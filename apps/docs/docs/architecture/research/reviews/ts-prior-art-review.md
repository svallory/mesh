---
title: "Review: TypeScript prior art"
description: "Independent fact-check of the TypeScript prior art document; final verdict ACCEPT-WITH-FIXES."
---

# Fact-check review: [`notes/research/06-ts-prior-art.md`](../ts-prior-art.md)

> Review of: [TypeScript prior art](../ts-prior-art.md).

VERDICT: ACCEPT-WITH-FIXES


Reviewer: independent fact-checker, 2026-10-01. I re-fetched every source named below on 2026-10-01. Local paths are under `/Users/svallory/work/mesh/scratch/ash-src/`.

## Why REJECT and not ACCEPT-WITH-FIXES

The Wasp headline is real, and the post is quoted accurately. The health numbers are mostly right. But the three sections the brief calls most important (criteria 3, 4 and 5) contain false claims that a designer would act on:

1. **Authorization push-down.** The document says Keystone, Payload and CASL check authorization in process and filter in memory. That is wrong: all three push the filter into the database query. It also says Hasura uses Postgres RLS (row-level security) and that PostGraphile generates RLS policies. Both are false.
2. **Expression-to-SQL.** The document gives "negative results" for TS-lambda-to-SQL, proxy capture and `Function.toString` parsing without having searched. At least five shipped TypeScript libraries do exactly this (Tinqer, Typhex, lambdaorm, Orange ORM, jsmql). Tinqer even ships row-filter policies. The document also describes ZenStack's SQL lowering as "compile time", but it happens at run time, per query, as a Kysely plugin. And it says nothing about TypeScript 7.0 shipping **no compiler API**, which the mesh plan's "TS AST to SQL compiler" depends on.
3. **Emitters.** The document says Wasp commits its generated code to the repo. It does not: the output goes to `.wasp/out`, which Wasp's own starter `.gitignore` excludes. The Wasp checksum manifest is presented as "the cheap, correct way to make a committed generated tree safe", but the code does not do that. TypeSpec's `emitter-framework` is described as an "IR transform pipeline". It is a 0.x library of Alloy JSX components for rendering code. TypeSpec's IR-transform package is `mutator-framework`. Prisma 8, a contract-first TypeScript rewrite that calls itself "AI-agent friendly by default", is missing entirely.
4. **LLM angle.** The summary says Wasp's benchmark is "the one published quantitative benchmark" and uses it as support for "a DSL agents have no training data for is a liability". But the benchmark repo shows the Wasp app was written in the **custom `.wasp` DSL** (`main.wasp`), not TypeScript. Even with the DSL it used about 38% fewer tokens than the Next.js app. So the only quantitative evidence in the document points the other way from the summary's conclusion. Convex's public eval suite and leaderboard, a second quantitative source, were also missed.

---

## Error table

Severity: **high** means a design decision would go wrong if taken from the document. **Medium** means a materially wrong or unsupported fact. **Low** means cosmetic or stale.

| # | Doc line | Claim in document | What the source actually says (URL / path) | Sev |
|---|---|---|---|---|
| 1 | 28-30, 692-697 | "A DSL that agents have no training data for is a liability", stated as the lesson of Wasp's reversal ("safety-relevant datapoint") | The Wasp post never mentions LLM training data as a reason. Its stated reasons are positioning ("Lang" in the name), adoption friction, IDE/tooling cost, and that ergonomics mattered less than expected (https://wasp.sh/blog/2026/05/13/new-language-for-web-dev-was-a-mistake). The benchmark's Wasp app used the `.wasp` DSL: `wasp/main.wasp` starts `app saasStarter { wasp: { version: "^0.21.0" } ...` (https://github.com/vincanger/token-compare-nextjs-wasp/tree/main/wasp). Fix: move the inference to the analysis section and add the counter-evidence that the DSL app was the cheaper one. | high |
| 2 | 31-36 | "31% fewer tool calls, 21% fewer file reads" | The post's table: **API calls** 66 vs 96 = 31% fewer; **tool uses** 52 vs 66 = 21% fewer; files read 12 vs 15 (the repo README says 20%). Fix the labels. | medium |
| 3 | 31, 646, 686-690 | "exactly one published quantitative benchmark … Wasp's"; "No independent benchmark found" | Convex publishes a quantitative eval suite: "Convex Evals: Behind the scenes of AI coding with Convex", 2025-03-19 (https://stack.convex.dev/convex-evals). It found guidelines "increase the success rate of AI writing Convex code by about 20%" (Claude 3.7 Sonnet, GPT-4o). There are also a public leaderboard with no-guidelines and with-guidelines tracks (https://www.convex.dev/llm-leaderboard/no-guidelines, …/with-guidelines), an eval repo (https://github.com/get-convex/convex-evals, 128★, pushed 2026-10-01), and a Chef model comparison, 2025-04-28 (https://stack.convex.dev/chef-model-exploration). | high |
| 4 | 37-42, 423-459 | ZenStack is the "exactly one serious production precedent" for compiling predicates to SQL in TS | True only for policy rules authored in a separate DSL. Shipped TS libraries compile **plain TS arrow functions** to SQL: Tinqer, Typhex, lambdaorm, Orange ORM (see check 4). TS frameworks that push authorization filters into SQL, using object filters rather than lambdas: Keystone `filter` access, Payload access functions returning a `Where`, Remult `apiPrefilter`/`backendPrefilter`, `@casl/prisma` `accessibleBy`, Platformatic DB `checks`. | high |
| 5 | 80-83 | ZenStack policies are "resolved at compile time into query filters" | At compile time ZModel becomes an `Expression` IR in a generated schema. The SQL is built **at run time on every query**: `PolicyPlugin.onKyselyQuery` → `PolicyHandler extends OperationNodeTransformer` → `ExpressionTransformer` maps each IR kind to Kysely `OperationNode`s (`zenstack/packages/plugins/policy/src/plugin.ts:28-31`, `policy-handler.ts:71,85`, `expression-transformer.ts:174-896`). Writes add pre-create/pre-update checks and **post-update re-reads** (`policy-handler.ts:125-150,345-420`). Some sub-expressions are evaluated in memory by `ExpressionEvaluator` (`expression-transformer.ts:396,534`). Unsupported functions throw at run time: `Function not implemented` (`expression-transformer.ts:754`). | high |
| 6 | 43-47, 338-345 | Effect v4 "gained" a derived CRUD layer; "newest and least-known entrant" | `makeRepository` already existed in `@effect/sql` 0.12.0, published 2024-09-15 (https://unpkg.com/@effect/sql@0.12.0/src/Model.ts, line 612). It is also in `@effect/sql` 0.52.1. v4 moved it into the `effect` package as `SqlModel` and added soft delete (`effect/packages/effect/src/sql/SqlModel.ts:1-12`). Fix: "moved into core in v4, exists since 2024". | high |
| 7 | 333-335 | "4.0.0 published 2026-10-01 … with 47,965,603 weekly downloads" | The publish date is right: npm `time["4.0.0"]` = 2026-10-01T03:11:28Z, GitHub `effect@4.0.0` = 2026-10-01T01:47Z. The download window is 2026-09-23 to 09-29, **before** 4.0.0 existed, so the 48M are v3 downloads. Fix the attribution. | medium |
| 8 | 53-55, 474-477, 542, table 397-398, 404 | Authorization is either in-process (Keystone, Payload, NestJS+CASL) or pushed to the DB, "never both"; these frameworks "filter in memory … full table scan" | Keystone: "Filter-level access control lets you restrict which items can be operated on by providing a function which returns a GraphQL filter … combined with the query filter" (https://keystonejs.com/docs/config/access-control). Payload: "Return a Query to limit the Documents to only those that match the constraint" (https://payloadcms.com/docs/access-control/collections). CASL: first-party `@casl/prisma`, whose `accessibleBy(ability).ofType('Post')` "returns an object aggregated from permission rules `WhereInput`" (https://github.com/stalniy/casl/blob/master/packages/casl-prisma/README.md). It has 194,893 downloads/week, and `@casl/mongoose` is also first-party. | high |
| 9 | 55 | "The push-down projects all use role/session context rather than resource-level policy functions" | Contradicted by ZenStack, which the same bullet lists: per-model `@@allow` rules over fields and relations. | medium |
| 10 | 243-248, 404 | "there is no widely-used, well-maintained 'ability → SQL' compiler for Node ORMs"; only "thin community adapters" (`casl-drizzle`, 17★) | `@casl/prisma` 2.0.2 is maintained in `stalniy/casl/packages/casl-prisma` and has 194,893 downloads/week (https://api.npmjs.org/downloads/point/last-week/@casl/prisma). | high |
| 11 | 287-290, 407-408, 511-513 | Hasura pushes auth "via row-level security derived from permission rules"; PostGraphile uses "RLS policies that PostGraphile *generates*" from smart tags; "Authorization literally becomes DDL" | Hasura: "converts incoming GraphQL requests into a single SQL query which includes constraints derived from the permission rules". These are WHERE clauses, not RLS (https://hasura.io/docs/2.0/auth/authorization/permissions/index/). PostGraphile does not generate policies. The developer writes them (`create policy update_if_author on comments …`), and PostGraphile passes identity through `pgSettings` (https://postgraphile.org/postgraphile/next/security). Smart tags control schema exposure, not policies. | high |
| 12 | 299-318, 409-411, 507-510, 541 | Triplit, InstantDB and Zero all express "permissions as expressions inside the query language" | Only Triplit fits: `permissions: { authenticated: { insert: { filter: [['authorId','=','$token.sub']] } } }` (https://github.com/aspen-cloud/triplit/blob/main/packages/docs/src/pages/schemas/permissions.mdx). InstantDB uses a **separate CEL rule language** in strings, e.g. `"view": "auth.id != null"`, checked per object (https://www.instantdb.com/docs/permissions). Zero: "Zero does not have (or need) a first-class permission system like RLS"; permissions are written in TS inside `defineQuery`/`defineMutator` (https://zero.rocicorp.dev/docs/permissions). Rewrite §1.14 and §3.5. | high |
| 13 | 302-303 | `rocicorp/zero` repo 404, so stars unknown | Zero lives in `rocicorp/mono`: 3,397★, pushed 2026-10-01 (`gh api repos/rocicorp/mono`). | low |
| 14 | 304-307, 892 | Triplit: last publish 2025-07-31, otherwise unexplained | Triplit's co-founder joined Supabase on 2025-10-08, and Supabase does not plan to integrate Triplit (https://supabase.com/blog/triplit-joins-supabase). Repo `aspen-cloud/triplit`: 3,116★, last push 2026-01-19. This belongs in criterion 7. | medium |
| 15 | 140-141, 394 | Wasp authorization: "Declarative role assignment on entities plus per-route guards"; table "Roles + route guards" | Wasp has no roles. The docs say: "In the future, we will be adding role-based authorization to Wasp" (`wasp/web/docs/features/data/crud.md:438`). What exists: `authRequired` on pages and `context.user` in operations. | high |
| 16 | 143-144, 394, 575-608, 791-796 | Wasp's generated app is "committed into the project"; the checksum manifest makes "a committed generated tree safe" | Output goes to `.wasp/out` (`wasp/waspc/src/Wasp/Project/Common.hs:87,93`), and the starter `.gitignore` begins `.wasp/` (`wasp/waspc/data/Cli/starters/skeleton/gitignore:1`). The checksum file only makes incremental writes into a **gitignored** build directory safe. Note also that it compares new draft checksums with the *recorded* checksums, not with the bytes on disk (`WriteFileDrafts.hs:36-61`), so it would not notice hand edits to the output. The analysis section's "adopt it verbatim … for committed code" stands on a false premise. | high |
| 17 | 124 | Wasp GitHub latest release `v0.25.0` (2026-09-30) | Released 2026-07-27T14:37Z (`gh api repos/wasp-lang/wasp/releases`). | low |
| 18 | 128-132 | Wasp "as of 2026 is a TypeScript spec" (sourced only to the homepage and a blog snippet) | Missing facts. The TS config shipped as a preview in 0.15.0 (`wasp/waspc/ChangeLog.md:606-612`). 0.24.0 (2026-06-11) renamed it "Wasp Spec", importing from `@wasp.sh/spec`. DSL reading was removed by PR #4334 (merged 2026-06-22) and the parser by PR #4369 (2026-06-25). The language server was removed by PR #4335. In v0.25.0 (2026-07-27) a `.wasp` file is a hard error: "Defining your app with the Wasp DSL (`main.wasp`) is no longer supported" (`waspc/src/Wasp/Project/WaspFile.hs:36-42`, and the same text at tag v0.25.0). The data model still lives in Prisma's `schema.prisma`. | medium |
| 19 | 22-27, 136-137, 737, 762 | Wasp spent "$5M" / "five years" | The post says "raised over $5M in total" (raised, not spent) and that the company started "back in 2021 when we went through Y Combinator". Wording is acceptable, but say "raised". | low |
| 20 | 48-52, 562-567 | TypeSpec `emitter-framework` is "an IR transform pipeline that emitters share" and "solves the 'third-party plugin breaks on core upgrade' problem" | `packages/emitter-framework/package.json` is version **0.21.0**, depends on `@alloy-js/core\|typescript\|python\|csharp`, and builds with `alloy build`. It is a JSX component library for *rendering* code. TypeSpec's IR-transform package is `packages/mutator-framework` (0.17.1). Both are pre-1.0, so the "solves breakage" claim is unsupported. | high |
| 21 | 569-573, 637 | TypeSpec mapping back to the DSL is `[unverified]` ("SourceMapper" not found) | The mechanism is in `typespec/packages/compiler/src/core/diagnostics.ts:119-131` (`getSourceLocation(target)`) and `types.ts:2309,2328` (`SourceLocation`, `DiagnosticTarget`). Emitters report diagnostics against a Type or Node, and the compiler resolves that to a `.tsp` position. There is no mapping from *emitted output* back to `.tsp`. Settle it in these terms. | medium |
| 22 | 610-628 | Prisma generator protocol / DMMF `[unverified]`; Prisma presented as "PSL → generated client" | Prisma 8 (npm `prisma` latest = 8.0.0-rc.19, 2026-09-29) is a TypeScript rewrite: "contract-first model … Deterministic JSON contract plus TypeScript types replace heavy runtime codegen … Contract JSON is consumable by tools and agents … Only PSL to IR to types emission happens at build time — query compilation happens at runtime", with an extension SPI and hooks (`beforeCompile`, `afterExecute`) (https://github.com/prisma/orm/blob/main/ARCHITECTURE.md). Prisma 7 (with `@prisma/generator-helper` 7.10.0, 2026-08-25) lives on the `v7` branch. Rewrite §4.3 around both: v7 generators plus the v8 contract IR. | high |
| 23 | 373 | Prisma row: "Schema → typed client, migrations, Studio" | Out of date for Prisma 8. Its README says it is "designed to be extensible, composable, and AI-agent friendly by default" and installs `SKILL.md` files for agents (https://github.com/prisma/orm). This is also LLM-angle evidence for criterion 5. | medium |
| 24 | 385 | "The compiler API (`ts.createSourceFile`) is what a TS-AST-to-SQL compiler would sit on", next to "TypeScript v7.0.2" | TypeScript 7.0 (2026-07-08): "While TypeScript 7.0 is here, it does not ship with an API … We expect TypeScript 7.1 to ship with a new (and different) API". The 6.0 API is available through `@typescript/typescript6` (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/). This matters directly for the mesh plan's "TS AST to SQL compiler" and "re-parse with the TS compiler API" fallback. | high |
| 25 | 461-480, 537 | Proxy capture: "not used by any of the serious projects … no maintained TS library" | Orange ORM (alfateam/orange-orm, 1,017★, npm `orange-orm` 5.5.0, 15,978/wk) takes filter callbacks over proxied column objects, e.g. `db.order.customer(customer => customer.isActive.eq(true))` (https://github.com/alfateam/orange-orm). Drizzle relational `where: (users, { eq }) => …` and Convex `.filter(q => q.eq(q.field(...)))` are the same callback-plus-builder pattern. | high |
| 26 | 482-487 | LINQ-style libraries are "post-hoc filtering … a dead end" | Tinqer: "Queries are expressed as inline arrow functions, parsed into an expression tree, and compiled into SQL for PostgreSQL or SQLite" (https://github.com/tinqerjs/tinqer). It has 24★, npm `@tinqerjs/tinqer` 0.0.28, 228/wk, and a `policies/row-filters.ts` module. lambdaorm: `Products.filter(p => (p.price > 5 && p.supplier.country == country))` run via `orm.execute(query, {country})` (npm `lambdaorm` 2.3.15, 2025-06-02, 187/wk). | high |
| 27 | 521-529, 536 | `Function.toString` parsing: "no project … doing it"; TS AST → SQL: "no production TS precedent found" | Tinqer calls `queryBuilder.toString()` and parses it with `oxc-parser` (`packages/tinqer/src/parser/parse-query.ts:7,83`; its only dependency is `oxc-parser` 0.150.0). Typhex compiles `.where((u) => u.age > 18)` "through either a TypeScript transformer or a runtime parser"; the transformer needs `ts-patch` (https://github.com/kalyvasio/typhex, 1★, 0.1.0-alpha.1, 5 dl/wk). jsmql parses arrow-function or template source into MongoDB queries (https://github.com/flash-oss/jsmql). All are small, but they exist and they show the real limits (see check 4). | high |
| 28 | 444-446 | ZenStack "has been shipping [node-anchored errors] since 2022" | No source given. Cite the first release that had the validator, or drop the year. | low |
| 29 | 69-72 | ZModel is "zod-inspired" and "a superset of Prisma's schema language" (cites README:29-49) | README:29 says "Modern schema-first ORM that's compatible with Prisma's schema and API". Neither "zod-inspired" nor "superset" appears there. | low |
| 30 | 187-189, 838 | `@encore.dev/cli` "not found" on npm | The package is `encore.dev`: 1.58.6, 34,645/wk (https://api.npmjs.org/downloads/point/last-week/encore.dev). Also, GitHub v1.58.6 was released 2026-10-01T08:37Z, not 09-30. | low |
| 31 | 197-199, 838 | `convex` downloads "not found" | 1,788,402/wk (https://api.npmjs.org/downloads/point/last-week/convex). | medium |
| 32 | 175 | Payload GitHub release v3.90.2 dated 2026-09-30 | 2026-09-23T14:04Z, the same day as the npm publish. | low |
| 33 | 226 | NestJS v12.1.1 dated 2026-09-30 | 2026-09-28T09:06Z. | low |
| 34 | 281 | Hasura v2.50.3 dated 2026-09-21 | Released 2026-09-09; 2026-09-21 is the last push. | low |
| 35 | 229-232 | nestjs-query "moved" by "an org rename" to `@ptc-org` | `@ptc-org/*` is published from the fork `TriPSs/nestjs-query` (196★); the original `doug-martin/nestjs-query` still exists (842★). It is a fork, not a rename. | low |
| 36 | 152-156, 395 | `redwoodjs/redwood` "redirects (the canonical name has changed)"; name not given | It redirects to **`redwoodjs/graphql`** ("Redwood GraphQL", 17,594★, v8.9.0 2025-10-21). Name it. | low |
| 37 | 252-259, 405 | Platformatic DB: derives from "app configuration … its own ORM with schema, migrations"; auth `[unverified]`; push-down "No" | DB-first: it "automatically generates GraphQL and REST APIs from your database schema … introspecting" (https://github.com/platformatic/platformatic/blob/main/docs/reference/db/overview.md). Authorization rules have `checks` such as `{ "userId": "X-PLATFORMATIC-USER-ID" }` using "the supported where clause operators" (docs/reference/db/authorization/rules.md:65-81). That is a push-down. | medium |
| 38 | 263-276, 739-740 | Amplication: "last push 2026-06-30 — roughly three months of no activity"; plugins "mutate the *entity model* before code generation" | The last default-branch commit is 2026-04-02 (v3.15.0, released 2026-04-02), so about six months. The plugins README says plugins let you "do almost anything you want with the generated code" (https://github.com/amplication/plugins). That is generated-code hooks; no source supports "mutate the entity model". | medium |
| 39 | 115-118, 393 | Remult decorators and filtering `[unverified]` | Easy to settle: `@Entity<Task>("tasks", { apiPrefilter: () => … return { owner: remult.user!.id } })`; "apiPrefilter adds a filter to all CRUD API requests"; `backendPrefilter` covers backend queries (https://github.com/remult/remult/blob/main/docs/docs/access-control.md:58-125). Push-down = yes, as object filters. | medium |
| 40 | 718-721, 381 | Gel: "its repo has been quiet since December 2025" (no reason given) | Gel Data Inc. is shutting down; the team joined Vercel; Gel Cloud shut down 2026-01-31 (https://www.geldata.com/blog/gel-joins-vercel, 2025-12-02). This is a key criterion 7 fact. | medium |
| 41 | 706-710 | Rails derives "(with a small DSL) the admin" | Rails has no built-in admin generator; admin comes from third-party gems. Remove it or cite a source. | low |
| 42 | 711 | Laravel stars from `laravel/laravel` | That repo is the app skeleton; the framework is `laravel/framework`. State which one you mean. | low |
| 43 | 747-749 | "PostGraphile/Habra are not TypeScript-first" | "Habra" is a typo for Hasura. The PostGraphile part is also wrong (see #11). | low |
| 44 | 28-30, 454-459, 692-697 | Opinion inside fact sections ("That is the single most important data point", "What this means for mesh", "Treat … numbers as marketing") | Breaks `_rules.md` rule 4. Move all of it to `## Implications for mesh`. | medium |

---

## Check 2: Wasp, verbatim

### 2a. "5 Years and $5M Later: Inventing a New Programming Language for Web Development Was a Mistake"

URL correct: https://wasp.sh/blog/2026/05/13/new-language-for-web-dev-was-a-mistake. Header: "May 13, 2026 · 19 min read · Matija Sosic, Co-founder & CEO @ Wasp". Page footer: "Last updated on Sep 30, 2026". The post exists, and every quotation in the research document matches the text.

Key passages, verbatim:

- "My twin brother and I started it back in 2021 when we went through Y Combinator, and raised over $5M in total."
- "Five years in, we realize it was a mistake. Creating a new language makes sense for certain problems and domains, but in this case, it wasn't a fit and brought us more trouble than it was worth."
- "…why we're replacing our custom language with TypeScript, while Wasp itself stays the same under the hood."
- TL;DR: "Developers resonated with the problem Wasp was solving, but the language was a tough sell. "Lang" in the name made them think our aim was to replace JavaScript (it wasn't) and were skeptical of how it'd work with their tooling." / "Many developers loved Wasp once they gave it a try. But getting them to try it out was the hard part." / "Adoption still grew, but as we kept pushing towards 1.0 we realised the "language" concern wasn't going away. Also, maintaining a good IDE experience for a custom language proved to be way harder than expected." / "It turned out having a custom language wasn't Wasp's core value. It was maintaining a high-level specification of the entire full-stack app, making it easier to reason about for both humans and AI." / "We decided to replace Wasp's config language with TypeScript. It is "only" an interface change, while everything else stays the same."
- On tooling: "We ended up developing our own language server and a VS Code extension for it, but since Wasp used Prisma's DSL as an embedded language and had many references to React & Node.js files, we still only reached 80% of where we wanted to be."
- On ergonomics: "Finally, the ergonomics we aimed for with the language didn't turn out to be as important as we thought. Developers are perfectly happy using TypeScript, a language they are familiar with, even if it requires a few extra lines and braces."
- Section heading: "Language was never the moat. It's having a high-level understanding of your entire app at compile time."
- "We only swapped the "front end" of the compiler, or how you define a high-level app spec in Wasp."
- On the TS SDK: "Every editor works out of the box. Developers can use conditionals, loops, and imports … Splitting the spec across multiple files becomes trivial."
- On AI, the only AI-specific claims: "With AI and developers reviewing generated code less frequently, this became even more valuable…" and "We repeatedly hear from developers using Wasp that it is the stack that works best with AI". These are anecdotal.

**The researcher's paraphrase** "the spec was the value and the language the tax" is a fair summary of "Language was never the moat", but the word "tax" does not appear in the post. Mark it as a paraphrase. **The stated reasons are positioning/adoption, IDE tooling cost, and low value of the syntax ergonomics.** Not one reason concerns LLMs or training data.

**What Wasp looks like now, from primary sources:**
- The spec is `main.wasp.ts`, called the "Wasp Spec" since 0.24.0, importing `@wasp.sh/spec`. `@wasp.sh/spec` is on npm: 0.25.0, 80 downloads/week. Example from the post: `app.page('LoginPage', { component: { importDefault: 'Login', from: '@src/pages/auth/Login' } }); app.route('LoginRoute', { path: '/login', to: loginPage }); app.query('getTasks', { fn: …, entities: ['Task'] }); app.job(…); export default app;`
- Removal timeline: TS config preview in 0.15.0. DSL file reading removed by PR #4334 (merged 2026-06-22). DSL parser removed by PR #4369 (2026-06-25). Language server removed (PR #4335, listed in the v0.25.0 notes). v0.25.0 (2026-07-27) rejects `main.wasp` with the hard error quoted in table row #18.
- Pipeline now: Haskell `analyzeWaspTsFile` runs a Node script against `main.wasp.ts`, receives JSON declarations, and merges them with entities parsed from `schema.prisma` (`waspc/src/Wasp/Project/WaspFile/TypeScript.hs`). AppSpec, the `Generator` monad, `FileDraft` and the checksum sync are unchanged. Output still goes to gitignored `.wasp/out`.
- **Kept:** the Haskell compiler and its AppSpec IR, all generators, Prisma's `schema.prisma` for the data model, the `wasp` CLI, `wasp studio` (and `wasp show spec --json` in the unreleased 0.26.0 changelog).

### 2b. "Next.js vs Wasp: 40% Less Tokens for the Same App"

URL correct: https://wasp.sh/blog/2026/03/26/nextjs-vs-wasp-40-percent-less-tokens-same-app. "March 26, 2026 · Vince Canger, Developer Relations @ Wasp".

- **Compared:** "We compared the two frameworks on the same feature prompt in the same app: Vercel's SaaS Starter." Wasp converted that starter to Wasp themselves ("we took Vercel's official SaaS starter app in Next.js and converted it to a Wasp (React, Node.js, Prisma) app").
- **Agent and models:** Claude Code. "same models (Opus for planning and implementation, Haiku for exploring)". Pricing table: "Opus 4.6 | $5.00 | $25.00 | $0.50 | $6.25". The protocol pins `CLAUDE_CODE_SUBAGENT_MODEL=claude-haiku-4-5-20251001` (https://github.com/vincanger/token-compare-nextjs-wasp/blob/main/code-generation-test.md).
- **Task:** a single "Team Announcements" feature (data model, two operations, a page, navigation, an activity type). The prompt is framework-neutral.
- **Runs:** **one session per framework** (plan plus implementation). No repetitions and no variance reported.
- **Numbers (post table):** cost $2.87 vs $5.17 ("44% cheaper"); total tokens 2.5M vs 4.0M (2,505,796 vs 4,049,413; "38% fewer"); API calls 66 vs 96 ("31% fewer"); tool uses 52 vs 66 ("21% fewer"); files read 12 vs 15; output tokens 5,416 vs 5,395 ("~same"); duration 14.9m vs 15.0m; cache creation $1.32 vs $2.82; cache read $1.09 vs $1.71. The researcher's §5 table matches the post. The summary bullet mislabels two rows (error #2).
- **The key fact the document misses:** the Wasp app in the published comparison repo uses **`main.wasp`, the custom DSL** (`app saasStarter { wasp: { version: "^0.21.0" }, … auth: { userEntity: User, … onAfterSignup: import { onAfterSignup } from "@src/auth/hooks" …`). The blog's illustrative snippets show `main.wasp.ts`, but the measured code base used the DSL.
- **Methodological weaknesses:**
  1. n=1 per arm; no variance.
  2. Vendor-run; the vendor did the conversion and chose the feature.
  3. No correctness or quality outcome is reported. The protocol says to "verify the app compiles and the feature works", but the results do not say whether either implementation passed.
  4. Internal inconsistencies:
     - The README reports output tokens Next.js 5,416 / Wasp 5,395, the reverse of the post.
     - The README says 45% cost reduction; the post says 44%.
     - The post's prose gives cache creation as "$2.15 vs $0.97" and cache read as "$1.14 vs $0.67", which do not match its own table ($2.82/$1.32, $1.71/$1.09). This is probably main-agent vs subagent accounting, but it is unexplained.
  5. The headline "~70% higher token efficiency (output per token)" is a ratio derived from the same single run.
  6. A confound acknowledged by the vendor: "Claude has seen far more Next.js training data (advantage: Next.js)".
  7. The Wasp codebase is ~40% smaller by design, so the experiment measures context size, not framework semantics.
  8. Repo: 0 stars, last push 2026-03-25; nobody independent has reproduced it.

---

## Check 3: LLM evidence (criterion 5)

Verified as cited: the Wasp post and benchmark (above), and the Convex tagline. The tagline is verbatim on https://www.convex.dev/: "All gas, no breakages. Convex is the reactive backend platform that keeps up with you and your agents."

Missed, **for** structured or schema-first stacks helping agents:
- **Convex Evals**, 2025-03-19 (https://stack.convex.dev/convex-evals): seven categories (fundamentals, data modeling, queries, mutations, actions, idioms, clients). Guidelines "increase the success rate of AI writing Convex code by about 20%" (Claude 3.7 Sonnet, GPT-4o). There is a public leaderboard with no-guidelines vs with-guidelines tracks (https://www.convex.dev/llm-leaderboard/no-guidelines) and an eval repo (https://github.com/get-convex/convex-evals). Note: this measures guideline/context effects on a TS API, not DSL vs TS.
- **Convex Chef model comparison**, 2025-04-28 (https://stack.convex.dev/chef-model-exploration).
- **Prisma 8** markets itself as "AI-agent friendly by default", ships per-version agent skills and a machine-readable contract JSON "consumable by tools and agents" (https://github.com/prisma/orm, ARCHITECTURE.md). These are design claims, not measurements.
- **ZenStack:** posts exist but they are not benchmarks. "Code as Doc: Automate by Vercel AI SDK and ZenStack for Free" (https://zenstack.dev/blog/code-as-doc) argues LLMs handle declarative schema better than imperative code for docs generation. "How to Build AI Agents…" is at https://zenstack.dev/blog/ai-agent. The researcher wrote "not found"; replace that with these URLs and their dates, labelled as qualitative vendor claims.

Missed, **for** the cold-start / low-resource concern:
- Wu et al., "A Survey on LLM-based Code Generation for Low-Resource and Domain-Specific Programming Languages", ACM TOSEM 2025 (https://arxiv.org/abs/2410.03981). It covers 111 papers and concludes DSL/LRPL generation "remains a critical challenge" and that there is no standard benchmark.
- Cassano et al., "Knowledge Transfer from High-Resource to Low-Resource Programming Languages for Code LLMs" (MultiPL-T), revised 2024-09-22 (https://arxiv.org/abs/2308.09895). It reports measurable gains for low-resource languages from synthetic training data.
- Chand et al., "Leveraging LLMs for Multi-File DSL Code Generation: An Industrial Case Study", 2026-04-27 (https://arxiv.org/abs/2604.24678). On 7B models, fine-tuning gives the largest gains and one-shot in-context learning gives "smaller but consistent improvements".

Missed, **against** a simple "less training data = worse" reading:
- AutoCodeBench (Tencent Hunyuan, 2025-08; https://arxiv.org/abs/2508.09101): Elixir, a niche language, scored highest of 20 languages in its reported results. This is a general-purpose language, not a DSL, but it weakens "training-data volume decides". The reported numbers come via secondary write-ups; the researcher should read the paper's table before citing figures.
- Wasp's own benchmark ran on the custom DSL and still came out cheaper (check 2b).

**Net:** the document's "exactly one benchmark" and "no independent evidence" are wrong. Its conclusion that Wasp proves DSLs hurt agents is not supported by any source. What the sources support: context size drives agent token cost (Wasp, n=1); curated guidance raises pass rates by about 20% (Convex); DSL code generation is a known research problem, eased by examples or fine-tuning (survey, Chand 2026).

---

## Check 4: Expression-to-SQL approaches (criterion 3)

**ZenStack v3, confirmed with corrections.**
- The IR is a closed 10-kind union (`zenstack/packages/schema/src/expression.ts:1-69`; `?`, `!`, `^` are the some/none/every collection predicates). It comes from ZModel, not from compiling TypeScript.
- Mechanism: `PolicyPlugin` implements `onKyselyQuery`, and `PolicyHandler` (a Kysely `OperationNodeTransformer`) rewrites each Select/Insert/Update/Delete node at run time. `ExpressionTransformer` maps IR kinds to Kysely nodes (`@expr('binary')`, `@expr('member')`, …).
- Writes: pre-create and pre-update checks, plus a post-update re-read with id-matching. Updating id fields under post-update policies is unsupported (`policy-handler.ts:378`).
- Calls: functions are resolved from a registry and throw at run time if not implemented (`expression-transformer.ts:744-754`).
- Fix: "compile-time" applies only to ZModel → IR. Lowering to SQL happens on every query at run time.

**Approaches the researcher did not search, found:**

| Library | URL | Mechanism | Maturity (2026-10-01) | Limits stated by the project |
|---|---|---|---|---|
| Tinqer | https://github.com/tinqerjs/tinqer | Runtime `Function.prototype.toString()` on the query builder lambda, parsed with `oxc-parser` into an expression tree, compiled to PostgreSQL/SQLite. LINQ-like `.where(u => u.age >= params.minAge)` | 24★, created 2025-09-20, pushed 2026-09-28; `@tinqerjs/tinqer` 0.0.28, 228/wk | External values must come through an explicit `params` object (no closure capture, since toString loses scope). Ships row-filter policies (`src/policies/row-filters.ts`): the closest TS analogue to "policy as filter from a lambda" |
| Typhex | https://github.com/kalyvasio/typhex | Two modes: a **TS transformer** (`compilerOptions.plugins: [{ transform: "typhex/transformer" }]` via `ts-patch`) that compiles predicates at build time and "auto-captures closure variables", or a runtime parser fallback that needs explicit closure variables | 1★, created 2026-02-12; npm `typhex` 0.1.0-alpha.1, 5/wk | Alpha. Depends on `ts-patch`, i.e. the TS 6 transformer API, which TS 7.0 does not provide |
| lambdaorm (λORM) | https://www.npmjs.com/package/lambdaorm | Whole query written as a lambda chain (`Products.filter(p => …).having(…).sort(…)`) passed to `orm.execute(query, params)` and parsed from source; targets MySQL, Postgres, Oracle, SQL Server, SQLite, MongoDB | 2.3.15 (2025-06-02), 187/wk; the GitHub org path in the npm link returned 404 from the API | Parameters passed explicitly; low adoption |
| Orange ORM | https://github.com/alfateam/orange-orm | Proxy/builder capture: callbacks receive typed column proxies (`customer => customer.isActive.eq(true).and(...)`) that build a filter AST | 1,017★, active (pushed 2026-10-01); `orange-orm` 5.5.0, 15,978/wk | Builder methods (`.eq`, `.startsWith`), not JS operators |
| jsmql | https://github.com/flash-oss/jsmql | A strict JS subset (template literal, and per its docs arrow-function source via `toString`) compiled to MongoDB MQL JSON | 5★, pushed 2026-09-27 | MongoDB only; useful as a design reference for "strict subset + hard errors" |
| LinqBox | https://github.com/sinclairzx81/linqbox | LINQ query syntax inside a tagged template, parsed to ESTree; in-memory generators | 150★; `@sinclair/linqbox` 0.7.4, 1/wk | Research project; in-memory, not SQL |
| sqlizer | https://github.com/jtheisen/sqlizer | Proof of concept: JS queries translated to SQL with TS types | 18★, last push 2019 | Abandoned PoC |
| ts-sql-query | https://github.com/juanluispaz/ts-sql-query | Typed builder ("like … Linq in .Net") | 318★, active | Builder, not lambdas |
| LinqToTypeScript | https://github.com/arogozine/LinqToTypeScript | In-memory LINQ | 157★; 4,023/wk | Not SQL (the doc's "dead end" is right only for this family) |

Callback-plus-builder APIs worth naming in the table: Drizzle relational `where: (t, { eq }) => eq(t.id, 1)` and Convex `.filter(q => q.eq(q.field('x'), 1))`.

Non-TS precedents the section should cite briefly: C# LINQ expression trees, Scala Quill, and Python Pony ORM. I did not re-verify these and did not count them as findings; the researcher must source them before citing.

**Platform constraint the section omits:** TypeScript 7.0 (2026-07-08) "does not ship with an API"; a new, different API is expected in 7.1; the 6.0 API is available as `@typescript/typescript6` (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/). Any build-time arrow-function compiler, mesh's included, must pick TS 6 API, another parser (oxc, as Tinqer does; or SWC/Babel), or wait for 7.1.

**What the evidence shows about limits.** Every lambda-to-SQL library above either:
- loses closures, so values must go through explicit params (runtime `toString`: Tinqer, lambdaorm, Typhex runtime mode), or
- needs a compiler hook to capture them (Typhex transformer).

None has meaningful adoption. The largest, Orange ORM, uses builder methods rather than JS operators.

---

## Statistics comparison

I re-checked 26 profiled projects plus 7 extras (the brief asked for at least 12).

| Project | Field | Doc | Actual (2026-10-01) | OK? |
|---|---|---|---|---|
| ZenStack | stars / release | 2,948 / v3.9.7 2026-09-30 | 2,948 / v3.9.7 2026-09-30 | yes |
| zenstack (v2) / @zenstackhq/orm | ver, dl | 2.22.3 (06-06) 54,081 / 3.9.7 28,158 | same | yes |
| zenstack-v3 repo | archived | yes, 99★, push 2026-02-10 | same | yes |
| Remult | stars / npm | 3,210 / 3.3.18 (08-30) 3,401 | same | yes |
| Wasp | stars / GH release | 18,754 / v0.25.0 **2026-09-30** | 18,754 / v0.25.0 **2026-07-27** | date wrong |
| @wasp.sh/wasp-cli | ver, dl | 0.25.0 (07-27), 5,150 | same | yes |
| @redwoodjs/core | ver, dl | 8.9.0 (2025-10-21), 4,941 | same | yes |
| redwoodjs/sdk | stars / rel | 1,712 / v1.7.4 09-23 | same | yes |
| Keystone | stars / npm | 9,981 / 8.1.0 (08-31) 18,277 | same | yes |
| Payload | stars / GH rel / dl | 45,045 / **09-30** / 1,060,642 | 45,045 / **09-23** / 1,060,642 | date wrong |
| Encore | stars / rel / npm | 12,405 / **09-30** / "not found" | 12,406 / **10-01** / `encore.dev` 34,645 | date + package wrong |
| Convex | stars / npm dl | 12,632 / **"not found"** | 12,632 / **1,788,402** | dl wrong |
| AdonisJS | stars / rel / lucid / bouncer | 19,139 / v7.5.2 09-23 / 174,367 / 39,936 | same | yes |
| NestJS | stars / rel / dl | 76,777 / v12.1.1 **09-30** / 17,940,374 | 76,775 / **09-28** / 17,940,374 | date wrong |
| @ptc-org/nestjs-query-core | ver, dl | 11.0.0-alpha.1 (09-20), 45,696 | same | yes |
| CASL | stars / ver / dl | 7,090 / 7.0.1 / 2,027,217 | same | yes |
| Platformatic | stars / ver / dl | 2,060 / 3.71.0 / 3,667 | same | yes |
| Amplication | stars / activity | 16,016 / "3 months" | 16,016 / last commit 2026-04-02 (~6 months) | activity wrong |
| Hasura | stars / rel | 32,130 / v2.50.3 **09-21** | 32,130 / **09-09** | date wrong |
| graphile/crystal | stars / rel | 12,933 / grafserv@1.0.2 09-04 | same | yes |
| TypeSpec | stars / ver / dl | 5,877 / 1.16.0 / 314,963 | same | yes |
| Effect | stars / ver / dl | 16,327 / 4.0.0 10-01 / 47,965,603 | same; dl window predates 4.0.0 | attribution wrong |
| tRPC | stars / rel / dl | 40,682 / v11.19.0 09-16 / 6,140,518 | same | yes |
| oRPC | stars / dl | 5,658 / 1,754,881 + 2,016,298 | 5,659 / 1,753,881 + 2,016,298 | yes (±1k) |
| InstantDB | stars / ver / dl | 10,536 / 1.0.67 / 254,339 | same | yes |
| Zero | stars | "Not Found" | rocicorp/mono 3,397 | gap |
| Triplit | ver / dl | 1.1.10 (2025-07-31) / 203,175 | same | yes |
| Prisma / Drizzle / Kysely / Zod | stars, ver, dl | as doc | match (Kysely 14,253) | yes |
| Gel / Cerbos / Casbin / DRF / Rails / Laravel / API Platform / Supabase | stars, rel | as doc | match | yes |

**Totals: 33 projects checked. 25 fully match, 8 have at least one wrong field.** By field: about 95 fields checked, 10 wrong or missing (Wasp, Payload, Encore, NestJS and Hasura release dates; Encore package; Convex downloads; Amplication activity; Effect attribution; Zero repo). Stars and download counts are reliable. Release dates are not: the researcher often took `pushed_at` as the release date.

## Citation sample statistics

Sampled: **43 citations** (32 URLs/API endpoints, 11 local paths). **Supports: 34. Partial: 7. Does not support: 2. Dead links: 0.**

- **Partial** (number right, attached claim wrong):
  - api.github wasp-lang/wasp (release date)
  - payloadcms/payload (date)
  - encoredev/encore (date)
  - nestjs/nest (date)
  - hasura/graphql-engine (date)
  - `zenstack/README.md:29-49` (no "zod-inspired"/"superset")
  - npm `effect` downloads (v3 window credited to v4)
- **Does not support:**
  - the npm downloads endpoint for `convex`: it returns 1,788,402, so the doc's "not found" is wrong
  - `typespec/packages/emitter-framework/src/typescript/lib.ts:1-40`: it shows a diagnostic catalogue, but is used to support "an IR transform pipeline", which the package (Alloy JSX components, 0.21.0) contradicts
- **Supports** (verified verbatim or by value):
  - Both Wasp posts (all §5 quotes match; the §5 table matches)
  - wasp.sh banner "100% TypeScript"
  - convex.dev tagline
  - GitHub stars for zenstack, remult, redwoodjs/sdk, keystone, convex-backend, adonisjs/core, doug-martin/nestjs-query, stalniy/casl, platformatic, amplication, graphile/crystal, typespec, Effect-TS/effect, trpc, middleapi/orpc, instantdb, geldata/gel
  - npm figures for zenstack, @zenstackhq/orm, payload, @casl/ability
  - `zenstack/packages/schema/src/expression.ts:1-69`; `expression-validator.ts:86,240,245`; `README.md:52-56,59-63`
  - `wasp/waspc/src/Wasp/Generator.hs:16-36`; `Generator/FileDraft.hs:37-66`; `Generator/WriteFileDrafts.hs:35-61` (mechanism correct; the "committed" claim built on it is not)
  - `typespec/.../library.ts:64`; `types.ts:2925`
  - `effect/.../SqlModel.ts:1-31`; `Statement.ts:670-701` (line counts 362/181/415/520/1,593/464 exact)
- **Uncited claims found:** Wasp roles, Hasura RLS, PostGraphile-generated RLS, Triplit/Instant/Zero semantics, Keystone/Payload in-memory filtering, Amplication entity-model plugins, "since 2022", Rails admin.

## Acceptance criteria

| # | Criterion | Status | What is missing / wrong |
|---|---|---|---|
| 1 | Project profiles | **Partial** | All 18 named are present, but: the "known complaints" field is `[unverified]` or absent for nearly every project (required by the brief); backing (funding/company) is missing for most; extension model is `[unverified]` for 10. Wrong facts: Wasp auth/committed output, Keystone/Payload/CASL/Platformatic/Remult push-down, Hasura/PostGraphile mechanism, Triplit/Instant/Zero, Amplication plugins. Absent but relevant: **Prisma 8** (contract-first, agent-first), **Medusa v2** (medusajs/medusa, 36,542★, TS `model.define` data-model DSL; verify it derives migrations/services), **LoopBack 4** (loopbackio/loopback-next, 5,108★, model-driven REST/OpenAPI), **Feathers** (15,259★, schema + resolvers + hooks), **Blitz.js** (14,126★, last push 2025-11-21; named in the Wasp post as a peer that faded), **Redwood GraphQL** naming, **PocketBase** (61,230★, API rules as filter expressions pushed into SQL; Go, but a direct policy-as-filter precedent), **Pothos**, **Deepkit** (marcj/deepkit, 3,543★, last push 2026-02-11). |
| 2 | Comparison table | **Partial** | The table exists, but it lacks the brief's *health* and *known complaints* columns and repeats errors #8, #11, #12, #15, #16, #37. |
| 3 | Expression-to-SQL | **Partial (fails on substance)** | Proxy capture, `Function.toString`, build-time AST and LINQ-to-SQL were all declared absent without searching. Tinqer, Typhex, lambdaorm, Orange ORM and jsmql exist. ZenStack mechanism misdescribed. TS 7.0 no-API constraint missing. Non-TS precedents absent. |
| 4 | DSL-to-code emitters | **Partial** | TypeSpec emitter-framework mischaracterized. `mutator-framework` missing. TypeSpec diagnostics mapping left `[unverified]` though it is in `diagnostics.ts:119-131`. Wasp's current pipeline (TS spec → Node analyzer → JSON decls) not described; output wrongly said to be committed. Prisma generator protocol `[unverified]`; Prisma 8 contract IR missing. |
| 5 | LLM angle | **Partial** | Wasp posts found and quoted accurately. Missed: Convex evals and leaderboard, ZenStack posts (exist, qualitative), Prisma 8 agent design, academic DSL/low-resource literature. The benchmark-ran-on-DSL fact is missing and the conclusion drawn is unsupported. |
| 6 | Other-language peers | **Complete (minor errors)** | Rails "admin" claim; `laravel/laravel` vs `laravel/framework`; Gel shutdown not mentioned. |
| 7 | Why none became Ash-for-TS | **Partial** | Fact #6 is wrong (Hasura/PostGraphile) and has the "Habra" typo. Missing facts: Gel company shut down and the team joined Vercel (2025-12-02); Triplit's founder joined Supabase (2025-10-08); Blitz faded; Redwood split into Redwood GraphQL and RedwoodSDK; Wasp still has no authorization model ("In the future, we will be adding role-based authorization"). |

Other rule breaches:
- Word count is 9,037, above the 3,000–6,000 target.
- Analysis appears in fact sections (row #44).
- Many claims are labelled "from general knowledge", which `_rules.md` rule 2 forbids unless marked. Several are not marked: Hasura RLS, PostGraphile, Keystone/Payload in-memory.

## Required fixes, in priority order

1. Rewrite §3: add the check 4 table; correct the ZenStack mechanism; add the TS 7.0 API constraint; delete the false negative results.
2. Correct authorization push-down everywhere: Summary bullet 8, §1.5, §1.6, §1.10, §1.11, §1.13, §3.2, §3.5, the §3.7 table, §2 table, §7 #6 and #7. Use the sources in rows #8, #10, #11, #37 and #39.
3. Rewrite §1.14 and §3.5 for Triplit (filters), InstantDB (CEL) and Zero (no permission system; TS queries and mutators).
4. Fix Wasp: auth (none), output gitignored, DSL removed in v0.25.0, Wasp Spec package. Retract "adopt the checksum manifest for committed code" or rebase it on what the code actually does.
5. Fix §4: TypeSpec emitter-framework vs mutator-framework, `getSourceLocation`, Prisma 7 generator-helper plus the Prisma 8 contract IR.
6. Fix §5 and the Summary: correct the metric labels; state that the benchmark ran on the `.wasp` DSL with n=1 and no correctness outcome; add the Convex evals, ZenStack posts, Prisma 8 and the academic sources; move all inference to the analysis section.
7. Fix Effect (since 2024 in `@effect/sql`; downloads are v3) and the health dates listed above.
8. Add the missing projects listed under criterion 1, and fill the "known complaints" and "backing" fields.

---

## Round 2 re-verification

Reviewer, 2026-10-01. Checked the revised [`06-ts-prior-art.md`](../ts-prior-art.md) (10,631 words, with `## Revision log (round 2)`) against primary sources, re-fetched today.

**New verdict: ACCEPT-WITH-FIXES.** Every high row from round 1 is now correct at the source. The remaining problems are local:
- one false push-down claim (Casbin) that round 1 also missed;
- a wrong count in the Summary;
- one misquote;
- under-reported limits for the two libraries that matter most to mesh (Tinqer row filters, the Typhex subset);
- an unverifiable precedent (lambdaorm);
- some analysis still inside fact sections.

### R2.1 Round-1 rows: status after revision

| Round-1 rows | Result |
|---|---|
| High: 1, 3, 4, 5, 6, 8, 10, 11, 12, 15, 16, 20, 22, 24, 25, 26, 27 | **Fixed and correct at source**, with these residues: 1 (see R2.4 #8, #9), 4 (see R2.4 #2), 11 (PostGraphile quote, R2.4 #4) and 26 (lambdaorm, R2.4 #5). Checked at source: ZenStack run-time lowering (`plugin.ts:28-31`, `policy-handler.ts:71,83-88,125-150,378`); `makeRepository` in `@effect/sql@0.12.0` documented "Create a simple CRUD repository from a model" (unpkg `Model.ts:605-612`); Keystone/Payload/CASL/Remult/Platformatic quotes; Hasura quote verbatim, and the page has no "RLS" or "row-level"; InstantDB CEL and Zero "does not have (or need) a first-class permission system" verbatim; Wasp `crud.md:438`, `.wasp/out` gitignored; `emitter-framework` 0.21.0 Alloy, `mutator-framework` 0.17.1; Prisma 8 ARCHITECTURE quotes (lines 117, 124 for the agent passage); both TS 7.0 quotes verbatim. |
| Medium: 2, 7, 9, 14, 18, 21, 23, 31, 37, 38, 39, 40, 44 | Fixed: 2, 7, 9, 14, 18 (ChangeLog `93-99`, `606-612` confirmed), 21, 23, 31, 38, 40. Mostly fixed: 37 (misquote, R2.4 #12) and 39 (typo, R2.4 #13). **Partly fixed: 44**, since opinion remains (R2.4 #9). |
| Low, sampled half: 13, 17, 19, 29, 30, 32, 35, 36, 41, 43 | All fixed. |
| The 8 health rows | All correct now: Wasp 2026-07-27, Payload 09-23, Encore v1.58.6 10-01 / `encore.dev` 34,645, Convex 1,788,402, NestJS 09-28, Amplication last commit 04-02, Hasura 09-09, Effect downloads labelled v3, Zero = `rocicorp/mono` 3,397★. |

### R2.2 Section 3, profile by profile

| Profile | Exists at URL | Mechanism correct | Where translation happens | Subset as documented upstream | Unsupported → | Maturity (verified) | Verdict |
|---|---|---|---|---|---|---|---|
| ZenStack v3 | yes (local clone 3.9.7) | yes | IR at build time, SQL per query at run time | 10 IR kinds; function registry | node-anchored validator errors; `Function not implemented` at run time; non-CRUD Kysely queries rejected unless `dangerouslyAllowRawSql` (`policy-handler.ts:85-92`) | 3.9.7 / 2026-09-30 / 28,158 / 2,948★ | correct |
| Typhex | yes | yes (transformer + runtime parser, `ts-patch`) | build time (transformer) or run time | **under-reported**, see R2.4 #7 | not documented upstream; the doc's statement is fair | 0.1.0-alpha.1 / 2026-06-15 / 5 / 1★, created 2026-02-12 | **toy**: one author, alpha, 5 dl/wk. Present it as a design sketch, not a precedent |
| Tinqer | yes | yes (`toString` + `oxc-parser` 0.150.0, `package.json:22-24`) | run time | LINQ subset; "closure variables are not supported" is stated explicitly (`docs/guide.md:1749`); the doc infers it instead of citing this | throws (guide examples: "UPDATE requires a WHERE clause…") | 0.0.28 / 2026-09-28 / 228 / 24★ | correct, but row filters under-described (R2.4 #6) |
| lambdaorm | npm yes; GitHub `lambda-orm/lambdaorm` **404** | **unverifiable**, see R2.4 #5 | run time | — | — | 2.3.15 / 2025-06-02 / 187 | abandoned-looking, closed-source build |
| Orange ORM | yes | yes, README `711-713, 723-724` | run time | builder methods | type/method errors | 5.5.0 / 2026-09-05 / 15,978 / 1,017★ | correct in §3.4; **wrong in the Summary** (R2.4 #2) |
| jsmql | yes | yes (arrow-function form `jsmql(({ $ }) => …)`, README lines 37, 66-68) | run time | strict JS subset → MongoDB | throws | **missing from doc:** npm `@koresar/jsmql` 0.5.0 / 2026-09-19 / 67 dl/wk; 5★ | toy-scale; MongoDB, not SQL |
| LinqBox / sqlizer / ts-sql-query / LinqToTypeScript | yes | the one-line classifications are correct; numbers match my round-1 figures | — | — | — | as stated | ok (the doc's `[unverified]` tag is overly cautious) |
| Builder DSLs (§3.5) | — | correct | — | — | — | — | ok |
| Policy languages (§3.6) | — | **Casbin is wrong**, R2.4 #1; Triplit default semantics, R2.4 #3 | — | — | — | — | fix |
| TS 7 statement (§3.8) | yes | both quotes verbatim (devblogs, 2026-07-08) | — | — | — | `@typescript/typescript6` 6.0.2 (2026-07-06), `oxc-parser` 0.152.0, `@swc/core` 1.16.13, `langium` 4.4.0 (ZenStack depends on `langium`, `packages/language/package.json:78`), `typescript` 7.0.2 (2026-07-08): all confirmed | correct, except the "Bander" row (R2.4 #11) |

### R2.3 Wasp, now facts only?

- §1.3: all seven quotes are verbatim against the post. The v0.25.0 removal (2026-07-27, PRs #4334/#4369/#4335, `WaspFile.hs:36-42`) is correct. The `.wasp/out` gitignore is correct. The benchmark description is correct: Vercel SaaS Starter, n=1 per arm, Opus/Haiku, the labels 31% = API calls and 21% = tool uses, the Wasp app in `main.wasp` (the DSL), and the inconsistencies.
- Residual conclusions are listed in R2.4 #8 and #9 (Summary line 30, §5.2 bullet 3).

### R2.4 Still wrong: fix list

| # | Doc line | Problem | Fix (with source) | Sev |
|---|---|---|---|---|
| 1 | 445, 623-624, 873-874 | Casbin "does push filtering into SQL" / "Casbin … all do it". A round-1 claim, missed in my round-1 review. | Casbin adapters persist policy only: "Casbin loads and saves policy through adapters. The enforcer calls `LoadPolicy()` to load rules and, when supported, `SavePolicy()` to persist them" (https://casbin.apache.org/docs/adapters). Enforcement is in process. Remove Casbin from every push-down list and the §1.18 "Relevance" cell. | high |
| 2 | 41-44 | "'Compile the arrow function to SQL' does exist in TypeScript — five times", listing Orange ORM and jsmql; "None has adoption" | Orange ORM does not compile arrow-function operators: its callbacks call builder methods (`customer.isActive.eq(true)`, README:711-712). jsmql targets MongoDB MQL, not SQL. Say "three libraries compile arrow functions to SQL (Tinqer, Typhex, lambdaorm); a fourth, jsmql, does the same for MongoDB; Orange ORM is a proxy builder". Replace "None has adoption" with the numbers: Orange ORM 15,978 dl/wk is real adoption for a builder. | medium |
| 3 | 360-361, 674 | Triplit "Denied by default if no rule" | The source: "By default, there are no access controls on the database … Once a permissions object is defined … If no rules for an operation are provided, the operation not be allowed by default" (`permissions.mdx:150`). So the default is **open** with no `permissions` object, and **deny** per operation once one exists. State both halves. | medium |
| 4 | 335-336 | PostGraphile quoted as *"you can bring your own finer granular permissions in the form of Row-Level Security (RLS) policies"*. This string is not on the cited page. | The page says "PostgreSQL introduced much more granular permissions in the form of Row-Level Security (RLS) policies in PostgreSQL 9.5" and shows `create policy update_if_author on comments for update using ("userId" = current_user_id())` (https://postgraphile.org/postgraphile/next/security). Replace the quote with this text. | medium |
| 5 | 559-562, 669 | lambdaorm: query "parsed from source"; "own" parser | It cannot be verified from source. The GitHub repo linked from the org (`lambda-orm/lambdaorm`) returns 404. The npm tarball 2.3.15 ships **obfuscated** JS (javascript-obfuscator style, e.g. `operand/application/services/operandBuilderCacheDecorator.js`), whose builder takes an expression *string* (`s.trim()`). Its parser is the `3xpr` dependency (`"3xpr": "^1.15.27"` in `package.json`). Say so, mark the mechanism `[unverified — obfuscated build, no public source]`, and note the last release was 2025-06-02. Do not count it as an inspectable precedent. | medium |
| 6 | 553-554 | Tinqer row filters reduced to a file name | The README documents them. Quote it: `schema.withRowFilters<ScopeContext>({ users: (u, ctx) => u.orgId === ctx.orgId, … })`; "Any SELECT/UPDATE/DELETE using `schema` includes the row filter automatically"; "Filters must be provided for every table (set a table's filter to `null` to opt out)"; "Row filters are not automatically applied to INSERT statements" (https://github.com/tinqerjs/tinqer, README ~lines 255-285). This is the closest existing analogue of mesh's "policy = filter for reads" and it does not cover inserts. Also cite `docs/guide.md:1749` ("External variables must be passed via the params object - closure variables are not supported") instead of inferring it from examples. | medium |
| 7 | 525-527, 667 | Typhex subset described only as "a practical safe subset" | Copy the README's list (lines 243-255). Supported: `=== !== == != > >= < <=`, `&& \|\| !`, member access, literals, array literals, `in`, `.startsWith/.endsWith/.includes`, aggregates, `.some`/`.every` relation predicates, ternaries, arithmetic, null checks. Unsupported in runtime mode: "unsigned right shift (`>>>`), optional chaining, nullish coalescing, arbitrary function calls, loops, assignments, `await`, `new`, or `instanceof`". This is the most concrete published TS-subset list in the document. | medium |
| 8 | 30 | Summary: "the DSL app still won" | Interpretive. Write "the DSL app used fewer tokens (2,505,796 vs 4,049,413)…". | low |
| 9 | 823-827, 754-760, 389-391, 434, 441 | Analysis in fact sections, against `_rules.md` rule 4: §5.2 bullet 3 ("no source supports that reading, and Wasp's own DSL benchmark points the other way"), in a section that promises "no conclusion"; §4.3 "mesh comparison" paragraph ("the one to read first", "does not transfer"); §1.15 "the best reference for mesh's compiler architecture"; §1.18 Medusa "Closest modern 'TS model DSL'", Deepkit "Architecturally closest to mesh's ambitions" | Move each to `## Implications for mesh`. In §5.2 keep only the facts (the four reasons, with no LLM reason among them). | medium |
| 10 | 790-800 | The academic papers sit under §5.1 "Evidence that structured or schema-first stacks help agents" | Wu et al. and Cassano et al. document that DSL/low-resource generation is *hard* and needs data or fine-tuning. That is cold-start evidence, which belongs in §5.2 or a neutral list. Chand et al. (fine-tuning helps DSL output) is neutral. Re-sort them. | medium |
| 11 | 655 | Parser table row "Bander / hand-written — lambdaorm, jsmql" | "Bander" is not a known parser or package. lambdaorm's parser is the `3xpr` package; jsmql's is its own. Replace the row. | low |
| 12 | 297-299 | Platformatic quote "automatically introspects your database schema" | The source says "automatically introspecting your database schema to create type-safe, fully-featured APIs" (`docs/reference/db/overview.md:10`). Quote it exactly. | low |
| 13 | 131 | Remult "`backendPrefilter` / `backendPrefilter`-style" | Typo. Write "`backendPrefilter` / `backendPreprocessFilter`" (`access-control.md:106-125`). | low |
| 14 | 818-822 | AutoCodeBench "repository-level code generation"; a "`50.9%`" figure | The abstract says "3,920 problems evenly distributed across 20 programming languages" and does not say repository-level (https://arxiv.org/abs/2508.09101, 2025-08-12). Remove "repository-level" and the unexplained 50.9%. | low |
| 15 | 828-829 | "the search performed is recorded in Sources" | Sources does not record any search queries. Add them or delete the clause. | low |
| 16 | 433-434 | PocketBase "API rules are filter expressions pushed into SQL"; Medusa `model.define`: neither cited | Add the primary doc URLs (PocketBase API rules docs; Medusa data-model docs in `medusajs/medusa`), or mark `[unverified]`. | low |
| 17 | 455 | ZenStack v2 row: "run time, Kysely/Prisma where" | v2 runs on Prisma; Kysely arrived with v3 (`README.md:52-56`). Write "Prisma `where`". | low |
| 18 | 841-844 | Laravel line lost its health data | Add `laravel/framework` stars and latest release (round 1 had numbers, though for the skeleton). | low |
| 19 | 564-565 | jsmql has no npm data | Add `@koresar/jsmql` 0.5.0 (2026-09-19), 67 dl/wk. | low |
| 20 | §2 table / §1 profiles | The brief's "known complaints" field (criterion 1) is still absent for almost every project, and there is still no complaints column (criterion 2). Not fixed since round 1. | Add a "Known complaints" column with one sourced issue or post per project, or mark "not searched". | medium |

### R2.5 Fresh citation sample (36, none checked in round 1)

**Supports: 31. Partly: 4. Does not support: 1. Dead: 0.**

- **Supports:**
  - Hasura permissions URL and quote
  - Triplit `permissions.mdx:45-62` and the line-150 quote
  - Platformatic `rules.md:55-81`
  - `X-PLATFORMATIC-ROLE` (`user-roles-metadata.md:16`)
  - Typhex README:114-245 (lines 225, 245)
  - Typhex npm date
  - Tinqer `package.json:22-24`
  - Tinqer npm date
  - Orange README:711,723
  - Orange npm date
  - ZenStack `policy-handler.ts:83-88`
  - unpkg `@effect/sql@0.12.0/src/Model.ts:605-612`
  - Wasp `ChangeLog.md:93-99`
  - Wasp `ChangeLog.md:610-612`
  - Prisma ARCHITECTURE agent passage (lines 117, 124)
  - TS 7.0 quotes 1 and 2
  - `@typescript/typescript6` 6.0.2
  - `oxc-parser` 0.152.0
  - `@swc/core` 1.16.13
  - `langium` 4.4.0 and ZenStack's use of it
  - https://www.convex.dev/llm-leaderboard (200; both tracks present)
  - https://zenstack.dev/blog/code-as-doc (200)
  - https://zenstack.dev/blog/ai-agent (200)
  - Supabase/Triplit quote
  - Gel quotes ("shutting down…", "fully shut down on Jan 31 of next year")
  - InstantDB quote and code
  - Zero quote
  - Keystone mutation-filter quote
  - Payload Query quote (casing aside)
  - `@casl/prisma` 2.0.2 date 2026-07-06
- **Partly:**
  - PostGraphile (meaning right, quote not on page)
  - Platformatic `overview.md:8-16` (misquote)
  - AutoCodeBench (problem count right, "repository-level" unsupported)
  - lambdaorm npm page (the lambda syntax is shown; "parsed from source" cannot be verified)
- **Does not support:**
  - "the search performed is recorded in Sources"

### R2.6 Content lost in the rewrite?

Nothing correct was lost from the project list:
- All 17 profiled sections remain.
- §1.18 gained Prisma 8, PocketBase, Medusa, LoopBack, Feathers, Blitz, Deepkit and Pothos, and dropped only the "TypeScript" row (its claim is now correctly handled in §3.8) and Zod's weekly downloads.

The comparison table kept all round-1 columns (Declared in, Derives, Auth model, SQL push-down, Extension model, Codegen vs reflection, Generated code committed) and added "Hlth". The only regressions are the Laravel health data (R2.4 #18) and jsmql's npm figures, which were never present (R2.4 #19).

### R2.7 Criteria after round 2

| # | Status |
|---|---|
| 1 Profiles | Partial: known complaints missing (R2.4 #20); Bouncer push-down `[unverified]`; Medusa/LoopBack/Feathers/Deepkit/Pothos health-only |
| 2 Comparison table | Partial: no complaints column; Casbin error carried into §1.18 |
| 3 Expression-to-SQL | Complete after R2.4 #1-#7 |
| 4 Emitters | Complete (mutator-framework API and DMMF types honestly left open) |
| 5 LLM angle | Complete after R2.4 #9, #10, #14 |
| 6 Peers | Complete (Laravel numbers, R2.4 #18) |
| 7 Why none | Complete after removing Casbin from #6 |

---

## Round 3 final check

Reviewer, 2026-10-01. Checked the round-3 document (13,101 words, `## Revision log (round 3)`) against primary sources. I cloned Tinqer at commit `41598b3` (2026-09-28) into `/Users/svallory/work/mesh/scratch/ts-prior-art-review/tinqer`.

**Final verdict: ACCEPT-WITH-FIXES.** No further revision round is planned. The document is reliable for design use **when read together with the residual-error list below**. Every substantive round-1 and round-2 error is fixed at source. What remains:
- one wrong description of how Tinqer reports unsupported constructs, the point that matters most for mesh;
- three markdown tables broken by round 3;
- a handful of small inaccuracies.

### R3.1 Round-2 "still wrong" items

| R2 # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Casbin push-down | **Fixed correctly** | Removed from §1.18 relevance, §3.6 and §7 #6. The quote matches https://casbin.apache.org/docs/adapters. §3.9 still lists Casbin as a *policy language*, which is correct. |
| 2 | Summary: lambda-to-SQL libraries and adoption | **Fixed correctly** | Summary lines 42-50: three SQL libraries; jsmql is MongoDB; Orange ORM is a proxy builder with 15,978 dl/wk. All numbers re-verified. |
| 3 | Triplit default | **Fixed correctly** | Lines 403-408 quote `permissions.mdx:150` and state both halves (open with no `permissions` object, deny per operation once one exists). |
| 4 | PostGraphile quote | **Fixed correctly** | Lines 373-377 now match the page text ("…in the form of Row-Level Security (RLS) policies in PostgreSQL 9.5") and the `update_if_author` example. |
| 5 | lambdaorm | **Fixed correctly** | The 404 repo, obfuscated tarball and `3xpr` dependency are all confirmed. It is marked as not inspectable. |
| 6 | Tinqer depth | **Mostly fixed; one statement wrong** | See R3.2 and residual #1. |
| 7 | Typhex list / design sketch | **Fixed correctly** | Lines 584-594 match README lines 243-255 and 225 exactly. Framed as "a design sketch, not a precedent". Small count error: residual #8. |
| 8 | "DSL app still won" | Fixed, but round 3 left a duplicated line (residual #4) | — |
| 9 | Analysis moved out of fact sections | **Fixed correctly** | §1.15, §1.18, §4.3 and §5.2 are now factual; the readings sit in `## Implications for mesh`, lines 1101-1107. |
| 10 | §5 placements | **Fixed**, with an ordering/heading nit (residual #6) | The academic papers are now in a neutral §5.3. |
| 11 | "Bander" row | Fixed, but the replacement rows broke the §3.8 table (residual #3) | — |
| 12 | Platformatic quote | Fixed correctly | Line 330 matches `overview.md:10`. |
| 13 | Remult typo | Fixed correctly | — |
| 14 | AutoCodeBench | Fixed correctly | It now uses the abstract's wording ("3,920 problems evenly distributed across 20 programming languages"). |
| 15 | "search recorded in Sources" | Fixed (deleted) | — |
| 16 | PocketBase / Medusa citations | Fixed | The PocketBase quote is verbatim at https://pocketbase.io/docs/api-rules-and-filters/; the Medusa URL returns 200. |
| 17 | ZenStack v2 Kysely | Fixed | — |
| 18 | Laravel health | Fixed correctly | `laravel/framework` 34,943★, v13.34.0 (2026-09-29T12:48Z) confirmed. |
| 19 | jsmql npm data | Fixed correctly | — |
| 20 | Known complaints | **Added**; every sampled issue exists. Caveat: residual #7. | — |

### R3.2 Tinqer in depth: document statements vs source

| Document statement (lines 604-662) | Verdict | Source |
|---|---|---|
| The lambda is obtained by `queryBuilder.toString()` at `parse-query.ts:82-83` | Correct | Line 83: `const fnString = queryBuilder.toString();` |
| `parseJavaScript` → `parseSync("query.ts", code, { sourceType: "module" })`, `oxc-parser` 0.150.0 as the only runtime dependency | Correct | `src/parser/oxc-parser.ts`; `packages/tinqer/package.json:22-24` |
| `convertAstToQueryOperationWithParams` produces a `QueryOperation` | Correct | `parse-query.ts:120` |
| Results go through `parse-cache.ts`, so an identical query is not re-parsed | Correct, but incomplete | The cache is **keyed on the function's source text**, enabled by default, capacity 1024, configurable through `setParseCacheConfig`; results are deep-frozen (`parse-query.ts:86-94,145-149`; `parse-cache-config.ts`). |
| Expression subset (README "Expression Support") | Correct | README:560-572 matches. The visitor also accepts `==`/`!=` (`visitors/index.ts:143`), which the README omits. |
| "Literals … auto-extracted into `autoParams` (`parse-query.ts:22`)" | Line off by one | `autoParams` is declared at line 23. |
| Closures: "External variables must be passed via the params object - closure variables are not supported" (`docs/guide.md:1749`) | Correct | Also stated in README:598 ("Lambdas cannot capture external variables; use params object"). The code throws ``Unknown identifier '${name}'. Variables must be passed via params object or referenced as table parameters.`` (`visitors/common/identifier.ts:59-62`). |
| **"Unmappable AST nodes throw from the visitor — the guide's examples show messages such as 'UPDATE requires a WHERE clause…'"** | **Wrong** | See residual #1. |
| Row filters cover SELECT/UPDATE/DELETE, not INSERT; every table needs a filter or `null`; "fails closed" | Correct | README:253 quote verbatim. Unbound context throws "Row filters require context binding. Call schema.withContext(context)." (`policies/row-filters.ts:88,486,530`). **Omitted:** context must be read by direct property access: "Row filter context parameters must use direct property access (ctx.key)" (`row-filters.ts:673`). A missing key throws `Row filter context is missing required key "<key>"` (`:904`). |
| Databases: PostgreSQL via pg-promise, SQLite via better-sqlite3; SQLite ignores `RETURNING` | Correct | README:509. |
| 24★, one contributor (`jeswin`), 0 open issues, created 2025-09-20, pushed 2026-09-28; 0.0.28 (2026-09-28), 228 dl/wk | Correct | `jeswin` has 405 commits and is the only contributor; MIT licence. **Omitted:** 8 npm versions in total, first 0.0.21 on 2025-10-28. Adapters: `@tinqerjs/pg-promise-adapter` 214 dl/wk, `@tinqerjs/better-sqlite3-adapter` 243 dl/wk. No GitHub releases; npm only. |

### R3.3 Known-complaints sample

I checked **41 issue citations across 37 projects**: the 17 profiles plus the §1.18 table. **All 41 exist, are open, and match the cited title and comment count.**
- Profiles: zenstack #717, remult #570, wasp #1088, redwoodjs/graphql #8861, redwoodjs/sdk #632, keystone #8774, payload #7312, encore #1641, convex-backend #96, adonisjs/core #4510, nestjs-query #1538, casl #8, nest #1006, platformatic #5042, amplication #4654, hasura #9592, graphile/crystal #2564, triplit #196, instant #2546, typespec #2463, effect #6378, trpc #3297, orpc #1389.
- §1.18 table: casbin #710, prisma/orm #1798, drizzle #376, kysely #320, zod #475, pocketbase #159, medusa #8548, directus #7237, strapi #20870, loopback-next #2043, feathers #1337, blitz #586, deepkit #562, pothos #534, gel #3946, cerbos #2574, opa #6559, appsmith #1911.

The caveat is labelling (residual #7).

### R3.4 Fresh citation sample (32, none checked in earlier rounds)

**Supports: 30. Partly: 1. Does not support: 1. Dead: 0.**

- **Supports:**
  - the 21 §1.18 and §1.14/§1.17 issue citations (prisma #1798 through orpc #1389)
  - `laravel/framework` stars
  - `laravel/framework` release
  - PocketBase API-rules quote
  - Medusa Data Model URL
  - jsmql 0 open issues
  - Wasp `FileDraft.hs:3,26,45` (`Writeable`)
  - Tinqer README:509 (`RETURNING`)
  - Tinqer README:253 ("fails closed")
  - Tinqer one contributor
  - Typhex one human contributor
- **Partly:**
  - `parse-query.ts:22` (the line is 23)
- **Does not support:**
  - Typhex "1 open issue": `kalyvasio/typhex` has 0 open issues and 3 open dependabot PRs; GitHub's `open_issues_count` = 3 counts PRs.

### R3.5 Did round 3 lose or break correct content?

No correct facts were lost. Round 3 broke formatting in four places, all listed as residuals #2-#5: the §1.18 and §2 table headers, the §3.8 table, a duplicated Summary line, and §5 ordering.

### Residual errors (for readers)

Each entry gives the line in [`06-ts-prior-art.md`](../ts-prior-art.md), what is wrong, and the correct fact with its source.

1. **Lines 628-631 (also the "Unsupported →" cell of the Tinqer row at line 782): how Tinqer reports unsupported constructs.**
   - *Wrong:* "unmappable AST nodes throw from the visitor — the guide's examples show messages such as 'UPDATE requires a WHERE clause…'".
   - *Correct:* the visitor does throw specific errors, e.g. ``Unsupported AST node type: ${type}`` (`packages/tinqer/src/visitors/index.ts:131`) and ``Unknown identifier '${name}'. Variables must be passed via params object…`` (`visitors/common/identifier.ts:59-62`). But `parseQuery` wraps the whole parse in `try/catch`, logs with `console.error("Failed to parse query:", error)` and **returns `null`** (`parser/parse-query.ts:153-159`). The plan then throws a **generic** error, so the specific reason never reaches the caller except through console output:
     - "Failed to parse query" (`plans/select-plan.ts:415-416`)
     - "Failed to parse update builder or not an update operation" (`plans/update-plan.ts`)
     - the corresponding delete and insert messages
   - "UPDATE/DELETE requires a WHERE clause or explicit allowFullTableUpdate()/allowFullTableDelete()" is a **SQL-generator safety check in the adapters** (`pg-promise-adapter/src/generators/update.ts:71`, `delete.ts:25`; same in `better-sqlite3-adapter`). It is not an unsupported-construct report.
2. **Lines 486-487 (§1.18) and 512-513 (§2): broken markdown tables.**
   - The header rows have 5 and 10 cells but the delimiter rows have 4 and 9. GitHub-flavoured markdown does not render a table when the counts differ, so both appear as raw text.
   - Line 530 (Payload row): `` `boolean \ | Where` `` splits the cell. It should be `` `boolean \| Where` ``.
   - The data in these tables is correct.
3. **Lines 768-769 (§3.8 parser table): malformed rows.**
   - The `3xpr` and "Hand-written parser" rows have 8 cells under a 4-column header; they were pasted from the §3.9 table.
   - Read them as: lambdaorm's parser is the npm dependency `3xpr` `^1.15.27`, unverified because the build is obfuscated; jsmql uses its own hand-written parser and targets MongoDB.
4. **Lines 30-32 (Summary): the token figures are printed twice.** The facts are correct: 2,505,796 vs 4,049,413 total tokens.
5. **Lines 875-919 (§5): structure.**
   - §5.3 appears before §5.2.
   - The intro (line 877) still says "Two lists"; there are three: for (§5.1), neutral (§5.3), against (§5.2).
   - The content is correct.
6. **Line 599: Typhex "1 open issue".** *Correct:* 0 open issues and 3 open dependabot PRs; one human contributor (`kalyvasio`, 49 commits) plus `dependabot[bot]` (`gh api repos/kalyvasio/typhex/issues?state=open`).
7. **"Known complaints" cells (§1 profiles, §2 and §1.18 tables): many are feature requests or discussions, not complaints.**
   - Feature requests or discussions: zenstack #717, wasp #1088, typespec #2463, trpc #3297, amplication #4654, nest #1006 ("Who is using Nest in production?"), kysely #320, pocketbase #159, pothos #534, appsmith #1911, opa #6559, cerbos #2574.
   - Every issue exists as cited, but read the column as "most-discussed open issue". Not every cell names a defect.
   - The AdonisJS **Lucid** row (line 525) cites `adonisjs/core#4510`, which is a core-repo issue, not a Lucid one.
8. **Line 636: `autoParams` cited at `parse-query.ts:22`.** The line is 23.
9. **Lines 432 and 534 (Zero complaints):** "issues not searchable at `rocicorp/zero` (404)". Zero's issues live in `rocicorp/mono`, which is searchable. This is an omission, not a false fact.
10. **Line 685: the `[unverified]` tag on LinqBox, sqlizer, ts-sql-query and LinqToTypeScript is unnecessary.** I verified their stars and dates in round 1 (150★, 18★ / last push 2019, 318★, 157★).

Everything else I checked across the three rounds is correct as written.

### Tinqer: verified account

How it works:
- Tinqer is a **run-time** LINQ-style SQL builder for PostgreSQL (pg-promise) and SQLite (better-sqlite3). You pass a builder arrow function such as `(q, params) => q.from("users").where(u => u.age >= params.minAge)`.
- On every call it does `queryBuilder.toString()` (`parse-query.ts:83`) and looks the text up in an LRU parse cache (default on, 1024 entries, keyed on the source text).
- On a cache miss it parses the text with `oxc-parser` 0.150.0, takes the first statement's expression, walks it with its own visitors into a `QueryOperation` tree, auto-extracts literals as bound parameters, and the adapter generates parameterised SQL.

Supported subset (README:560-572):
- `=== !== > >= < <=` (plus `==`/`!=` in code), `&& || !`, `+ - * / %`
- string `.includes/.startsWith/.endsWith/.toLowerCase/.toUpperCase`
- `??` and `?.`
- array `.includes` (becomes `IN`)
- case-insensitive helpers, window functions, opt-in full-text search

Limits, documented:
- **No closures.** Outer variables must go through the `params` object (`docs/guide.md:1749`, README:598). An unknown identifier throws.
- **Row filters** (`withRowFilters`, `(row, ctx) => …`) apply to SELECT/UPDATE/DELETE, **not INSERT**. Every table needs a filter or `null`. Context is read only as `ctx.key`. A missing context fails closed.
- SQLite ignores `RETURNING`. Right and full joins are not supported.

Limits, from the code:
- **Error reporting is poor.** Specific parse or visitor errors are caught, logged to the console and turned into a generic "Failed to parse query" (`parse-query.ts:153-159`, `select-plan.ts:415-416`). There are no source spans.
- The top-level builder must parse as a single expression statement, and the visitor only handles `ArrowFunctionExpression` lambdas (`parse-query.ts:103-115`, `visitors/index.ts:116`). So builder functions transpiled from arrows to `function` (ES5 targets) would fail to parse. This is my inference from the code, not tested.
- Any tool that injects code into function bodies would make `toString()` return foreign identifiers that the visitor rejects; coverage instrumentation such as Istanbul is the obvious example. Also an untested inference.
- Static types come from TypeScript generics, but the check that matters runs only at run time. Code can type-check (for example, a closure variable) and still fail at run time.

Maturity: a one-person project (`jeswin`, 405 commits), 24★, 0 open issues, MIT, 8 npm versions from 0.0.21 (2025-10-28) to 0.0.28 (2026-09-28). Downloads per week: about 228 for core, 214 for the pg adapter, 243 for the SQLite adapter. It is a working, well-documented **reference design** for toString-based lambda-to-SQL with row-level policies, not a production precedent.
