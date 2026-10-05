---
title: "Can an existing project carry Mesh's expression language?"
description: "Research of 2026-10-05: projects that evaluate TypeScript-like expressions both in memory and as SQL, fact-checked; no established one fits, one young project (Greffon) shares the design."
---

# 09 — Can an existing project carry Mesh's expression language?

> Independent fact-check: [review of this document](./reviews/expression-language-review.md). Decision record: [ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md).

**Audience:** a reader who has seen none of the Mesh research. Terms used once and then assumed:
*arrow expression* — a TypeScript lambda such as `({ self }) => self.status === "sent"`.
*expression tree* — the data structure a compiler builds out of a lambda, so that other programs (an
evaluator, a SQL generator) can walk it. *builder call* — a function call that exists only to record a
query, e.g. `eq(users.id, 5)`. *in-memory evaluation* — running the same rule against a loaded record
without a database. *pushdown* — sending part of the work to the database as SQL.

All numbers in this document were read on **2026-10-04/05**. Weekly download counts come from
`https://api.npmjs.org/downloads/point/last-week/<pkg>` (window 2026-09-27 → 2026-10-03) and version,
release date and licence from `https://registry.npmjs.org/<pkg>`. Stars and open-issue counts come from
`https://api.github.com/repos/<owner>/<repo>` (via `gh api`). Every quote below was fetched; where I
could not fetch something, the text says **not verified**.

**Fact-checked on 2026-10-05.** Every claim was re-checked against its primary source; the corrections are
folded into the text below and listed in `reviews/09-expression-language-review.md`. The review found one
project the first draft missed (Greffon, §3.1a) and corrected the draft's conclusion accordingly (§6).

---

## 1. The question and why it matters

Mesh wants an entity file to declare rules as ordinary TypeScript arrow expressions over a data model:

```ts
filter=({ self }) => self.status === "sent" && self.dueOn < today()
#paidAt=({ input }) => input.paidAt
authorize-if=({ self, actor }) => self.customer.userId === actor.id
```

Each such expression must (1) type-check against the entity's fields, with the editor offering only
what is supported; (2) run **in memory** against a loaded record; (3) be translated to **SQL**
(Postgres and SQLite) for filters, atomic updates and policies folded into queries, including
relationship traversal (`self.customer.userId`) and aggregates; (4) produce a precise **build-time**
error for an unsupported construct.

The operator's question is therefore narrow and practical: **is there an established project that
already lets you write normal TypeScript/JavaScript expressions bound to a data model and get both
in-memory evaluation and SQL?** If one exists, Mesh should depend on it or copy its design. If not,
Mesh has to build it, and the existing designs tell it what the hard parts are.

The short answer, established below with evidence: **no established project does.** The one project that
does exactly this, **Greffon** (§3.1a), is seven weeks old, has 0 GitHub stars and 4 downloads a week, and was
missed by the first draft of this report. Among older projects, the closest neighbours each give one of the
two halves: **tinqer** parses arrow source text and compiles to SQL only; **CASL/ucast** and **Remult**
evaluate the same *data structure* both in memory and as SQL, but the data structure is not a JS
expression; **TanStack DB** runs the same query object locally and pushes only a `WHERE` fragment
downstream. Everything else either takes a builder call or a separate string language.

---

## 2. Comparison table

Columns: (1) how the expression is captured; (2) in memory **and** SQL?; (3) typed against a schema,
restricted to supported ops?; (4) relationship traversal / aggregates; (5) how unsupported constructs
are reported; (6) maturity (stars / weekly downloads / latest release, read 2026-10-04); (7) could Mesh
use it as a library behind its own syntax?

