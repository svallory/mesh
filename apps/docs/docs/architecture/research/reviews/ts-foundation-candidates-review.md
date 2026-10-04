---
title: "Review: Candidate foundation libraries"
description: "Independent fact-check of the Candidate foundation libraries document; final verdict ACCEPT-WITH-FIXES."
---

# Review: ts-foundations ([`notes/research/07-ts-foundation-candidates.md`](../ts-foundation-candidates.md))

> Review of: [Candidate foundation libraries](../ts-foundation-candidates.md).

VERDICT: ACCEPT-WITH-FIXES

(Final verdict after round 3. History: round 1 REJECT, round 2 ACCEPT-WITH-FIXES. The final residual-errors list is at the end, under `## Round 3 final check` → `### Residual errors (for readers)`.)


Reviewer: independent fact-check, 2026-10-01. Every npm number below was re-fetched on 2026-10-01 from
`registry.npmjs.org/<pkg>/latest` and `api.npmjs.org/downloads/point/last-week/<pkg>`; every GitHub number with
`gh api repos/<o>/<r>` and `gh api repos/<o>/<r>/releases --paginate` (non-prerelease, published on or after
2026-07-03 for "90d", on or after 2025-10-01 for "365d"). Local Bun: `bun --version` = 1.4.2.

## Verdict in one paragraph

The raw registry numbers are good: all ~95 npm versions and weekly-download figures I re-fetched match exactly, and
GitHub star counts match. Most of the analysis that sits on top of them is not usable as it stands. (a) Four
candidates in the workflow, event-sourcing and migration tables are **the wrong npm packages**: `emmett`, `dbos`,
`hatchet` and `pgroll` are unrelated libraries. Their descriptions are "A custom event emitter", "Who cares" (2016),
"Send user activities into logstash" (2015) and an unrelated Postgres tool. (b) The Elysia-versus-Hono section
(criterion 4) gets validation, OpenAPI, Node support and performance claims wrong in ways that change the
comparison. (c) The precedents lesson ("integral layers cost you cadence") rests on a misreading of RedwoodJS: its
team moved to RedwoodSDK in April 2025, and Prisma had nothing to do with it. (d) The TypeScript 7 question was left
open, and it is answerable today: TS 7.0 ships **no** compiler API. (e) Bun facts include a wrong Windows ARM64
"not supported" row and a "no memory figures found" claim that Bun's own 1.4 release notes contradict. The document
also has no `## Implications for mesh (researcher's analysis)` section; analysis is mixed into the fact sections,
which breaks evidence rule 4. Keep the registry tables, fix the rows and sections listed below, and resubmit.

---

## 1. Error table

Line numbers are lines of [`07-ts-foundation-candidates.md`](../ts-foundation-candidates.md). Severity: **high** = would mislead a decision; medium =
wrong fact, limited blast radius; low = imprecision.

