---
title: "Review: Expression language"
description: "Independent fact-check of the expression-language research: 47 claims confirmed, 15 corrected, 7 not verifiable; the conclusion was rewritten."
---

# Review of 09-expression-language.md

> Review of: [Can an existing project carry Mesh's expression language?](../expression-language.md).

Date: 2026-10-05. Reviewer: fact-check agent. Method: curl against npm registry (`https://registry.npmjs.org/<pkg>`, `https://api.npmjs.org/downloads/point/last-week/<pkg>`), GitHub API and raw files, published tarballs (unpacked and grepped), vendor docs. GitHub's unauthenticated API rate-limited some late calls (noted below).

## Verdict

The conclusion in its original form did not hold. The report said no project reads a normal TS lambda and gives both memory evaluation and SQL. Greffon (https://github.com/PhenX/Greffon) does, with build-time capture. It is seven weeks old, 0 stars, 4 downloads/week, so "no established project" still stands. The conclusion in section 6 was rewritten. Numbers (versions, downloads, stars, dates) were almost all correct. The errors are in descriptions of mechanism and in one missed project.

## Claims checked

C = CONFIRMED, X = CORRECTED, U = UNVERIFIABLE/not verified.

| # | Claim | Result | Source |
|---|---|---|---|
| 1 | tinqer 0.0.28, 2026-09-28, MIT, 273 dl/wk, window 09-27..10-03 | C | https://registry.npmjs.org/@tinqerjs/tinqer ; https://api.npmjs.org/downloads/point/last-week/@tinqerjs/tinqer |
| 2 | tinqerjs/tinqer 24 stars, 0 open issues, push 2026-09-28 | C | https://api.github.com/repos/tinqerjs/tinqer |
| 3 | tinqer is "1 month old" | X: repo created 2025-09-20, npm created 2025-10-28, 8 versions | same two URLs |
| 4 | README quote "Tinqer is a type-safe query builder..." | C (the README continues with one more sentence, now noted) | https://raw.githubusercontent.com/tinqerjs/tinqer/main/README.md |
| 5 | `toString()` then `parseJavaScript` in `dist/parser/parse-query.js`; `parseSync("query.ts", ...)` in `oxc-parser.js` | C (lines 55, 66, 16 of published 0.0.28 tarball) | https://registry.npmjs.org/@tinqerjs/tinqer/-/tinqer-0.0.28.tgz |
| 6 | "(never executed)" lifecycle quote, "Query Lifecycle" | C | https://raw.githubusercontent.com/tinqerjs/tinqer/main/llms.txt line 563 |
| 7 | Supported expression set list | C | llms.txt "Expression Support" |
| 8 | Error strings and line numbers visitors/index.js:60, call-expression.js:24, projection.js:463/469 | C | tarball |
| 9 | `Unsupported AST node type: TemplateLiteral` in docs | C | llms.txt line 2055 |
| 10 | Closure variables not supported quote | C | llms.txt line 3926 |
| 11 | "Boolean values use INTEGER (0/1)"; boolean in SQLite interface marked incorrect; `TypeError: SQLite3 can only bind...` | C | llms.txt lines 594, 2026-2045 |
| 12 | `normalizeJoins` / `wrapWindowFilters` exist | C | tarball `dist/parser/normalize-*.js` |
| 13 | Row filters via `__tinqerRowFilters()` (item 20 "not verified whether documented") | C for code; the doc question resolved: documented as "Row Filters"/`withRowFilters` | llms.txt line 258, 1448; tarball `dist/plans/select-plan.js:212` |
| 14 | tinqer has no in-memory evaluator; join/groupJoin/selectMany support | C | llms.txt, tarball (no memory adapter; adapters are pg-promise and better-sqlite3) |
| 15 | npm `repository` field null | C | registry JSON |
| 16 | TanStack DB 0.11.3 / 2026-10-02 / 1,253,879 dl / MIT; 3,926 stars; 134 issues | C | registry; https://api.github.com/repos/TanStack/db |
| 17 | live-queries.md quotes ("Live queries resolve...", "similar to SQL query builders...") | C, but the two sentences appear in the opposite order in the file (line 8 then 10); noted in report | https://raw.githubusercontent.com/TanStack/db/main/docs/guides/live-queries.md |
| 18 | "The functional variant API cannot be optimized..." quote | C (line 2872) | same |
| 19 | `fn.*` variants are "never pushed down" / "local-only" | X: doc says only "cannot be optimized by the query optimizer or use collection indexes"; "never pushed down" is an inference; wording softened | same |
| 20 | `compileSQL` snippet and TODO in `sql-compiler.ts`; `Unknown operator/function`, `Compiler can't handle nested properties` | C | https://raw.githubusercontent.com/TanStack/db/main/packages/electric-db-collection/src/sql-compiler.ts lines 27-40, 113, 366 |
| 21 | TanStack DB has window functions | X: none in published 0.11.3 (functions.d.ts has count/sum/avg/min/max etc.; "window" only means top-K orderBy+limit) | https://registry.npmjs.org/@tanstack/db/-/db-0.11.3.tgz |
| 22 | ZenStack @zenstackhq/server 3.9.7 / 2026-09-30 / 54,675 dl; 2,948 stars; 184 issues | C | registry; https://api.github.com/repos/zenstackhq/zenstack |
| 23 | "ZenStack v3's ORM is built on top of Kysely..." quote | C | https://zenstack.dev/docs/orm/access-control/query |
| 24 | "an intuitive expression language that's very similar to JavaScript" | C | https://zenstack.dev/docs/orm/access-control/write-policies |
| 25 | Raw SQL quote ("same page") | X for attribution only: it is on the query page, not write-policies; wording itself C | query page |
| 26 | Mental-model quote "the simplest mental model to think is that rows..." | X: actual is "the simplest mental model is to think that rows not satisfying the policies "don't exist"" | query page |
| 27 | Post-mutation read can throw `ORMError` REJECTED_BY_POLICY after persisting | C | query page |
| 28 | ZenStack "SQL only"; "compiled to JS that builds a Kysely AST" | X: policy plugin has `ExpressionEvaluator` (in-memory evaluation of auth()/literal-rooted subexpressions) and `ExpressionTransformer` building Kysely nodes at run time from expression AST data | https://raw.githubusercontent.com/zenstackhq/zenstack/main/packages/plugins/policy/src/expression-evaluator.ts and `expression-transformer.ts` (lines ~385-402, 534) |
| 29 | ucast README 3-point quote | C | https://raw.githubusercontent.com/stalniy/ucast/master/README.md lines 15-17 |
| 30 | ucast core Parser/Interpreter quote | C in substance; the report's single-sentence quote merged a bullet list with semicolons; reformatted | https://raw.githubusercontent.com/stalniy/ucast/master/packages/core/README.md |
| 31 | FieldCondition / DocumentCondition / CompoundCondition and the `x > 4` explanation | C | same |
| 32 | CASL "you can use some MongoDB operators" | C | https://raw.githubusercontent.com/stalniy/casl/master/README.md line 125 |
| 33 | `@ucast/sql` description quote | C | https://raw.githubusercontent.com/stalniy/ucast/master/packages/sql/README.md line 6 |
| 34 | @casl/ability 7.0.1 2026-07-06 2,090,797 dl; @ucast/mongo2js 2.0.0 2026-04-24 2,092,399 dl; stars 7,093 / 272 | C | registry; GitHub API |
| 35 | ucast "no relationship traversal" | X: `@ucast/sql` 0.2.0 supports `some`/`none`/`every` relation conditions with `getRelationMetadata` | sql README lines 80-133 |
| 36 | Remult 3.3.18 2026-08-30, 4,790 dl, MIT, 3,210 stars | C | registry; GitHub API |
| 37 | `Filter.createCustom` JSDoc and quote "Custom filters are evaluated on the backend..." | C | https://raw.githubusercontent.com/remult/remult/main/projects/core/src/filter/filter-interfaces.ts lines 112-130 |
| 38 | Spec runs custom filter on Postgres and InMemoryDataProvider (cited lines 9-62, 250) | C in substance (imports line 9, pg provider 237, InMemory 250); the 9-62 range is loose | https://raw.githubusercontent.com/remult/remult/main/projects/tests/dbs/sql-stuff/reusable-custom-filter.spec.ts |
| 39 | Remult `filtering-and-relations` docs page exists | C | https://remult.dev/docs/filtering-and-relations |
| 40 | Convex quotes, example, version 1.46.0 2026-09-16, 1,926,336 dl, 12,652 stars | C | https://docs.convex.dev/database/reading-data/filters.md ; registry; GitHub API |
| 41 | Convex "memory only" | U: not checked against a source | - |
| 42 | InstantDB rules quote and `auth.id != null`; 1.0.67 2026-08-31, 308,545 dl, 10,542 stars | C | https://instantdb.com/docs/permissions.md ; registry; GitHub API |
| 43 | InstantDB client `where` semantics | U | - |
| 44 | Zero quotes, 1.9.0 2026-08-14, 262,455 dl, 3,400 stars | C | https://zero.rocicorp.dev/llms.txt ; registry ; GitHub API |
| 45 | Orange ORM quotes, 5.5.0 2026-09-05, 16,363 dl, ISC, 1,017 stars | C | https://raw.githubusercontent.com/alfateam/orange-orm/master/README.md ; registry |
| 46 | ts-sql-query 1.68.0 2026-06-14, 7,728 dl, 318 stars, builder example | C | registry; README |
| 47 | npm `tsql` is "Tagged template literals for tedious", 0.1.7, 18 dl | C | registry |
| 48 | linq 4.0.3 2024-05-19, 53,536 dl, 1,730 stars | C | registry; https://api.github.com/repos/mihaifm/linq |
| 49 | Drizzle 0.45.3 2026-09-21, 30.9M dl; 35,953 stars | C (live count now 35,954); docs example confirmed | registry; https://orm.drizzle.team/docs/get-started/sqlite-new |
| 50 | Kysely 0.29.6 2026-09-16, 22.5M dl, 14,261 stars; docs example and README line | C | registry; GitHub; querying.tsx line 21 |
| 51 | MikroORM 7.2.3 2026-09-30, 1.2M dl, 9,244 stars; query-builder.md lines 159, 202 | C; snippet had unquoted `b.title` key, fixed to `'b.title'` | registry; query-builder.md |
| 52 | Prisma 7.10.0 2026-08-25, 21.0M dl, 47,694 stars | X partly: `@prisma/client` latest is 7.10.0 (matches) but `prisma` CLI `latest` is 8.0.0-rc.19 (21.86M dl); repo API returns "Moved Permanently", stars not re-read | registry; GitHub API |
| 53 | Prisma `where: { published: true }` doc | C | https://www.prisma.io/docs/orm/prisma-client/queries/filtering-and-sorting |
| 54 | TypeORM 1.1.1 2026-09-01, 6.6M dl, 36,660 stars | C | registry; GitHub |
| 55 | mingo 7.2.4 / sift 17.1.3 / jsonata 2.2.2 / expr-eval 2.0.2 / cel-js 0.8.2 / filtrex 3.1.0 / jsep 1.4.0 / tinybase 10.0.1 versions, dates, downloads; mingo 1,040 and tinybase 5,185 stars | C | registry; GitHub |
| 56 | `@marcbachmann/cel-js` 8.0.0 2026-07-07 | C | registry |
| 57 | sift repo "404" on GitHub API | X: returns 1,703 stars (pushed 2024-06-16) | https://api.github.com/repos/crcn/sift.js |
| 58 | `sqlite-linq`, `@blacktunes/sql` not found; blacktunes-sql repo 404 | C (also `@blacktunes/sqlite`; npm search for "blacktunes" gives unrelated packages) | registry; GitHub API |
| 59 | "No npm package `triplit` ... not found" | X: `triplit` is 404 but `@triplit/client` and `@triplit/db` exist | https://registry.npmjs.org/@triplit/client |
| 60 | PonyORM generator-translation quote | C | https://ponyorm.readthedocs.io/en/latest/queries.html |
| 61 | PonyORM version/licence "not verified" | Now resolved: 0.7.20, Apache-2.0, uploaded 2026-08-09; stars still unverified | https://pypi.org/pypi/pony/json |
| 62 | EF Core overview quotes (life of a query; user-input warning) | C | https://learn.microsoft.com/en-us/ef/core/querying/overview |
| 63 | "EF Core does not evaluate expression trees locally" | X: client evaluation in top-level projection, and an in-memory provider exists | https://learn.microsoft.com/en-us/ef/core/querying/client-eval ; https://learn.microsoft.com/en-us/ef/core/providers/in-memory/ |
| 64 | Ash `defmacro expr` at expr.ex:207-219 returning `Ash.Expr.expr(unquote(body))` | X: that is only the `do:` clause; the main clause calls `do_expr(body)`; lines 206-218 | local checkout `scratch/ash-src/ash/lib/ash/expr/expr.ex` |
| 65 | `to_sat_expression` calls `consolidate_relationships` and `upgrade_related_filters_to_join_keys` (sat.ex:15-20) | C (lines 17-20) | local `ash/lib/ash/expr/sat.ex` |
| 66 | Ash evaluates in memory | C (`ash/lib/ash/filter/runtime.ex` exists; behaviour not read) | local checkout |
| 67 | Exposed README quote; Diesel README quote; cel.dev quote | C | https://raw.githubusercontent.com/JetBrains/Exposed/main/README.md ; https://raw.githubusercontent.com/diesel-rs/diesel/master/README.md ; https://cel.dev/ |
| 68 | Ecto, Quill unverified | U (ecto.sql.org and hexdocs now answer 301; not followed). Quill not retried | - |
| 69 | Section 3.9 "no CEL-to-SQL in npm" | U (not searched independently) | - |

## Independent search for missed candidates

Searches: npm registry text search (about 14 queries on lambda/arrow/predicate/SQL/expression-tree phrasing; mostly noise), GitHub repository search, WebSearch.

* **Greffon** (https://github.com/PhenX/Greffon, https://phenx.github.io/Greffon/): serious, documented in new section 3.1a. Build-time capture of plain lambdas via Vite or tsc transform, closed subset with coded errors, memory provider plus Postgres and SQLite providers, navigation predicates via EXISTS. Maturity: 14 packages all 0.1.1 on 2026-08-20, MIT, repo created 2026-08-14, 0 stars, `@greffon/core` 4 dl/week. The README says "nothing is published to npm yet", contradicted by the registry. I did not run it.
* JayData (`jaystack/jaydata`, 347 stars, unmaintained since 2022): historical, mentioned in one sentence.
* `linkgress-orm` (Postgres ORM, 3,119 dl/wk, 1.0.33): builder calls (`where(u => eq(...))`), not an expression reader. `linq-to-typescript`: in-memory LINQ. `linqbox` (WebSearch hit): not examined.

## Corrections made in the report

1. Conclusion (section 6) and the short answer (section 1) rewritten: no established project, but Greffon exists and matches the design. New subsection 3.1a and a table row.
2. tinqer "1 month old" replaced with about a year old (created 2025-09-20, first publish 2025-10-28). Row-level security noted as documented.
3. TanStack DB: removed "window functions"; "never pushed down" attributed correctly as inference; quote order noted.
4. ZenStack: "SQL only / compiled to JS" replaced (partial in-memory evaluator; run-time Kysely transform); mental-model quote fixed; raw-SQL quote attributed to the right page.
5. ucast: relationship support exists in `@ucast/sql`; interpreter quote reformatted as the bullet list it is.
6. EF Core in-memory claim fixed; Ash macro description fixed; PonyORM version filled in.
7. Table fixes: Prisma versions, Drizzle stars, MikroORM snippet quoting, sift repo 404 claim, Triplit "not found" claim; "tanqer" typo.
8. Section 7 updated (items 8, 11, 20 resolved or corrected; items 21-22 added).

## Still unverified

Convex "memory only"; InstantDB client `where` semantics; Ecto and Quill mechanisms; stars for PonyORM and Prisma (repo moved); CEL-to-SQL absence in npm; Greffon's actual behaviour and commit history (docs and package metadata only; GitHub API rate limit); linqbox; Orange ORM filter API; Triplit mechanism; `ZenStack` claim that policies are stored as expression AST data in the generated schema (the generator emits `ExpressionUtils` calls, the policy attribute path was not traced end to end).