| Candidate | 1. Capture | 2. Memory + SQL | 3. Typed | 4. Rel / agg | 5. Unsupported | 6. Maturity | 7. Usable |
|---|---|---|---|---|---|---|---|
| **tinqer** (`@tinqerjs/tinqer`) | `fn.toString()` → `oxc-parser` at **runtime**, whole lambda | **SQL only** ("never executed") | Yes, `createSchema<Schema>()` + TS generics | Yes: `join`, `groupJoin`, `selectMany`, `groupBy` | **Run time**: `throw new Error("Unsupported AST node type: TemplateLiteral")` | 24★ / 273 dl / 0.0.28 on 2026-09-28; repo created 2025-09-20, first npm publish 2025-10-28 (about a year old, 8 versions) | Closest of the older projects, but SQL-only and 0.0.x |
| **Greffon** (`@greffon/*`) | build-time Vite/tsc transform reifies the lambda into a tree and keeps the original function; runtime `toString()` fallback | **Both**: memory provider calls the lambda, Postgres/SQLite providers emit SQL (author's docs; not run here) | Yes (TS generics; closed-subset diagnostics in editor, ESLint and build) | Navigation predicates via `EXISTS`, `join`/`flatMap`/`include`, `groupBy` (some memory-only) | **Build time**, coded errors (`R1101`...), same message in editor and lint | 0★ / 4 dl / 0.1.1 on 2026-08-20; repo created 2026-08-14 | Matches Mesh's design; far too young to depend on, read it |
| **TanStack DB** | ordinary callback executed immediately to build an IR (`eq()`, `and()` helpers) | **Memory always**, plus a `WHERE` fragment compiled to SQL for Electric | Yes (TS inference over schemas) | Yes (joins, `groupBy`, `count/sum/avg`; no SQL window functions found) | Run time `throw`; `fn.*` variants documented as "cannot be optimized by the query optimizer or use collection indexes" (that they are never pushed to Electric is an inference, not a quote) | 3,926★ / 1.25M dl / 0.11.3 on 2026-10-02 | Design reference; library is client-sync oriented, not an expression compiler |
| **ZenStack v3** | policies written in **ZModel**; the schema carries them as expression-AST data, and the policy plugin's `ExpressionTransformer` turns them into Kysely nodes at run time | **SQL**, plus a small in-memory `ExpressionEvaluator` for the parts that depend only on `auth()` and constants (partial evaluation, not a record check) | Yes (ZModel schema; typed ORM + `$qb`) | Yes (all ORM-level relations, field-level policies) | Build time (ZModel compile); unknown-arg / type errors raised as `ORMError` | 2,948★ / 54,675 dl / 3.9.7 on 2026-09-30 | Different authoring language (DSL, not TS arrows) |
| **CASL + ucast** | a **conditions AST** parsed from a Mongo-style object literal | **Both**: `@ucast/mongo2js` (memory) and `@ucast/sql` (SQL) | Typed by hand at call sites; no schema binding | `@ucast/sql` has `some`/`none`/`every` relation conditions (with relation metadata); `@casl/ability` conditions are field paths | Parser/interpreter level errors | 7,093★ (casl) / 2.09M dl (ability), ucast 272★ / 2.09M dl (mongo2js) | Design reference — the *shape* of the answer, not the language |
| **Remult** | filter functions return an `EntityFilter<T>` **object**, interpreted by the data provider | **Both**: `InMemoryDataProvider` and SQL providers | Yes (`EntityFilter<T>` derived from the entity type) | Yes (`filtering-and-relations`) | TS types + run-time provider errors | 3,210★ / 4,790 dl / 3.3.18 on 2026-08-30 | Design reference (same filter, two providers) |
| **Convex** | `filter(q => q.eq(q.field("name"), "Alex"))` — helper calls, not operators | **Memory only** (no SQL anywhere in Convex) | Yes (typed `FilterBuilder<T>`; table names as strings) | Not in filters (join via `.with()` fetches, not filter conditions) | Compile/type errors; no "unsupported expression" case because there is no expression | 12,652★ / 1.93M dl / 1.46.0 on 2026-09-16 | No SQL; useful only for its undefined-field rule |
| **InstantDB** | server rules are a **string language** ("inspired by … Google's CEL"); client `where` uses JS operators over cached objects | Rules evaluated by Instant's backend; no user-visible SQL | Rules are strings (untyped); client `where` is typed-ish | Rules yes (CEL-ish paths) | Rule parse errors from the CLI/dashboard | 10,542★ / 308,545 dl / 1.0.67 on 2026-08-31 | Not usable as a TS-expression layer |
| **Zero (Rocicorp)** | **ZQL**, a separate string language parsed by `packages/zql` | Both, but against a **SQLite replica**, never SQL | Yes (schema-driven query builder) | Yes | Parser errors on the string | 3,400★ / 262,455 dl / 1.9.0 on 2026-08-14 | Design reference (replica over pushdown) |
| **ts-sql-query** | builder calls (`tCustomer.id.equals(10)`) | SQL only (6 engines) | Yes (Table subclasses) | Yes (joins, dynamic conditions) | TS compile errors | 318★ / 7,728 dl / 1.68.0 on 2026-06-14 | No (nothing to read an AST) |
| **linq.js (`linq`)** | fluent builder over in-memory arrays | **Memory only** | Yes, generic | Yes (aggregates) | TS errors | 1,730★ / 53,536 dl / 4.0.3 on 2024-05-19 | No SQL at all |
| **Drizzle ORM** | builder calls (`where(eq(users.email, x))`) | SQL only | Yes (schema-inferred) | Yes (relational query v1) | TS errors | 35,954★ / 30.9M dl / 0.45.3 on 2026-09-21 | Confirmed: **not** expression-reading |
| **Kysely** | builder calls (`.where('id', '=', id)`) | SQL only | Yes | Yes | TS errors | 14,261★ / 22.5M dl / 0.29.6 on 2026-09-16 | Confirmed: **not** expression-reading |
| **MikroORM** | Mongo-style object filters (`.where({ 'b.title': { $like: '...' } })`) | SQL only | Yes (entity metadata) | Yes (`.where({ books: { tags: { name: 'Cool' } } })`) | TS errors | 9,244★ / 1.2M dl / 7.2.3 on 2026-09-30 | Confirmed: **not** expression-reading |
| **Prisma** | `where: { published: true }` objects | SQL only | Yes (generated input types) | Yes | TS errors | 47,694★ (repo moved; star count not re-read) / 21.9M dl (`prisma` CLI) / `@prisma/client` 7.10.0 on 2026-08-25, `prisma` CLI `latest` tag is 8.0.0-rc.19 | Confirmed: **not** expression-reading |
| **TypeORM** | builder / find-options objects | SQL only | Yes | Yes | TS errors | 36,660★ / 6.6M dl / 1.1.1 on 2026-09-01 | Confirmed: **not** expression-reading |
| **PonyORM** (Python) | **decompiles** a generator/lambda expression | SQL only | Yes (entity classes) | Yes (join descriptors) | Run time (it fails on unsupported constructs) | 0.7.20 on 2026-08-09, Apache-2.0 (PyPI); stars not verified | Design reference; different language |
| **mingo / sift** | Mongo-style query **objects** | Memory only | No | No joins; aggregation in mingo | Unknown operator throws | mingo 1,040★ / 354,268 dl / 7.2.4 (2026-08-07); sift 7.9M dl / 17.1.3 (2024-04-17) | Useful evaluator only |
| **cel-js / jsonata / expr-eval / filtrex / jsep** | separate expression **string** / parser | Memory only | No | No | Parse errors | see §5.7 | Not usable as-is |
| **Orange ORM** | builder / decorators (not verified in detail) | SQL only | Yes | Yes | TS errors | 1,017★ / 16,363 dl / 5.5.0 on 2026-09-05 | No |
| **`sqlite-linq`, `@blacktunes/sql`** | — | — | — | — | — | **not found** (npm 404, rechecked 2026-10-05) | — |
| **Triplit** (`@triplit/client`, `@triplit/db`) | not examined | not examined | — | — | — | exists on npm (the first draft said not found) | not assessed |

---

## 3. The serious candidates

### 3.1 tinqer — the one that reads arrow functions

Of the older projects, the only one found that takes a normal TypeScript arrow, parses its source at run time,
and compiles it to SQL. (Greffon, §3.1a, does the same at build time and adds an in-memory provider.)

> "Tinqer is a type-safe query builder for TypeScript. Queries are expressed as inline arrow functions,
> parsed into an expression tree, and compiled into SQL for PostgreSQL or SQLite."
> — https://raw.githubusercontent.com/tinqerjs/tinqer/main/README.md (the README continues: "The API is
> similar to DotNet's LINQ-based frameworks.")

Capture mechanism, from the shipped code:

```js
// packages/…/dist/parser/parse-query.js
// 1. Convert function to string
const fnString = queryBuilder.toString();
// 3. Parse with OXC to get AST
const program = parseJavaScript(fnString);
```
— https://github.com/tinqerjs/tinqer, `packages/core/dist/parser/parse-query.js` (published tarball
`@tinqerjs/tinqer@0.0.28`, file `package/dist/parser/parse-query.js`), and
`package/dist/parser/oxc-parser.js`: `parseSync("query.ts", code, DEFAULT_PARSER_OPTIONS)`.

