---
title: "Candidate foundation libraries"
description: "Candidate foundation libraries for each layer of a Mesh implementation."
---

# Candidate foundation libraries for Mesh, layer by layer

> Independent fact-check: [review of this document](./reviews/ts-foundation-candidates-review.md).

Ref: `ts-foundations` · Date: 2026-10-01 (round 2 corrections) · For the Ash-style resource
framework design

Everything below was measured on **2026-10-01**. Package versions and licences come from
`https://registry.npmjs.org/<pkg>/latest`; weekly downloads from
`https://api.npmjs.org/downloads/point/last-week/<pkg>`; stars, licences, release dates and
contributor counts from `https://api.github.com/repos/<owner>/<repo>` via the `gh` CLI. Every
package's repository URL in this document is taken from that package's own npm `repository`
field, never guessed.

**Method notes that change how the numbers should be read.**

- `rel90/rel365` = **non-prerelease, non-draft** GitHub releases whose `published_at` is on or
  after **2026-07-03** (90-day window) or **2025-10-01** (365-day window). Counted with
  `gh api --paginate "repos/<owner>/<repo>/releases?per_page=100"`, so there is **no 100-release
  cap** anywhere in this document. Round 1 printed capped values as facts; they are gone.
- `top5%` = share of the **top 100 contributors returned by the GitHub contributors API**
  (not "all contributions"), where the API returned exactly 100 entries. Repos with fewer
  contributors are counted over all of them. The single-person share is given separately as
  `lead%` where it matters.
- Evidence strength is stated per row: version/stars/downloads are hard numbers; Bun support,
  Node support and `bun build --compile` behaviour are only claimed where a primary source was
  read, otherwise the cell says **not checked**. Nothing is from memory alone; unconfirmed
  beliefs are marked `[unverified]`.

Elixir terms used here: **macro** — code that generates code at compile time; **behaviour** — a
contract (a set of required callbacks) that modules can implement; **GenServer** — an
Erlang-style process with its own mailbox and state.

---

## Summary