| # | Line(s) | Claim in document | What the source says | Sev |
|---|---|---|---|---|
| 1 | 158, 163-169 | DBOS Transact = npm `dbos@1.0.0`, 18 weekly DL, "`@dbos-inc/dbos` not found… live name is `dbos`… a rename artifact" | `dbos@1.0.0` was published 2016-04-12 with description "Who cares" and no repo (`https://registry.npmjs.org/dbos`). The real package is `@dbos-inc/dbos-sdk@5.2.11`, MIT, **487,945** weekly, repo `dbos-inc/dbos-transact-ts` (1,382★, 7/30 releases). "Rename artifact" is invented. | high |
| 2 | 161, 167-168 | Hatchet = npm `hatchet@0.3.2`, Apache-2.0, 185 weekly | `hatchet@0.3.2` = "Send user activities into logstash", 2015-03-11, repo `jbuck/hatchet`. The real package is `@hatchet-dev/typescript-sdk@1.33.2`, MIT, **686,624** weekly. GitHub `hatchet-dev/hatchet` licence is MIT, not Apache-2.0; releases 36/303 (not 37/100). | high |
| 3 | 175, 180-182 | Emmett = npm `emmett@3.2.0`, MIT, 5,542 weekly; "GitHub licence null even though npm says MIT" | `emmett@3.2.0` = "A custom event emitter for Node.js and the browser" (2020-02-17, repo `jacomyal/emmett`). The real package is `@event-driven-io/emmett@0.42.4`, 17,810 weekly, npm licence field `null`. The MIT-vs-null "discrepancy" compares two different projects. | high |
| 4 | 111, 121-122 | pgroll npm `pgroll@0.0.10`, ISC, 469 DL; "moved from `atlassian/pgroll` (404 today) to `xataio/pgroll`" | npm `pgroll` is `tnht95/pgroll`, an unrelated tool. Xata's pgroll is a Go CLI that is not distributed via npm. `xataio/pgroll` licence is **Apache-2.0** (`gh api repos/xataio/pgroll`). Nothing supports an Atlassian origin: a 404 on a guessed URL is not evidence of a move. Remove the claim. | high |
| 5 | 28-29 (Summary) | "Elysia has 90% of its contributions from one person (`SaltyAom`), Hono 84% from `yusukebe`" | 90% and 84% are **top-5** shares (doc line 615 says so). Single person: SaltyAom 1,918/2,225 = **86%**; yusukebe 1,755/2,578 = **68%** (`gh api repos/{elysiajs/elysia,honojs/hono}/contributors?per_page=100`). | high |
| 6 | 55-56 vs 360-361 | Summary: "I verified compile behaviour for Bun itself, Elysia, Drizzle and Kysely" | The document's own table says Drizzle "not checked (0 deps ⇒ likely fine)" and Kysely "not checked". Only Elysia has a source (its deploy doc). The Summary overstates the evidence. | high |
| 7 | 555-558, 639-640 | "Validation library is baked in on Elysia's side… schema has to be expressed in `t` (or TypeBox)"; "separate TypeBox support via `Elysia.t`" | `https://elysiajs.com/essential/validation.md`: "Elysia also supports Standard Schema, allowing you to use your favorite validation library: Zod, Valibot…". `Elysia.t` *is* TypeBox ("a schema builder based on TypeBox"), not a separate option. Elysia's peerDependency is `@sinclair/typebox >=0.34.0 <1`, which pins it to the old TypeBox line (see #22). The doc's own generated-route example (line 645) passes a non-`t` schema, which contradicts its own claim. Both frameworks accept Standard Schema; Elysia uses it inline, Hono through `@hono/standard-validator`. | high |
| 8 | 229, 570-574 | Elysia OpenAPI = `@elysiajs/swagger` (1.3.1, 247K), "first-party, zero-extra-choice" | `https://elysiajs.com/plugins/swagger.md`: "Swagger plugin is deprecated and is no longer maintained. Please use OpenAPI plugin instead." Current: `@elysia/openapi@1.4.16` (96,368/wk; the docs install this name) and the mirror `@elysiajs/openapi@1.4.16` (370,344/wk). It adds `fromTypes()`, which generates OpenAPI from TS types (`elysiajs.com/at-glance.md`), and `mapJsonSchema` for Standard Schema libraries. The table row and the section must use the current plugin. | high |
| 9 | 357, 589-592 | Hono "runs on Node directly with an optional Node adapter" (contrast with Elysia's "separate package") | `https://hono.dev/docs/getting-started/nodejs`: "Hono was not designed for Node.js at first, but with a Node.js Adapter, it can run on Node.js". Node needs `@hono/node-server` (2.1.3, 71.4M/wk). The asymmetry the section builds on does not exist: both need an adapter package on Node. | high |
| 10 | 600-606, Open Q4 | No Elysia benchmark found; "Hono… makes no throughput claim in its docs index either" | Elysia: `https://elysiajs.com/at-glance.md` §Performance has a req/s table (Elysia 255,574 avg vs Hono 203,937, Fastify 65,897 on Bun). Footnote: "Debian 11, Intel i7-13700K tested on **Bun 0.7.2 on 6 Aug 2023**", from SaltyAom/bun-http-framework-benchmark, which Elysia's author maintains. The homepage says "21x faster than Express". Hono: `hono.dev/llms.txt` lists "Benchmarks" (`/docs/concepts/benchmarks`: "Hono is the fastest, compared to other routers for Cloudflare Workers"). Independent number: Bun 1.4 release notes give Elysia peak memory under load 55 MB vs `node:http` 81 MB (`https://bun.com/blog/bun-v1.4`). Report these figures with their age and conflicts of interest. Do not report "not found". | high |
| 11 | 48-51, 303-308, 824-832, 860-865 | Redwood "integral (Prisma)… release-cadence collapse… integral choices couple a framework to a database tool's release cycle" | The repo is now `redwoodjs/graphql` ("RedwoodGraphQL"). The team launched RedwoodSDK (`redwoodjs/sdk`, v1.7.4 2026-09-23). Peter Pistorius, 2025-04-01, `https://rwsdk.com/blog/redwoodjs-to-redwoodsdk`: focus shifted to RedwoodSDK; "RedwoodJS will remain fully supported". Community fork: CedarJS. The cadence drop is a strategic pivot, so it is no evidence about Prisma or integral layers. The lesson in §8 must be rewritten. | high |
| 12 | 806-807 | "Fastify maintains a first-party platform package" | `@nestjs/platform-fastify` is published from `nestjs/nest` (npm `repository`) and maintained by the Nest team. Nest's default adapter is `@nestjs/platform-express` (12.1.2). Fastify's star count (Summary line 49) says nothing about Nest's adapter strategy. | medium |
| 13 | 323-336, 759 | `bun-windows-arm64` ❌; table has "Modern/Baseline" columns; "Windows ARM64 gap is the only hard matrix hole" | `https://bun.com/docs/bundler/executables.md` "Supported targets": the table has only `--target / OS / Arch / Libc` columns, and **`bun-windows-arm64` is listed as supported**. There is a cross-compile example `--target=bun-windows-arm64`, and `Bun.Build.CompileTarget` includes it. No Modern/Baseline columns exist; the ✅/❌ cells look invented. | high |
| 14 | 342-345, 44-45 | "N-API addons do survive compilation… matters because better-sqlite3… and Prisma's query engine are native-addon-shaped" | better-sqlite3 does not run on Bun at all. It needs V8 C++ APIs, tracked in **open** issue `oven-sh/bun#4290` ("Support V8 C++ APIs for 'nan' addons…"), with duplicates such as #24956 (2025-11-22). Bun's docs say nothing about embedding a `.node` built for another platform when cross-compiling, and the doc should state that gap instead of implying cross-compile + addons works. | high |
| 15 | 362 | Prisma on Bun: "engines are native binaries, expect friction" | Prisma 7.0.0 (2025-11-19) made the Rust-free TypeScript Query Compiler the default and removed the Rust binary (`https://www.prisma.io/changelog/2025-11-19`). Current `@prisma/client` is 7.10.0. The claim is stale. | high |
| 16 | 44-45 | "`bun:sqlite` locking behaviour… fragile" | Nothing in the document's body or sources supports this. Source it or remove it. | medium |
| 17 | 761-766, Open Q1 | "Did not find a measured idle RSS… in Bun's documentation and release notes" | Bun 1.4 release notes (`https://bun.com/blog/bun-v1.4`, 2026-08-20) give measured numbers. `hello.js` on Linux: peak memory **14.6 MB** (Bun 1.4) vs 33.0 MB (1.3) vs 44.5 MB (Node 26), startup 5.1 ms. HTTP servers at peak under 1M requests/64 conns: node:http 81 MB, Elysia 55 MB, Express 92 MB, Fastify 120 MB. These are not idle-RSS numbers, but they are the closest primary-source figures and must be cited. Third-party: Sharkbench Bun.serve 24.5 MB under load (`https://sharkbench.dev/web/javascript-bunserve`, Bun v1, updated 2025-08-24). | high |
| 18 | 774 | Row "`node:cluster` (implied)": `boundedChannel()`, `http.server.*` channels missing | That text is the **`node:diagnostics_channel`** entry (`bun.com/docs/runtime/nodejs-compat.md` line 31). The real `node:cluster` gap: "load-balancing HTTP requests across processes is only supported on Linux (through `SO_REUSEPORT`)". That matters because Elysia's deploy doc recommends cluster mode. | medium |
| 19 | 348, 752 | `Bun.isStandaloneExecutable()` | It is a property, not a function: `if (Bun.isStandaloneExecutable) {…}` (executables doc). | low |
| 20 | 250-257, Open Q3 | TS 7 "consistent with the native port"; "did not read the migration notes"; ts-morph "inherits TS's own versioning risk" | Resolved, see §5 of this review. TS 7.0 "does not ship with an API"; `@ts-morph/common@0.29.0` bundles **TypeScript 6.0.2**, so ts-morph is unaffected by `typescript@7` but is tied to the 6.0 API. | high |
| 21 | 415-418, 467, 662 | "Kysely defines no schema language at all" | `https://kysely.dev/docs/migrations.md`: "Migrations can use the `Kysely.schema` module to modify the schema" (`db.schema.createTable…`). Kysely has a DDL builder. What it lacks is a schema-as-source-of-types DSL. Reword. | medium |
| 22 | 131, 135-137 | TypeBox = `@sinclair/typebox@0.34.52`, "zero GitHub releases" on `sinclairzx81/typebox` | Current TypeBox is the unscoped **`typebox@1.3.34`** (14,235,555/wk; README `npm install typebox`). `@sinclair/typebox` 0.34.x is the legacy line, and its npm `repository` is a different repo (`sinclairzx81/sinclair-typebox`, 12★). Add `typebox` 1.x. Elysia pins `@sinclair/typebox <1` (#7). | medium |
| 23 | 690-695 | Kysely: "22 community dialects including Postgres.js"; "`bun:sqlite` is… a community path for Kysely"; "Both cover the plan's Postgres + `bun:sqlite` needs" | `https://kysely.dev/docs/dialects`: 5 core, 2 **organization** dialects (Postgres.js, SingleStore), **23** community dialects. **No `bun:sqlite` or Bun SQL dialect is listed.** Unlisted npm options: `kysely-bun-sqlite@0.4.0` (26,612/wk), `kysely-bun-worker`. Kysely's own docs therefore do not cover `bun:sqlite`; the doc must say so. | high |
| 24 | 439-445 | Standard Schema interface "deliberately tiny… `Props` carrying only `version`, `vendor`, `types`" | `@standard-schema/spec@1.1.0` `dist/index.d.ts`: that is `StandardTypedV1`. `StandardSchemaV1` adds `validate(value, options) => Result \| Promise<Result>` with an issues array, and a separate `StandardJSONSchemaV1` exposes `jsonSchema.input/output(options)` ("May throw if conversion is not supported"). The coupling analysis misses the point that matters for a compiler: the spec is **opaque**. You cannot enumerate fields, defaults, coercions or constraints, so mesh cannot derive DB columns, forms or OpenAPI from it without the JSON Schema extension or library-specific code. | high |
| 25 | 389-390 | Elysia lifecycle "`onStart → transform → beforeHandle → handler → afterHandle → mapResponse → afterResponse`" (cites `essential/plugin`) | `https://elysiajs.com/essential/life-cycle.md` per-request order: Request → Parse → Transform → (Derive) → Before Handle → (Resolve) → handler → After Handle → Map Response → Error → After Response. `onStart` is a server-start event, not a request phase. `essential/plugin` contains none of this. | medium |
| 26 | 563-566 | "Hono's `hc` only needs the exported type… Hono's is the lighter contract"; `"strict": true` in "the client's tsconfig" | `hc` is a runtime import from `hono/client`, so the client must install `hono` as a dependency. Eden needs `elysia` as a dev dependency. The rpc page says set `"strict": true` "in both the Client's and Server's tsconfig.json". "Lighter" is opinion (rule 4). | medium |
| 27 | 572-574 | Hono OpenAPI is "a community layer" | `@hono/zod-openapi` lives in `honojs/middleware` (Hono org). `hono-openapi` (rhinobase) is third-party and supports Standard Schema. Say "Hono-org middleware, not core". | low |
| 28 | 619-621 | Hono's "release rate is roughly seven times higher" | 22 vs 1 in 90 days = 22×; 73 vs 21 in 365 days = 3.5×. Neither is 7×. | low |
| 29 | 52-53 | "Every serious candidate except Fastify and OpenFGA has 60–97%…" | OpenFGA's own figure is 61% (line 192), inside the stated range. TypeORM 60%, MCP SDK 64%, Babel 64%, Inngest 62% are equally flat. The top-5 denominator is only the first 100 contributors returned by the API, not "all contributions" (line 65). | low |
| 30 | 93, 95, 100-103, 190, 231, 885-889 | Repos 404: `postgresjs/postgres`, `better-sqlite3/better-sqlite3`, `casl/casl`, `pothos-graphql/pothos`, `eventuate-tracings/*`; "could not locate replacements" | The npm `repository` field (already in the researcher's `npm_data.json`) gives `porsager/postgres` (8,731★), `WiseLibs/better-sqlite3` (7,499★), `stalniy/casl` (7,090★), `hayes/pothos` (2,619★), `castore-dev/castore` (276★, last push 2025-10-12). These repo names were guessed from memory. `eventuate-tracings` and "Emmett-node" are not real projects. | medium |
| 31 | 94 | `@libsql/client` stars "repo 17,249" | 17,249 is `tursodatabase/libsql` (the database). The client's npm repo is `tursodatabase/libsql-client-ts`, **577★**. | medium |
| 32 | 156 | Inngest 5,905 stars, Apache-2.0 | 5,905 is `inngest/inngest` (server, licence NOASSERTION). The SDK repo `inngest/inngest-js` has **1,011★**, and GitHub detects its licence as **GPL-3.0** while npm says Apache-2.0. Resolve which licence applies before relying on it. Releases 14/77 (doc 14/74). | medium |
| 33 | 176 | `@eventstore/db-client@6.2.1` as the KurrentDB client, "repo unresolvable" | Last published **2024-05-10**. Successor: `@kurrent/kurrentdb-client@1.3.1` (25,513/wk, repo `kurrent-io/KurrentDB-Client-NodeJS`, 178★). The brief names KurrentDB explicitly. | medium |
| 34 | 194-198 | Oso: "strong signal of a project in maintenance mode" | It is officially deprecated: `osohq/oso` README begins "# Deprecated — We have deprecated the legacy Oso open source library… not end-of-lifing". State that fact. | medium |
| 35 | 191 | Cerbos = `@cerbos/hub@0.6.2` (17,618/wk) | `@cerbos/hub` is the Cerbos Hub client. The PDP SDKs are `@cerbos/grpc` (0.29.1) and `@cerbos/http`. Use those. | low |
| 36 | 291-295, Open Q9 | MCP SDK npm 1.31.0 vs GitHub v2.2.0: "another split-version hazard… registry lag?" | Intentional: v2 is split into `@modelcontextprotocol/server@2.2.0` (8,706,552/wk), `/client@2.2.0` (6,546,370/wk), `/core`, `/server-legacy` (v2.2.0 release notes). `@modelcontextprotocol/sdk` stays on 1.x. The current candidate is missing. Releases 26/**49** (doc 26/33). | medium |
| 37 | 46-47, 97-98 | "`prisma@latest` lies… hazard for a framework that pins both" | `prisma@8.0.0-rc.19` is now "The Prisma CLI: one binary for the ORM, Composer, and the Prisma Developer Platform", from a **different repo** (`prisma/prisma-cli`), with `prev`=7.10.0. The ORM repo was renamed `prisma/orm`. It is a deliberate repackaging with an RC on `latest`, not registry lag. | low |
| 38 | 836-843 | Nitro = `nitropack@2.13.4`; repos `unjs/nitro`, `unjs/h3` | Repos moved to `nitrojs/nitro` and `h3js/h3` (redirects). Nitro v3 is published as `nitro@3.0.260903-beta`. `nitropack` is the v2 line. Nitro licence on GitHub: NOASSERTION. | low |
| 39 | 847-851 | Better Auth "60 releases in 365 days"; adapters list repeats Prisma | Releases **18/79**. Adapters ship as `@better-auth/drizzle-adapter@1.7.7` etc. "Prisma" is listed twice. | low |
| 40 | 210, 852-856 | Auth.js "large, actively released… neither is hostage" | Auth.js has been maintained by the Better Auth team since 2025-09-26 ("Auth.js is now part of Better Auth", nextauthjs/next-auth discussion #13252, balazsorban44: "our pace slowed… maintenance will continue for security"). `next-auth@latest` is still v4.24.15; v5 is still beta (`5.0.0-beta.32`, 2026-07-20). next-auth releases 30/**118**. | high |
| 41 | 267-272 | PGlite "87 releases in 90 days… has become the default answer for test Postgres without Docker" | Non-prerelease GitHub releases: **69/224**, and they are per-package monorepo tags, not PGlite releases. "Default answer" is unsourced opinion. | low |
| 42 | 132, 159 | Effect / `@effect/workflow` rel 31/31 | **95/468** (monorepo per-package tags). The 100-release cap made 31/31 meaningless. | low |
| 43 | 364 | BullMQ in compiled binary: "expect friction (ioredis)" | ioredis is pure JS. Unsourced speculation; mark `[unverified]` or drop. | low |
| 44 | 403-405, Open Q5 | WinterCG not fetched | WinterCG became WinterTC (Ecma TC55) in Dec 2024 `[reviewer: verify and cite ecma-international.org]`. Either cite it or drop the claim. | low |
| 45 | whole doc | No `## Implications for mesh (researcher's analysis)` section | Evidence rule 4. Opinions such as "Hono's is the lighter contract" (566), "Drizzle's model is the only one a code generator can emit verbatim" (472), "This is the cleanest precedent" (847) and "generated decorators are noise" (474) sit inside the fact sections. Move them. | medium |
| 46 | Report | Word count 8,269 | Over the brief's 8,000 cap; the brief allowed up to 8,000. | low |

---

## 2. Version / statistics comparison

Downloads are last-week counts on 2026-10-01; versions are the npm `latest` tag. "OK" = exact match.

| Package / repo | Doc value | Re-fetched value | Result |
|---|---|---|---|
| `elysia` | 1.4.30 · 1,356,946 · 19,207★ · 1/21 | 1.4.30 · 1,356,946 · 19,207★ · 1/21 | OK |
| `hono` | 4.13.12 · 78,082,739 · 32,400★ · 22/73 | same | OK |
| `fastify` | 5.12.5 · 16,606,307 · 37,217★ · 10/23 | same | OK |
| `h3` | 2.0.1-rc.32 · 53,755,875 · 5,442★ · 10/39 | same · 10/**40** | rounding |
| `nitropack` | 2.13.4 · 2,667,019 · 11,255★ | same (repo now `nitrojs/nitro`) | OK, see #38 |
| `drizzle-orm` | 0.45.3 · 29,472,576 · 35,928★ · 2/12 | same; `rc` tag 1.0.0-rc.4 | OK |
| `drizzle-kit` | 0.31.11 · 24,270,410 | same | OK |
| `kysely` | 0.29.6 · 20,470,848 · 14,252★ · 4/17 | same · 14,253★; `next` 0.30.0-beta.2 | OK |
| `prisma` / `@prisma/client` | 8.0.0-rc.19 / 7.10.0 | same (CLI repo `prisma/prisma-cli`) | OK, see #37 |
| `typeorm` | 1.1.1 · 6,379,569 · 36,655★ · 3/7 | same | OK |
| `mikro-orm` | 7.2.3 · 945,410 · 9,245★ · 15/58 | same | OK |
| `postgres` | 3.4.9 · 22,048,218 · "repo 404" | same · **porsager/postgres 8,731★** | mismatch (#30) |
| `better-sqlite3` | 13.0.3 · 13,347,409 · "repo 404" | same · **WiseLibs 7,499★** | mismatch (#30) |
| `@libsql/client` | 0.18.0 · 3,717,376 · 17,249★ | same · **577★** (client repo) | mismatch (#31) |
| `@ariga/atlas` | 1.3.3 · EULA · 20,799 | same; GitHub `ariga/atlas` licence Apache-2.0 (source) | OK, add nuance |
| `pgroll` | 0.0.10 · ISC · 469 · 6,594★ | npm pkg unrelated (`tnht95/pgroll`); xataio/pgroll Apache-2.0 | **wrong package** (#4) |
| `zod` | 4.6.5 · 359,979,939 · 44,051★ · 11/26 | same | OK |
| `valibot` | 1.5.0 · 24,325,230 · 9,029★ · 3/19 | same | OK |
| `arktype` | 2.2.6 · 2,344,112 · 7,872★ · 54/100 | same · 54/**182** | cap artefact |
| `@sinclair/typebox` | 0.34.52 · 135,762,057 · 6,976★ · 0/0 | same; **`typebox` 1.3.34, 14,235,555** missing | missing candidate (#22) |
| `effect` | 4.0.0 · 47,965,603 · 16,327★ · 31/31 | same · **95/468** | mismatch (#42) |
| `@standard-schema/spec` | "—" | **1.1.0 · 141,979,763/wk** | missing data |
| `bullmq` | 6.3.11 · 10,429,842 · 9,464★ · 100/100 | same · **117/241** | cap artefact |
| `pg-boss` | 12.35.1 · 2,449,121 · 4,012★ · 36/90 | same · 35/91 | rounding |
| `graphile-worker` | 0.18.0 · 711,414 · 2,403★ · 1/1 | same | OK |
| `@temporalio/client` / `worker` | 1.24.0 · 5,015,703 / 4,442,847 · 933★ · 14/29 | same | OK |
| `inngest` | 4.21.0 · 2,904,676 · 5,905★ · 14/74 | same · **1,011★ (SDK repo)** · 14/77 | mismatch (#32) |
| `@restatedev/restate-sdk` | 1.17.2 · 291,092 · 123★ · 13/30 | same | OK |
| `dbos` | 1.0.0 · 18 · 1,381★ | **wrong package**; `@dbos-inc/dbos-sdk` 5.2.11 · 487,945 · 1,382★ · 7/30 | wrong (#1) |
| `@trigger.dev/sdk` | 4.7.0 · 1,198,732 · 16,452★ · 49/88 | same · **53/176** | mismatch |
| `hatchet` | 0.3.2 · 185 · 8,042★ · 37/100 | **wrong package**; `@hatchet-dev/typescript-sdk` 1.33.2 · 686,624 · 36/303 | wrong (#2) |
| `emmett` | 3.2.0 · 5,542 · 540★ | **wrong package**; `@event-driven-io/emmett` 0.42.4 · 17,810 | wrong (#3) |
| `@eventstore/db-client` | 6.2.1 · 7,417 | same, last publish 2024-05-10; successor `@kurrent/kurrentdb-client` 1.3.1 · 25,513 | stale (#33) |
| `@castore/core` | 2.4.2 · 2,528 · no repo | same · `castore-dev/castore` 276★ | mismatch (#30) |
| `@casl/ability` | 7.0.1 · 2,027,217 · "repo 404" | same · `stalniy/casl` 7,090★ | mismatch (#30) |
| `@cerbos/hub` | 0.6.2 · 17,618 · 4,604★ · 3/10 | same | OK (wrong package choice, #35) |
| `@openfga/sdk` | 0.9.7 · 564,429 · 5,899★ · 5/30 (openfga/openfga) | same; npm licence Apache-2.0 (doc "—") | OK, licence missing |
| `oso` | 0.27.3 · 10,458 · 3,490★ · 0/0 | same; README says **Deprecated** | OK (#34) |
| `better-auth` | 1.7.7 · 11,457,645 · 30,146★ · 18/60 | same · 18/**79** | mismatch |
| `next-auth` | 4.24.15 · 7,228,760 · 28,371★ · 30/98 | same · 30/**118** | mismatch |
| `@auth/drizzle-adapter` | 1.11.3 · 422,949 | same | OK |
| `@trpc/server` | 11.19.0 · 6,140,518 · 40,682★ | same | OK |
| `@orpc/server` | 1.15.4 · 1,753,881 · 5,658★ | same | OK |
| `@ts-rest/core` | 3.52.1 · 903,172 · 3,341★ | same; last stable 2025-03-04 | OK |
| `@hono/zod-openapi` | 1.6.3 · 2,843,528 | same | OK |
| `hono-openapi` | 1.3.3 · "1.76M" | 1,755,042 | OK |
| `@elysiajs/swagger` | 1.3.1 · 247,152 | same, **deprecated in docs** | see #8 |
| `@pothos/core` | 4.15.1 · 513,011 · "repo 404" | same · `hayes/pothos` 2,619★ | mismatch (#30) |
| `graphql-yoga` / `graphql` | 5.24.1 · 2,169,683 / 17.0.2 · 58,028,969 | same | OK |
| `typescript` | 7.0.2 · 343,822,214 | same; `next` 7.1.0-dev.20261001.1 | OK |
| `ts-morph` | 28.0.0 · 34,149,591 · 6,197★ · 0/2 | same (bundles TS 6.0.2) | OK |
| `oxc-parser` | 0.152.0 · 67,974,417 · 22,929★ · 30/100 | same · 30/**122** | cap artefact |
| `@swc/core` | 1.16.13 · 50,781,591 · 34,211★ · 18/87 | same | OK |
| `@babel/core` | 8.0.6 · 215,417,274 · 44,043★ · 5/19 | same | OK |
| `magic-string` | 1.4.2 · 264,549,242 · 2,778★ · 13/15 | same | OK |
| `vitest` | 5.0.3 · 130,200,958 · 17,178★ · 7/38 | same | OK |
| `fast-check` | 4.10.2 · 54,866,647 · 5,167★ | same | OK |
| `testcontainers` | 12.2.0 · 8,534,235 · 2,619★ · 2/17 | same | OK |
| `@electric-sql/pglite` | 0.5.8 · 23,190,567 · 16,102★ · 87/100 | same · **69/224** | mismatch (#41) |
| `@opentelemetry/api` | 1.9.1 · 101,739,516 | same | OK |
| `pino` | 10.3.1 · 60,378,008 · 18,234★ · 0/10; last 2026-02-09 | same | OK |
| `@logtape/logtape` | 2.3.10 · 618,222 · 2,004★ | same | OK |
| `@modelcontextprotocol/sdk` | 1.31.0 · 68,841,026 · 13,498★ · 26/33 | same · 26/**49**; v2 = `@modelcontextprotocol/server` 2.2.0 | mismatch (#36) |
| `@nestjs/core` | 12.1.2 · 17,940,374 · 76,777★ · 15/38 | same | OK |
| `@adonisjs/core` | 7.5.2 · 201,780 · 19,139★ · 5/19; top-5 96% | same; 96.1% | OK |
| `@redwoodjs/core` | 8.9.0 · 4,941 · 17,594★ · 0/1 | same (repo renamed `redwoodjs/graphql`) | OK numbers, wrong reading (#11) |
| `bun-types` / Bun release | 1.4.2 / bun-v1.4.2 2026-09-05 · 3/18 | same | OK |
| Elysia contributors | 1,918 / 30; top-5 90% | 1,918 / 30; 90.4% | OK |
| Hono contributors | 1,755 / 245 / 71 / 53 / 31; 84% | same; 83.6% | OK |
| Fastify contributors | delvedor 774, mcollina 758; 54% | same; 53.5% | OK |
| Better Auth contributors | Bekacru 3,116; 80% | same; 79.9% | OK |

Totals: 70 packages/repos compared. Versions and downloads: 100% exact for the packages actually listed.
Mismatches larger than rounding: **4 wrong-package rows** (dbos, hatchet, emmett, pgroll), **7 wrong/missing star
counts** (postgres, better-sqlite3, @libsql/client, inngest, CASL, Pothos, Castore), **9 release-count errors**
(Effect, PGlite, Better Auth, next-auth, MCP, Trigger.dev, arktype, oxc, BullMQ), most caused by not paginating past
100 releases. The doc mentions the cap at line 64, but its tables print the capped values as facts.

---

## 3. Citation sample

32 citations fetched and judged.

| Result | Count | Citations |
|---|---|---|
| Supports | 14 | elysiajs.com/patterns/deploy (2-3× quote); elysiajs.com/eden/installation; elysiajs.com/llms.txt (no benchmark entry; now 123 lines, not 102); hono.dev/docs/guides/rpc (status-code typing, `strict`, Standard Schema TIP); orm.drizzle.team/llms.txt (7.4 kb, 0 deps); orm.drizzle.team/docs/upgrade-v1 (journal removed, DDL snapshots, commutativity, "If you were using Relational Queries, you need to upgrade to v2"); orm.drizzle.team/docs/relations-v1-v2; kysely.dev/llms.txt (codegen/prisma-kysely/Kanel; "not an ORM… doesn't have the concept of relations"); registry `@ariga/atlas` licence; GitHub osohq/oso releases; GitHub sinclairzx81/typebox releases (empty); GitHub oven-sh/bun releases; GitHub elysia/hono contributors; GitHub hono releases |
| Partially supports / omits a contradicting fact on the same page | 13 | bun.sh/docs/bundler/executables (no Modern/Baseline columns, windows-arm64 supported, property not function); bun.sh/docs/runtime/nodejs-compat (cluster row is diagnostics_channel); elysiajs.com/integrations/node (package now `@elysia/node`); elysiajs.com/plugins/swagger (page says deprecated); elysiajs.com/performance/benchmark (404 true, but at-glance has the benchmarks); hono.dev/llms.txt (lists a Benchmarks page); hono.dev/docs/getting-started/nodejs ("not designed for Node.js at first… with a Node.js Adapter"); hono.dev/docs/guides/validation (the quoted Standard Schema line is on the rpc page; validation page documents `@hono/standard-validator`); orm.drizzle.team/docs/get-started/bun-sql-new (Bun SQL/Postgres, not `bun:sqlite`; the right page is `bun-sqlite-new`); kysely.dev/docs/migrations (also documents `Kysely.schema`); kysely.dev/docs/dialects (23 community, Postgres.js is organization, no bun:sqlite); standardschema.dev (quote OK, interface description incomplete); GitHub search pgroll (repo exists; Atlassian origin unsupported) |
| Does not support | 5 | elysiajs.com/essential/plugin (no lifecycle order); elysiajs.com/essential/validation (contradicts "must be `t`"); npm `dbos`; npm `hatchet`; npm `emmett` |
| Dead link | 0 | — (all cited doc URLs return 200, except `/performance/benchmark`, which the doc itself reports as 404) |

Support rate: 14/32 = **44% fully supported**, 41% partial, 16% not supported.

---

## 4. Acceptance criteria

| # | Criterion | Status | What is missing |
|---|---|---|---|
| 1 | Per-layer candidate tables | **Partial** | Columns absent everywhere: **maintainers & funding**, **footprint** (except Drizzle), **known pain points with links**. Bun/Node/compile only for 12 rows. Absent candidates the brief names: **native `Bun.serve` routes**, **`Bun.sql`**, **`bun:sqlite`** (raw drivers), **Kysely migrator** as a row, **JSON:API libraries**, **`@jridgewell/*`**, **`bun test`** (`bun-types` is listed instead), OpenTelemetry JS SDK (`@opentelemetry/sdk-node` 0.222.0), **KurrentDB client** (`@kurrent/kurrentdb-client`), **authentication alternatives** (only Better Auth and next-auth). Also missing: `typebox` 1.x, `@elysia/openapi`, `@hono/standard-validator`, `@hono/node-server`, MCP v2 packages. Four rows are the wrong package (#1-#4). |
| 2 | Coupling profile per candidate | **Partial** | Only HTTP, data, validation and tracing. Nothing for jobs, workflows, event sourcing, authorization, authentication, API surface, codegen, testing, agent tooling. Errors in the done parts: #7, #24, #25, #26. Missing leak: Drizzle schemas are dialect-specific (`pgTable` from `drizzle-orm/pg-core` vs `sqliteTable` from `drizzle-orm/sqlite-core`), so the plan's "same contract for Postgres and SQLite" means emitting two schema files. Missing leak: Hono's generated route uses `c.get('actor')`, which requires typing `Variables` in Hono's `Env` generic. |
| 3 | Swap cost per layer | **Partial** | Data layer only, done reasonably. HTTP swap cost (Elysia lifecycle vs Hono middleware vs Fetch handler) is only implied. Validation swap cost misses Standard Schema's opacity (#24). Other layers absent. |
| 4 | Elysia vs Hono in depth | **Partial, with high-severity errors** | Validation (#7), OpenAPI (#8), Node support (#9), performance (#10), typed-client coupling (#26) are wrong or incomplete. Bus-factor data is correct, but the Summary misquotes it (#5). Missing: Eden version-lock requirement ("Make sure that both the client and server have matching Elysia versions", eden/installation). Missing: Elysia's peer pin to `@sinclair/typebox <1`. |
| 5 | Drizzle vs Kysely in depth | **Mostly complete** | Drizzle v1 RC: verified (rc.4 2026-06-27, prerelease; npm `rc` tag 1.0.0-rc.4; snapshot `rc5` 1.0.0-rc.5-5935859 exists). Relations v2 breaking, and it affects generated output: verified (v1 imports move to `drizzle-orm/_relations`, `db._query`; `where`/`orderBy` become objects; upgrade guide says you "need to upgrade to v2"). Errors: Kysely `bun:sqlite` coverage (#23), "no schema language" (#21). |
| 6 | Bun facts | **Partial** | Version correct. Wrong compile matrix (#13). Native-addon cross-compile gap not stated, better-sqlite3 wrongly implied to work (#14). Memory figures exist (#17). Mislabelled compat row (#18). Omitted: Bun 1.4 is "now written in Rust — and this is the first release" (`bun.com/blog/bun-v1.4`), a material maturity/regression-risk fact for a Bun-first design. |
| 7 | Precedents | **Partial** | Redwood outcome misattributed (#11). Nest/Fastify ownership wrong (#12). Auth.js handover omitted (#40). **T3 stack**: heading only, no content (line 834). **Ash's own data-layer contract**: absent, although the brief lists it explicitly. One line plus a pointer to the `ash-*` researchers would satisfy the scope rule. |

---

## 5. Check 5: TypeScript 7 (dedicated)

**What it is.** TypeScript 7 is the native (Go) port of the compiler, developed in `microsoft/typescript-go`. That
repo is now archived; its README says "This was the staging repo for the TypeScript 7.0 release during the native
port process, which is now completed!" and "will be permanently archived in September 2026". Announcement post:
`https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/`, dated 2026-07-08. GitHub release `v7.0.2`
in `microsoft/TypeScript` is dated 2026-08-20. npm dist-tags on 2026-10-01: `latest` 7.0.2, `rc` 7.0.1-rc,
`next` 7.1.0-dev.20261001.1. `@typescript/native-preview` stopped at 7.0.0-dev.20260707.2 and is superseded.

**Programmatic API: none in 7.0.** The announcement says: "While TypeScript 7.0 is here, it does not ship with an
API. We expect TypeScript 7.1 to ship with a new (and different) API, but until then we have made it a priority to
ensure TypeScript can be run side-by-side with TypeScript 6.0 for utilities that still need some programmatic access
to the compiler (such as typescript-eslint)." The tarball confirms it. `typescript@7.0.2` `package.json` has
`"main": null`. The `"."` export is `./lib/version.cjs`, which exports only `version` and `versionMajorMinor = "7.0"`.
Everything else is under `./unstable/*`: `unstable/ast`, `unstable/ast/factory`, `unstable/ast/visitor`,
`unstable/sync`, `unstable/async`, and so on. `dist/api/{sync,async}/client.js` spawn the platform-native `tsc`
binary with `--api` and talk to it over IPC. The package depends on about 20 platform binary packages
(`@typescript/typescript-<os>-<arch>`). So `import ts from "typescript"` on 7.x gives you no `createProgram`, no
`createSourceFile`, no `forEachChild`. The type-checking results themselves are meant to match 6.0 (archived README
status table: "Type checking: done — Same errors, locations, and messages as TS 6.0"; "API: not ready").

**Compatibility package.** `@typescript/typescript6@6.0.2` (bin `tsc6`, depends on `@typescript/old: npm:typescript@^6`)
"re-exports the TypeScript 6.0 API" so it can be installed next to TS 7. The announcement suggests
`npm install -D typescript@npm:@typescript/typescript6` for tools that need the API.

**ts-morph.** `ts-morph@28.0.0` (2026-04-12) release notes: "feat(BREAKING): TypeScript 6.0". It depends on
`@ts-morph/common@~0.29.0`, which **bundles its own compiler**: `dist/typescript.js` reports `version = "6.0.2"`. ts-morph
therefore keeps working when a project has `typescript@7` installed, but it is locked to the 6.0 JS API and will not
see 7.x-only behaviour. The doc's claim that ts-morph "inherits TS's own versioning risk without adding a second one"
is backwards: it adds a pinned second compiler. Other tools: secondary sources (not primary) report that
typescript-eslint, ts-jest and Volar-based tools cannot use TS 7.0 and recommend aliasing TS 6 for them
(`https://dev.to/dev_encyclopedia/why-your-typescript-7-upgrade-broke-eslint-ts-jest-and-ts-morph-385k`;
`https://github.com/block52/ui/issues/601`). The announcement itself says Volar-style tools "can only currently rely
on TypeScript 6.0".

**What a build tool that needs the TS AST should depend on today.** The facts the researcher should write down:
(1) For a stable, span-accurate AST with a type checker, the only supported JS API today is TS 6.0: either
`typescript@~6.0` (6.0.3, 2026-04-16) or `@typescript/typescript6`, or indirectly `ts-morph@28`, which bundles 6.0.2.
(2) The TS 7 API is `unstable/*`, process-spawning, and announced as "new (and different)" for 7.1, which is not yet
released (only `7.1.0-dev` nightlies). (3) For parse-only work (spans, no types), `oxc-parser` (0.152.0, 67.9M/wk) and
`@swc/core` are native alternatives. The plan line 202 ("Re-parse expression text with the TS compiler API") must
name which of these it means. That is a decision; the research must state the three options with the facts above.
(4) The plan's compiler runs at build time, so TS 7's native binary does not affect the Bun single-binary runtime.
It does matter if the mesh compiler itself is to ship as a `bun build --compile` binary: the 6.0 JS API embeds fine,
the 7.x API needs the external native `tsc` executable.

## 6. Check 6: Bun (dedicated)

| Fact | Doc | Verified | Source |
|---|---|---|---|
| Current version | bun-v1.4.2, 2026-09-05 | Correct; local `bun --version` 1.4.2 | `gh api repos/oven-sh/bun/releases` |
| Bun 1.4 rewritten in Rust | not mentioned | "Bun is now written in Rust - and this is the first release" (1.4.0, 2026-08-20) | https://bun.com/blog/bun-v1.4 |
| Compile targets | 8, Windows ARM64 ❌ | 8, **all supported, including `bun-windows-arm64`** | https://bun.com/docs/bundler/executables.md "Supported targets" |
| x64 single binary (Nehalem + runtime AVX2/AVX-512) | correct | correct | same |
| Cross-compile from Mac | correct | correct; Windows-specific flags other than `hideConsole` "can't use… when cross-compiling" | same, line ~1126 |
| N-API `.node` embedding | "survive compilation" | true for host-built addons. Cross-target addon embedding: **not documented**. better-sqlite3 needs V8 C++ APIs and does not run on Bun at all (open `oven-sh/bun#4290`) | same; GitHub issue |
| `--asset` dirs, `Bun.isStandaloneExecutable`, `BUN_OPTIONS`, embedded SQLite (in-memory, lost on exit) | correct, except `isStandaloneExecutable` is a property | correct | same |
| `node:sea` not implemented | correct | correct | nodejs-compat |
| Memory | "not found" | Bun 1.4 notes: `hello.js` Linux peak **14.6 MB** (Node 26: 44.5 MB); peak under load node:http **81 MB**, Elysia **55 MB**, Express 92 MB, Fastify 120 MB; "13% - 48% memory usage reduction" for HTTP servers. Sharkbench: Bun.serve 24.5 MB under load (Bun v1, 2025-08-24) | https://bun.com/blog/bun-v1.4 ; https://sharkbench.dev/web/javascript-bunserve |
| Idle RSS of HTTP + SQLite specifically | not found | Still not found as a primary-source figure. The researcher's recommendation to measure it locally stands, but the doc must cite the figures above as the nearest evidence. | — |

**Per-candidate compile claims.** Elysia: sourced (Elysia's deploy doc recommends `--compile`; the "2-3x memory"
claim has no methodology). Hono, h3, Drizzle, Kysely, Zod/Valibot/ArkType, pino/OTel: marked "not checked", and I
found no source either way. The Summary's "verified for Drizzle and Kysely" is false (#6). Prisma: stale premise
(#15). better-sqlite3: does not work on Bun (#14). BullMQ: unsourced (#43). No candidate other than Elysia has
compile evidence. The doc's "not checked" labels are honest; the Summary is not.

---

## 7. Fix list for the researcher (in priority order)

1. Replace the four wrong packages (#1-#4) and re-pull their numbers. Get repo names from each package's npm
   `repository` field, never by guessing (#30, #31, #32).
2. Rewrite the Elysia-vs-Hono section: Standard Schema on both (#7), current Elysia OpenAPI plugin and `fromTypes`
   (#8), Hono needs `@hono/node-server` (#9), both projects' performance claims with date and authorship (#10),
   `hc` runtime dependency and Eden version lock (#26), lifecycle from `essential/life-cycle` (#25).
3. Fix the Summary bullets: #5, #6, #16, #29, and the NestJS/Redwood bullet (#11, #12).
4. Rewrite the precedents section: Redwood pivot (#11), Nest adapter ownership (#12), Auth.js handover (#40), Oso
   deprecation (#34). Add T3 and a one-line pointer for Ash's data layer.
5. Replace Open Question 3 with §5 of this review, sourced from the announcement and the tarball facts.
6. Fix Bun facts: matrix (#13), native addons (#14), memory (#17), compat row (#18), the Rust rewrite.
7. Fix Kysely dialects and `bun:sqlite` (#23), Kysely schema module (#21), Standard Schema surface (#24), Prisma 7
   (#15), MCP v2 (#36), TypeBox 1.x (#22), KurrentDB (#33).
8. Paginate release counts past 100 (#39-#42) or drop the capped columns.
9. Add the missing columns and candidates from the criterion 1 row of the table in §4, and move opinions into
   `## Implications for mesh (researcher's analysis)` (#45).

---

## Round 2 re-verification

Re-checked 2026-10-01 against the revised document (1,167 lines, 11,592 words, with `## Revision log (round 2)`).
Line numbers below refer to the **revised** document. Everything was checked against primary sources: npm
registry metadata and downloads API, `gh api` (paginated releases, repo metadata), package tarballs, and the
official documentation pages.

### Verdict: ACCEPT-WITH-FIXES

The researcher's claim that the round-1 findings were fixed holds for the substance of every high and medium row I
re-checked (#1-#18, #20-#26, #30-#34, #36, #40, #45), and for the sampled low rows (#19, #27, #28, #29, #38, #39,
#41, #42, #44). Specific checks:

- **Packages.** The four rebuilt packages match npm metadata exactly:
  - `@dbos-inc/dbos-sdk`: "Lightweight durable workflows built on Postgres", repo `dbos-inc/dbos-transact-ts`, 487,945/wk.
  - `@hatchet-dev/typescript-sdk`: repo `hatchet-dev/hatchet`, 686,624/wk.
  - `@event-driven-io/emmett`: "Emmett - Event Sourcing development made simple", 17,810/wk.
  - pgroll is described as a Go CLI not on npm, `xataio/pgroll` Apache-2.0.
- **Release counts.**
  - Matching my paginated recount: BullMQ 117/241, Better Auth 18/79, next-auth 30/118, MCP 26/49, Trigger.dev 53/176, Hatchet 36/303, Elysia 1/21 (105 stable total), Hono 22/73 (405), emmett 1/11.
  - Within ±1: Effect 96/468 (31 Effect releases were published today, 2026-10-01) and PGlite 70/225 (UTC boundary).
  - The counting window is stated correctly (line 15).
- **Bun 1.4 memory tables.** Lines 845-860 reproduce `bun.com/blog/bun-v1.4` exactly, including the `Bun.serve` 36/45 MB row, the Vite row and the Windows startup figures. They are correctly labelled as peak memory under load, not idle RSS.
- **Elysia Standard Schema quote.** Verbatim, including the "ArkType, Effect Schema, Yup, Joi" list.
- **Benchmark quotes.** Hono's Deno line ("Hono 3.0.0 Requests/sec: 136112") and Workers line are verbatim, as is Elysia's footnote 1 (Bun 0.7.2, 2023-08-06).
- **Redwood and Auth.js.** The Redwood quote ("our focus is evolving to a new direction: RedwoodSDK") and the Auth.js discussion #13252 quotes are verbatim.
- **Nest adapters.** `@nestjs/platform-{fastify,express}`: repository `nestjs/nest`, maintainers `nestjscore`, `kamilmysliwiec`, both present in `packages/`. Correct.
- **New quotes.** The TS 7 announcement quote and the `@typescript/typescript6` description are verbatim. `@ts-morph/common@0.29.0` bundles `version = "6.0.2"`. The Kysely dialect counts (5/2/23, no Bun dialect) are correct. Standard Schema signatures match `dist/index.d.ts`.

The verdict is not ACCEPT for two reasons: one wrong statement in the new TypeScript section, and correct
criterion-3/4/5 content from round 1 that the rewrite deleted.

### R2 error table: what is still wrong

| # | Line(s) | Claim | What the source says | Sev |
|---|---|---|---|---|
| R1 | 401 (option table), 63 | `typescript@7` `unstable/*`: "AST yes; **type checker not shipped**" | `typescript@7.0.2` `dist/api/sync/api.d.ts` exports `class Project { readonly checker: Checker }`, `class Program` (`getSourceFile`, `getSourceFileNames`), `class Emitter`, and `class Checker` with `getSymbolAtLocation`, `getTypeAtLocation`, `getTypeOfSymbol`, `getTypeOfSymbolAtLocation`, etc. The unstable API **does** expose a type checker, over the IPC channel to `tsc --api`. Correct the cell to "AST + checker + emitter, over IPC to native `tsc`; explicitly unstable, replaced by a 'new (and different)' API in 7.1". Keep the "do not depend on it" conclusion. | high |
| R2 | 585-603 (§5 Data), whole document | Criterion 3 asks for real API comparisons ("Drizzle versus TypeORM versus Prisma: schema definition, query model, migrations, transactions, relation loading … Use real API comparisons") | Round 1 §4 had correct, sourced code-level comparisons: `sqliteTable('posts', {…})` / `interface DB` / `@Entity() class Post` / `schema.prisma`; `db.select().from(posts).where(eq(...))` / `db.selectFrom('posts').where('state','=','published')` / `find({ where })` / `prisma.post.findMany({ where })`; `db.transaction(async (tx) => …)` vs `db.transaction().execute(async (trx) => …)`. **The rewrite deleted all of it**; §5 is now a bullet summary. Restore that subsection (round-1 text was correct apart from the "only one a generator can emit verbatim" opinion, which belongs in §Implications). | high |
| R3 | §6 (616-771) | Criterion 4 requires "what generated mesh routes would look like on each" | Round 1's "What generated mesh routes would look like" subsection is gone (no `handleAction` example remains). Restore it. Fix it so the Elysia sketch reflects Standard Schema support, and label both sketches as the researcher's illustrations, not doc quotes. | medium |
| R4 | §7 (775-829) | Criterion 5 requires "relational queries" and "raw SQL escape hatch" | Both round-1 subsections were deleted: Drizzle `db.query.posts.findMany({ with: { comments: true } })` + `relations()` vs Kysely's `jsonArrayFrom` recipes ("kysely is not an ORM and it doesn't have the concept of relations", `kysely.dev/llms.txt`), and the `sql` tagged template on both. Restore them, and add one fact: in Drizzle v1 the old API survives only as `drizzle-orm/_relations` / `db._query` (`orm.drizzle.team/docs/relations-v1-v2`). | medium |
| R5 | §1, codegen layer | The "Code generation and AST" inventory table (stars, downloads, cadence, top-5 for `ts-morph`, `oxc-parser`, `@swc/core`, `@babel/core`, `magic-string`, `source-map-js`) was removed; `magic-string` and `source-map-js` no longer appear anywhere | Criterion 1 requires the per-layer table. Round-1 values were verified correct (e.g. ts-morph 6,197★ 34,149,591/wk 0/2; oxc 22,929★ 67,974,417/wk 30/**122**; swc 34,211★ 18/87; Babel 44,043★ 5/19; magic-string 2,778★ 264,549,242/wk 13/15). Restore the table with oxc's corrected 365-day count. | medium |
| R6 | 670 | Eden client snippet `import { treaty, type App } from '@elysia/eden'`, presented as "from `elysiajs.com/eden/installation`" | The page has `import { treaty } from '@elysia/eden'` and `import type { App } from './server'`. `App` is not exported by `@elysia/eden`; the doc's line is invented and would not compile. Copy the two lines verbatim. The Hono snippet (643-651) is abridged (the page has `// ...` inside the handler); label it "abridged". | medium |
| R7 | 800-802, 1022-1023 | `kysely-bun-sqlite@0.4.0` presented as the `bun:sqlite` option for Kysely | Its npm `peerDependencies` is `"kysely": "^0.28.2"`, which under 0.x caret semantics excludes the current `kysely@0.29.6`. State this; it makes the Kysely + `bun:sqlite` path weaker than "undocumented community path". | medium |
| R8 | 937 | "I found no source for the 'community fork CedarJS' claim and have dropped it" | It exists: `cedarjs/cedar` ("The React + GraphQL Web App Framework", 146★, created 2025-04-09, pushed 2026-10-01). README: "Companies transitioning from RedwoodJS or looking for an actively maintained full-stack framework". `@cedarjs/core@7.0.0` has **40,813**/wk, about 8× `@redwoodjs/core`'s 4,941. It is a continuation (not a GitHub fork flag) and a real precedent outcome. Restore it with these sources. | medium |
| R9 | 245 | `@cerbos/grpc` row: repo `cerbos/cerbos-sdk-javascript`, 4,604★ | 4,604 is `cerbos/cerbos` (the PDP server). `cerbos/cerbos-sdk-javascript` has **83★**. Either show 83 or label 4,604 as "server repo", as the OpenFGA row does. | low |
| R10 | 102-104 | "h3's repo is `unjs/h3` but the h3 v3 work lives under `h3js/h3` (redirect)" | h3's npm `repository` is `h3js/h3`; `unjs/h3` redirects to it. There is no separate "v3 work" location. Also contradicts line 10 ("taken from npm `repository`"). Replace with "repo `h3js/h3` (formerly `unjs/h3`)". Same fix at line 950 (`unjs/h3@2.0.1-rc.32`). | low |
| R11 | 942-945 | T3 recipe "Next.js (App Router) + tRPC + Prisma + Tailwind + shadcn/ui"; "Its integration history is the reference for…" | `t3-oss/create-t3-app` README lists Next.js, tRPC, Tailwind CSS, TypeScript, Prisma, **Drizzle**, **NextAuth.js**. No shadcn/ui. The claim is uncited. Fix the list, cite the README, and move the "reference for how a stack stays assembled" sentence to §Implications (rule 4). | low |
| R12 | 361 | "Daniel Rosenwaters" | The announcement's author is **Daniel Rosenwasser**. | low |
| R13 | 520-522, 996-997 | "The GitHub org formerly named `wintercg` now resolves to `WinterTC55`"; December 2024 date `[unverified]` | `gh api orgs/WinterTC55` is the original org (created 2022-03-31, "Technical Committee on Web-interoperable Server Runtimes"). The name `wintercg` is now held by a **different** org created 2026-08-18, so it does not resolve to WinterTC55. Date (settles the item I marked as from memory): the Ecma TC55 page's metadata says `datePublished: 2024-12-11` (`ecma-international.org/committees/tc55`). The public announcements are dated 2025-01-10 (W3C, Coralie Mercier, `w3.org/community/wintercg/2025/01/10/goodbye-wintercg-welcome-wintertc/`; Igalia, same date). Write: "TC55 was created in December 2024 (Ecma page first published 2024-12-11) and announced on 2025-01-10" and drop the `[unverified]`. | low |
| R14 | 633 | "Hono ships no validator" | `hono.dev/docs/guides/validation`: "Hono provides only a very thin Validator" (`import { validator } from 'hono/validator'`). Say "ships only a thin manual validator; schema validators are separate middleware". | low |
| R15 | 294 | tRPC "1 in 90 days and 21 in 365" | Paginated recount: **1/20** (the boundary release v11.6.0 is 2025-09-25, outside the window). | low |
| R16 | 502, 593 | "the `Elysia<typeof app>` generic for Eden" | Eden takes `treaty<App>` where `App = typeof app`; there is no `Elysia<typeof app>` construct. Write "`typeof app` (an `Elysia<…>` instance type) passed to `treaty<App>`". | low |
| R17 | 596, 944, 1003 | Opinion still in fact sections | "Already the best-analysed axis in this document" (596) and the T3 sentence (944) are opinions outside §Implications. Move or delete. | low |

### Package identity (check 2)

I checked every package named in every layer table (89 packages) against npm `repository` and `description`. All
match the project the row describes, except as listed below.

- `@cerbos/grpc` stars belong to the wrong repo (R9).
- `h3` repo is mis-stated (R10).
- `@prisma/client`'s npm field still says `prisma/prisma` and `@redwoodjs/core`'s says `redwoodjs/redwood`. Both redirect to the names the doc uses (`prisma/orm`, `redwoodjs/graphql`). Acceptable; a parenthetical would make it exact.
- `create-t3-app` weekly downloads are "—"; actual 698. Fill it in.

Downloads re-fetched for every new row match exactly:

| Package | Weekly downloads |
|---|---|
| `@hono/standard-validator` | 1,345,984 |
| `@nestjs/platform-express` | 12,952,123 |
| `@opentelemetry/sdk-node` | 23,041,126 |
| `@modelcontextprotocol/core` | 10,823,589 |
| `@modelcontextprotocol/server-legacy` | 519,205 |
| `@cerbos/grpc` | 77,230 |
| `typebox` | 14,235,555 |
| `@kurrent/kurrentdb-client` | 25,513 |
| `jsonapi-serializer` | 95,107 (version 3.6.9, `SeyZ/jsonapi-serializer`) |

### TypeScript compiler API subsection (check 4)

Correct:

- TS 7.0 ships no API, with the verbatim quote.
- 7.1 will bring a "new (and different)" API.
- `"main": null` and `"types": null`; the `.` export is `lib/version.cjs` with `versionMajorMinor = "7.0"`.
- The `unstable/*` list matches the `exports` map exactly.
- The clients spawn `tsc` with `["--api", "--cwd", cwd]`.
- 20 platform packages.
- `@typescript/typescript6@6.0.2` (bin `tsc6`), with the announcement's alias command.
- `typescript@6.0.3` exists.
- ts-morph 28 bundles TS 6.0.2, and its release note says "feat(BREAKING): TypeScript 6.0".

Wrong: the "type checker not shipped" cell (R1). Unchecked but honestly labelled: every "works inside a
`bun build --compile` binary" cell says "not checked". The reasoning that the TS 7 API needs the external native
`tsc` executable follows from `resolveExePath` + `spawn` in `dist/api/*/client.js`.

### Bun facts (check 6)

All correct:

- Eight targets, `bun-windows-arm64` supported.
- Four-column table.
- `Bun.Build.CompileTarget` plus `bun-linux-x64-baseline-musl`.
- Native-addon split.
- better-sqlite3 blocked: issue #4290 open, opened 2023-08-24, better-sqlite3 first unchecked item.
- `isStandaloneExecutable` is a property.
- Memory tables verbatim.
- Rust rewrite quote verbatim.
- Compat table, including the corrected `node:cluster` / `node:diagnostics_channel` rows.

The per-candidate table makes only sourced claims: Elysia compile (deploy doc), Prisma on Bun (changelog), Kysely
(dialects page), better-sqlite3 (issue). Everything else is "not checked". Prisma "yes since 7.0" is supported by
`prisma.io/changelog/2025-11-19` ("Rust-free Prisma Client becomes the default").

### Coupling and swap cost (check 8)

Correct as far as it goes:

- Drizzle's dialect-specific imports (`drizzle-orm/pg-core` vs `drizzle-orm/sqlite-core`).
- Hono `c.get('actor')` forcing an `Env['Variables']` type.
- The Elysia lifecycle order.
- The three Standard Schema interfaces and the opacity point (from `dist/index.d.ts`).
- Kysely `Kysely.schema`.
- Drizzle v1 RC (rc.4 2026-06-27, prerelease; npm `rc` tag 1.0.0-rc.4).
- The upgrade guide's "If you were using Relational Queries, you need to upgrade to v2".

What is missing is the code-level swap-cost comparison and the relational/raw-SQL subsections that round 1 had (R2,
R4).

### Fresh citation sample (check 9): 30 citations not checked before

| Result | Count | Items |
|---|---|---|
| Supports | 23 | bun.com/docs/runtime/http/server.md; /runtime/sql.md; /runtime/sqlite.md; /docs/test (Jest-compatible); ecma-international.org/committees/tc55 (both quotes); elysiajs.com/essential/life-cycle.md (order); prisma.io/changelog/2025-11-19; orm.drizzle.team/docs/get-started/bun-sqlite-new; npm `@hono/standard-validator` (0.4.0, peers); npm `@nestjs/platform-express` (repo, maintainers, DL); `gh api repos/nestjs/nest/contents/packages`; npm `@opentelemetry/sdk-node`; npm `@modelcontextprotocol/core`; npm `@modelcontextprotocol/server-legacy`; npm + gh `create-t3-app` (7.40.0, 29,149★, push 2025-12-13); npm `jsonapi-serializer`; npm `@jridgewell/sourcemap-codec@1.6.0`; npm `@hono/zod-openapi` repo `honojs/middleware`; npm `hono-openapi` repo `rhinobase/hono-openapi`; npm `@elysia/openapi` repo `elysiajs/elysia-openapi`; `typescript@7.0.2` `dist/api/sync/client.js` args; gh releases emmett 1/11; gh releases Elysia/Hono stable totals 105/405 |
| Partly | 4 | GitHub `wintercg`→`WinterTC55` (R13); `elysiajs.com/eden/installation` snippet (R6); npm `@cerbos/grpc` row stars (R9); gh releases tRPC 1/21 (R15) |
| Does not support | 3 | `typescript@7.0.2` `dist/api/sync/api.d.ts` vs "type checker not shipped" (R1); npm `h3` repository vs "repo is `unjs/h3`" (R10); TS 7 announcement byline vs "Rosenwaters" (R12) |
| Dead link | 0 | — |

Support rate: 23/30 = **77%** fully supported (round 1: 44%), 13% partial, 10% not supported.

### Content lost in the rewrite (check 11)

Correct round-1 content that must be restored (R2-R5, R8):

1. The code-level swap-cost comparison of Drizzle / Kysely / TypeORM / Prisma (schema, query model, migrations, transactions).
2. "What generated mesh routes would look like" for Hono and Elysia.
3. Drizzle-vs-Kysely "Relational queries" and "Raw SQL escape hatch".
4. The codegen/AST inventory table, including `magic-string` and `source-map-js`.
5. The CedarJS continuation, which was dropped on a false "no source" claim.

Nothing else of substance was lost; the remaining removals were errors.

### Criteria after round 2

| # | Status | Remaining gap |
|---|---|---|
| 1 | Partial | Codegen table removed (R5). Maintainers/funding, footprint and pain-point columns still absent; this is acknowledged in Open questions 5 and acceptable only if the lead agrees. |
| 2 | Mostly complete for HTTP/data/validation/tracing | Other layers inventory-only (acknowledged). |
| 3 | Partial | Real API comparisons deleted (R2). |
| 4 | Mostly complete | Generated-route sketches deleted (R3); Eden snippet fabricated line (R6). |
| 5 | Partial | Relational queries and raw-SQL subsections deleted (R4); `kysely-bun-sqlite` peer range (R7). |
| 6 | Complete | Idle RSS still unmeasured, but the nearest primary figures are cited and labelled. |
| 7 | Mostly complete | CedarJS (R8), T3 composition (R11). Ash's own data-layer contract still absent; one line plus a pointer to the `ash-*` researchers is enough. |

---

## Round 3 final check

Checked 2026-10-01 against the round-3 document (1,659 lines, 15,495 words). Line numbers refer to that version.
Every check below was redone at the source:

- npm registry and downloads API.
- `gh api`.
- Package tarballs: `typescript@7.0.2` and `drizzle-orm@0.45.3`, unpacked in the scratchpad.
- Official documentation pages: the Drizzle HTML pages, the Kysely `.md` pages, typeorm.io, prisma.io, hono.dev, and the GitHub READMEs.

I compared snippets after normalising whitespace, so a reformatted but identical snippet counts as verbatim.

### Final verdict: ACCEPT-WITH-FIXES

All 17 round-2 findings were applied, and 16 of them are correct at the source.

Most of the restored content is verbatim from the cited pages. The exceptions:

- one Drizzle API is used that does not exist in the stated `latest` version;
- the Hono generated-route sketch would not produce the typed client it claims;
- one invented Drizzle join syntax;
- one capability-table row is wrong about TypeORM;
- Prisma 8 (an RC) is presented as "current" without saying so.

The round-1 Bun "top-5 82%" figure was rechecked and is correct (14,060 of 17,095 = 82.2%).

None of this overturns a conclusion. No further round will run, so readers should apply the residual list at the end.

### R1–R17: applied and correct?

| # | Applied? | Correct at source? | Evidence / note |
|---|---|---|---|
| R1 | yes (lines 403, 405-411, 434) | **yes** | `typescript@7.0.2/dist/api/sync/api.d.ts`: `class Project { compilerOptions; rootFiles; program: Program; checker: Checker; emitter: Emitter; dispose() }`; `Checker.getDeclaredTypeOfSymbol` (l.226), `getCompletionsAtPosition` (230), `getResolvedSignature` (234), `getTypeAtPosition` (235), `getSymbolAtLocation`, `getTypeAtLocation`, `getTypeOfSymbol`; `Emitter.printNode` (337); `class NodeHandle` (339); `class Symbol` (373); guards `isUnionType`/`isObjectType`/`isErrorType` (465-496). Minor: line 409 misquotes the announcement as "will ship with a new (and different) API"; the actual text is "We expect TypeScript 7.1 to ship with a new (and different) API". |
| R2 | yes (§5.1, lines 655-889) | **mostly** | See the snippet table below. Wrong: the Drizzle join syntax (l.732-733), the Drizzle RQB-v2 API presented without a version label (l.813-839), the TypeORM "no schema artifact" row (l.882), and Prisma 8 RC framed as "current" (l.719-720, 757-764, 804-806). |
| R3 | yes (lines 1072-1113) | **partly** | The Hono sketch defines `export const app = new Hono().basePath('/api')` and then calls `app.post(...)` as a separate statement before `export type AppType = typeof app`. Hono's docs require chaining for RPC types: best-practices page, "if you want to use the RPC feature, you can get the correct type by chaining"; rpc page, "chain the handlers so that the types are always inferred". As written, `AppType` carries no `/posts` route, so `hc<AppType>` would be untyped. The claim at line 1074 that "every construct they use is documented" is therefore not true of the composition. Elysia sketch: `import { z } from 'zod'` is unused and `actorFromContext` is undefined (cosmetic, but it is presented as near-real code). |
| R4 | yes (lines 1127-1161) | **mostly** | The `_relations`/`db._query` relocation, the Kysely "is not an ORM… doesn't have the concept of relations" quote, the `jsonArrayFrom` recipe and both raw-SQL quotes are verified. Wrong: line 1129 "Relation definitions are passed to `drizzle()`" describes the v1-RC API; `drizzle-orm@0.45.3` (npm `latest`) has **no `defineRelations`** (0 matches in the tarball) and uses `relations()` + `drizzle(url, { schema })`. Line 1131: "a normal argument rather than a module" appears in no Drizzle page (researcher paraphrase presented as fact). The callback-parameter quote is verbatim from `/docs/rqb`. |
| R5 | yes (lines 302-323) | **yes**, numbers all exact | `source-map-js` 1.2.2 / 222,601,287 / 102★; `@jridgewell/sourcemap-codec` 1.6.0 / 267,975,697; `gen-mapping` 0.3.13 / 228,415,483; `trace-mapping` 0.3.31 / 301,813,077; `jridgewell/sourcemaps` 54★; swc 34,210★; top-5 shares ts-morph 96.5% (2,226/2,341), oxc 67.8%, swc 87.1%, Babel 64.4%, magic-string 79.2%. Gaps: `@typescript/typescript6` weekly downloads shown as "—" (actual **8,690,842**). Lines 321-323 say the source-map libraries "carry no `bun build --compile` risk (not checked either way)", which contradicts itself. |
| R6 | yes (lines 920-971) | **yes** | Eden import lines verbatim (`import { treaty } from '@elysia/eden'`, `import type { App } from './server'`); the Hono server block is labelled abridged and the client block is verbatim. |
| R7 | yes (lines 1177-1186) | **yes** | `kysely-bun-sqlite@0.4.0` `peerDependencies: {"kysely": "^0.28.2"}`; repo `dylanblokhuis/kysely-bun-sqlite`. |
| R8 | yes (lines 1322-1336) | **yes** | `cedarjs/cedar`: MIT, 146★, created 2025-04-09, `fork: false`, README quote verbatim; `@cedarjs/core@7.0.0`, MIT, `directory: packages/core`, 40,813/wk. Line 1336 says "what that means for mesh is in §9", but §9 *is* this section; it should point to "Implications for mesh". |
| R9 | yes (line 245) | **yes** | 83★. |
| R10 | yes (lines 102-104, 1353) | **yes** | |
| R11 | yes (lines 1338-1348) | **yes** | Both README quotes are verbatim ("a web development stack made by Theo focused on simplicity, modularity, and full-stack typesafety"; "each piece is optional, and the 'template' is generated based on your specific needs"); seven parts correct; 698/wk correct. Line 1347-1348 "the recipe is the product" is still opinion in a fact section. |
| R12 | yes (line 385) | **yes**, re-checked myself | The announcement page HTML contains "Daniel Rosenwasser" 13 times and no other spelling (`devblogs.microsoft.com/typescript/announcing-typescript-7-0/`). |
| R13 | yes (lines 556-569, 1406-1407) | **yes**, one overreach | W3C quote verbatim; Ecma `datePublished 2024-12-11`; `WinterTC55` created 2022-03-31. `gh api orgs/wintercg` → name "WinterCG", description "Web-interoperable Runtimes Community Group", 0 public repos, created 2026-08-18. It is a different org, but it has the same name and description, so "**unrelated**" (line 568) is unsupported. Write "a different organisation". |
| R14 | yes (lines 910-916) | **yes** | |
| R15 | yes (line 294) | **yes** | |
| R16 | yes (lines 535, 640) | **yes** | |
| R17 | partly | partly | "Already the best-analysed axis" removed. Opinion and recommendation still sits in fact sections (see check 6). |

### Restored content, snippet by snippet (check 3)

| Snippet / claim | Lines | Source | Result |
|---|---|---|---|
| Drizzle `usersTable = pgTable("users", {...})` + import | 665-674 | orm.drizzle.team/docs/sql-schema-declaration | verbatim |
| Kysely `Database` interface "six tables; only the two used here are shown" | 676-694 | kysely.dev/docs/examples/select/all-columns-of-a-table | Real snippet, but **wrong description**. The page's `Database` has **seven** tables (audit, person, person_backup, pet, toy, wine, wine_stock_change); the doc shows three and a heavily trimmed `PersonTable` (the page's has ~18 fields). `export type Person = Selectable<PersonTable>` is real. |
| TypeORM `@Entity() class User` | 696-707 | typeorm.io/docs/entity/entities | verbatim (abridged, labelled) |
| Prisma `model User {…}` | 709-717 | prisma.io/docs/orm/prisma-schema/data-model/models | verbatim |
| "client contract file is now named `contract.prisma`" | 719-720 | prisma.io queries + models pages | Supported by the docs ("the contract.prisma file that replaced schema.prisma"). Those docs describe **Prisma ORM 8**, which on npm is only `prisma@8.0.0-rc.19`; `@prisma/client@latest` is **7.10.0** (`next: null`), where `schema.prisma` is still the file. The doc does not say 8 is an RC. |
| Drizzle `db.select().from(users)` + SQL + "result type is inferred…" | 724-732 | /docs/select | verbatim. The heading promises "a filtered query with a join"; the snippet has neither. |
| Drizzle "joins are declared with `.innerJoin(table, on.<col>, eq.<col>)`" | 732-733 | /docs/select, /docs/joins | **Not real syntax.** The docs show `.innerJoin(pets, eq(users.id, pets.ownerId))` (orm.drizzle.team/docs/joins). |
| Kysely `selectFrom('person').innerJoin('pet', …)` | 737-745 | kysely.dev/docs/examples/join/simple-inner-join | verbatim |
| TypeORM `manager.find(User, { where: { firstName: "Timber" } })` | 749-755 | typeorm.io entity-manager-api | verbatim (no join, despite the heading) |
| Prisma 8 `db.orm.public.Post.where({ published: true }).all()` + "Every query chains…" | 761-768 | prisma.io/docs/orm/prisma-client/queries | verbatim; same RC caveat as above |
| Drizzle `db.transaction(async (tx) => …)`; savepoints; `tx.rollback()` | 774-781 | /docs/transactions | verbatim |
| Kysely `db.transaction().execute(async (trx) => …)` + rollback semantics quote | 786-802 | kysely.dev simple-transaction | verbatim (values objects collapsed onto one line) |
| Prisma "Prisma ORM 8 has no `$transaction`…" | 804-806 | prisma.io …/queries/transactions | verbatim; RC caveat |
| Drizzle `drizzle(process.env.DATABASE_URL, { relations })` + `db.query.users.findMany({ with: { posts: true } })` | 812-820 | cited "/docs/rqb and /docs/relations" | Verbatim on `/docs/rqb` only, not on `/docs/relations`. It is the **RQB v2 / Drizzle v1-RC API**: `drizzle-orm@0.45.3` (npm `latest`) exports no `defineRelations`, so this code does not run on the version the document's tables list. Must be labelled "v1 RC". |
| Drizzle `orderBy: (t) => sql\`${t.id} asc\`` + "❌ direct table usage" | 826-837 | /docs/rqb | verbatim (same v1-RC caveat) |
| `drizzle-orm/_relations` + `db._query` | 837-839 | /docs/relations-v1-v2 | verbatim |
| Kysely `jsonArrayFrom` + SqliteDialect JSON-parsing quote | 844-853 | kysely.dev/docs/recipes/relations | verbatim |
| Drizzle "Magic `sql` operator" quote | 860-863 | /docs/sql | verbatim (apart from apostrophe style) |
| Kysely raw-sql quote | 865-866 | kysely.dev/docs/recipes/raw-sql | verbatim |
| "TypeORM loads relations lazily through its entity manager" | 855 | uncited | Incomplete: TypeORM supports eager, lazy and explicit `relations:` loading in `find`; "lazily" alone misdescribes it. |
| Capability table "Kysely and TypeORM have no schema artifact" | 882 | uncited | **Wrong for TypeORM.** Decorated entity classes are the schema of record, and TypeORM's CLI `migration:generate` diffs entities against the database. |
| Capability table "TypeORM uses a manager" (transactions) | 878 | uncited | TypeORM's transaction is also a callback (`dataSource.transaction(async (manager) => …)`); the distinction drawn is weaker than stated. |
| Codegen/AST table | 302-316 | npm + gh | all figures exact (see R5) |
| Generated-route sketches | 1082-1105 | constructs from hono/elysia docs | Hono sketch breaks Hono's chaining requirement (see R3) |

### Fresh citation sample (check 4): 30 citations not checked in rounds 1–2

The sample is weighted to §4, §5/§5.1, §6, §8 and §9.

| Result | Count | Items |
|---|---|---|
| Supports | 23 | Bun top-5 82% (contributors API: top-5 14,060 of 17,095 = 82.2%); Drizzle sql-schema-declaration; Drizzle /select snippet + SQL + inference quote; Drizzle /transactions snippet; Drizzle savepoints + `tx.rollback()`; Drizzle /rqb `orderBy` callback snippet; Drizzle /rqb "❌ direct table usage"; Drizzle relations-v1-v2 `_relations`/`_query`; Drizzle /sql quote; Kysely simple-inner-join; Kysely simple-transaction + semantics quote; Kysely recipes/relations snippet + SqliteDialect quote; Kysely recipes/raw-sql; TypeORM entities; TypeORM entity-manager-api; Prisma models snippet; Prisma `contract.prisma` statement; Prisma `db.orm` + "Every query chains"; Prisma "no `$transaction`"; W3C 2025-01-10 announcement quote; T3 README quotes; `typescript@7.0.2` `api.d.ts` member list; codegen-table stars/downloads/top-5 figures |
| Right fact, wrong line or detail | 4 | `findMany({ with })` snippet attributed to `/docs/relations` (it is on `/docs/rqb` only); Kysely all-columns "six tables" (seven; three shown); `wintercg` org "unrelated" (same name and description, different org); line 409 announcement misquote ("will ship with" vs "We expect TypeScript 7.1 to ship with") |
| Does not support | 2 | Drizzle join syntax `.innerJoin(table, on.<col>, eq.<col>)` vs docs `eq(users.id, pets.ownerId)`; "every construct they use is documented" for the Hono sketch vs Hono's chaining requirement (hono.dev/docs/guides/best-practices) |
| Nonexistent (in the stated version) | 1 | `drizzle(url, { relations })` / `defineRelations` RQB v2 API: absent from `drizzle-orm@0.45.3` (npm `latest`); exists only on the 1.0 RC line |

Support rate: 23/30 = **77%** fully supported, 13% right fact/wrong detail, 7% not supported, 3% nonexistent in the
stated version.

### Check 5: nothing from round 2 lost or broken

All round-2-verified content is still present and unchanged, including:

- the four rebuilt packages, the release counts and the Bun 1.4 tables;
- the Elysia/Hono quotes, Node adapters and benchmarks;
- the TS 7 section;
- the Standard Schema signatures and Kysely dialect counts;
- Redwood, Auth.js (the "maintenance will continue for security and urgent issues" text is verbatim in discussion #13252) and NestJS.

### Check 6: recommendations or opinion in fact sections

| Line | Text | Why it does not belong |
|---|---|---|
| 439-444 (§2) | "line 202 of the plan … **must** name which of these it means" | Recommendation to the plan; move to Implications. |
| 652-653 (§5) | "is the one I would analyse first" | Researcher preference. |
| 1144-1145 (§7) | "Drizzle's relational queries are much closer to the shape; Kysely makes you write the join" | Analysis. |
| 1248-1250 (§8) | "it **should** be measured locally against … 284 MB" | Recommendation (fine in Open questions, where it already is). |
| 1347-1348 (§9) | "the *recipe* is the product" | Opinion (R17 said it was moved; it was not). |
| 1376-1378 (§9) | "consolidation is one way projects have responded to it" | Causal inference, unsourced. |
| 868, 1161 | "neither is a differentiator" | Judgement. Mild, acceptable if moved. |

### Residual errors (for readers)

1. **§5.1 lines 812-839 and §7 line 1129: Drizzle relational-query code is the 1.0-RC API.** `drizzle(url, { relations })`, `defineRelations` and callback-style `orderBy: (t) => …` come from `orm.drizzle.team/docs/rqb` (Relational Queries v2). `drizzle-orm@0.45.3`, the npm `latest` the document's tables list, contains no `defineRelations`. On 0.45.3 the form is `relations()` + `drizzle(url, { schema })` + `db.query.users.findMany({ with: { posts: true } })`. Read these snippets as "Drizzle v1 RC (`1.0.0-rc.4`, npm tag `rc`)". The `findMany({ with })` snippet is on `/docs/rqb`, not `/docs/relations`.
2. **§5.1 lines 732-733: the Drizzle join syntax `.innerJoin(table, on.<col>, eq.<col>)` does not exist.** The real form is `.innerJoin(pets, eq(users.id, pets.ownerId))` (`orm.drizzle.team/docs/joins`). Also, none of the four "filtered query with a join" snippets contains both a filter and a join; only Kysely's has a join.
3. **§6 lines 1085-1090: the generated Hono route would not type the client.** The routes are not chained onto the exported `app`, so `typeof app` carries no `/posts` route. Hono requires chaining for RPC types (`hono.dev/docs/guides/best-practices`: "if you want to use the RPC feature, you can get the correct type by chaining"). Read it as `export const app = new Hono().basePath('/api').post('/posts', zValidator('json', CreatePostInput), (c) => …)`. In the Elysia sketch, `import { z } from 'zod'` is unused and `actorFromContext` is undefined.
4. **§5.1 lines 719-720, 757-768, 804-806: the "current" Prisma API is Prisma ORM 8, which is a release candidate.** It covers `contract.prisma`, `db.orm.public.Post.where(...).all()` and "no `$transaction`". The docs do describe it (`prisma.io/docs/orm/prisma-client/queries`, `/queries/transactions`). On npm, 8 exists only as `prisma@8.0.0-rc.19`; `@prisma/client@latest` is **7.10.0**, where `schema.prisma`, `prisma.post.findMany` and `$transaction` are still the stable API.
5. **§5.1 line 882: "Kysely and TypeORM have no schema artifact" is wrong for TypeORM.** Its decorated entity classes are the schema of record, and its CLI generates migrations by diffing them. Line 855 ("loads relations lazily") is also incomplete: TypeORM supports eager, lazy and explicit `relations:` loading.
6. **§5.1 lines 676-678: the Kysely example `Database` has seven tables, not six.** The doc shows three, and `PersonTable` is cut from about 18 fields to 3 (`kysely.dev/docs/examples/select/all-columns-of-a-table`).
7. **§2 line 409: misquote.** The announcement says "We expect TypeScript 7.1 to ship with a new (and different) API", not "will ship with". The rest of §2, including the `Project`/`Program`/`Checker`/`Emitter` inventory, is correct.
8. **§1 lines 307 and 321-323: two gaps in the codegen table.** `@typescript/typescript6` weekly downloads are 8,690,842, not "—". The claim that the source-map libraries "carry no `bun build --compile` risk (not checked either way)" contradicts itself; read it as "not checked".
9. **§4 line 568: the `wintercg` GitHub org is not "unrelated".** It has the same name ("WinterCG") and description ("Web-interoperable Runtimes Community Group"); it is a different org, created 2026-08-18 with 0 public repos, and does not redirect to `WinterTC55`.
10. **§9 line 1336: wrong cross-reference.** "What that means for mesh is in §9" points at the section itself; the intended target is "Implications for mesh".
11. **Opinions in fact sections** (lines 439-444, 652-653, 1144-1145, 1248-1250, 1347-1348, 1376-1378): read them as the researcher's analysis, not as sourced fact.
12. **Still open, as the document itself admits:**
    - every "works inside `bun build --compile`" cell except Elysia;
    - idle RSS of a Bun HTTP + SQLite server;
    - the Inngest SDK licence conflict (npm Apache-2.0 vs GitHub GPL-3.0);
    - maintainers/funding and footprint columns;
    - model-level comparison of the jobs, workflows, event-sourcing and authorization layers.