Facts:

* **Databases:** PostgreSQL and SQLite only, through separate adapter packages
  (`@tinqerjs/pg-promise-adapter`, `@tinqerjs/better-sqlite3-adapter`) — the README's quick start shows
  the *same* arrow query running on both.
* **In-memory evaluation: no.** The documented lifecycle is explicit:
  "2. **Parse Lambda** - Lambda expressions are parsed into expression tree (never executed)"
  (https://raw.githubusercontent.com/tinqerjs/tinqer/main/llms.txt, "Query Lifecycle"). There is no
  in-memory adapter in the published package.
* **Supported set is small and enumerated**, which is exactly what Mesh wants to check:
  comparison `=== !== > >= < <=`, logical `&& || !`, arithmetic `+ - * / %`, string
  `.includes() .startsWith() .endsWith() .toLowerCase() .toUpperCase()`, null handling `?? ?.`,
  arrays `.includes()` → `IN`, helpers for case-insensitive matching, window functions, opt-in
  full-text search (same `llms.txt`, "Expression Support").
* **Relationships and aggregates:** yes — `join`, `groupJoin` + `selectMany(…defaultIfEmpty())`,
  `groupBy`, `count/sum/min/max/average`, `any/all`, `includes`.
* **Unsupported constructs:** *run time*, as thrown errors, not build time:
  - `package/dist/visitors/index.js:60`: `throw new Error(\`Unsupported AST node type: ${node.type}\`)`
  - `package/dist/visitors/value/call-expression.js:24`: `throw new Error(\`Unsupported call expression: …\`)`
  - `package/dist/visitors/select/projection.js:469`: `throw new Error("Unsupported call expression: Date.now(). External functions are not supported.")`
  - `package/dist/visitors/select/projection.js:463`: `"Unsupported method: ${methodName}(). Date arithmetic is not supported."`
  and the docs say which shapes fail: `Error: Unsupported AST node type: TemplateLiteral`.
* **Parameterization:** literals are auto-extracted into parameters, and **closure variables are not
  supported**: "External variables must be passed via the params object - closure variables are not
  supported" (`llms.txt`). This is a genuine design lesson for Mesh (`#paidAt=({input}) => …` implies
  destructured input, not closures).
* **Row-level security** is built in and documented: `withRowFilters<Ctx>()` / `withContext()` attach per-table
  predicates that SELECT, UPDATE and DELETE (not INSERT) include automatically, failing closed if context is
  unbound (`llms.txt`, "Row Filters"); `schema.__tinqerRowFilters()` injects them into every plan
  (`dist/plans/select-plan.js`). Mesh's policy-folding requirement has a precedent.
* **Maturity:** `@tinqerjs/tinqer` 0.0.28, published 2026-09-28, 273 downloads last week, MIT;
  `tinqerjs/tinqer` 24 stars, 0 open issues, last push 2026-09-28 (npm registry and
  `https://api.github.com/repos/tinqerjs/tinqer`, read 2026-10-04). The repo was created 2025-09-20 and the
  package first published 2025-10-28 (8 versions), so it is about a year old, not a month. Version `0.0.x`
  means no stability promise.

Judgement: **too small and 0.0.x to depend on, but the design Mesh planned is already implemented and shipped;
Mesh should read its visitor structure** (one visitor per node type, normalization passes
`normalizeJoins` / `wrapWindowFilters`, explicit `Unsupported …` errors) and then implement its own,
because tinqer offers no in-memory evaluator, no build-time checking, and a 0.0.x API.

### 3.1a Greffon — the project the first draft missed

Added in the 2026-10-05 fact-check. `PhenX/Greffon` describes itself as "Expression trees for TypeScript —
ordinary lambdas become typed, serializable trees you can evaluate, ship, or compile to SQL"
(https://github.com/PhenX/Greffon, https://raw.githubusercontent.com/PhenX/Greffon/main/README.md). Facts read
from the README, the docs site (https://phenx.github.io/Greffon/guide/the-subset, `/guide/the-boundary-rule`,
`/guide/joins-and-includes`) and the npm registry:

* **Capture:** a Vite/Rollup plugin (`@greffon/vite`) or a `tsc` transformer (`@greffon/ts-transformer`)
  validates the lambda against a closed subset at build time and rewrites it into a literal carrying both the
  original function and the tree. `@greffon/fallback` parses `toString()` at run time as a dev-only path.
  The parser is `oxc-parser`.
* **Two executions:** `@greffon/provider-memory` ("the in-memory provider is the reference semantics",
  calls the compiled function) and `@greffon/provider-postgres` / `provider-sqlite` (parameterized SQL). The
  README says the SQL providers are property-tested against the memory one. I did not run it.
* **Unsupported constructs:** build time, coded and located (`R1101` block bodies, `R1103` loose equality,
  `R1109` regex literals, `R2003` opaque function reference), identical in editor, ESLint and build. No
  silent client-side evaluation; `.inMemory()` marks the boundary explicitly.
* **Relationships and policy:** navigation predicates compile to `EXISTS` (CHANGELOG v0.1.1), plus `join`,
  `leftJoin`, `flatMap`, `include`, `groupBy` (`groupBy` after a join is memory-only). The README lists
  "`rewrite` folding a tenant filter into every query" and policy rules as use cases.
* **Maturity:** 14 `@greffon/*` packages, all 0.1.1, published 2026-08-20, MIT; 4 downloads last week for
  `@greffon/core`; GitHub repo created 2026-08-14, 0 stars, 0 forks (github.com page, read 2026-10-05).
  The README's own status line says "nothing is published to npm yet", which is stale: the registry shows the
  packages published. Everything above is the author's documentation; I did not execute the code.

Judgement: it is the closest match to Mesh's plan found (build-time capture, closed subset, one tree, memory and
SQL interpreters), and for that reason a design reference worth reading before Mesh builds its own. It is not
"established": one maintainer, seven weeks old, no users. Its README lists the same lineage Mesh follows (C#
`Expression<Func<>>`, EF Core providers).