- **Four rows in the round-1 tables described the wrong npm packages.** `dbos`, `hatchet`,
  `emmett` and `pgroll` on npm are unrelated projects ("Who cares", 2016; "Send user activities
  into logstash", 2015; a 2020 event emitter; an unrelated Postgres tool). The real candidates
  are `@dbos-inc/dbos-sdk`, `@hatchet-dev/typescript-sdk`, `@event-driven-io/emmett`, and — for
  pgroll — a **Go CLI that is not distributed via npm at all**.
- **Elysia and Hono both accept Standard Schema.** Elysia is not locked to `t`: its validation
  page says "Elysia also supports Standard Schema, allowing you to use your favorite validation
  library: Zod, Valibot, ArkType, Effect Schema, Yup, Joi". Hono gets there through
  `@hono/standard-validator`. `Elysia.t` *is* TypeBox, and Elysia peer-pins `@sinclair/typebox
  >= 0.34.0 < 1`.
- **Both frameworks need an adapter package on Node.** Elysia uses `@elysia/node`; Hono uses
  `@hono/node-server` ("Hono was not designed for Node.js at first, but with a Node.js Adapter,
  it can run on Node.js"). The asymmetry the round-1 document built its argument on does not exist.
- **Elysia's OpenAPI plugin is no longer `@elysiajs/swagger`.** The swagger page opens with
  "Swagger plugin is deprecated and is no longer maintained. Please use OpenAPI plugin instead";
  the current packages are `@elysia/openapi@1.4.16` and the mirror `@elysiajs/openapi@1.4.16`.
  Hono's OpenAPI lives in Hono-org middleware (`@hono/zod-openapi`, repo `honojs/middleware`),
  not in core.
- **Published benchmarks exist on both sites and both are old or self-published.** Elysia's
  at-a-glance table is footnoted "Debian 11, Intel i7-13700K tested on **Bun 0.7.2 on 6 Aug
  2023**" and points at a benchmark repo maintained by Elysia's own author; Hono's Bun section
  links to that same repo, and its own numeric tables are Deno/Hono 3.0.0 era.
- **Bus factor: single-person shares are 86% (Elysia, `SaltyAom` 1,918/2,225) and 68% (Hono,
  `yusukebe` 1,755/2,578).** The 90% and 84% figures that circulate are **top-5** shares. Hono's
  second contributor has 245 commits to Elysia's 30.
- **TypeScript 7.0 ships no compiler API.** Microsoft: "While TypeScript 7.0 is here, it does not
  ship with an API." `typescript@7.0.2`'s `package.json` has `"main": null`; the `.` export is
  `lib/version.cjs` and everything else is `unstable/*` over a spawned native `tsc --api`. The
  supported typed-AST path today is TypeScript **6.0** (`typescript@~6.0`,
  `@typescript/typescript6`, or `ts-morph@28`, which bundles TS 6.0.2).
- **Bun's compile matrix has eight targets and all of them are supported**, including
  `bun-windows-arm64`. The round-1 "❌ / Windows ARM64 gap" row was invented. What *is* missing is
  cross-target native-addon embedding, and `better-sqlite3` does not run on Bun at all (open issue
  `oven-sh/bun#4290`).
- **Bun 1.4 memory figures do exist** in Bun's own release notes: `hello.js` peak 14.6 MB on Linux
  (Node 26: 44.5 MB); peak under 1M requests / 64 connections: `node:http` 81 MB, **Elysia 55 MB**,
  Express 92 MB, Fastify 120 MB, `Bun.serve` 36 MB. Bun 1.4 is also the first release "now written
  in Rust".
- **The RedwoodJS cautionary tale was misread.** Redwood's cadence drop follows a **strategic
  pivot** to RedwoodSDK announced 2025-04-01 ("RedwoodJS will remain fully supported"), not an
  integral-data-layer coupling. It is not evidence about Prisma.
- **Auth.js is now maintained by the Better Auth team** (announced 2025-09-26, "our pace slowed
  over the past year… maintenance will continue for security"). That, not a storage adapter, is
  now the interesting fact about that layer.
- **What survives unchanged:** Drizzle (schema-of-record) and Kysely (query layer) are
  complementary rather than competing; Standard Schema is the one genuinely neutral contract but
  it is **opaque** (you cannot read fields or defaults off it); and the whole candidate set is
  concentrated, with top-5 shares of 60–97% almost everywhere.

---

## 1. Master snapshot

All numbers from the APIs above, 2026-10-01. Method caveats in the header.

### HTTP servers

| Package | Version | Licence | Stars | Weekly DL | rel90/365 | top5% | lead% |
|---|---|---|---|---|---|---|---|
| `elysia` | 1.4.30 | MIT | 19,207 | 1,356,946 | 1/21 | 90% | 86% (`SaltyAom` 1,918) |
| `hono` | 4.13.12 | MIT | 32,400 | 78,082,739 | 22/73 | 84% | 68% (`yusukebe` 1,755) |
| `fastify` | 5.12.5 | MIT | 37,217 | 16,606,307 | 10/23 | 54% | — |
| `h3` | 2.0.1-rc.32 | MIT | 5,442 | 53,755,875 | 10/40 | 84% | — |
| `nitropack` (Nitro v2 line) | 2.13.4 | npm: MIT / GitHub: NOASSERTION | 11,255 | 2,667,019 | 1/17 | 85% | — |
| `nitro` (v3 line) | 3.0.260903-beta | — | same repo | — | — | — | — |

Repos: `elysiajs/elysia`, `honojs/hono`, `fastify/fastify`, `h3js/h3` (formerly `unjs/h3`, which
redirects), **`nitrojs/nitro`** (the Nitro repo moved from `unjs/nitro`; the old name redirects).
h3's npm `repository` field is `h3js/h3`. `h3@latest` is a **release candidate**
(`2.0.1-rc.32`), and `fastify@latest` is 5.12.5 while its newest GitHub release is a prerelease
`v6.0.0-alpha.4`.

### Data access

| Package | Version | Licence (npm) | Repo (from npm `repository`) | Stars | Weekly DL | rel90/365 | top5% |
|---|---|---|---|---|---|---|---|
| `drizzle-orm` | 0.45.3 | Apache-2.0 | `drizzle-team/drizzle-orm` | 35,928 | 29,472,576 | 2/12 | 79% |
| `kysely` | 0.29.6 | MIT | `kysely-org/kysely` | 14,253 | 20,470,848 | 4/17 | 90% |
| `prisma` (CLI) | 8.0.0-rc.19 | Apache-2.0 | `prisma/prisma-cli` | 47,686 | 20,627,431 | 4/23 | 94% |
| `@prisma/client` | 7.10.0 | Apache-2.0 | `prisma/orm` | 47,686 | 19,703,477 | 4/23 | 94% |
| `typeorm` | 1.1.1 | MIT | `typeorm/typeorm` | 36,655 | 6,379,569 | 3/7 | 60% |
| `mikro-orm` | 7.2.3 | MIT | `mikro-orm/mikro-orm` | 9,245 | 945,410 | 15/58 | 94% |
| `postgres` (postgres.js) | 3.4.9 | Unlicense | `porsager/postgres` | 8,731 | 22,048,218 | — | — |
| `@libsql/client` | 0.18.0 | MIT | `tursodatabase/libsql-client-ts` | 577 | 3,717,376 | — | — |
| `better-sqlite3` | 13.0.3 | MIT | `WiseLibs/better-sqlite3` | 7,499 | 13,347,409 | — | — |
| **Bun built-ins** | `bun-types` 1.4.2 | MIT | `oven-sh/bun` | — | — | — | — |
| `Bun.serve` | runtime API | — | `oven-sh/bun` | — | — | — | — |
| `Bun.sql` | runtime API | — | `oven-sh/bun` | — | — | — | — |
| `bun:sqlite` | runtime API | — | `oven-sh/bun` | — | — | — | — |

The four "repo 404" entries in round 1 were guessed owner/repo names. The correct repos come
straight from npm: `porsager/postgres`, `WiseLibs/better-sqlite3`,
`tursodatabase/libsql-client-ts`, `stalniy/casl`, `hayes/pothos`, `castore-dev/castore`.
`@libsql/client`'s 17,249 stars in round 1 were `tursodatabase/libsql`, **the database**; the
client repo has 577.

`prisma@latest` (`8.0.0-rc.19`) and `@prisma/client@latest` (`7.10.0`) are on different majors by
design: the CLI was repackaged into its own repo (`prisma/prisma-cli`, described as "The Prisma
CLI: one binary for the ORM, Composer, and the Prisma Developer Platform"), the ORM repo was
renamed `prisma/orm`, and the RC is deliberately on `latest` with `prev` = 7.10.0. This is not
registry lag.

Bun's own driver APIs are first-class candidates for a Bun-first framework and cost nothing:
`Bun.serve` ("Use `Bun.serve` to start a high-performance HTTP server in Bun",
`bun.com/docs/runtime/http/server.md`), `Bun.sql` ("native bindings for working with SQL databases
through a unified Promise-based API that supports PostgreSQL, MySQL, and SQLite",
`bun.com/docs/runtime/sql.md`) and `bun:sqlite` ("Bun natively implements a high-performance
SQLite3 driver", `bun.com/docs/runtime/sqlite.md`).

### Migrations

| Package | Version | Licence | Repo | Stars | Weekly DL | rel90/365 | Note |
|---|---|---|---|---|---|---|---|
| `drizzle-kit` | 0.31.11 | MIT | `drizzle-team/drizzle-orm` | (same repo) | 24,270,410 | 2/12 | paired release with `drizzle-orm` |
| `@ariga/atlas` | 1.3.3 | **Ariga EULA** (npm) / Apache-2.0 (GitHub source) | `ariga/atlas` | 8,757 | 20,799 | 1/5 | not an OSI licence on npm |
| **pgroll (Xata)** | Go CLI, **not on npm** | Apache-2.0 | `xataio/pgroll` | 6,594 | n/a | — | npm `pgroll` is an unrelated `tnht95` tool |
| Kysely `Migrator` | ships in `kysely/migration` | MIT | `kysely-org/kysely` | — | — | — | hand-written SQL/TS files, no diffing |
| Prisma Migrate | ships with `prisma` | Apache-2.0 | `prisma/prisma-cli` | — | — | — | owns `schema.prisma` |
| `pg-boss`, `graphile-worker` | see jobs table | MIT | — | — | — | — | ship their own schema migration |

Atlas's npm `latest` manifest carries a licence string that is a **custom EULA**, not SPDX:
"licensed under the Ariga End User License Agreement available at
https://ariga.io/legal/atlas/eula. By using this software, you accept the terms described in the
license." (`https://registry.npmjs.org/@ariga/atlas/latest`). The GitHub repository is
Apache-2.0, so the source is open and the distributed npm artefact is not.

**The pgroll row is rebuilt from scratch.** npm `pgroll@0.0.10` is `tnht95/pgroll`, ISC,
469 weekly downloads — an unrelated tool. Xata's pgroll is a **Go command-line binary**, published
on GitHub (`xataio/pgroll`, 6,594 stars, Apache-2.0, last push 2026-09-21) and not distributed
through npm. Round 1's claim that it "moved out of Atlassian" is **removed**: a 404 on a guessed
URL is not evidence, and I found no source for an Atlassian origin.

### Schema and validation

| Package | Version | Licence | Stars | Weekly DL | rel90/365 | top5% |
|---|---|---|---|---|---|---|
| `zod` | 4.6.5 | MIT | 44,051 | 359,979,939 | 11/26 | 77% |
| `valibot` | 1.5.0 | MIT | 9,029 | 24,325,230 | 3/19 | 83% |
| `arktype` | 2.2.6 | MIT | 7,872 | 2,344,112 | 54/182 | 88% |
| `typebox` (**current line**) | 1.3.34 | MIT | 6,976 | 14,235,555 | 0/0 | 93% |
| `@sinclair/typebox` (legacy line) | 0.34.52 | MIT | repo `sinclairzx81/sinclair-typebox`, 12★ | 135,762,057 | 0/0 | — |
| `effect` (Schema) | 4.0.0 | MIT | 16,327 | 47,965,603 | 96/468 | 84% |
| `@standard-schema/spec` | 1.1.0 | MIT | — | 141,979,763 | — | — |

Round 1 listed only `@sinclair/typebox`, the **legacy** 0.34 line, whose npm `repository` points
at a different, near-empty repo. Current TypeBox is the unscoped **`typebox@1.3.34`** (README:
`npm install typebox`), repo `sinclairzx81/typebox`, which has **zero GitHub releases** (tags
only) — so the npm version moves independently of the release feed. This matters directly:
`elysia@1.4.30`'s `peerDependencies` pin `@sinclair/typebox: ">= 0.34.0 < 1"`, i.e. Elysia is on
the legacy line and cannot consume `typebox@1`.

### Background jobs

| Package | Version | Licence | Stars | Weekly DL | rel90/365 | top5% |
|---|---|---|---|---|---|---|
| `bullmq` | 6.3.11 | MIT | 9,464 | 10,429,842 | 117/241 | 90% |
| `pg-boss` | 12.35.1 | MIT | 4,012 | 2,449,121 | 35/91 | 90% |
| `graphile-worker` | 0.18.0 | MIT | 2,403 | 711,414 | 1/1 | 95% |

Round 1 printed `100/100` for BullMQ, which was the API page cap, not a release rate. Paginated:
**117 in 90 days, 241 in 365**, consistent with continuous automated releases. `graphile-worker`
at 0.18.0 with 1 release in 365 days is the opposite profile.

### Durable workflows / sagas

| Package | Version | Licence | Repo | Stars | Weekly DL | rel90/365 |
|---|---|---|---|---|---|---|
| `@temporalio/client` + `/worker` | 1.24.0 | MIT | `temporalio/sdk-typescript` | 933 | 5,015,703 / 4,442,847 | 14/29 |
| `inngest` (SDK) | 4.21.0 | Apache-2.0 (npm) / **GPL-3.0 detected on GitHub** | `inngest/inngest-js` | 1,011 | 2,904,676 | 14/77 |
| `@restatedev/restate-sdk` | 1.17.2 | MIT | `restatedev/sdk-typescript` | 123 | 291,092 | 13/30 |
| **`@dbos-inc/dbos-sdk`** | 5.2.11 | MIT | `dbos-inc/dbos-transact-ts` | 1,382 | **487,945** | 7/30 |
| `@effect/workflow` | 0.19.1 | MIT | `Effect-TS/effect` | 16,327 | 578,084 | 96/468 (monorepo tags) |
| `@trigger.dev/sdk` | 4.7.0 | MIT | `triggerdotdev/trigger.dev` | 16,452 | 1,198,732 | 53/176 |
| **`@hatchet-dev/typescript-sdk`** | 1.33.2 | MIT | `hatchet-dev/hatchet` | 8,042 | **686,624** | 36/303 |

**All three of round 1's workflow rows were wrong packages, rebuilt from npm metadata:**

| Round 1 wrote | What that npm name actually is | The real candidate |
|---|---|---|
| `dbos@1.0.0`, 18 weekly DL, "a rename artifact" | published **2016-04-12**, description **"Who cares"**, ISC, **no repository field** | `@dbos-inc/dbos-sdk@5.2.11`, MIT, 487,945 weekly, "Lightweight durable workflows built on Postgres" |
| `hatchet@0.3.2`, Apache-2.0, 185 weekly | "Send user activities into logstash", **2015-03-11**, repo `jbuck/hatchet` | `@hatchet-dev/typescript-sdk@1.33.2`, MIT, 686,624 weekly; the `hatchet-dev/hatchet` repo is **MIT**, not Apache-2.0 |
| `emmett@3.2.0`, MIT, 5,542 weekly, "GitHub licence null" | "A custom event emitter for Node.js and the browser", 2020-02-17, repo `jacomyal/emmett` | `@event-driven-io/emmett@0.42.4`, 17,810 weekly, npm licence field `null` — the "MIT vs null discrepancy" was comparing two different projects |

`inngest@4.21.0`'s 5,905 stars belong to the **server** repo `inngest/inngest` (licence
NOASSERTION), not to the SDK; the SDK's npm `repository` is `inngest/inngest-js` (1,011 stars),
whose GitHub licence detection says **GPL-3.0** while npm says Apache-2.0. Which licence actually
governs the published code needs resolving before relying on it — flagged, not resolved.

### Event sourcing / CQRS

| Package | Version | Licence | Repo (from npm) | Stars | Weekly DL | rel90/365 |
|---|---|---|---|---|---|---|
| `@event-driven-io/emmett` | 0.42.4 | null | `event-driven-io/emmett` | 540 | 17,810 | 1/11 |
| `@kurrent/kurrentdb-client` | 1.3.1 | Apache-2.0 | `kurrent-io/KurrentDB-Client-NodeJS` | 178 | 25,513 | — |
| `@castore/core` | 2.4.2 | MIT | `castore-dev/castore` | 276 | 2,528 | — |

`@eventstore/db-client@6.2.1` (7,417 weekly) was **last published 2024-05-10** and is superseded
by `@kurrent/kurrentdb-client@1.3.1`, which is the current KurrentDB client and the one the brief
names. Round 1's "repo unresolvable" was a guessed repo name; npm's field resolves it.

`eventuate-tracings/*` and "Emmett-node" in round 1's open questions are **not real projects**;
the live Castore scope is `@castore/*`, repo `castore-dev/castore`, 276 stars, last push
2025-10-12.

### Authorization

| Package | Version | Licence | Repo | Stars | Weekly DL | rel90/365 | top5% |
|---|---|---|---|---|---|---|---|
| `@casl/ability` | 7.0.1 | MIT | `stalniy/casl` | 7,090 | 2,027,217 | — | — |
| `@cerbos/grpc` (PDP SDK) | 0.29.1 | Apache-2.0 | `cerbos/cerbos-sdk-javascript` | 83 | 77,230 | — | — |
| `@openfga/sdk` | 0.9.7 | Apache-2.0 | `openfga/js-sdk` (SDK); `openfga/openfga` (server) | 5,899 | 564,429 | 5/30 | 61% |
| `oso` | 0.27.3 | Apache-2.0 | `osohq/oso` | 3,490 | 10,458 | 0/0 | 75% |

Round 1 listed `@cerbos/hub@0.6.2` (17,618 weekly) as the Cerbos candidate; `@cerbos/hub` is the
Cerbos **Hub** client. The PDP decision-point SDKs are `@cerbos/grpc` and `@cerbos/http`.

**Oso is officially deprecated.** The `osohq/oso` README begins: "# Deprecated — We have
deprecated the legacy Oso open source library… we are not end-of-lifing (EOL) the library and
we'll continue to provide support and critical bug fixes." Its newest GitHub release is dated
2024-06-13. This is a stated deprecation, not an inferred maintenance signal.

**OpenFGA has the best contributor spread measured here**: top 5 = 61% across 100 contributors,
with 30 releases in 365 days. Its model is Zanzibar-style relationship tuples — a different data
shape from the attribute/rule models above.

### Authentication

| Package | Version | Licence | Repo | Stars | Weekly DL | rel90/365 | top5% |
|---|---|---|---|---|---|---|---|
| `better-auth` | 1.7.7 | MIT | `better-auth/better-auth` | 30,146 | 11,457,645 | 18/79 | 80% |
| `next-auth` (Auth.js) | 4.24.15 | ISC | `nextauthjs/next-auth` | 28,371 | 7,228,760 | 30/118 | 83% |
| `@auth/drizzle-adapter` | 1.11.3 | ISC | `nextauthjs/next-auth` | — | 422,949 | — | — |

Both expose the **database as an adapter package** (`@better-auth/drizzle-adapter@1.7.7` and
siblings for Prisma, Kysely, Knex, Mongoose; `@auth/drizzle-adapter` and siblings for Prisma, Knex,
Sequelize, Mongoose), so storage is replaceable by construction. Round 1's "60 releases in 365
days" for Better Auth was a truncated count; paginated it is **18/79**. Round 1 also listed
"Prisma" twice in the Better Auth adapter list.

### API surface

| Package | Version | Licence | Repo | Stars | Weekly DL |
|---|---|---|---|---|---|
| `@trpc/server` | 11.19.0 | MIT | `trpc/trpc` | 40,682 | 6,140,518 |
| `@orpc/server` | 1.15.4 | MIT | `middleapi/orpc` | 5,658 | 1,753,881 |
| `@ts-rest/core` | 3.52.1 | MIT | `ts-rest/ts-rest` | 3,341 | 903,172 |
| `zod-openapi` | 6.0.2 | MIT | — | — | 1,595,411 |
| `@asteasolutions/zod-to-openapi` | 9.1.0 | MIT | — | — | 5,415,043 |
| `openapi3-ts` | 4.6.1 | MIT | — | — | 12,249,254 |
| `@hono/zod-openapi` | 1.6.3 | MIT | `honojs/middleware` | — | 2,843,528 |
| `hono-openapi` | 1.3.3 | MIT | `rhinobase/hono-openapi` (third party) | — | 1,755,042 |
| `@elysia/openapi` | 1.4.16 | MIT | `elysiajs/elysia-openapi` | — | 96,368 |
| `@elysiajs/openapi` (mirror) | 1.4.16 | MIT | same | — | 370,344 |
| `@elysiajs/swagger` (**deprecated**) | 1.3.1 | MIT | `elysiajs/elysia-swagger` | — | 247,152 |
| `graphql-yoga` | 5.24.1 | MIT | — | 8,528 | 2,169,683 |
| `@pothos/core` | 4.15.1 | ISC | `hayes/pothos` | 2,619 | 513,011 |
| `graphql` | 17.0.2 | MIT | — | — | 58,028,969 |

`tRPC` releases 1 in 90 days and **20** in 365 (`trpc/trpc`; `v11.6.0` was published
2025-09-25, just outside the 365-day window). `@ts-rest/core`'s newest **stable**
release is dated 2025-03-04; the newest tag is a `v3.53.0-rc.1` from 2025-06-02 — a year and a
half without a stable. `@pothos/core`'s repo is `hayes/pothos` (Pothos, formerly GiraphQL), not
`pothos-graphql/pothos`. No JSON:API-focused library was in round 1's inventory; the closest
thing measured here is `jsonapi-serializer@3.6.9` (`SeyZ/jsonapi-serializer`, 95,107 weekly), a
serializer rather than a framework integration — recorded as a gap, not a recommendation.

### Code generation and AST

| Package | Version | Licence | Repo | Stars | Weekly DL | rel90/365 | top5% |
|---|---|---|---|---|---|---|---|
| `typescript` | **7.0.2** | Apache-2.0 | `microsoft/TypeScript` | — | 343,822,214 | — | — |
| `@typescript/typescript6` | 6.0.2 | Apache-2.0 | `microsoft/TypeScript` | — | 8,690,842 | — | — |
| `ts-morph` | 28.0.0 | MIT | `dsherret/ts-morph` | 6,197 | 34,149,591 | 0/2 | 96.5% (`dsherret` 2,226/2,341) |
| `oxc-parser` | 0.152.0 | MIT | `oxc-project/oxc` | 22,929 | 67,974,417 | 30/122 | 67.8% |
| `@swc/core` | 1.16.13 | Apache-2.0 | `swc-project/swc` | 34,210 | 50,781,591 | 18/87 | 87.1% |
| `@babel/core` | 8.0.6 | MIT | `babel/babel` | 44,043 | 215,417,274 | 5/19 | 64.4% |
| `magic-string` | 1.4.2 | MIT | `Rich-Harris/magic-string` | 2,778 | 264,549,242 | 13/15 | 79.2% |
| `source-map-js` | 1.2.2 | BSD-3-Clause | `7rulnik/source-map-js` | 102 | 222,601,287 | — | — |
| `@jridgewell/sourcemap-codec` | 1.6.0 | MIT | `jridgewell/sourcemaps` | 54 | 267,975,697 | — | — |
| `@jridgewell/gen-mapping` | 0.3.13 | MIT | `jridgewell/sourcemaps` | 54 | 228,415,483 | — | — |
| `@jridgewell/trace-mapping` | 0.3.31 | MIT | `jridgewell/sourcemaps` | 54 | 301,813,077 | — | — |

The AST half is analysed in §2. The **source-map** half matters separately: the plan's stage 6
wants every emitted file to map back to `.mx` spans, and `magic-string` (sourcemap-preserving string
rewriting), `source-map-js` and the `@jridgewell/*` family are the standard codecs — between
`@jridgewell/trace-mapping` (301.8M weekly) and `@jridgewell/sourcemap-codec` (268.0M weekly) they
are the most-consumed source-map code in the ecosystem. They are pure JavaScript, but their
behaviour inside a `bun build --compile` binary was **not checked**.

### Testing

| Package | Version | Licence | Stars | Weekly DL | rel90/365 |
|---|---|---|---|---|---|
| `bun test` (built-in) | ships with Bun 1.4.2 | MIT (Bun) | — | — | — |
| `bun-types` | 1.4.2 | MIT | — | 20,840,301 | — |
| `vitest` | 5.0.3 | MIT | 17,178 | 130,200,958 | 7/38 |
| `fast-check` | 4.10.2 | MIT | 5,167 | 54,866,647 | — |
| `testcontainers` | 12.2.0 | MIT | 2,619 | 8,534,235 | 2/17 |
| `@electric-sql/pglite` | 0.5.8 | Apache-2.0 | 16,102 | 23,190,567 | 70/225 |

`bun test` is the runtime's own Jest-compatible runner (`bun.com/docs/test/`), not a package.
PGlite is an in-process WASM Postgres: 23M weekly downloads and **70 non-prerelease releases in
90 days / 225 in 365** (round 1's "87 releases in 90 days… the default answer" was a capped count
plus an unsourced opinion; note these are per-package monorepo tags, not PGlite-specific releases).
`@jridgewell/sourcemap-codec@1.6.0` is the current source-map codec (`jridgewell/sourcemaps`).

### Observability

| Package | Version | Licence | Stars | Weekly DL | rel90/365 |
|---|---|---|---|---|---|
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 | — | 101,739,516 | — |
| `@opentelemetry/sdk-node` | 0.222.0 | Apache-2.0 | — | 23,041,126 | — |
| `pino` | 10.3.1 | MIT | 18,234 | 60,378,008 | 0/10 |
| `@logtape/logtape` | 2.3.10 | MIT | 2,004 | 618,222 | 0/0 |

`pino`'s newest release is 2026-02-09 — seven months without one, on a package doing 60M weekly
downloads. `@logtape/logtape` has 97% of contributions from one person and uses Git tags rather
than releases. Both are bus-factor facts, not quality facts.

### Agent tooling

| Package | Version | Licence | Stars | Weekly DL | rel90/365 | top5% |
|---|---|---|---|---|---|---|
| `@modelcontextprotocol/sdk` (v1 line) | 1.31.0 | MIT | 13,498 | 68,841,026 | 26/49 | 64% |
| `@modelcontextprotocol/server` (v2) | 2.2.0 | MIT | 13,498 | 8,706,552 | — | — |
| `@modelcontextprotocol/core` (v2) | 2.2.0 | MIT | 13,498 | 10,823,589 | — | — |
| `@modelcontextprotocol/server-legacy` | 2.2.0 | MIT | 13,498 | 519,205 | — | — |

The npm/GitHub version split is **intentional**, not registry lag: MCP v2 is split into
`@modelcontextprotocol/server`, `/client`, `/core` and `/server-legacy`, all at 2.2.0, while
`@modelcontextprotocol/sdk` stays on the 1.x line. The GitHub repo's newest release is `v2.2.0`;
paginated, the repo has 26 non-prerelease releases in 90 days and **49** in 365 (round 1 printed
26/33 from a truncated list). Contributors: 64% top-5 across 100 people.

### Framework precedents

| Package | Version | Licence | Repo | Stars | Weekly DL | Last release | rel90/365 |
|---|---|---|---|---|---|---|---|
| `@nestjs/core` | 12.1.2 | MIT | `nestjs/nest` | 76,775 | 17,940,374 | 2026-09-28 | 15/38 |
| `@adonisjs/core` | 7.5.2 | MIT | `adonisjs/core` | 19,139 | 201,780 | 2026-09-23 | 5/19 |
| `@redwoodjs/core` | 8.9.0 | MIT | `redwoodjs/graphql` ("RedwoodGraphQL") | 17,595 | 4,941 | **2025-10-21** | 0/1 |
| `create-t3-app` | 7.40.0 | MIT | `t3-oss/create-t3-app` | 29,149 | 698 | repo last push 2025-12-13 | 0 in 90d |
| `nuxt` | 4.5.2 | MIT | — | — | 2,438,918 | — | — |

---

## 2. TypeScript compiler API: what a build tool can depend on today

This is the layer Mesh's compiler sits on, so it is worth stating precisely. All of it comes from
the TypeScript 7.0 announcement (Daniel Rosenwasser, `devblogs.microsoft.com`, **2026-07-08**), the
`typescript@7.0.2` package itself, and `ts-morph@28.0.0`'s dependency chain.

**TypeScript 7.0 is the native (Go) port and ships no programmatic API.** Verbatim from the
announcement: "While TypeScript 7.0 is here, it does not ship with an API. We expect TypeScript
7.1 to ship with a new (and different) API, but until then we have made it a priority to ensure
TypeScript can be run side-by-side with TypeScript 6.0 for utilities that still need some
programmatic access to the compiler (such as typescript-eslint)."

The package confirms it:

| Fact | Where |
|---|---|
| `"main": null`, `"types": null` | `typescript@7.0.2` `package.json` |
| The `.` export resolves to `./lib/version.cjs`, which exports only `version` and `versionMajorMinor = "7.0"` | same |
| Everything else is under `./unstable/*`: `unstable/ast`, `unstable/ast/clone`, `unstable/ast/factory`, `unstable/ast/is`, `unstable/ast/scanner`, `unstable/ast/utils`, `unstable/ast/visitor`, `unstable/async`, `unstable/sync`, `unstable/fs`, `unstable/proto` | same, `exports` map |
| The clients **spawn the platform-native `tsc` binary** with `--api` and talk to it over IPC: `args = ["--api", "--cwd", cwd]` after `resolveExePath(...)` | `dist/api/sync/client.js` |
| 20 platform binary packages (`@typescript/typescript-<os>-<arch>`) as optional dependencies | same |
| `dist/api/sync/api.d.ts` exports `class Project` (`readonly program: Program`, `readonly checker: Checker`, `readonly emitter: Emitter`, plus `compilerOptions`, `rootFiles`, `dispose()`), `class Program` (`getSourceFile`, `getSourceFileNames`), `class Checker` (`getSymbolAtLocation`, `getTypeAtLocation`, `getTypeOfSymbol`, `getDeclaredTypeOfSymbol`, `getResolvedSignature`, `getTypeAtPosition`, `getCompletionsAtPosition`, …), `class Emitter` (`printNode`), `class Symbol`, `class NodeHandle`, and the type-predicate guards (`isUnionType`, `isObjectType`, `isErrorType`, …) | same |

A note on what "unstable" means here, because it is easy to over- or under-read. The round-2
version of this document said the 7.x API ships no type checker; it does ship one, and it is
substantial — this is a complete `Project`/`Program`/`Checker`/`Emitter` surface, reached over an
IPC channel to the native `tsc`. What makes it unsuitable as a stable dependency is not
incompleteness but the announcement's own sentence: "We expect TypeScript 7.1 to ship with a new
(and different) API". Depending on it means depending on an API the TypeScript team has already
said it will replace, while also requiring a native `tsc` executable at runtime.

So on 7.x, `import ts from "typescript"` gives you no `createProgram`, no `createSourceFile`,
no `forEachChild`. The compatibility package is `@typescript/typescript6@6.0.2` (bin `tsc6`),
which "provides an executable named tsc6, so that if needed, you can install TypeScript 7.0 …
side-by-side without naming conflicts"; the announcement suggests
`npm install -D typescript@npm:@typescript/typescript6`.

**What ts-morph does.** `ts-morph@28.0.0` depends on `@ts-morph/common@~0.29.0`, which **bundles
its own compiler**: `dist/typescript.js` in `@ts-morph/common@0.29.0` contains `version = "6.0.2"`
and `versionMajorMinor = "6.0"`. Its release note for 28.0.0 is "feat(BREAKING): TypeScript 6.0".
Consequences: ts-morph keeps working in a project that has `typescript@7` installed, but it is
pinned to the 6.0 JS API and will never see 7.x-only behaviour. Round 1 said ts-morph "inherits
TS's own versioning risk without adding a second one" — that is backwards; it *adds* a pinned
second compiler.

**The options, side by side.**

| Option | Gives you | Typed? | Speed | Stability | Works inside a `bun build --compile` binary? |
|---|---|---|---|---|---|
| `typescript@~6.0` (6.0.3) | full JS compiler API, span-accurate AST + type checker | yes | JS compiler | stable, supported | not checked |
| `@typescript/typescript6` (6.0.2) | same, installable alongside TS 7 | yes | JS compiler | stable, official | not checked |
| `ts-morph@28` | same, with a batteries-included TS wrapper API (`Project`, `SourceFile`, `getNode`/`addExportDeclaration` builders) | yes | JS compiler, bundled | stable, single maintainer | not checked |
| `typescript@7` `unstable/*` | AST **+ type checker + emitter** over a spawned native `tsc --api` | yes — `Project.checker`, `Checker.getTypeAtLocation` / `getSymbolAtLocation` / `getTypeOfSymbol` / `getResolvedSignature`; `Project.program`, `Program.getSourceFile` / `getSourceFileNames`; `Emitter.printNode` | native | **unstable**, and replaced by a "new (and different)" API in 7.1 | would need the external native `tsc` executable — not checked |
| `oxc-parser@0.152.0` | parse-only AST with spans, native (Rust) | **no types** | native | stable-ish | not checked |
| `@swc/core@1.16.13` | parse-only AST with spans, native (Rust) | **no types** | native | stable | not checked |
| `@babel/core@8.0.6` | AST + transforms, no type checker | **no types** | JS | stable | not checked |

Two practical consequences for the plan's stage 6. First, line 202 of the plan ("Re-parse
expression text with the TypeScript compiler API") is ambiguous between the parse-only options
(oxc/swc/Babel) and the typed ones (TS 6.0); which it means is a decision for the plan. Second, if
the Mesh compiler itself is ever shipped as a
`bun build --compile` binary, the TS 6.0 JS API is embeddable but the TS 7 API needs the native
`tsc` executable present at runtime. The "not checked" cells are real gaps — I did not run a
compile test.

---

## 3. Runtime support and single-binary compile

**Bun (the runtime).** `bun-v1.4.2`, published 2026-09-05; 1.4.1 (2026-09-04); 1.4.0 (2026-08-20);
1.3.14 (2026-05-13). 18 non-prerelease releases in 365 days; top-5 contributors hold 82%
(`Jarred-Sumner` 8,613). Local `bun --version` on this machine: 1.4.2.

**`bun build --compile` targets** — all eight supported, from
`https://bun.com/docs/bundler/executables.md`, "Supported targets". The table has exactly four
columns (`--target`, OS, Architecture, Libc); the round-1 "Modern"/"Baseline" columns and the ❌
cells were invented.

| `--target` | OS | Arch | Libc |
|---|---|---|---|
| `bun-linux-x64` | Linux | x64 | glibc |
| `bun-linux-arm64` | Linux | arm64 | glibc |
| `bun-windows-x64` | Windows | x64 | - |
| `bun-windows-arm64` | Windows | arm64 | - |
| `bun-darwin-x64` | macOS | x64 | - |
| `bun-darwin-arm64` | macOS | arm64 | - |
| `bun-linux-x64-musl` | Linux | x64 | musl |
| `bun-linux-arm64-musl` | Linux | arm64 | musl |

`Bun.Build.CompileTarget` lists the same set (plus `bun-linux-x64-baseline-musl`). On x64, "Bun
ships a single binary that targets Nehalem (SSE4.2) and selects AVX2/AVX-512 code paths at
runtime"; the `-baseline`/`-modern` suffixes "are still accepted for backward compatibility and
resolve to the same binary". **There is no missing target.** Cross-compilation from a Mac is
documented for Linux and Windows; Windows-specific flags other than `hideConsole` "can't use … when
cross-compiling".

**Native addons: two distinct facts, both of which round 1 blurred.**

1. Bun documents embedding host-built addons: "You can embed `.node` files into executables", with
   the caveat "If you're using `@mapbox/node-pre-gyp` or similar tools, require the `.node` file
   directly, or it won't bundle correctly."
2. Bun's docs say **nothing** about embedding a `.node` built for a *different* platform when
   cross-compiling. That gap should be stated, not assumed away.
3. `better-sqlite3` does not run on Bun at all. It needs V8 C++ APIs; this is tracked in the
   **open** issue `oven-sh/bun#4290`, "Support V8 C++ APIs for 'nan' addons and other packages to
   work" (opened 2023-08-24, `better-sqlite3` is the first unchecked item on its list; duplicates
   such as #24956). So round 1's implication that better-sqlite3 was a workable compile target is
   wrong — the blocker is runtime, not cross-compilation.

**Assets and runtime detection.** `--asset ./public` embeds a directory tree; detection is the
**property** `Bun.isStandaloneExecutable` (round 1 wrote it as a function):

```ts
if (Bun.isStandaloneExecutable) {
  // Running from `bun build --compile` output
}
```

Compiled executables read `BUN_OPTIONS`. Bun also documents an embedded read-write SQLite database
in the binary, which is in memory and therefore lost on exit.

**Per-candidate status.** This table is where round 1 overstated its own evidence: only Elysia
has a source.

| Candidate | Node | Bun | `bun build --compile` | Source of claim |
|---|---|---|---|---|
| Elysia | via `@elysia/node` adapter | first-class, documented | explicitly recommended by Elysia's deploy doc | `elysiajs.com/integrations/node`, `elysiajs.com/patterns/deploy` |
| Hono | via `@hono/node-server` | documented | not checked | `hono.dev/docs/getting-started/nodejs` |
| h3 / Nitro | yes (Nitro's job) | yes | not checked | `nitrojs/nitro` |
| Fastify | not checked | not checked | not checked | — |
| Drizzle ORM | yes | yes, incl. `bun:sqlite` and `Bun.sql` | not checked | `orm.drizzle.team` llms.txt, `/docs/get-started/bun-sqlite-new` |
| Kysely | yes | needs a dialect; **no `bun:sqlite` dialect in Kysely's docs** | not checked | `kysely.dev/docs/dialects` |
| Prisma | yes | yes since 7.0 (Rust-free client is the default) | not checked | `prisma.io/changelog/2025-11-19` |
| Zod / Valibot / ArkType | yes | yes (pure JS) | not checked | — |
| BullMQ | yes (needs Redis) | not checked | not checked | — |
| pg-boss / Graphile Worker | yes (needs `pg`) | via `postgres`/`Bun.sql` | not checked | — |
| `better-sqlite3` | yes | **no** (`oven-sh/bun#4290` open) | not checked | GitHub issue 4290 |
| Vitest | yes | not checked | N/A | — |
| pino / OTel API | yes | yes | not checked | — |

Elysia's own compile claim, quoted from `elysiajs.com/patterns/deploy`: "Compiling server to binary
usually significantly reduces memory usage by 2-3x compared to development environment." That is
marketing on its own docs page with no methodology. It is at least *consistent* with Bun's own
measurements in §7 (Bun 1.4 peak memory under load: Elysia 55 MB vs Express 92 MB vs Fastify
120 MB).

---

## 4. Coupling profile: what leaks into Mesh if a library is adopted directly

### HTTP layer (Elysia or Hono)

**If Elysia is integral**, these appear in Mesh's generated code and public API: `new Elysia()`,
the `Elysia.t` schema namespace, `app.use(...)` plugin instances, the lifecycle hooks, and
`typeof app` (an `Elysia<…>` instance type) exported for Eden. The lifecycle it hands you is the
documented per-request
order from `elysiajs.com/essential/life-cycle.md` — section order: Request, Parse, Transform,
Derive, Before Handle, Resolve, After Handle, Map Response, On Error, After Response (the page
renders the same sequence as `/assets/lifecycle-chart.svg`). Round 1's chain started at `onStart`
and cited `essential/plugin`; `onStart` is a **server-start** hook, not a request phase, and the
plugin page does not contain this order.

**If Hono is integral**: `new Hono()`, `app.use(...)` middleware, `c.req.valid()`, `c.json(body,
status)`, and the `AppType = typeof route` export for `hc`. One coupling detail that round 1
missed: a generated route that reads request-scoped state uses `c.get('actor')`, which forces Mesh
to parameterise Hono's `Env` generic with a `Variables` type — that type is part of the generated
file's public shape.

**The neutral standard here is real but it is thinner than it looks.** Every one of these reduces
to `(request: Request) => Response | Promise<Response>`. The organisation that owns that surface
is **Ecma TC55**, "Ecma TC55 may be informally referred to as 'WinterTC'", whose stated scope is
"to define, refine, and standardize a 'minimum common API' surface … for improving
interoperability across multiple ECMAScript environments which expand beyond web browsers,
specifically web servers" (`ecma-international.org/committees/tc55`).

The history: WinterCG was a W3C Community Group that incubated the "minimum common API"; its
participants chartered **Ecma TC55 – Web-interoperable server runtimes** ("WinterTC") to host the
work, and the community group was to close. Per the W3C announcement
(`w3.org/community/wintercg/2025/01/10/goodbye-wintercg-welcome-wintertc/`, **2025-01-10**):
"the **WinterCG participants decided to charter an Ecma Technical Committee, TC55 –
Web-interoperable server runtimes**, ('WinterTC')… Once Ecma TC55/WinterTC is set up fully, all
WinterCG work will move there and the existing community group will close." The Ecma TC55 page's
own metadata gives `datePublished: 2024-12-11`, so the committee was created in **December 2024**
and announced publicly on **2025-01-10**.

The GitHub organisation is still `WinterTC55` ("WinterTC Technical Committee on Web-interoperable
Server Runtimes", created 2022-03-31). Note that the name `wintercg` on GitHub is now held by a
**different organisation** with the same name ("WinterCG") and the same description
("Web-interoperable Runtimes Community Group"), created
2026-08-18, zero public repositories — so `github.com/wintercg` does not resolve to WinterTC55.

### Data layer (Drizzle or Kysely)

**If Drizzle is integral**, generated schema files contain `pgTable`, column builders, `relations()`
and `InferSelectModel<typeof posts>`, which are part of the committed output. One leak round 1
missed: Drizzle's schema DSL is **dialect-specific** — `pgTable` comes from `drizzle-orm/pg-core`,
`sqliteTable` from `drizzle-orm/sqlite-core`. A plan that promises "the same contract for Postgres
and SQLite" therefore means emitting **two** schema files with different imports.

**If Kysely is integral**, generated code contains `Kysely<DB>` with a `Database` interface of
`Table` objects, `db.selectFrom()`, `sql` template literals. Round 1 said Kysely "defines no
schema language at all". That is wrong: Kysely **has** a DDL builder — `kysely.dev/docs/migrations`
says "Migrations can use the `Kysely.schema` module to modify the schema" (e.g.
`db.schema.createTable(...)`). What Kysely lacks is a *schema-as-source-of-types* DSL: its docs
route you to `kysely-codegen`, `prisma-kysely` or Kanel to produce types
(`kysely.dev/llms.txt`, "Generating types").

### Validation layer — Standard Schema, and why it is not as neutral as it looks

`@standard-schema/spec@1.1.0` is the contract. From `https://standardschema.dev/`: "The Standard
Schema project is a set of interfaces that standardize the provision and consumption of shared
functionality in the TypeScript ecosystem. Its goal is to allow tools to accept a single input
that includes all the types and capabilities they need — no library-specific adapters, no extra
dependencies." The actual surface, from the package's `dist/index.d.ts`:

```ts
interface StandardTypedV1<Input = unknown, Output = Input> {
    readonly "~standard": StandardTypedV1.Props<Input, Output>;
}
// Props: version: 1, vendor: string, types?: { input; output }

interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}
// Props adds:
//   validate: (value: unknown, options?) => Result<Output> | Promise<Result<Output>>
// Result = { value: Output; issues?: undefined } | { issues: ReadonlyArray<Issue> }
// Issue  = { message: string; path?: ReadonlyArray<PropertyKey | PathSegment> }

interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": StandardJSONSchemaV1.Props<Input, Output>;
}
// Props adds jsonSchema: { input(options), output(options) }  — "May throw if conversion is not supported."
```

The compiler-relevant fact is the third interface: **`StandardSchemaV1` itself is opaque.** It
exposes a validation function and a type-level `~standard`, and nothing else. You cannot
enumerate a schema's fields, defaults, coercions or constraints from it. A code generator that
wants to derive database columns, HTML forms or an OpenAPI document from a Standard Schema needs
either `StandardJSONSchemaV1` or library-specific introspection. Round 1 described the interface as
"deliberately tiny… with `Props` carrying only `version`, `vendor` and `types`" — that is
`StandardTypedV1`, the base type, not the validation interface.

### Tracing / logging

`@opentelemetry/api@1.9.1` exposes only types, a no-op span and a context manager — the neutral
contract; `@opentelemetry/sdk-node@0.222.0` is where implementations plug in. Both Elysia and
Hono have OTel plugins. The API package has not changed version in a long time, which is what a
stable contract looks like.

---

## 5. Swap cost per layer

**HTTP.** Elysia's lifecycle phases versus Hono's ordered middleware versus a bare Fetch handler
are three different shapes: a named-phase pipeline with its own context object and inference, a
linear middleware list with a `Context` wrapper, and a bare `(Request) => Response`. Moving from
Elysia to a Fetch handler means re-expressing policies, response shaping and error mapping;
moving from Hono to Elysia means re-expressing middleware as named phases and re-deriving
context types. Nothing is automatable either way. The typed client is the deeper coupling: both
`typeof app` (an `Elysia<…>` instance type) passed to `treaty<App>` (Eden) and `hc<AppType>`
(Hono) bake the *server's* inferred types into the client's type graph, so swapping HTTP frameworks
is a breaking change for every frontend consumer.

**Data.** The code-level comparison is in §5.1; what follows is the verdict.

**Validation.** Cheap to swap *at runtime* — both frameworks accept Standard Schema — but not
cheap at *compile time*. Because the interface is opaque, a Mesh compiler that wants to emit
types, DB columns or OpenAPI from a user's schema needs a second, non-neutral channel (§4).

**Jobs, workflows, event sourcing, authorization, auth, API surface, codegen, testing, agent
tooling: not compared at the model level in this pass.** Inventory only (versions, licences,
stars, cadence). The Zanzibar tuple model (OpenFGA) and the attribute/rule models (CASL, Cerbos)
are a genuinely different data shape from everything else here.

### 5.1 Code-level comparison: Drizzle, Kysely, TypeORM, Prisma

Same job — "give me the published posts, with their authors" — in each library. Every snippet
below is copied from the library's own documentation, with the URL in the heading. Where a snippet
is shortened, that is stated.

#### Schema definition

**Drizzle** (`orm.drizzle.team/docs/sql-schema-declaration`) — schema *is* a value:

```ts
import { integer, pgTable, varchar } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar().notNull(),
  age: integer().notNull(),
  email: varchar().notNull().unique(),
});
```

**Kysely** — there is no schema DSL; you (or codegen) write a `Database` interface. From
`kysely.dev/docs/examples/select/all-columns-of-a-table`, abridged (the interface on that page has
**seven** tables — audit, person, person_backup, pet, toy, wine, wine_stock_change — of which three
are shown, and the page's `PersonTable` has about 18 fields, cut to 3 here):

```ts
export interface Database {
  audit: AuditTable
  person: PersonTable
  pet: PetTable
}

interface PersonTable {
  id: Generated<number>
  first_name: string
  last_name: string | null
}

export type Person = Selectable<PersonTable>
```

**TypeORM** (`typeorm.io/docs/entity/entities`) — a class with decorators:

```ts
import { Entity, PrimaryGeneratedColumn, Column } from "typeorm"

@Entity()
export class User {
    @PrimaryGeneratedColumn()
    id: number
```

(abridged: the docs' example continues with `@Column()` fields.)

**Prisma** (`prisma.io/docs/orm/prisma-schema/data-model/models`) — a separate schema language:

```prisma
model User {
  id    Int    @id @default(autoincrement())
  email String
  name  String?
}
```

**Version note for all three Prisma snippets below.** The Prisma docs at these URLs describe
**Prisma ORM 8**, which on npm exists only as the release candidate `prisma@8.0.0-rc.19`.
`@prisma/client@latest` is still **7.10.0**, where `schema.prisma`, `prisma.post.findMany` and
`$transaction` remain the stable API. Read the ORM 8 snippets as the RC's shape, not as stable.

Prisma's client contract file is named `contract.prisma` rather than `schema.prisma`
(`prisma.io/docs/orm/prisma-client/queries`).

#### A filtered query with a join

None of the four snippets below contains **both** a filter and a join: Kysely's has a join, the
others have a filter. Read them as the basic read shapes of each API, not as one comparable query.

**Drizzle** (`orm.drizzle.team/docs/select`), verbatim:

```ts
const result = await db.select().from(users);
```

…which the page annotates with the generated SQL: ``select "id", "name", "age" from "users";``
and notes "the result type is inferred automatically based on the table definition, including
columns nullability". Filtering is `eq`/`and`/`or` against column objects; joins take a table and an
`eq(...)` predicate, e.g. `.innerJoin(pets, eq(users.id, pets.ownerId))`
(`orm.drizzle.team/docs/joins`).

**Kysely** (`kysely.dev/docs/examples/join/simple-inner-join`), verbatim (interface block omitted):

```ts
const result = await db
  .selectFrom('person')
  .innerJoin('pet', 'pet.owner_id', 'person.id')
  // `select` needs to come after the call to `innerJoin` so
  // that you can select from the joined table.
  .select(['person.id', 'pet.name as pet_name'])
  .execute()
```

**TypeORM** (`typeorm.io/docs/working-with-entity-manager/entity-manager-api`), verbatim:

```ts
const timbers = await manager.find(User, {
    where: {
        firstName: "Timber",
    },
})
```

**Prisma** — the current Prisma ORM documentation (`prisma.io/docs/orm/prisma-client/queries`)
documents **Prisma ORM 8** (release candidate `prisma@8.0.0-rc.19`), in which `findMany` has been
renamed, and shows the ORM 7 call as the "coming from Prisma ORM 7" side of the mapping:

```ts
// const posts = await prisma.post.findMany({ where: { published: true } });
const posts = await db.orm.public.Post.where({ published: true }).all();
```

The same page states "Every query chains methods on a model, and the last call in the chain says
what you want back and runs the query, usually `.all()` or `.first()`", and that `.where`,
`.select`, `.orderBy`, `.limit` and `.offset` may be written in any order.

#### Transactions

**Drizzle** (`orm.drizzle.team/docs/transactions`), verbatim:

```ts
await db.transaction(async (tx) => {
  await tx.update(accounts).set({ balance: sql`${accounts.balance} - 100.00` }).where(eq(users.name, 'Dan'));
  await tx.update(accounts).set({ balance: sql`${accounts.balance} + 100.00` }).where(eq(users.name, 'Andrew'));
});
```

The same page documents nested `savepoints` via `tx.transaction(...)` and explicit `tx.rollback()`.

**Kysely** (`kysely.dev/docs/examples/transactions/simple-transaction`), verbatim (interface block
omitted):

```ts
const catto = await db.transaction().execute(async (trx) => {
  const jennifer = await trx.insertInto('person')
    .values({ first_name: 'Jennifer', last_name: 'Aniston', age: 40 })
    .returning('id')
    .executeTakeFirstOrThrow()

  return await trx.insertInto('pet')
    .values({ owner_id: jennifer.id, name: 'Catto', species: 'cat', is_favorite: false })
    .returningAll()
    .executeTakeFirst()
})
```

The page explains the semantics: "If an exception is thrown inside the callback passed to the
`execute` method, 1. the exception is caught, 2. the transaction is rolled back, and 3. the
exception is thrown again."

**TypeORM** and **Prisma** both offer a callback transaction; Prisma's docs
(`prisma.io/docs/orm/prisma-client/queries/transactions`) note that "Prisma ORM 8 has no
`$transaction`, so both of the Prisma ORM 7 forms become `db.transaction(async (tx) => ...)`".
That is the RC again — stable `@prisma/client@7.10.0` still uses `prisma.$transaction`.

#### Relation loading

**Drizzle, v1 release-candidate API** (`orm.drizzle.team/docs/rqb`), verbatim — read these two
snippets as **Drizzle v1 RC** (`1.0.0-rc.4`, npm tag `rc`), *not* as `drizzle-orm@0.45.3`, which is
the npm `latest` the tables in §1 list. The `{ relations }` option, `defineRelations` and the
callback-style clauses below exist only on the RC line; on 0.45.3 the form is `relations()` plus
`drizzle(url, { schema })`, with the same `db.query.users.findMany({ with: { posts: true } })`
call:

```ts
const db = drizzle(process.env.DATABASE_URL, { relations });

const result = await db.query.users.findMany({
  with: {
    posts: true,
  },
});
```

In this RC API every callback clause receives the aliased table:

```ts
await db.query.posts.findMany({
  orderBy: (t) => sql`${t.id} asc`, // <- ✅ callback used
  with: {
    comments: {
      orderBy: (t, { desc }) => desc(t.id), // <- ✅ callback used
    },
  },
});
```

The page marks the direct-table form as wrong ("❌ direct table usage") for `orderBy`, `where`.`RAW`,
`extras` and subqueries inside `extras`. In v1 the same definitions imported from
`drizzle-orm/_relations` and were queried through `db._query`
(`orm.drizzle.team/docs/relations-v1-v2`).

**Kysely** has no object-graph layer. Relations are SQL recipes you write; the nested-relations
recipe (`kysely.dev/docs/recipes/relations`) is built on the `sql` template tag:

```ts
function jsonArrayFrom<O>(expr: Expression<O>) {
  return sql<Simplify<O>[]>`(select coalesce(json_agg(agg), '[]') from ${expr} as agg)`
}
```

That same page notes that "The built in `SqliteDialect` and some third-party dialects don't parse
the returned JSON columns to objects automatically" and that parsing "is handled (or not handled)
by the database driver that Kysely has no control over" — which matters for a `bun:sqlite`
target.

**TypeORM** loads relations in several ways — eagerly by decorator option, lazily through its entity
manager, or explicitly via the `relations:` option in `find`; **Prisma** nests them with
`include`-style arguments. All three shapes are different, which is the point below.

#### Raw SQL escape hatch

**Drizzle** (`orm.drizzle.team/docs/sql`) calls it the "Magic `sql` operator": "If you encounter
difficulties in writing an entire query using the library's query builder, you can selectively use
the `sql` template within specific sections of the Drizzle query… in partial SELECT statements,
WHERE clauses, ORDER BY clauses, HAVING clauses, GROUP BY clauses".

**Kysely** (`kysely.dev/docs/recipes/raw-sql`): "You can execute raw SQL strings and pass raw SQL
snippets to pretty much any method or function using the `sql` template tag."

#### What a common data-access contract could cover, and what it would lose

| Capability | Common contract? | Note |
|---|---|---|
| `select` with projection | yes | all four |
| `insert` / `update` / `delete` | yes | all four |
| Filter construction | **partly** | Drizzle takes column objects (`eq(users.name, 'Dan')`), Kysely takes string+operator pairs (`where('state', '=', 'published')`), TypeORM and Prisma take option objects. No single shape. |
| Join | partly | all four join; the argument shape differs enough that a contract would have to normalise it |
| Transaction callback | yes | all four use a callback; TypeORM's takes a `manager` (`dataSource.transaction(async (manager) => …)`) and Kysely's is `db.transaction().execute(async (trx) => …)` |
| Raw-SQL escape hatch | yes | `sql` template in both Drizzle and Kysely |
| Count / aggregate | partly | present in all, expressed differently |
| **Relation loading** | **no** | Drizzle's `with:`, TypeORM's eager/lazy/`relations:` loading, Prisma's `include` and Kysely's hand-written CTE recipes have nothing in common |
| Generated client / schema ownership | partly | Prisma owns its schema file and generates a client; TypeORM's decorated entity classes *are* its schema of record and its CLI diffs them against the database to generate migrations; Drizzle's schema is a value you export; Kysely has no schema artifact |
| Connection pooling / replica selection | no | all four delegate to the driver, differently |
| Migration ownership | no | drizzle-kit diffs and generates; Prisma Migrate owns it; Kysely and TypeORM run hand-written or CLI-generated files |

The data layer is where a replaceable contract is most valuable and most expensive at the same
time: a contract at the SQL level loses almost everything above the first block, and a contract at
the query-object level (`SelectQuery` with `where/and/or/orderBy/limit`) is achievable but is
reimplementing Drizzle's builder.

---

## 6. Elysia versus Hono in depth

The plan says Hono (`api-http | Mount generated routes | Hono (runs on Bun and Node)`); the
operator's example says Elysia.

### Validation: both are Standard Schema

Elysia, `elysiajs.com/essential/validation.md`, verbatim: "**Elysia.t** is a schema builder based
on TypeBox… Elysia also supports Standard Schema, allowing you to use your favorite validation
library: Zod, Valibot, ArkType, Effect Schema, Yup, Joi, and more. To use Standard Schema, simply
import the schema and provide it to the route handler."

So `Elysia.t` is TypeBox (not a separate TypeBox option), and Elysia is **not** locked to `t` —
round 1's own generated-route example passed a non-`t` schema, contradicting its own claim. One
real constraint remains: `elysia@1.4.30`'s peerDependencies pin
`@sinclair/typebox: ">= 0.34.0 < 1"`, i.e. the legacy line, not `typebox@1`.

Hono ships only a thin manual validator — "Hono provides only a very thin Validator. However, it
can be powerful when combined with a third-party Validator"
(`hono.dev/docs/guides/validation`, which documents `import { validator } from 'hono/validator'`) —
and schema validators are separate middleware. `hono.dev/docs/guides/rpc` adds: "The Standard
Schema Validator works as well, so you can use any Standard Schema library such as Valibot." The
package is `@hono/standard-validator@0.4.0` (1,345,984 weekly; peerDeps
`hono >= 4.11.2`, `@standard-schema/spec ^1.0.0`).

### Typed client: Eden versus `hc`

Hono, from `hono.dev/docs/guides/rpc` — **abridged**: the page's handler body contains a
`// ...` line that is omitted here, and the page shows the server block before the client block.

```ts
const route = app.post('/posts',
  zValidator('form', z.object({ title: z.string(), body: z.string() })),
  (c) => {
    // ...
    return c.json({ ok: true, message: 'Created!' }, 201)
  }
)
export type AppType = typeof route
```

The client, verbatim from the same page:

```ts
import type { AppType } from '.'
import { hc } from 'hono/client'
const client = hc<AppType>('http://localhost:8787/')
```

Elysia, from `elysiajs.com/eden/installation`, server side verbatim:

```typescript
// server.ts
import { Elysia, t } from 'elysia'

const app = new Elysia()
    .get('/', () => 'Hi Elysia')
    .get('/id/:id', ({ params: { id } }) => id)
    .post('/mirror', ({ body }) => body, {
        body: t.Object({
            id: t.Number(),
            name: t.String()
        })
    })
    .listen(3000)

export type App = typeof app // [!code ++]
```

and client side, verbatim — note that `@elysia/eden` exports `treaty` only; the `App` type is
imported from the server module:

```typescript
// client.ts
import { treaty } from '@elysia/eden'
import type { App } from './server' // [!code ++]

const client = treaty<App>('localhost:3000') // [!code ++]
```

Both are "export `typeof app`, feed it to a client factory". The differences that matter:

1. **Status codes flow to the client in Hono**: "If you explicitly specify the status code, such
   as 200 or 404, in `c.json()`, it will be added as a type for passing to the client."
2. **Both clients need the server package at build time.** Eden's page says "Eden needs Elysia to
   infer utility types. Make sure to install Elysia with the version matching the server", and the
   install snippet is `bun add @elysia/eden` + `bun add -d elysia`. Hono's `hc` is a **runtime**
   import from `hono/client`, so the client installs `hono`. Round 1's "Hono's is the lighter
   contract" was opinion; the verifiable difference is that Hono's client depends on the current
   `hono` version while Eden's types are locked to the *server's* Elysia version.
3. **Monorepo tsconfig**: Hono's rpc page says "For the RPC types to work properly in a monorepo,
   in both the Client's and Server's tsconfig.json files, set `"strict": true` in compilerOptions."
   Round 1 attributed this to the client's tsconfig only.

### OpenAPI generation

**Elysia**: `@elysiajs/swagger` is deprecated — `elysiajs.com/plugins/swagger.md` opens with
"Swagger plugin is deprecated and is no longer maintained. Please use OpenAPI plugin instead." The
current plugin is published under two names from the same repo `elysiajs/elysia-openapi`:
`@elysia/openapi@1.4.16` (96,368 weekly) and `@elysiajs/openapi@1.4.16` (370,344 weekly). It adds
`fromTypes()`, which generates OpenAPI from TypeScript types, and `mapJsonSchema` for Standard
Schema libraries.

**Hono**: no generator in core. `@hono/zod-openapi` lives in **`honojs/middleware`** — the Hono
organisation, but not `hono/hono` core. `hono-openapi@1.3.3` (`rhinobase/hono-openapi`) is
genuinely third-party and supports Standard Schema. Calling Hono's OpenAPI a "community layer" was
too flat; calling Elysia's "zero-extra-choice" was also too flat, because the plugin choice has
moved twice.

### Plugin and lifecycle model

Elysia has a named-phase lifecycle (§4) plus plugins that are themselves `Elysia` instances with
scoped encapsulation, plus an inference-time JIT compiler. Hono's model is ordered middleware over
Fetch: `app.use`, `app.mount`. Round 1's "Elysia's is more machinery than Mesh needs, and Hono's
is much less to inherit" is analysis; it now lives in §9.

### Node support — symmetric, not asymmetric

Elysia reaches Node through a separate adapter package, currently **`@elysia/node`** (the
integration page's install lines all say `@elysia/node`), applied as
`new Elysia({ adapter: node() })`
(`elysiajs.com/integrations/node`). Round 1 named the package `@elysiajs/node`; the page's install
lines all say `@elysia/node`.

Hono's page is equally explicit: "Hono was not designed for Node.js at first, but with a Node.js
Adapter, it can run on Node.js as well." The adapter is `@hono/node-server` (`@hono/node-server@2.1.3`,
**71,450,891 weekly**), and the documented versions are 18.x ⇒ 18.14.1+, 19.x ⇒ 19.7.0+, 20.x ⇒
20.0.0+. So the asymmetry round 1 built a conclusion on does not exist: **both need an adapter
package on Node.** What differs is only where each project draws the Fetch line.

### Published benchmarks, with dates and authors

**Elysia** (`elysiajs.com/at-glance.md`, §Performance) — requests/second:

| Framework | Runtime | Average | Plain text | Dynamic params | JSON body |
|---|---|---|---|---|---|
| `bun` (bare `Bun.serve`) | bun | 262,660 | 326,376 | 237,083 | 224,522 |
| `elysia` | bun | 255,575 | 313,074 | 241,892 | 211,759 |
| `hono` | bun | 203,938 | 239,230 | 201,663 | 170,920 |
| `fastify` | bun | 65,897 | 92,857 | 81,605 | 23,230 |
| `express` | bun | 29,716 | 39,455 | 34,701 | 14,990 |

Footnote 1, verbatim: "Measured in requests/second. The benchmark for parsing query, path
parameter and set response header on Debian 11, Intel i7-13700K tested on **Bun 0.7.2 on 6 Aug
2023**. See the benchmark condition here" → `github.com/SaltyAom/bun-http-framework-benchmark`,
a repository maintained by Elysia's own author. The homepage adds "21x faster than Express" and
"6x faster than Fastify" (against its own 2,454,631 req/s headline figure for Elysia on Bun).

**Hono** (`hono.dev/docs/concepts/benchmarks`) publishes: routers; Cloudflare Workers ("**Hono is
the fastest**, compared to other routers for Cloudflare Workers… Hono x 402,820 ops/sec ±4.78%");
Deno ("**Hono is the fastest**, compared to other frameworks for Deno… Hono 3.0.0, Requests/sec:
136112, Deno v1.22.0"); and a Bun section that says "Hono is one of the fastest frameworks for
Bun" and then **links to `SaltyAom/bun-http-framework-benchmark`** — Elysia author's repository,
with no numbers of its own.

So: both projects publish benchmarks, both are stale or self-published, and the only shared
number set is the one Elysia's author runs. Round 1's "not found / no throughput claim in its docs
index" was wrong: `hono.dev/llms.txt` lists the Benchmarks page, and Elysia's numbers live on
`at-glance`, not on the (404) `/performance/benchmark` page.

An independent, more recent number exists: **Bun 1.4's own release notes** measure peak memory
under load (§7), including Elysia at 55 MB versus `node:http` at 81 MB and Express at 92 MB.

### Maintenance risk

| | Elysia | Hono |
|---|---|---|
| Non-prerelease releases in 90 days | 1 (`1.4.30`, 2026-08-26) | 22 |
| Non-prerelease releases in 365 days | 21 | 73 |
| Total non-prerelease releases (paginated) | 105 | 405 |
| Contributors returned by the API | 100 | 100 |
| Top-5 share | 90.4% | 83.6% |
| Lead contributor | `SaltyAom` 1,918 / 2,225 = **86%** | `yusukebe` 1,755 / 2,578 = **68%** |
| Runners-up | `MarcelOlsen` 30, `Teyik0` 24 | `usualoma` 245, `EdamAme-x` 71 |

Round 1's summary line "Elysia has 90% of its contributions from one person, Hono 84% from
`yusukebe`" was wrong twice: those are top-5 shares, and the single-person shares are 86% and 68%.
The release-rate ratio is **22× over 90 days** and **3.5× over 365 days** — not "seven times".

### What generated Mesh routes would look like

**Both sketches below are the researcher's illustrations, not quotes.** Every construct they use is
documented, and each is cited: Hono's route chaining and `zValidator` from
`hono.dev/docs/guides/rpc`, Hono's `c.req.valid(...)` and `c.json(...)` from
`hono.dev/docs/guides/validation` and the rpc guide, `hc` from `hono.dev/docs/guides/rpc`;
Elysia's `.post(path, handler, schema)` and Standard Schema acceptance from
`elysiajs.com/essential/validation.md`, and `treaty<App>` from `elysiajs.com/eden/installation`.
The `handleAction` / `CreatePostInput` / `actor` names are Mesh's, not either library's.

On **Hono**, a route for a `post:create` action is a validator middleware plus a handler, one per
action — **chained onto the exported `app`**, because Hono's docs require chaining for the RPC types
to be inferred (`hono.dev/docs/guides/best-practices`: "if you want to use the RPC feature, you can
get the correct type by chaining"; the rpc guide: "chain the handlers so that the types are always
inferred"). Calling `app.post(...)` as a separate statement after the export would leave
`typeof app` without the `/posts` route:

```ts
export const app = new Hono().basePath('/api')
  .post('/posts',
    zValidator('json', CreatePostInput),
    (c) => handleAction(c.req.valid('json'), 'post:create', c.get('actor')))
export type AppType = typeof app
```

The frontend gets `hc<AppType>('https://api.example.com/')`. `c.get('actor')` is what forces the
`Env`/`Variables` type into the generated file (§4).

On **Elysia**, the same action, showing that the schema need not be `t` — it may be any Standard
Schema:

```ts
export const app = new Elysia()
  .post('/posts', ({ body }) => handleAction(body, 'post:create'),
        { body: CreatePostInput })
export type App = typeof app
```

with `CreatePostInput` a Standard Schema of the user's choosing, which Elysia's validation page
documents: "To use Standard Schema, simply import the schema and provide it to the route handler."

The difference that shows up in generated output is inference: Elysia's route type carries the
*validated* body, so the handler signature is tighter, but the generated file's types are then
computed by Elysia's inference rather than by the TypeScript compiler alone. That is the
"generated code is boring" trade-off, and it is analysis — see §9.

---

## 7. Drizzle versus Kysely under a code generator

### Schema as code

Drizzle's schema is a runtime value: `pgTable('posts', { ... })` is a call that drizzle-kit reads.
Kysely's docs route you to `kysely-codegen`, `prisma-kysely` or Kanel for types, but Kysely *does*
have a DDL builder (`Kysely.schema`, used inside migrations). So the honest framing is:
**Drizzle is schema-as-code-and-source-of-truth; Kysely is a query layer with a DDL escape
hatch.**

### Relational queries

**Drizzle has them.** The query API is `db.query.<table>.findMany({ with: … })`
(`orm.drizzle.team/docs/rqb`, snippet in §5.1). **Version note:** the `{ relations }` option and
`defineRelations` shown on that page are the **v1 release-candidate** API; `drizzle-orm@0.45.3`
(the npm `latest`) instead uses `relations()` plus `drizzle(url, { schema })`. Inside a relational
query, "references to a table's columns must go through the callback parameter, not through the
imported table object".

The older v1 API is not gone, just relocated: `orm.drizzle.team/docs/relations-v1-v2` shows the v1 form as
`import { relations } from "drizzle-orm/_relations"` queried through `db._query`, which is how a
framework that emitted v1 code last year keeps it compiling.

**Kysely has no object-graph layer at all.** Its own index states that Kysely "is not an ORM… it
doesn't have the concept of relations" (`kysely.dev/llms.txt`), and relation-shaped queries live
under recipes: CTE-based helpers like `jsonArrayFrom` in `kysely.dev/docs/recipes/relations`
(snippet in §5.1).

### Raw SQL escape hatch

Both matter here, because the plan's `expr` compiler will need a "give up and emit SQL" path.

**Drizzle** (`orm.drizzle.team/docs/sql`) calls it the "Magic `sql` operator" and makes the case
explicitly: "If you encounter difficulties in writing an entire query using the library's query
builder, you can selectively use the `sql` template within specific sections of the Drizzle
query… in partial SELECT statements, WHERE clauses, ORDER BY clauses, HAVING clauses, GROUP BY
clauses".

**Kysely** (`kysely.dev/docs/recipes/raw-sql`): "You can execute raw SQL strings and pass raw SQL
snippets to pretty much any method or function using the `sql` template tag." Its
`jsonArrayFrom` recipe (above) is itself an escaped hatch wrapped in a helper.

Both are parameterised rather than string-concatenated.

### Dialect coverage — including the `bun:sqlite` hole

Drizzle documents every PostgreSQL, MySQL, SQLite and SingleStore database, plus setup guides for
`bun:sqlite`, `node:sqlite`, Bun SQL, D1, OP-SQLite and Turso (`orm.drizzle.team/llms.txt`;
`/docs/get-started/bun-sqlite-new`).

Kysely's dialect page lists **5 core** dialects (PostgreSQL, MySQL, MSSQL, SQLite, PGlite),
**2 organization** dialects (Postgres.js, SingleStore Data API) and **23 community** dialects
(PlanetScale, Cloudflare D1, two Cloudflare Durable Objects, AWS RDS Data API, SurrealDB, Neon,
Xata, AWS S3 Select, libSQL/sqld, Fetch driver, SQLite WASM, two Deno SQLite variants, Node SQLite,
TiDB Cloud, Capacitor SQLite, BigQuery, Clickhouse, PGLite, Oracle, Firebird, MariaDB). Round 1
said "22 community dialects including Postgres.js" — the count is 23 and Postgres.js is an
*organization* dialect.

**There is no Bun or `bun:sqlite` dialect in Kysely's documentation at all** (zero occurrences of
"Bun" on that page). The unlisted npm option is `kysely-bun-sqlite@0.4.0` (26,612 weekly, repo
`dylanblokhuis/kysely-bun-sqlite`), and it carries a caveat that matters: its npm
`peerDependencies` is **`"kysely": "^0.28.2"`**. Under npm's caret semantics for `0.x` — where
`^0.28.2` means `>=0.28.2 <0.29.0` — that **excludes the current `kysely@0.29.6`**. A project on
Kysely 0.29 therefore cannot satisfy this dialect's peer range without forcing Kysely down to the
0.28 line.

So the plan's "Postgres + `bun:sqlite`" story is a first-class documented path for Drizzle, and for
Kysely it is an undocumented, third-party, currently version-incompatible one.

### Migrations

Kysely is deliberately hands-off. From `kysely.dev/docs/migrations`: migrations are files with
`up`/`down`; "Migrations should never depend on the current code of your app because they need to
work even when the app changes. Migrations need to be 'frozen in time'"; ordering is
alpha-numeric by filename with a safety check unless you pass `allowUnorderedMigrations`;
execution is via `Migrator` + `FileMigrationProvider`. For a framework that generates migrations
from an IR diff, that is a feature: a dumb, reliable executor for compiler-emitted SQL. Drizzle-kit
is the smarter tool and is mid-rewrite — its v1 upgrade guide records that the journal was removed,
SQL and snapshots moved into per-migration folders, drizzle-kit "Migrated from database snapshots
to DDL snapshots", and commutativity checks were added.

### Stability

- **Drizzle**: 2 non-prerelease releases in 90 days, 12 in 365. `v1.0.0-rc.4` (2026-06-27) is
  still a prerelease while npm `latest` is `0.45.3`; relations v1 → v2 is a mandatory upgrade.
  A relations-v2 migration is a **codegen-output migration for every user**.
- **Kysely**: 4 in 90 days, 17 in 365, `v0.29.6` stable, with a parallel `v0.30.0-beta` line.

| | Drizzle | Kysely |
|---|---|---|
| Emittable schema declaration | Yes, directly (dialect-specific imports) | N/A (Mesh would emit the interface) |
| Emittable query layer | Yes | Yes |
| Emittable types | `InferSelectModel<typeof t>` | plain interfaces |
| Diffable schema of record | Yes (drizzle-kit) | No (needs external DDL history) |
| Generated output readability | Good | Excellent (plain TS) |

---

## 8. Bun facts

**Version.** `bun-v1.4.2`, 2026-09-05; 1.4.1 (2026-09-04); 1.4.0 (2026-08-20); 1.3.14 (2026-05-13);
1.3.13 (2026-04-20); 1.3.12 (2026-04-10). `bun-types@latest` is 1.4.2. 18 non-prerelease releases
in 365 days; top-5 contributors 82% (`Jarred-Sumner` 8,613). Local `bun --version`: 1.4.2.

**Bun 1.4 is the first release written in Rust.** Verbatim from `https://bun.com/blog/bun-v1.4`
(2026-08-20): "Bun is now written in Rust - and this is the first release". That is a material
maturity and regression-risk fact for a Bun-first design, and round 1 did not mention it.

**Memory figures — these exist**, in the same release notes:

| Measurement (`hello.js`, no server) | Bun 1.4 | Bun 1.3 | Node.js 26 |
|---|---|---|---|
| Linux startup time | 5.1 ms | 10.9 ms | 27.2 ms |
| Linux **peak memory** | **14.6 MB** | 33.0 MB | 44.5 MB |
| Windows startup time | 15.5 ms | 39.0 ms | 40.1 ms |
| Windows peak memory | 16.8 MB | 46.5 MB | 32.5 MB |

| Server, peak memory under load — 1,000,000 requests with 64 connections (100,000 for Next.js and Vite) | Bun 1.4 | Bun 1.3 | Node.js 26 | Δ vs 1.3 |
|---|---|---|---|---|
| fastify | 120 MB | 233 MB | 156 MB | −48% |
| Express | 92 MB | 169 MB | 145 MB | −46% |
| `node:http` | 81 MB | 135 MB | 107 MB | −40% |
| **Elysia** | **55 MB** | 91 MB | n/a | −40% |
| Next.js | 285 MB | 397 MB | 342 MB | −28% |
| `Bun.serve` | 36 MB | 45 MB | n/a | −20% |
| Vite dev server | 233 MB | 268 MB | 214 MB | −13% |

Headline in the same section: "Applications using HTTP servers with Bun should see a 13% - 48%
memory usage reduction." What is measured is **peak memory under load**, not idle RSS, and none of
these figures include SQLite. **Idle RSS of a minimal Bun HTTP + SQLite server: still not found** in
Bun's docs or release notes (see Open questions).

**Compile.** §3 covers the target matrix (eight targets, all supported), assets, the
`Bun.isStandaloneExecutable` **property**, `BUN_OPTIONS`, the embedded in-memory SQLite database,
and the native-addon situation.

**Not implemented:** the single-executable-application API. `node:sea` — "🔴 Not implemented. Use
`bun build --compile` to build single-file executables instead".

**Node compatibility gaps that affect the candidates**, from
`https://bun.com/docs/runtime/nodejs-compat.md`:

| Module | Status | The gap that matters |
|---|---|---|
| `node:async_hooks` | 🟡 | `createHook`, `executionAsyncId`, `triggerAsyncId`, `executionAsyncResource` are **stubs — async ids are always 0**; `AsyncLocalStorage` is not propagated into `MessagePort`, `BroadcastChannel` or `Worker` events |
| `node:cluster` | 🟡 | "`node:http`/`node:https` servers in workers each bind their own socket instead, so **load-balancing HTTP requests across processes is only supported on Linux (through `SO_REUSEPORT`)**. Otherwise, implemented but not battle-tested." |
| `node:diagnostics_channel` | 🟡 | `channel()`, `subscribe()`, `tracingChannel()` and the http client/http2/dgram built-in channels exist; **missing** `boundedChannel()` and the `http.server.*`, `net`, `module`, `console`, `child_process`, `worker_threads` built-in channels |
| `node:worker_threads` | 🟡 | ignores `resourceLimits`/`trackUnmanagedFds`; missing `moveMessagePortToContext` and `locks` |
| `node:test` | 🟡 | missing reporters, snapshot testing, `mock.module()`, code coverage; `test.only()` "accepted but do[es] not filter"; "Use `bun:test` instead" |
| `node:fs` hooks / `node:module` | 🟡 | `registerHooks`, `stripTypeScriptTypes`, `getSourceMapsSupport`/`setSourceMapsSupport` **missing**; `findSourceMap` always returns `undefined` |
| `node:inspector` | 🟡 | `Session` lacks `Network`; `Runtime.evaluate` and the HeapProfiler domain not implemented |
| `node:v8` | 🟡 | `queryObjects`, `startCpuProfile`, `startHeapProfile`, `takeCoverage` missing; `serialize`/`deserialize` use JSC's wire format |
| `node:domain` | 🟡 | does not route errors from timers, `nextTick`, promises |
| `node:crypto` | 🟡 | BoringSSL lacks `ed448`, `rsa-pss`, `dsa`, `dh`, `ml-kem-512`, `secp256k1`, and the CCM/OCB/XTS/chacha20-poly1305 ciphers; `setFips()` is a no-op |

(Round 1 labelled the `boundedChannel()` text as `node:cluster`; it is the
`node:diagnostics_channel` entry. The real `node:cluster` gap — Linux-only load balancing via
`SO_REUSEPORT` — is material because Elysia's deploy doc recommends cluster mode.)

Two of these bite Mesh specifically: **`findSourceMap` always returns `undefined`**, so the runtime
half of "stack traces resolve to `.mx`" needs a mechanism other than the Node API; and
**`AsyncLocalStorage` does not propagate into `Worker`/`MessagePort` events**, so per-request
context cannot follow a worker hop. `node:test` pointing at `bun:test` is aligned with a Bun-first
design.

**`bun:sqlite` locking behaviour: not checked.** Round 1 asserted it was "fragile" with no source.
It is not asserted here because I did not verify it.

---

## 9. Precedents for the integral-versus-replaceable split

### NestJS — replaceable HTTP adapter

`@nestjs/core@12.1.2`, MIT, 76,775 stars, 17.9M weekly, 15 non-prerelease releases in 90 days and
38 in 365. The tell is the adapter packages, and they are **Nest's own**: `@nestjs/platform-fastify@12.1.2`
(2,166,046 weekly) and `@nestjs/platform-express@12.1.2` (12,952,123 weekly) both declare npm
`repository` = `github.com/nestjs/nest.git`, both list `nestjscore` and `kamilmysliwiec` as
maintainers, and both live in `packages/platform-*` in that repo. Round 1's "Fastify maintains a
first-party platform package" was wrong — the **Nest** team maintains the Fastify adapter. Fastify's
own 37,217 stars say nothing about Nest's adapter strategy.

### AdonisJS — integral

`@adonisjs/core@7.5.2`, MIT, 19,139 stars, 201,780 weekly, 5 non-prerelease releases in 90 days and
19 in 365. AdonisJS ships its own HTTP server, DI container, ORM integration and CLI as one stack;
it does not publish `platform-express`-style adapter packages in this version. Bus factor is very
thin: top-5 share 96%, `thetutlage` 2,246 of 2,401 lifetime contributions.

### RedwoodJS — integral, but the cadence drop has a different cause

`@redwoodjs/core@8.9.0`, MIT, 17,595 stars, **4,941 weekly**. Its newest GitHub release is
**2025-10-21** — 0 non-prerelease releases in 90 days, 1 in 365. The repo is now
`redwoodjs/graphql` ("RedwoodGraphQL").

The reason is a **strategic pivot**, not an integral-coupling effect. Peter Pistorius announced it
on the RedwoodSDK blog (`https://rwsdk.com/blog/redwoodjs-to-redwoodsdk`, 2025-04-01): "our focus
is evolving to a new direction: RedwoodSDK… **RedwoodJS will remain fully supported**, with active
maintenance and updates." The team has since shipped `redwoodjs/sdk` (1,712 stars, v1.7.4,
2026-09-23). Round 1 used Redwood's cadence as evidence that "integral choices couple a framework
to a database tool's release cycle"; that inference does not survive the announcement.

### CedarJS — the continuation of RedwoodJS

`cedarjs/cedar` ("The React + GraphQL Web App Framework", MIT, **146 stars**, created
**2025-04-09**, last push **2026-10-01**). It is a **continuation, not a GitHub fork**: the API
reports `fork: false`. Its README is explicit about the audience: "Companies transitioning from
RedwoodJS or looking for an actively maintained full-stack framework".

`@cedarjs/core@7.0.0` (MIT, repo field `cedarjs/cedar`, directory `packages/core`) does
**40,813 weekly downloads** — roughly **8×** `@redwoodjs/core`'s 4,941.

The dates line up: CedarJS appeared in April 2025, the same month the RedwoodSDK pivot was
announced. So the Redwood outcome is not "cadence collapse" alone; it is a three-way split of the
same project — the original repo entering maintenance, the same team shipping RedwoodSDK, and a
community continuation keeping the RedwoodJS shape alive with more weekly installs than the
original. Facts only; what that means for Mesh is in "Implications for Mesh".

### T3 stack — replaceable at the platform, integral at the contract

`create-t3-app@7.40.0` (MIT, `t3-oss/create-t3-app`, 29,149 stars, 698 weekly, repo last pushed
2025-12-13, 0 non-prerelease releases in 90 days). The README defines the stack as "a web
development stack made by Theo focused on **simplicity**, **modularity**, and **full-stack
typesafety**", and lists its parts exactly: **Next.js, tRPC, Tailwind CSS, TypeScript, Prisma,
Drizzle, NextAuth.js** (both ORMs, not one). It also notes that "each piece is optional, and the
'template' is generated based on your specific needs".

So the framework, the API layer, the ORM and the auth layer are each separately replaceable.

### Nuxt / Nitro / h3 — share a minimal handler, swap the platform

`nuxt@4.5.2` (MIT, 2,438,918 weekly). The Nitro layer abstracts over **deployment targets**, not
over the HTTP framework; h3 (`h3js/h3@2.0.1-rc.32`, 5,442 stars, 53.8M weekly — a huge transitive
footprint) is the request handler many share. This is the "share a minimal handler contract, swap
the platform" pattern. Caveats: h3's `latest` is a release candidate, and Nitro's v3 line is
published as `nitro@3.0.260903-beta` from the renamed repo `nitrojs/nitro` while `nitropack` is
the v2 line.

### Better Auth and Auth.js — replaceable by construction, but one of them is in maintenance mode

Both treat the **database as an adapter** (see §1, Authentication). Better Auth
(`better-auth@1.7.7`, MIT, 30,146 stars, 11.5M weekly, 18 non-prerelease releases in 90 days and
**79** in 365; `Bekacru` 3,116, top-5 80%) ships `@better-auth/drizzle-adapter@1.7.7` and siblings
for Prisma, Kysely, Knex, Mongoose. Auth.js ships `@auth/drizzle-adapter@1.11.3` (422,949 weekly)
and siblings.

But **Auth.js is now maintained by the Better Auth team.** From `balazsorban44` in discussion
`nextauthjs/next-auth#13252`, "Auth.js is now part of Better Auth", posted **2025-09-26**: "we want
to acknowledge the obvious: **our pace slowed over the past year**. Maintainers moved roles, time
was tight, and the surface area outgrew what we could responsibly support. This transition ensures
that Auth.js continues to receive security and critical fixes… If you're starting something new
… we recommend Better Auth as the best way forward for most teams." The observable state today:
`next-auth@latest` is still **4.24.15** and v5 is still `5.0.0-beta.32` (2026-07-20), while the
repo has 30 non-prerelease releases in 90 days and 118 in 365 (round 1's 30/98 was truncated).

The reported outcome: two projects with identical adapter-based storage designs, one of them
absorbed into the other.

### Ash's own data-layer contract — pointer, not analysis

Ash's data layer is not owned by this document's researcher. One line for orientation: Ash defines
its own resource-level data contract (changesets, actions, relationships, ecto adapters) and the
`ash_sql` ecosystem is where that contract meets Postgres. The `ash-*` researchers own the mapping;
this document only compares the TypeScript candidates for the same role.

---

## Open questions

1. **`bun build --compile` compatibility is still largely unchecked.** Only Elysia has a source.
   Hono, h3/Nitro, Drizzle, Kysely, Zod/Valibot/ArkType, pino, OTel, `@swc/core` and `oxc-parser`
   all need a real compile test. If the Mesh compiler itself ships as a compiled binary, the TS 6.0
   JS API vs the TS 7 native-`tsc` question in §2 becomes load-bearing.
2. **Idle RSS of a minimal Bun HTTP + SQLite server: still not found.** Bun 1.4's figures are
   peak-memory-under-load; this is the number to measure locally against the 284 MB BEAM reference.
3. **Which AST the compiler uses** — parse-only (oxc/swc/Babel) or typed (TS 6.0) — is undecided in
   the plan and decides the whole codegen dependency set.
4. **The Inngest SDK licence discrepancy**: npm says Apache-2.0, GitHub detects GPL-3.0 for
   `inngest/inngest-js`. Unresolved; needs the LICENSE file in the published tarball.
5. **Missing columns**: maintainers/funding and footprint (beyond Drizzle's own "~7.4kb minified+
   gzipped, exactly 0 dependencies") are still not gathered per candidate. A JSON:API library has
   not been evaluated either; `jsonapi-serializer@3.6.9` is recorded as a data point, not a pick.
6. **Job, workflow, event-sourcing and authorization layers are inventory only** — models not
   compared. Start with OpenFGA's tuple model vs CASL/Cerbos attribute rules.
7. **WinterCG → WinterTC is now settled on dates** (TC55 created December 2024, announced
   2025-01-10; see §4). Nothing outstanding there.

---

## Implications for Mesh (researcher's analysis)

This section is opinion; everything above it is sourced.

1. **The HTTP layer is genuinely a free choice, and the round-1 asymmetry argument was an
   artefact.** Both frameworks are Fetch-native, both accept Standard Schema, both need a Node
   adapter, and both ship a "export the server type" typed client. The two things that actually
   differ are bus factor (86% / 68% single-person, 1 release vs 22 in 90 days) and how much
   inference the generated file carries. If Mesh's principle is "generated code is boring",
   Hono's smaller inference surface is the better fit; if the principle is "derived types are the
   product", Elysia's are richer. That is a design-philosophy call, not a capability call.
2. **The compiler must not bet on TypeScript 7's API — but not because it is empty.** The
   `unstable/*` surface is complete enough to be tempting (`Project`, `Program`, `Checker` with
   `getTypeAtLocation` and `getSymbolAtLocation`, `Emitter`), all of it over an IPC channel to the
   native `tsc`. The disqualifier is that the TypeScript team has already said 7.1 replaces it
   with a "new (and different)" API, and it requires a native executable at runtime. Depending on
   `typescript@~6.0` (or ts-morph, which bundles 6.0.2) is the only supported typed-AST path today,
   and it costs a pinned second compiler in the tree.
3. **Standard Schema is neutral at runtime and opaque at compile time.** That is exactly the wrong
   shape for a code-generating framework: it can validate anything and describe nothing. Any
   compiler-driven path (DB columns, forms, OpenAPI) needs `StandardJSONSchemaV1` or
   library-specific introspection as a second channel — so the validation layer is *not* free to
   replace, contrary to round 1.
4. **The data layer is complementary, and the `bun:sqlite` asymmetry is now decisive rather than
   merely real.** Drizzle owns the schema of record (dialect-specific imports, so two emitted
   files); Kysely owns queries and a DDL escape hatch but has no documented `bun:sqlite` dialect,
   and the one community dialect that exists pins `kysely@^0.28.2`, excluding the current 0.29.6.
   For a Bun-first framework that names SQLite as a target, that is a Kysely-shaped problem to
   solve, not a config flag. Drizzle v1 is also still an RC with a mandatory relations-v2
   migration, which is a codegen-output migration for every user.
5. **Bun's compile story is stronger than round 1 said and its native-addon story is weaker.**
   Eight targets, all supported, cross-compile from a Mac, `Bun.serve` peaking at 36 MB under
   load. But `better-sqlite3` does not run on Bun at all, cross-target `.node` embedding is
   undocumented, and Bun 1.4 is the first Rust release — all three are reasons to prefer Bun's
   own drivers (`bun:sqlite`, `Bun.sql`) over native addons in a Bun-first design.
6. **The precedents do not support the round-1 lesson, and the corrected record is richer.** Redwood
   split three ways in April 2025: the original repo to maintenance, the same team onto
   RedwoodSDK, and CedarJS continuing the RedwoodJS shape with ~8× the original's weekly installs.
   Auth.js's slowdown was maintenance capacity and ended in absorption by a competitor. T3's record
   is the one that reads most like a Mesh: every layer replaceable, the recipe is the product, and
   the recipe has survived by changing its parts (both Prisma *and* Drizzle in the current list).
   The pattern the corrected evidence supports is narrower than round 1 claimed: *adapter surfaces
   cost maintenance effort and sometimes consolidate; they do not by themselves compress a release
   train.* Make the integral-versus-replaceable call on coupling grounds (§4, §5.1), not on cadence
   folklore.
7. **Concentration is the one risk that survived correction.** Almost every candidate has a 60–97%
   top-5 contribution share, and the two HTTP candidates are 86% and 68% single-person. Whatever
   Mesh adopts, the generated code should assume the library can be forked. CedarJS is the counter-
   example worth studying: 146 stars, but 40,813 weekly downloads — a small fork serving more
   installs than the 17,595-star original it continues.
8. **"Generated code is boring" favours a smaller inference surface.** On Hono the generated route
   is a validator middleware plus a handler, and the file's types are the TypeScript compiler's.
   On Elysia the route type carries the validated body and is computed by Elysia's inference. The
   former is more inspectable and more portable across framework versions; the latter is a better
   developer experience on day one. This is the sharpest place where a design principle, not a
   capability, decides the HTTP layer.
9. **Smaller observations, moved here from the fact sections.** Plan line 202 ("Re-parse expression
   text with the TypeScript compiler API") is ambiguous between parse-only and typed options; which
   it means is a decision for the plan, and it decides the whole codegen dependency set. On
   relation loading, Drizzle's relational queries are closer to the shape an Ash-style `has_many`
   graph wants; Kysely makes you write the join or the CTE. The raw-SQL escape hatch is not a
   differentiator — Drizzle and Kysely are both first-class and parameterised. In the T3 recipe, the
   *recipe* is the product, and it has survived by changing its parts. Adapter surfaces do carry a
   real maintenance cost, and consolidation is one way projects have responded to it — Auth.js is
   the example. Where a fact above says a figure "should be measured locally" (idle RSS of a Bun
   HTTP + SQLite server), that recommendation is recorded in Open questions.

---

## Revision log (round 2)

Each row: review finding, what changed, and what I verified it against.

| # | Finding | Change | Verified against |
|---|---|---|---|
| 1 | `dbos` is the wrong package | Row rebuilt as `@dbos-inc/dbos-sdk@5.2.11`, MIT, 487,945/wk, `dbos-inc/dbos-transact-ts` 1,382★, 7/30. "Rename artifact" deleted. | `registry.npmjs.org/dbos/latest` (v1.0.0, 2016, "Who cares", no repo), `…/@dbos-inc/dbos-sdk/latest`, npm downloads API |
| 2 | `hatchet` is the wrong package; licence wrong | Row rebuilt as `@hatchet-dev/typescript-sdk@1.33.2`, MIT, 686,624/wk; `hatchet-dev/hatchet` is MIT, 8,042★, 36/303 | `…/hatchet/latest` (2015 logstash tool), `…/@hatchet-dev/typescript-sdk/latest`, `gh api repos/hatchet-dev/hatchet` |
| 3 | `emmett` is the wrong package; MIT-vs-null "discrepancy" bogus | Row rebuilt as `@event-driven-io/emmett@0.42.4`, 17,810/wk, npm licence `null`. Discrepancy explanation removed. | `…/emmett/latest` (2020 event emitter, `jacomyal/emmett`), `…/@event-driven-io/emmett/latest` |
| 4 | `pgroll` npm is unrelated; Atlassian claim unsupported | Row rebuilt as a Go CLI, Apache-2.0, `xataio/pgroll`, **not on npm**. Atlassian sentence deleted. | `…/pgroll/latest` (`tnht95/pgroll`, ISC), `gh api repos/xataio/pgroll` |
| 5 | 90%/84% are top-5, not single-person | Both figures relabelled everywhere; 86% / 68% added as single-person shares | `gh api repos/{elysiajs/elysia,honojs/hono}/contributors?per_page=100` (2,225 / 2,578 totals) |
| 6 | Summary overstated compile verification | Summary bullet rewritten: only Elysia has a source; §3 says so explicitly | `elysiajs.com/patterns/deploy`; per-row "not checked" labels |
| 7 | Elysia accepts Standard Schema; `t` is TypeBox | Validation subsection rewritten with the verbatim quote; peer pin `@sinclair/typebox >= 0.34.0 < 1` added | `elysiajs.com/essential/validation.md`; `registry.npmjs.org/elysia/latest` peerDependencies |
| 8 | `@elysiajs/swagger` deprecated | Table row and section now use `@elysia/openapi@1.4.16` (96,368/wk) and `@elysiajs/openapi@1.4.16` (370,344/wk), repo `elysiajs/elysia-openapi` | `elysiajs.com/plugins/swagger.md` warning; both npm manifests |
| 9 | Hono also needs an adapter on Node | "Node support — symmetric" subsection; `@hono/node-server@2.1.3`, 71,450,891/wk | `hono.dev/docs/getting-started/nodejs` |
| 10 | "No Elysia benchmark found" | Both published benchmark tables added with dates, hardware, runtimes and the authorship conflict; Bun 1.4 memory figures cited as the independent number | `elysiajs.com/at-glance.md` §Performance + footnote 1; `elysiajs.com` homepage; `hono.dev/docs/concepts/benchmarks`; `hono.dev/llms.txt`; `bun.com/blog/bun-v1.4` |
| 11 | Redwood outcome misattributed | Redwood section rewritten around the 2025-04-01 pivot; Prisma-causation sentence deleted; CedarJS claim dropped | `rwsdk.com/blog/redwoodjs-to-redwoodsdk`; `gh api repos/redwoodjs/{graphql,sdk}` |
| 12 | Nest maintains the Fastify adapter | Corrected, with npm `repository`, maintainers and `packages/platform-*` as evidence | `registry.npmjs.org/@nestjs/platform-fastify/latest`; `gh api repos/nestjs/nest/contents/packages` |
| 13 | Windows ARM64 is supported; invented columns | Target table rebuilt with the docs' real four columns, all eight supported; "only hard matrix hole" deleted | `bun.com/docs/bundler/executables.md` §Supported targets; `Bun.Build.CompileTarget` |
| 14 | better-sqlite3 does not run on Bun | Native-addon facts split into three bullets; round-1's "survives compilation, therefore…" implication removed | `gh api repos/oven-sh/bun/issues/4290` (open, `better-sqlite3` first on the list) |
| 15 | Prisma 7 removed the native engine | Prisma row now says Rust-free client is the default since 7.0.0 (2025-11-19) | `prisma.io/changelog/2025-11-19` |
| 16 | `bun:sqlite` locking "fragile" unsourced | Claim removed; §8 says "not checked" | — |
| 17 | Bun memory figures exist | Tables for `hello.js` and for peak memory under load added with exactly what was measured; idle-RSS gap restated | `bun.com/blog/bun-v1.4` §Memory usage, §Startup |
| 18 | `boundedChannel()` row is `node:diagnostics_channel` | Rows relabelled; real `node:cluster` gap (Linux-only `SO_REUSEPORT`) added | `bun.com/docs/runtime/nodejs-compat.md` lines for both modules |
| 19 | `Bun.isStandaloneExecutable` is a property | Corrected, with the docs' snippet | `bun.com/docs/bundler/executables.md` §Detecting standalone mode |
| 20 | TypeScript 7 open question | New §2 with the full answer | `devblogs.microsoft.com/typescript/announcing-typescript-7-0/`; `typescript@7.0.2` package.json/exports and `dist/api/sync/client.js`; `@ts-morph/common@0.29.0` bundled `version = "6.0.2"` |
| 21 | Kysely has a DDL builder | Reworded: Kysely *has* `Kysely.schema`; what it lacks is schema-as-source-of-types | `kysely.dev/docs/migrations` |
| 22 | TypeBox 1.x missing | Added `typebox@1.3.34` (14,235,555/wk) and labelled `@sinclair/typebox` as the legacy line | npm manifests for both, repo fields |
| 23 | Kysely dialects: 23 community, no `bun:sqlite` | Counts corrected (5 core / 2 organization / 23 community); absence of any Bun dialect stated; `kysely-bun-sqlite@0.4.0` recorded | `kysely.dev/docs/dialects` (zero occurrences of "bun") |
| 24 | Standard Schema surface | Full `dist/index.d.ts` signatures quoted; `StandardTypedV1` vs `StandardSchemaV1` vs `StandardJSONSchemaV1` distinguished; opacity point added | `unpkg.com/@standard-schema/spec@1.1.0/dist/index.d.ts` |
| 25 | Elysia lifecycle order wrong, wrong page | Order taken from `essential/life-cycle.md` section order; `onStart` described as a server-start hook, not a request phase | `elysiajs.com/essential/life-cycle.md`; `essential/plugin.md` contains no `onStart` |
| 26 | `hc` is a runtime import; `strict` is both tsconfigs | Corrected; Eden version-lock requirement added; "lighter contract" opinion moved to §9 | `hono.dev/docs/guides/rpc`; `elysiajs.com/eden/installation` |
| 27 | Hono OpenAPI is "a community layer" | Relabelled "Hono-org middleware, not core"; `rhinobase/hono-openapi` named as third party | npm `repository` for `@hono/zod-openapi` (`honojs/middleware`) and `hono-openapi` |
| 28 | "seven times higher" release rate | Recomputed: 22× over 90 days, 3.5× over 365 | paginated release counts |
| 29 | "every serious candidate" bus-factor claim | Reworded to the measured set; top-5 denominator caveat added to the header | contributors API |
| 30 | Five repos 404'd; names were guessed | All replaced with npm `repository` values: `porsager/postgres` 8,731★, `WiseLibs/better-sqlite3` 7,499★, `stalniy/casl` 7,090★, `hayes/pothos` 2,619★, `castore-dev/castore` 276★ | npm manifests + `gh api repos/...` |
| 31 | `@libsql/client` stars were the database's | Corrected to `tursodatabase/libsql-client-ts` 577★ | npm `repository` |
| 32 | Inngest stars/licence | Split into server (5,905★, NOASSERTION) and SDK (`inngest-js`, 1,011★, GitHub GPL-3.0 vs npm Apache-2.0, flagged unresolved) | npm manifests, `gh api repos/inngest/inngest-js` |
| 33 | `@eventstore/db-client` is stale | Replaced by `@kurrent/kurrentdb-client@1.3.1`, 25,513/wk; old package's last publish 2024-05-10 noted | npm manifests |
| 34 | Oso is deprecated | README quote added; "maintenance mode" inference removed | `gh api repos/osohq/oso/readme` |
| 35 | `@cerbos/hub` is the wrong Cerbos package | Row now `@cerbos/grpc@0.29.1` (77,230/wk); hub noted as the Hub client | npm manifests |
| 36 | MCP split version is intentional | v2 packages added (`/server`, `/core`, `/server-legacy` 2.2.0); releases recounted 26/49 | npm manifests + downloads API |
| 37 | `prisma@latest` is a deliberate repackaging | Reworded from "lies / registry lag" to the CLI-repo repackaging with `prev` = 7.10.0 | npm dist-tags, `prisma/prisma-cli` |
| 38 | Nitro/h3 repo moves | `nitrojs/nitro`, `h3js/h3` noted; `nitro@3.0.260903-beta` named as the v3 line; GitHub licence NOASSERTION | npm manifests |
| 39 | Better Auth releases | 18/79; adapter packages named without the duplicated Prisma entry | paginated releases |
| 40 | Auth.js is maintained by Better Auth | Rewritten with the 2025-09-26 announcement and its quotes; `next-auth@latest` still 4.24.15, v5 still beta; 30/118 | `gh api repos/nextauthjs/next-auth/discussions/13252`; npm dist-tags |
| 41 | PGlite release count and "default answer" | Recounted 70/225; per-package-monorepo-tags caveat added; opinion deleted | paginated releases |
| 42 | Effect releases | 96/468 with the monorepo-tags caveat | paginated releases |
| 43 | BullMQ/ioredis speculation | "expect friction (ioredis)" deleted; cell says not checked | — |
| 44 | WinterCG → WinterTC | Substance confirmed and cited to `ecma-international.org/committees/tc55` and the `WinterTC55` org; the December 2024 date marked `[unverified]` | both sources |
| 45 | No `## Implications for mesh` section | Added; opinions ("lighter contract", "only one a generator can emit verbatim", "cleanest precedent", "generated decorators are noise", "much less to inherit") removed from fact sections or restated as sourced facts | — |
| 46 | Word count over cap | Document rewritten tighter; see the report for the final count | — |

**Disagreements with the review, resolved in favour of the source.** Effect releases: I count
**96/468** (review: 95/468). PGlite: I count **70/225** (review: 69/224). `h3`: review's 40/365
confirmed. Counts were produced with `gh api --paginate "repos/<o>/<r>/releases?per_page=100" --jq
'.[]|select(.prerelease==false and .published_at>="<date>")'` over windows of 90 days
(≥ 2026-07-03) and 365 days (≥ 2025-10-01); ±1 differences are most likely boundary handling.

**Not fixed in round 2.** (a) The WinterTC handover date. (b) The Inngest SDK licence conflict —
flagged, not
resolved. (c) `bun build --compile` behaviour for every candidate except Elysia — no source exists
and running compile tests is out of scope. (d) Footprint/maintainer columns and the model-level
comparison of jobs, workflows, event sourcing and authorization. (e) A JSON:API library
evaluation. (f) The review's suggestion that WinterCG "became WinterTC in Dec 2024" is confirmed in
substance only. Items (a) and (f) were closed in round 3; (b)–(e) remain open.

---

## Revision log (round 3)

Verdict after round 2 was ACCEPT-WITH-FIXES: the round-1 corrections held, and what remained was
one wrong statement plus correct round-1 content that the rewrite had deleted. Each row: finding,
what changed, what I verified it against.

| # | Finding | Change | Verified against |
|---|---|---|---|
| R1 | `typescript@7` `unstable/*` "type checker not shipped" is wrong | Option table row corrected to "AST + checker + emitter, over IPC to native `tsc`"; a fact-table row added listing `Project`/`Program`/`Checker`/`Emitter`/`Symbol` from `api.d.ts`; the "unstable, replaced in 7.1" warning kept and its rationale made explicit | `unpkg.com/typescript@7.0.2/dist/api/sync/api.d.ts` (`Project.checker`, `Checker.getTypeAtLocation`, `getSymbolAtLocation`, `getTypeOfSymbol`, `Emitter.printNode`) |
| R2 | Code-level data-layer comparison deleted | New **§5.1** restores it: schema definition, filtered query with a join, transaction, relation loading, raw SQL — for Drizzle, Kysely, TypeORM and Prisma — each with a cited doc snippet and an "abridged" label where shortened; ends with the cover/lose capability table | `orm.drizzle.team/docs/{sql-schema-declaration,select,transactions,rqb,relations,sql}`; `kysely.dev/docs/{examples/select/all-columns-of-a-table,examples/join/simple-inner-join,examples/transactions/simple-transaction,recipes/relations,recipes/raw-sql}`; `typeorm.io/docs/{entity/entities,working-with-entity-manager/entity-manager-api}`; `prisma.io/docs/orm/prisma-schema/data-model/models`, `/orm/prisma-client/queries`, `/orm/prisma-client/queries/transactions` |
| R3 | Generated-route examples deleted | New §6 subsection "What generated Mesh routes would look like" with a `post:create` route on each framework, labelled as the researcher's illustration with each construct cited; the Elysia sketch now shows Standard Schema rather than `t` | constructs from `hono.dev/docs/guides/rpc`, `elysiajs.com/essential/validation.md`, `elysiajs.com/eden/installation` |
| R4 | Relational-query and raw-SQL subsections deleted | Both restored in §7, plus the v1-v2 relocation fact (`drizzle-orm/_relations`, `db._query`) | `orm.drizzle.team/docs/rqb`, `/docs/relations-v1-v2`; `kysely.dev/llms.txt`; `kysely.dev/docs/recipes/{relations,raw-sql}` |
| R5 | Codegen/AST inventory table removed | Table restored in §1 with `magic-string`, `source-map-js` and `@jridgewell/{sourcemap-codec,gen-mapping,trace-mapping}`, next to `typescript`, `@typescript/typescript6`, `ts-morph`, `oxc-parser`, `@swc/core`, `@babel/core`; oxc's 365-day count corrected to **122** | npm manifests + downloads API for all ten; `gh api repos/{Rich-Harris/magic-string,7rulnik/source-map-js,jridgewell/sourcemaps,dsherret/ts-morph,oxc-project/oxc,swc-project/swc,babel/babel}`; paginated releases and contributors |
| R6 | Eden snippet had a fabricated import; Hono snippet silently shortened | Both import lines copied verbatim (`import { treaty } from '@elysia/eden'` + `import type { App } from './server'`); the Hono block split into server and client halves and labelled **abridged** with the `// ...` omission named | `elysiajs.com/eden/installation` lines 62-63; `hono.dev/docs/guides/rpc` |
| R7 | `kysely-bun-sqlite` peer range excludes current Kysely | Stated: `peerDependencies: {"kysely": "^0.28.2"}`, which under 0.x caret semantics is `>=0.28.2 <0.29.0` and therefore excludes `kysely@0.29.6`; repo field `dylanblokhuis/kysely-bun-sqlite` added | `registry.npmjs.org/kysely-bun-sqlite/latest` |
| R8 | CedarJS exists | New §9 subsection with `cedarjs/cedar` (146★, created 2025-04-09, pushed 2026-10-01, `fork: false`), the README quote, and `@cedarjs/core@7.0.0` at 40,813 weekly (~8× `@redwoodjs/core`) | `gh api repos/cedarjs/cedar`, its README; npm manifest + downloads API for `@cedarjs/core` |
| R9 | Cerbos stars are the server repo's | Row corrected to **83** for `cerbos/cerbos-sdk-javascript`; `cerbos/cerbos` (4,605) is the PDP server, labelled the way the OpenFGA row already was | `gh api repos/{cerbos/cerbos,cerbos/cerbos-sdk-javascript}` |
| R10 | h3 repository mis-stated | Now `h3js/h3` (formerly `unjs/h3`, which redirects), taken from npm `repository`; the invented "h3 v3 work" phrase removed, in both places it appeared | `registry.npmjs.org/h3/latest` |
| R11 | T3 composition uncited and wrong | List corrected to the README's exact seven parts (Next.js, tRPC, Tailwind CSS, TypeScript, Prisma, Drizzle, NextAuth.js); shadcn/ui removed; the "reference for how a stack stays assembled" opinion moved to §9; weekly downloads filled in (698) | `gh api repos/t3-oss/create-t3-app/readme`; npm downloads API |
| R12 | Announcement author misspelled | "Daniel Rosenwaters" → **Daniel Rosenwasser** | byline in the announcement's JSON-LD |
| R13 | WinterTC dates; `wintercg` org claim wrong | §4 rewritten: TC55 created **December 2024** (`datePublished: 2024-12-11` on the Ecma page), announced **2025-01-10** with the W3C quote; the `[unverified]` marker is dropped. Corrected that `github.com/wintercg` is a *different* org created 2026-08-18, and that `WinterTC55` (created 2022-03-31) is the original | `ecma-international.org/committees/tc55` page metadata; `w3.org/community/wintercg/2025/01/10/goodbye-wintercg-welcome-wintertc/`; `gh api orgs/{WinterTC55,wintercg}` |
| R14 | "Hono ships no validator" | Reworded to "only a thin manual validator", with the docs' sentence and `import { validator } from 'hono/validator'` | `hono.dev/docs/guides/validation` |
| R15 | tRPC release count | 21 → **20** in 365 days; `v11.6.0` (2025-09-25) is outside the window | paginated release list, enumerated tag by tag |
| R16 | `Elysia<typeof app>` is not a construct | Rewritten as "`typeof app` (an `Elysia<…>` instance type) passed to `treaty<App>`", in both §4 and §5 | `elysiajs.com/eden/installation` |
| R17 | Opinions left in fact sections | "Already the best-analysed axis" deleted from §5; the T3 opinion moved to §9 as part of item 6 | — |

### Final cleanup (residual errors list)

One line per residual item, in the order the review listed them.

| # | Residual | Change |
|---|---|---|
| C1 | Drizzle relational-query code is the 1.0-RC API, not `drizzle-orm@0.45.3` | §5.1 and §7 snippets now labelled "v1 release-candidate API" (`1.0.0-rc.4`, npm tag `rc`), with the 0.45.3 form (`relations()` + `drizzle(url, { schema })`) stated; the `findMany({ with })` snippet is cited to `/docs/rqb` only |
| C2 | `.innerJoin(table, on.<col>, eq.<col>)` does not exist | Replaced with the documented `.innerJoin(pets, eq(users.id, pets.ownerId))` (`/docs/joins`); the block now states that none of the four snippets contains both a filter and a join |
| C3 | Hono sketch would not type the client; Elysia sketch had unused/undefined names | Route chained onto the exported `app` with Hono's chaining requirement quoted (`/docs/guides/best-practices`); unused `zod` import and undefined `actorFromContext` removed |
| C4 | Prisma snippets are ORM 8, which is an RC | "Version note for all three Prisma snippets" added (`prisma@8.0.0-rc.19`; stable `@prisma/client@7.10.0` still uses `schema.prisma`, `findMany`, `$transaction`) |
| C5 | "Kysely and TypeORM have no schema artifact" is wrong for TypeORM | Row corrected: TypeORM's decorated entities *are* its schema of record and its CLI diffs them to generate migrations; relation loading described as eager/lazy/`relations:`; transaction row no longer implies TypeORM is not callback-based |
| C6 | Kysely `Database` has seven tables, not six | Stated "seven" with the table names, and the `PersonTable` trimming (~18 fields to 3) acknowledged |
| C7 | Announcement misquoted | Now "We expect TypeScript 7.1 to ship with a new (and different) API" |
| C8 | Codegen table gaps | `@typescript/typescript6` weekly downloads filled in as **8,690,842**; the self-contradicting "carry no compile risk (not checked either way)" replaced with "behaviour inside a `bun build --compile` binary was **not checked**" |
| C9 | `wintercg` org called "unrelated" | Changed to "a different organisation with the same name and the same description" |
| C10 | CedarJS cross-reference pointed at §9 | Now points to "Implications for Mesh" |
| C11 | Opinions in fact sections | Six passages (plan line 202, "analyse first", relation-loading preference, "measure locally", "recipe is the product", "consolidation…", and both "neither is a differentiator") removed from the fact sections and consolidated as item 9 of "Implications for Mesh" |

Additional item in this round: **Ash's own data-layer contract** — a one-line orientation plus a
pointer to the `ash-*` researchers, added at the end of §9 as criterion 7 requires.

**Restored content, counted.** §5.1 (six subsections plus the capability table), the §6 generated-
route examples, §7's relational-queries and raw-SQL subsections, and §1's codegen/AST table. None
of it is new text: every snippet is re-fetched from the documentation page cited beside it, and the
ones I shortened are marked "abridged".

**Still open after round 3.** (a) The Inngest SDK licence conflict (npm Apache-2.0 vs GitHub
GPL-3.0). (b) `bun build --compile` behaviour for every candidate except Elysia. (c) Per-candidate
maintainers/funding and footprint columns. (d) Model-level comparison of jobs, workflows, event
sourcing and authorization. (e) A JSON:API library evaluation. (f) Every "works inside a
`bun build --compile` binary" cell in §2 is still **not checked**.

---

## Sources

### Primary APIs (queried 2026-10-01)

- `https://registry.npmjs.org/<pkg>/latest` — versions, licences, `repository`, peerDependencies
- `https://api.npmjs.org/downloads/point/last-week/<pkg>` — weekly downloads
- `https://api.github.com/repos/<owner>/<repo>` and `/contributors?per_page=100` — stars, licences,
  contributor counts
- `gh api --paginate "repos/<owner>/<repo>/releases?per_page=100"` — release counts
- `https://unpkg.com/<pkg>@<version>/…` — `typescript@7.0.2` package.json, exports, `lib/version.cjs`,
  `dist/api/sync/client.js`; `@ts-morph/common@0.29.0` bundled compiler version;
  `@standard-schema/spec@1.1.0/dist/index.d.ts`

### Documentation fetched

- https://elysiajs.com/essential/validation.md — Standard Schema, `Elysia.t` is TypeBox
- https://elysiajs.com/essential/life-cycle.md — per-request phase order
- https://elysiajs.com/essential/plugin.md — plugins; contains no lifecycle order
- https://elysiajs.com/plugins/swagger.md — deprecation notice
- https://elysiajs.com/at-glance.md — benchmark table + footnote 1
- https://elysiajs.com — "21x faster than Express" headline
- https://elysiajs.com/eden/installation.md — Eden, `treaty<App>`, version-lock tip
- https://elysiajs.com/integrations/node.md — `@elysia/node` adapter
- https://elysiajs.com/patterns/deploy — compile recommendation, 2-3x claim, cluster mode
- https://hono.dev/docs/guides/rpc — `hc` from `hono/client`, `strict` in both tsconfigs,
  Standard Schema tip, status-code typing
- https://hono.dev/docs/getting-started/nodejs — Node adapter, version floors
- https://hono.dev/docs/concepts/benchmarks — router/Workers/Deno tables, Bun section
- https://hono.dev/llms.txt — documentation index (lists Benchmarks)
- https://bun.com/docs/bundler/executables.md — target matrix, N-API, assets, `isStandaloneExecutable`
- https://bun.com/docs/runtime/nodejs-compat.md — per-module status
- https://bun.com/docs/runtime/http/server.md, /runtime/sql.md, /runtime/sqlite.md,
  /docs/test/ — `Bun.serve`, `Bun.sql`, `bun:sqlite`, `bun test`
- https://bun.com/blog/bun-v1.4 — Rust rewrite, memory and startup tables
- https://bun.sh/docs/bundler/executables — same content under the previous domain
- https://kysely.dev/docs/dialects — 5 core / 2 organization / 23 community dialects
- https://kysely.dev/docs/migrations — `Kysely.schema`, frozen-in-time, `Migrator`
- https://orm.drizzle.team/docs/upgrade-v1 — v1 restructure, DDL snapshots, commutativity
- https://orm.drizzle.team/docs/relations-v2 — relational query v2
- https://orm.drizzle.team/docs/get-started/bun-sqlite-new — `bun:sqlite` support
- https://orm.drizzle.team/llms.txt — footprint claim, dialect index
- https://standardschema.dev/ — project statement
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ — TS 7.0, no API, 7.1, side-by-side
- https://www.prisma.io/changelog/2025-11-19 — Rust-free client default
- https://ecma-international.org/committees/tc55 — TC55 scope, "informally referred to as WinterTC"
- https://rwsdk.com/blog/redwoodjs-to-redwoodsdk — RedwoodJS → RedwoodSDK pivot
- `https://github.com/nextauthjs/next-auth/discussions/13252` (via `gh api`) — Auth.js joins Better Auth
- `https://api.github.com/repos/oven-sh/bun/issues/4290` — native addon support
- `https://api.github.com/repos/osohq/oso/readme` — deprecation notice

Fetched additionally in round 3:

- https://orm.drizzle.team/docs/sql-schema-declaration, /docs/select, /docs/transactions,
  /docs/rqb, /docs/relations, /docs/sql, /docs/relations-v1-v2 — §5.1 and §7 snippets
- https://kysely.dev/docs/examples/select/all-columns-of-a-table,
  /docs/examples/join/simple-inner-join, /docs/examples/transactions/simple-transaction,
  /docs/recipes/relations, /docs/recipes/raw-sql, /docs/llms.txt — §5.1 and §7
- https://typeorm.io/docs/entity/entities,
  /docs/working-with-entity-manager/entity-manager-api — `@Entity()`, `manager.find`
- https://www.prisma.io/docs/orm/prisma-schema/data-model/models,
  /docs/orm/prisma-client/queries, /docs/orm/prisma-client/queries/transactions — schema model,
  ORM 8 query and transaction forms
- https://hono.dev/docs/guides/validation — thin `hono/validator` statement
- https://unpkg.com/typescript@7.0.2/dist/api/sync/api.d.ts — `Project`/`Program`/`Checker`/`Emitter`
- https://www.w3.org/community/wintercg/2025/01/10/goodbye-wintercg-welcome-wintertc/ — TC55 charter
  announcement, 2025-01-10
- `https://api.github.com/orgs/WinterTC55` and `/orgs/wintercg` — the two different organisations
- `gh api repos/t3-oss/create-t3-app/readme` — the T3 stack's seven parts
- `gh api repos/cedarjs/cedar` and its README — CedarJS facts

### Local artefacts

- `scratch/ts-foundations/` — round-1 captures (`npm_data.json`, `gh_repos.json`, `pages/`, `md/`)
- `scratch/ts-foundations/r2/` — round-2 captures: `pkgs.sh`, `dl.sh`, `relcount.sh`,
  `fetch.sh`, `fetch2.sh` outputs, `pages/`, `ts7-pkg.json`, `tsm-typescript.js`

### Plan document

- `/Users/svallory/work/mesh/notes/Ash-style Resource Framework on MX + TypeScript Implementation
  Plan.md`