An older, abandoned precedent: JayData (`jaystack/jaydata`, 347 stars, "this library isn't maintained anymore",
last push 2022-12-02) translated JS lambdas to OData/SQL providers; not examined further.

### 3.2 TanStack DB — one query object, two executions

TanStack DB is the only project found whose *same* query is executed by an in-memory incremental engine
**and** turned into SQL.

> "The query system is built around an API similar to SQL query builders like Kysely or Drizzle." …
> "Live queries resolve to collections that automatically update when their underlying data changes."
> (two sentences from the same file, quoted here in reverse order of appearance)
> — https://raw.githubusercontent.com/TanStack/db/main/docs/guides/live-queries.md

How it captures a filter:

```ts
q.from({ user: usersCollection })
 .where(({ user }) => eq(user.active, true))
```
— same file, "Where Clauses". The callback is an ordinary function that **runs immediately** and returns
an IR node; nothing parses source text.

The split between what can be pushed down and what cannot is stated bluntly, and is the single most
useful sentence in this whole survey for Mesh:

> "The functional variant API cannot be optimized by the query optimizer or use collection indexes. It
> is intended for use in rare cases where the standard API is not sufficient."
> — `docs/guides/live-queries.md`, "Functional Variants"

i.e. `fn.where(row => …)` (arbitrary JS that "gets executed") is an optimizer-opaque escape hatch. The doc does
not say "local-only"; that follows from the Electric compiler accepting only the structured expressions
(`eq()/gt()/and()/or()` and the like), which is my inference from `sql-compiler.ts`. And even then the SQL is narrow: the Electric adapter
compiles just a `WHERE` fragment for the sync protocol —

```ts
export function compileSQL<T>(options: LoadSubsetOptions, compileOptions?): SubsetParams {
  const { where, orderBy, limit } = options
  …
  if (where) {
    // TODO: this only works when the where expression's PropRefs directly reference a column of the collection
    compiledSQL.where = compileBasicExpression(where, params, encodeColumnName)
```
— `packages/electric-db-collection/src/sql-compiler.ts`
(https://github.com/TanStack/db), producing `SubsetParams` from `@electric-sql/client`, with errors
like `Unknown operator/function: ${name}` and `Compiler can't handle nested properties: …` thrown at
run time.

* **Databases:** local in-memory/SQLite persistence; Postgres only as the sync source via ElectricSQL.
* **Typed:** yes, by TypeScript inference from collection schemas (`docs/guides/schemas.md`).
* **Relationships/aggregates:** joins, `groupBy`, `count/sum/avg/min/max` — yes. The first draft also listed
  window functions; none exist in the published 0.11.3 package (only result "windows" via `orderBy`+`limit`).
* **Maturity:** `@tanstack/db` 0.11.3 published 2026-10-02, 1,253,879 downloads last week, MIT;
  `TanStack/db` 3,926 stars, 134 open issues, last push 2026-10-03 (read 2026-10-04).

Judgement: not usable as Mesh's expression layer (the expression vocabulary is helper functions, and
arbitrary JS is by design never translated). Copy the *boundary*: one supported vocabulary that both
engines understand, plus an explicit, documented escape hatch that is local-only.

### 3.3 ZenStack v3 — policies folded into a real query pipeline

ZenStack is the strongest existing answer to "fold a policy into the SQL a query actually runs".

> "ZenStack v3's ORM is built on top of Kysely. Regardless of whether you use the ORM API or the
> query-builder one, queries are eventually transformed into Kysely's SQL AST and then compiled down to
> SQL and sent to the database for execution. The access control enforcement is implemented by
> transforming the AST and injecting proper filters."
> — https://zenstack.dev/docs/orm/access-control/query

Points relevant to Mesh:

* Policies are authored in **ZModel**, a DSL whose expression language the docs describe as
  "an intuitive expression language that's very similar to JavaScript"
  (https://zenstack.dev/docs/orm/access-control/write-policies) — not TypeScript.
* Enforcement reaches everywhere except raw SQL: "Raw SQL queries executed via `$executeRaw()` and
  `$queryRaw()` are not subject to access control enforcement. Similarly, raw queries made with
  query-builder API using the `sql` tag are not subject to access control enforcement."
  (https://zenstack.dev/docs/orm/access-control/query, the first page cited, not the write-policies page).
* Mental model worth stealing for Mesh's docs: "the simplest mental model is to think that rows not
  satisfying the policies "don't exist"." (same query page; the first draft garbled the word order).
* Partial in-memory evaluation exists: `packages/plugins/policy/src/expression-evaluator.ts` evaluates ZModel
  expression nodes to JS values, and `expression-transformer.ts` uses it for subexpressions rooted in `auth()`
  (https://github.com/zenstackhq/zenstack). The rest becomes Kysely SQL nodes at run time. So the first
  draft's "SQL only" and "compiled to JS" were wrong in detail.
* Known hazard, documented by them: a mutation can persist and *then* throw on the post-mutation read
  (`ORMError` with reason `REJECTED_BY_POLICY`).
* Maturity: `@zenstackhq/server` 3.9.7 published 2026-09-30, 54,675 downloads last week, MIT;
  `zenstackhq/zenstack` 2,948 stars, 184 open issues, last push 2026-10-02 (read 2026-10-04).

### 3.4 CASL / ucast — the shape of "one conditions value, many interpreters"

ucast is the clearest existing decomposition of the problem Mesh has, minus the TypeScript part.

> "1. You can translate an HTTP request query string into SQL, Mongo, ElasticSearch or anything you can
> imagine. 2. You can execute MongoDB query in javascript runtime 3. You can create an expressive query
> builder for SQL"
> — https://raw.githubusercontent.com/stalniy/ucast/master/README.md

> "Parser is a function that translates conditions from any language into conditions AST. …" "An
> interpreter is a function that interprets conditions AST in a specific way. For example, it can:"
> then a bullet list: "interpret conditions in JavaScript runtime to return a boolean result", "or it can
> convert conditions into SQL `WHERE` statement", "or MongoDB query", …
> — https://raw.githubusercontent.com/stalniy/ucast/master/packages/core/README.md

The node vocabulary is tiny and worth copying: **FieldCondition** ("in condition `x > 4`, `x` is a
field, `4` is a value and `>` is operator"), **DocumentCondition**, **CompoundCondition** (same file).
The condition language is MongoDB query syntax; CASL layers abilities on it — "you can use some
MongoDB operators to define conditions" (https://raw.githubusercontent.com/stalniy/casl/master/README.md).
Published parts: `@ucast/mongo2js` (memory) and `@ucast/sql` ("It provides an interpreter that can
translate ucast conditions into SQL query", https://raw.githubusercontent.com/stalniy/ucast/master/packages/sql/README.md).
Maturity: `@casl/ability` 7.0.1 (2026-07-06), 2,090,797 dl/week; `@ucast/mongo2js` 2.0.0 (2026-04-24),
2,092,399 dl/week; `stalniy/casl` 7,093 stars, `stalniy/ucast` 272 stars (read 2026-10-04).

Limits for Mesh: no schema binding; `@casl/ability` conditions are field paths (dot notation for nested
fields), though `@ucast/sql` 0.2.0 (2026-04-24, 15,810 dl/week) does support `some`/`none`/`every` relation
conditions given relation metadata (https://raw.githubusercontent.com/stalniy/ucast/master/packages/sql/README.md;
the first draft said there was no relationship support); and the "expression" is a JSON document, not TS — so ucast is a **design reference**, not a dependency.

### 3.5 Remult — the same filter value, two data providers

Remult is the only mature project found that deliberately runs the *same* declared filter through an
in-memory provider and SQL providers:

```ts
static activeOrdersFor = Filter.createCustom<Order, { year: number }>(
  async ({ year }) => ({ status: [...], createdAt: { $gte: …, $lt: … } }),
);
```
— https://github.com/remult/remult/blob/main/projects/core/src/filter/filter-interfaces.ts (JSDoc on
`Filter.createCustom`), whose doc comment states: "Custom filters are evaluated on the backend,
ensuring security and efficiency. When the filter is used in the frontend, only its name is sent to the
backend via the API". The test suite runs the same custom filter against Postgres
(`createPostgresDataProvider`) and `InMemoryDataProvider`
(`projects/tests/dbs/sql-stuff/reusable-custom-filter.spec.ts`, lines 9–62, 250).

Like ucast, the unit is a typed object (`EntityFilter<T>`), not a TS expression; relation filtering is
a feature of that object language, not of TS. Maturity: `remult` 3.3.18 (2026-08-30), 4,790 dl/week,
MIT; `remult/remult` 3,210 stars (read 2026-10-04).

### 3.6 Convex — what "no SQL at all" looks like, and one rule Mesh must copy

> "Filters effectively loop over your table looking for documents that match. This can be slow or cause
> your function to hit a limit when your table has thousands of rows."
> … "If your query references a field that is missing from a given document then that field will be
> considered to have the value `undefined`."
> — https://docs.convex.dev/database/reading-data/filters.md

```ts
await ctx.db.query("users").filter((q) => q.eq(q.field("name"), "Alex")).collect();
```
(same page). The vocabulary is helper calls (`q.eq`, `q.gte`, …), mapped in the docs to TypeScript
equivalents (`q.eq(l, r)` ≡ `l === r`). No SQL, no expression reading, no joins inside filters. Two
lessons: the explicit undefined-field rule, and the advice to use indexes instead of filters.

### 3.7 InstantDB, Zero, and other string-language designs

* **InstantDB** rules are strings: "Our rule language takes inspiration from Rails' ActiveRecord,
  Google's CEL, and JSON" with rules such as `"view": "auth.id != null"`
  (https://instantdb.com/docs/permissions.md). Rules are stored as JSON in the dashboard or in an
  `instant.perms.ts` file. A separate string language, so not Mesh's answer; the citation is useful as
  evidence that "CEL-shaped" policy strings keep being reinvented.
* **Zero (Rocicorp)** avoids SQL entirely: "Zero is a query-driven sync engine for TypeScript apps. It
  replicates Postgres into a SQLite replica inside `zero-cache`, then syncs subsets of rows to clients
  based on the queries your app runs… The client runs its own ZQL optimistically against a local store…
  `zero-cache` runs that returned ZQL against its SQLite replica"
  (https://zero.rocicorp.dev/llms.txt). ZQL is parsed by `packages/zql` in the `rocicorp/mono`
  repository (`builder`, `planner`, `ivm` directories). Design lesson for Mesh: an embedded SQL engine
  is a legitimate way to get "in-memory and SQL" semantics with one expression language, at the cost of
  a custom language and a replica.
* **Orange ORM** (5.5.0, 2026-09-05, 16,363 dl/week, ISC, `alfateam/orange-orm` 1,017 stars) describes
  itself as "The ultimate Object Relational Mapper for Node.js, Bun and Deno" and, for browser use,
  "it logs method calls initiated by the client, which are later replayed and authenticated on the
  server" (https://raw.githubusercontent.com/alfateam/orange-orm/master/README.md). That is a
  **recorded call log** — builder calls, not expressions. Details of its filter API: not verified.

### 3.8 Confirmed: the mainstream query builders do not read expressions

The brief asked for confirmation that Drizzle, Kysely and MikroORM's query builder take builder calls.
From docs fetched today:

* **Drizzle:** `await db.delete(usersTable).where(eq(usersTable.email, user.email))`
  — https://orm.drizzle.team/docs/get-started/sqlite-new
* **Kysely:** `await db.deleteFrom('person').where('id', '=', id)`
  — https://github.com/kysely-org/kysely/blob/master/site/docs/getting-started/Querying.tsx; README:
  "Kysely … is a type-safe and autocompletion-friendly TypeScript SQL query builder."
* **MikroORM:** `.where({ books: { tags: { name: 'Cool' } } })`, `.where({ 'b.title': { $like: '%TypeScript%' } })`
  — https://github.com/mikro-orm/mikro-orm/blob/master/docs/docs/query-builder.md (lines 159, 202)
* **Prisma:** `where: { published: true }` — https://www.prisma.io/docs/orm/prisma-client/queries/filtering-and-sorting
* **TypeORM** (`1.1.1`, 2026-09-01, 36,660 stars) — find-options and QueryBuilder objects;
  internals not verified.
* **ts-sql-query** is explicitly a builder: `connection.selectFrom(tCustomer).where(tCustomer.id.equals(customerId))`
  (https://raw.githubusercontent.com/juanluispaz/ts-sql-query/master/README.md). Note the name trap:
  the npm package **`tsql` is a different project** — "Tagged template literals for tedious",
  0.1.7, 18 downloads/week (registry, read 2026-10-04). The QueryDSL-style library is **`ts-sql-query`**.
* **linq.js** (`linq` 4.0.3, 2024-05-19, 1,730 stars, 53,536 dl/week) is in-memory LINQ: fluent chains
  over arrays with no SQL backend. It cannot serve the SQL half of Mesh's requirement.

### 3.9 Not found

* **`sqlite-linq`**: no such package — `https://registry.npmjs.org/sqlite-linq` returns
  `{"error":"Not found"}` (read 2026-10-04).
* **`@blacktunes/sql`**: `https://registry.npmjs.org/@blacktunes/sql` returns `{"error":"Not found"}`
  and `https://api.github.com/repos/schmidsi/blacktunes-sql` returns HTTP 404 (read 2026-10-04).
  Reported in the brief as a Babel-source-parsing SQL generator; that description is **not verified**
  here. If it matters, it needs a different route (it may have been renamed or unpublished).
* **`@tinqerjs/tinqer` has no GitHub description on npm** (the registry `repository` field is null);
  the README above was fetched from `https://raw.githubusercontent.com/tinqerjs/tinqer/main/README.md`.
* **`sift`** repository: `https://api.github.com/repos/crcn/sift.js` now returns 1,703 stars, last push
  2024-06-16 (the first draft's "404" was wrong or transient).
* **Triplit:** the first draft said no `triplit` package was confirmed. The unscoped name `triplit` is indeed
  404 on npm, but `@triplit/client` and `@triplit/db` exist on the registry. Not assessed.
* **Rechecked 2026-10-05:** `sqlite-linq`, `@blacktunes/sql`, `@blacktunes/sqlite` all return
  `{"error":"Not found"}` on npm; an npm search for "blacktunes" returns two unrelated packages; the GitHub
  repo `schmidsi/blacktunes-sql` is 404. Genuinely not found. An npm search also surfaced `linq-to-typescript`
  (in-memory LINQ port) and `linkgress-orm` (Postgres ORM; its docs show builder calls such as
  `where(u => eq(u.username, 'alice'))`, so not an expression reader).

---

## 4. In-memory evaluators (the "memory half" on its own)

These parse or accept a small expression language and evaluate it against a JS value. None of them
emits SQL; they are useful as reference semantics (and as a possible in-memory backend), not as the
expression front end.

| Package | What it is (fetched) | Version / latest | dl/week |
|---|---|---|---|
| `mingo` | "MongoDB query language for in-memory objects" (README) | 7.2.4 / 2026-08-07 | 354,268 |
| `sift` | "Sift is a tiny library for using MongoDB queries in Javascript"; operators `$in $nin $exists $gte … $elemMatch` | 17.1.3 / 2024-04-17 | 7,905,664 |
| `jsonata` | "JSON query and transformation language" (README) | 2.2.2 / 2026-07-16 | 2,250,210 |
| `expr-eval` | "Parses and evaluates mathematical expressions" (README) | 2.0.2 / 2019-09-28 | 538,609 |
| `cel-js` | registry description: "Common Expression Language (CEL) evaluator for JavaScript" | 0.8.2 / 2025-07-11 | 116,732 |
| `filtrex` | — (README not fetched) | 3.1.0 / 2024-10-14 | 622,749 |
| `jsep` | — (README not fetched) | 1.4.0 / 2024-11-05 | 16,309,317 |
| `tinybase` | — (README 404 on the paths tried) | 10.0.1 / 2026-09-24; `tinyplex/tinybase` 5,185 stars | 20,440 |

A newer CEL implementation exists: `@marcbachmann/cel-js` 8.0.0, published 2026-07-07 (npm search).

---

## 5. Design references outside JavaScript

Two lines each, as the brief asks. These are references for *capture mechanism* and *whether there is
also an in-memory evaluator*.

* **.NET LINQ / EF Core.** Capture: the compiler builds `Expression<T>` trees and the provider walks
  them — "The LINQ query is processed by Entity Framework Core to build a representation that is ready
  to be processed by the database provider … The database provider identifies which parts of the query
  can be evaluated in the database / These parts of the query are translated to database-specific query
  language (for example, SQL for a relational database)"
  (https://learn.microsoft.com/en-us/ef/core/querying/overview). In-memory evaluation: EF Core does evaluate
  parts locally (client evaluation in the top-level projection,
  https://learn.microsoft.com/en-us/ef/core/querying/client-eval) and ships an in-memory provider that Microsoft
  discourages for testing (https://learn.microsoft.com/en-us/ef/core/providers/in-memory/); the first draft's
  "EF Core does not evaluate expression trees locally" was wrong. Security note worth quoting into Mesh's docs: "Even when using LINQ, if
  you are accepting user input to build expressions, you need to make sure that only intended
  expressions can be constructed" (same page).
* **Ash (Elixir).** Capture: a macro at compile time — `defmacro expr(body)`, which calls `do_expr(body)` (the
  `do:` clause forwards to `Ash.Expr.expr(unquote(body))`) (local checkout `~/work/mesh/scratch/ash-src/ash/lib/ash/expr/expr.ex:206-218`; `ash/lib/ash/filter/runtime.ex` is the in-memory evaluator),
  which builds `Ash.Query.BooleanExpression` nodes. In-memory evaluation: yes — Ash evaluates
  expressions itself and only compiles to SQL when a SQL data layer is present; the SAT layer shows
  the query-planning trick: `to_sat_expression/2` calls `consolidate_relationships` and
  `upgrade_related_filters_to_join_keys` (same file's sibling `ash/lib/ash/expr/sat.ex:15-20`), i.e.
  relationship traversal is rewritten into join keys *before* code generation.
* **Ecto (Elixir).** Not verified (https://ecto.sql.org and https://hexdocs.pm/ecto/query.html were 301 redirects on 2026-10-05; the targets were not followed). Known design from memory only: queries are keyword-list/macro compositions, not
  expression trees — treat as unverified.
* **Kotlin Exposed.** "It offers two approaches for database access: a typesafe SQL-wrapping
  Domain-Specific Language (DSL) and a lightweight Data Access Object (DAO) API"
  (https://raw.githubusercontent.com/JetBrains/Exposed/main/README.md). Capture: builder DSL; no
  in-memory evaluator; supports embedded databases (H2/SQLite in-process), which is the closest thing
  to a second execution target.
* **Scala Quill.** Not verified (https://docs.quarkiverse.io/quarkus-quill/ returned 404 on the paths
  tried).
* **PonyORM (Python).** Capture: it **decompiles** the expression — "Pony provides a number of
  functions, for example `select()`, that receive a generator expression, and then translate this
  generator into a SQL query" (https://ponyorm.readthedocs.io/en/latest/queries.html). In-memory
  evaluation: no (SQLite/Postgres/MySQL backends only). Version/maturity: 0.7.20, Apache-2.0, uploaded 2026-08-09 (https://pypi.org/pypi/pony/json); stars not verified.
* **Diesel (Rust).** "A safe, extensible ORM and Query Builder for Rust"
  (https://raw.githubusercontent.com/diesel-rs/diesel/master/README.md); capture is a typed builder over
  a schema trait, no expression trees, no in-memory evaluator.
* **CEL (language, not a framework).** "Common Expression Language (CEL) is an expression language
  that's fast, portable, and safe to execute in performance-critical applications … Non-Turing complete,
  and only accesses data provided by the host application … Formally Verifiable"
  (https://cel.dev/). Relevant to Mesh because it is the design most policy engines converge on:
  total, terminating, side-effect-free expression language with a *host-supplied* variable set.
  InstantDB's rules borrow from it; `cel-js` evaluates it in memory. CEL-to-SQL translators in JS:
  **not found** in the npm search performed (only `@bufbuild/cel` evaluators appeared).

---

## 6. Conclusion

**Is there a project Mesh can rely on? No established one.** The first draft said no project at all; the
fact-check found **Greffon** (§3.1a), which does capture a normal TypeScript arrow at build time and gets both
in-memory evaluation and SQL, with build-time errors. It is seven weeks old, 0 stars, 4 downloads a week,
0.1.1, one maintainer, and its docs are the only evidence of its behaviour (not executed here). So: nothing
mature, one very young project that validates Mesh's design and should be read (and possibly watched or
contributed to) before Mesh writes its own. Every older candidate captures the expression by one of three
mechanisms, and none captures a normal TypeScript arrow with both executions:

* **Builder calls** (Drizzle, Kysely, MikroORM, Prisma, TypeORM, ts-sql-query, Convex, TanStack DB):
  nothing to read from; Mesh would still have to own the vocabulary. Confirmed from docs today (§3.8).
* **A data language, not a TS expression** (CASL/ucast, Remult, InstantDB rules, Zero's ZQL, CEL, JSONata,
  Mongo-style objects): these *do* get both executions, but only because the "expression" is a value
  Mesh would have to invent anyway. Their contribution is the architecture — one AST, two
  interpreters — which Mesh should adopt.
* **Source-text parsing** (tinqer at run time; Greffon at build time): tinqer is 0.0.28 / 273 downloads per
  week / no in-memory evaluator / run-time-only errors; Greffon is the closest match but 0.1.1 / 4 downloads.
  Not dependencies; reference implementations.

### What Mesh should copy

1. **Two interpreters over one AST** (ucast, Remult): one in-memory evaluator and one SQL emitter must
   consume the *same* node type, so a rule cannot be true in one and false in the other. This is the
   single most important structural decision, and two mature projects already make it.
2. **A tiny, enumerated node vocabulary** (ucast's FieldCondition / DocumentCondition /
   CompoundCondition): field, operator, value; a whole-document test; and `and`/`or`/`not`. Plus a
   node for "function call with a fixed allow-list" so `today()` and friends are explicit rather than
   arbitrary code.
3. **Compile the AST, then rewrite relationships into joins** (Ash's `to_sat_expression` →
   `consolidate_relationships`, `upgrade_related_filters_to_join_keys`; tinqer's `normalizeJoins`):
   do this as a normalization pass before SQL generation, not inside the emitter.
4. **A declared supported-subset check before anything else** (tinqer's "Expression Support" list,
   ZenStack's ZModel expression language): a fixed list of comparison, logical, arithmetic, string,
   null and array operations, plus aggregates and window functions. Anything outside it is a build
   error with a source span.
5. **Explicit boundary between pushable and local-only** (TanStack DB's `eq()` vs `fn.where`): if Mesh
   ever allows an escape hatch that cannot be pushed down, it must be named as local-only in the type
   and the docs, or the same rule will silently execute in the wrong place.
6. **Parameters, never closures** (tinqer): `#paidAt=({input}) => …` style destructuring maps to
   parameters; a rule that captures ambient state is a build error.
7. **Fold policies into the query AST, not around it** (ZenStack): "rows not satisfying the policy
   don't exist" is the right mental model, injected as AST filters so indexes still work.

### Pitfalls the surveyed projects document — carry these into Mesh's design

* **Null vs undefined.** Convex: a missing field "will be considered to have the value `undefined`";
  SQL has three-valued logic where `NULL = NULL` is unknown and `NULL AND FALSE` is `FALSE`. JS `&&`
  returns an operand, not a boolean. Every design must state whether a missing relationship is `null`,
  is absent, or short-circuits (Mesh should treat absent relationship traversal as `null`, and
  `x == null` must translate to `IS NULL`, not `= NULL`).
* **Booleans differ per database.** tinqer: "Boolean values use INTEGER (0/1)" on SQLite, and its docs
  mark `boolean` in a SQLite schema interface as *incorrect*; PostgreSQL has a native boolean type.
* **Dates.** tinqer rejects `Date.now()` ("External functions are not supported") and date arithmetic
  ("Date arithmetic is not supported"); SQLite stores dates as `TEXT`/INTEGER ISO strings while
  Postgres uses `TIMESTAMP`. Mesh's `today()` must be a parameter computed once per action, not a
  function call in the SQL.
* **Strings, case and collation.** tinqer's supported set is `.includes()/.startsWith()/.endsWith()/
  .toLowerCase()/.toUpperCase()` and its case-insensitive helpers compile to `LOWER(x) LIKE …`, with
  the explicit note that this is for *portable* case-insensitivity — it does not reproduce a
  collation. `%` and `_` in a `LIKE` pattern are wildcards in SQL but literal in JS; and SQLite's
  `LIKE` is case-insensitive for ASCII by default while Postgres `LIKE` is case-sensitive — verified
  from tinqer's SQLite section only (`LOWER()` is used to normalize).
* **Short-circuit evaluation and side effects.** tinqer extracts literals into parameters and refuses
  closure variables; nothing else found allows a function call in a filter. A rule like
  `a() && b()` must either be rejected or defined as "always both evaluated", because SQL has no
  guaranteed short-circuit for cost reasons and `CASE WHEN` changes error behaviour.
* **Type coercion.** tinqer requires the schema interface to match the target database's types and
  throws `TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and null` at run time
  otherwise; JS `==`, `+` and `+` on strings have no SQL equivalent and none of the surveyed projects
  supports them. Mesh should support only `===`/`!==` and typed arithmetic, and reject the rest at
  build time.
* **Unsupported is not the same as wrong.** tinqer throws `Unsupported …` at run time; Mesh's
  requirement is a build-time error, which means Mesh must do its checking over the AST it
  already has rather than relying on a library's runtime behaviour (Greffon shows this is workable: its subset
  validator runs in the build, editor and lint).
* **Pushdown is partial in practice.** TanStack DB's SQL is a `WHERE` fragment for a sync protocol,
  not a query; Zero never speaks SQL to Postgres at query time. Any "we translate to SQL" claim should
  be checked against what is actually sent.

---

## 7. Not verified

Everything below was requested or implied by the brief and could **not** be established from a source
fetched today. None of it is asserted anywhere above except where marked *not verified* in place.

1. **`@blacktunes/sql`** — described in the brief as a Babel-source-parsing SQL generator; both the npm
   package and the GitHub repository 404'd on 2026-10-04. Its design and whether it still exists are
   unverified.
2. **`sqlite-linq`** — no such npm package; may exist under another name. Not searched further.
3. **`linq-to-sql` (npm, 0.0.1, 2014)** — listed in npm search results but not examined; no assessment
   of its mechanism or maturity.
4. **Ecto query mechanism** — `ecto.sql.org` did not resolve and `hexdocs.pm/ecto/query.html` 404'd.
5. **Scala Quill** — docs URL 404'd; nothing quoted about its quoted-DSL compilation.
6. **PonyORM** — version, licence, release date, stars, and its filtering/decompilation page
   (`filtering.html` and `advanced_topics_filtering.html` both 404'd). Only `queries.html` was read.
7. **Orange ORM's filter API** — only its README's browser/call-log description was read; whether it
   has any expression capture: not verified.
8. **Triplit** — `@triplit/client` and `@triplit/db` exist on npm (the unscoped `triplit` does not); its
   expression/query mechanism was not examined.
9. **Prisma TypedSQL and client extensions** — the TypedSQL doc pages returned 404 on the paths tried;
   the claim "Prisma never translates a TS expression" rests on its documented `where`-object filtering
   API only.
10. **TypeORM internals** — stars/versions read, but no doc quoted for its filter mechanism.
11. **`sift` repository statistics** — resolved on 2026-10-05: 1,703 stars (see §3.9).
12. **Drizzle relational-query v1 and `with` clauses** — not read; the "relationships: yes" cell in the
    table for Drizzle rests on general knowledge of its API, not on a fetched quote.
13. **`@mikro-orm` relationship filtering example** — the quoted lines are from `query-builder.md`
    lines 159 and 202 of a single fetch; the exact rendered semantics of nested object filters were not
    cross-checked.
14. **`filtrex` and `jsep` descriptions** — READMEs not fetched (only registry metadata).
15. **Tinybase's query/expression capability** — README 404 on the paths tried; only version and star
    count are given.
16. **CEL-to-SQL translators in JavaScript** — a targeted npm search ("cel sql translator") surfaced
    only evaluators; whether a maintained CEL→SQL compiler exists is **not verified**.
17. **Cerbos and OPA partial evaluation to SQL** — `docs.cerbos.sh` did not resolve and OPA was not
    fetched; nothing is claimed about them in this document.
18. **`@ucast/sql` field-error reporting** — the SQL package README does not mention `FieldError`
    (grep found none), so the claim "ucast reports unsupported constructs per field" is **not
    verified** and has been left out of the table's column-5 judgement beyond "parser/interpreter level
    errors".
19. **PowerSync and ElectricSQL as standalone candidates** — only TanStack DB's Electric adapter was
    read; Electric's own sync/shape mechanism was not examined.
20. **Whether tinqer's row-level-security injection is documented** — resolved on 2026-10-05: documented
    ("Row Filters" in `llms.txt`).
21. **Greffon behaviour** — read from docs and package metadata only; the code was not run, and its claim that
    SQL providers are property-tested against the memory provider is not verified. GitHub API rate limits
    prevented reading its commit history.
22. **Convex "memory only"** and **InstantDB client `where` semantics** in the comparison table — not checked
    against a source in the fact-check.