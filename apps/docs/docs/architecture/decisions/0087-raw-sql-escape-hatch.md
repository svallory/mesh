---
title: "0087. The raw-SQL escape hatch: what ships before 1.0"
description: "Decision record 0087: six designs for the raw-SQL escape hatch, why 'like Ash's fragment' and 'before 1.0' cannot both hold as written, and the questions the operator must answer. Status: Accepted by the lead for Option E, pending the operator (2026-11-17); questions 1, 7 and 14 stay open for the operator."
---

# 0087. The raw-SQL escape hatch: what ships before 1.0

## Status

Accepted by the lead for Option E, pending the operator. The lead accepted Option E alone on 2026-11-17, as a reversible step that changes no entity-file syntax, no `Mesh` member and no diagnostic; the acceptance awaits the operator's review. Questions 1, 7 and 14 are the operator's and stay open (section "Questions for the operator"); Option E is built with the proposed answers to questions 7 and 14 in force provisionally, and reversing either removes the `query` export and the `raw-sql` capability. Options A, B, C, D and F are not accepted: each needs the operator.

## Date

Proposed 2026-11-14. Accepted by the lead for Option E 2026-11-17.

## Deciders

operator; the lead, for Option E only, pending the operator. Proposed by the lead under its ruling D24 (run of 2026-11-14, in the lead's ruling log `notes/decisions.md`, which is outside this site): "This run writes a design for the raw-SQL escape hatch as a proposed ADR in a pull request left open for the operator; nothing is built from it until the operator accepts it." On 2026-11-17 the operator ordered every unblocked item of the tracker done (ruling D28 of that log), and the lead accepted Option E under its ruling D34, from the reviewed implementation design (`notes/architecture/raw-sql-design.md`, outside this site, open decision 0): the lead rules the questions about how Option E is built (2 to 6, 8 to 13 and 15); questions 1, 7 and 14 ask what the operator meant or make product commitments, and are deferred to the operator (ruling D49). Every "is" in an option's text describes that option, not a rule in force; the Decision section says what is in force.

## Context

### What the hatch is and what this site says about it

A raw-SQL escape hatch lets an author write SQL by hand where Mesh's own constructs cannot say what the database can: a recursive query, a window function, a database function Mesh has no name for.

Six passages of this site mention it. All six place it after 1.0, and four of them describe it as Ash's `fragment`:

| Passage | What it says |
|---|---|
| [Roadmap](../roadmap/roadmap.md), section 6, "Also after 1.0" | "Raw-SQL escape hatch", described as "Like Ash's `fragment`" |
| [ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md) | The operator's ruling it quotes: "A raw-SQL escape hatch (like Ash's `fragment`) is planned, not in v1." Its decision repeats "planned after v1" and its last action item is "After v1: the raw-SQL escape hatch." |
| [Vocabulary mapping](../roadmap/vocabulary-mapping.md), "After v1" | "a raw-SQL `fragment`" |
| [Open questions](../open-questions.md), "Planned, not v1" | "a raw-SQL escape hatch like Ash's `fragment`" |
| [ADR-0050](./0050-entity-file-syntax.md), "Not in v1" | "the raw-SQL escape hatch", among the things "planned or rejected and … not shown to users" |
| [Architecture overview](../overview/architecture.md), "Not in 1.0" | "a raw-SQL escape hatch" |

> **Correction, 2026-11-17 (at acceptance).** The table describes `main` at `be9f6ee`, where this record was written. Amendments of 2026-11-14 that merged before the acceptance changed it: on `main` at `b5e58ba` all six passages place the hatch before 1.0 (the roadmap in section 5, "Before 1.0, milestone not assigned"; ADR-0056 and ADR-0050 through dated amendments that keep their decision text; the open-questions page; the architecture overview, under "Before 1.0, with no milestone assigned"). Four still described it as Ash's `fragment`: the roadmap's row, the open-questions page, the vocabulary page and the ruling ADR-0056 quotes. The acceptance of Option E corrects the first three to say what ships before 1.0; ADR-0056's quoted ruling is kept as written and gains an amendment pointing here.

On 2026-10-18 the operator moved the hatch before 1.0. That move is recorded in three places, all outside this site: the tracker item `mesh-raw-sql-escape-hatch` ("Moved before 1.0 by the operator on 2026-10-18 … Its design is not written yet: where it may appear (filters, read policies, rollups), how it binds parameters, how it relates to SQL translation, which comes in M10, after 1.0. Design first, then build."), the tracker item `mesh-docs-scope-2026-10-18` ("The operator moved has-many through= and the raw-SQL escape hatch before 1.0"), and one line of the language spec notes, `notes/spec/expressions.md` ("A raw-SQL escape hatch comes before 1.0. Not built."). None holds the operator's words, and none says which feature was meant (question 1, still the operator's).

### What Ash's `fragment` is

This section is taken from Ash's published documentation, read on 2026-11-14 (Ash 3.37.4, AshPostgres 2.15.2, AshSqlite 0.3.1), not from memory. (Ash also uses the word "fragment" for a shared piece of resource DSL, such as the one every Hyper resource includes, [gap analysis](../research/hyper-port-gap-analysis.md), section 1. That is another feature and is not meant here.)

A `fragment` is SQL written **inside an expression**, with `?` slots filled by other expressions. The [Expressions guide](https://hexdocs.pm/ash/expressions.html) says: "Fragments come in two forms. For SQL/query-backed data layers, they will be a string with question marks for interpolation. For example: `fragment("(? + ?)", foo, bar)`. For elixir-backed data layers, they will be a function or an MFA that will be called with the provided arguments." The [AshPostgres guide](https://hexdocs.pm/ash_postgres/expressions.html) shows a whole subquery in one: `fragment("points > (SELECT SUM(points) FROM games WHERE user_id = ? AND id != ?)", user_id, id)`, and calls that "a last resort". The [AshSqlite guide](https://hexdocs.pm/ash_sqlite/expressions.html) says the same for SQLite.

Three facts about it matter here:

1. **It lives where expressions live.** [`Ash.Query`](https://hexdocs.pm/ash/Ash.Query.html), under "Escape Hatches": "Fragments only barely count as an escape hatch. … You can use data-layer-specific expressions in your expressions for filters, calculations, etc." A slot filled with an attribute becomes a column of the row being considered; the data layer writes the surrounding query.
2. **The string form cannot run in memory.** In Ash's source, [`Ash.Query.Function.Fragment`](https://github.com/ash-project/ash/blob/v3.37.4/lib/ash/query/function/fragment.ex) evaluates a function or an MFA and answers `:unknown` for everything else. Our [Ash runtime internals](../research/ash-runtime-internals.md) page, section 5.5, says of fragments that "both can be evaluated in-memory too"; that is wrong for the string form, and an action item below corrects it. Ash's answer for an expression that needs both forms is another feature, [`Ash.CustomExpression`](https://hexdocs.pm/ash/Ash.CustomExpression.html), where the author writes one expression per data layer ("It is good practice to always define an expression for `Ash.DataLayer.Simple`").
3. **It is the lowest rung of `Ash.Query`'s list.** `Ash.Query` lists four escape hatches "in the order that you should prefer them", the least powerful first: fragments, manual read actions, `modify_query`, and using Ecto directly. (The [research synthesis](../research/synthesis.md), Step 1, section 5, "Strengths, ranked", item 3, praises a different, action-level ladder: "Escape hatches are layered and real: action → manual action → generic action → plain Elixir → Ecto". Its last rung is the same as `Ash.Query`'s.)

| Rung | What it is | What Mesh has |
|---|---|---|
| String `fragment` (`Ash.Query`'s first) | SQL inside an expression the data layer translates | Nothing. It needs SQL translation, which is M10 |
| Function `fragment` (the same entry) | A function called with the arguments, for data layers written in Elixir | Already there: a function body in an entity file that is not one expression runs in memory as plain code ([ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md)) |
| Manual read action (`Ash.Query`'s second, [guide](https://hexdocs.pm/ash/manual-actions.html)) | Replace how a read is performed | Not planned ([roadmap](../roadmap/roadmap.md), section 6: "Not planned at all … manual and generic actions") |
| `modify_query` (`Ash.Query`'s third) | Edit the data layer's query before it runs | No plan and no roadmap entry |
| "Using Ecto directly" (`Ash.Query`'s fourth) | Query the tables with the query library, beside Ash: "every `Ash.Resource` is an `Ecto.Schema`" | Nothing inside Mesh's transaction. An application can open a second connection of its own, which sees nothing the running transaction has not committed |
| `Ash.CustomExpression` (not in `Ash.Query`'s list; added here because it is Ash's answer to fact 2) | A named expression with one form per data layer | Nothing. [ADR-0010](./0010-one-expression-tree-two-evaluators.md) keeps the rule for later: "extension-supplied functions must bring both forms" |

### The conflict

Every passage that describes the hatch says "like Ash's `fragment`": SQL inside a translated expression. Mesh translates no expression to SQL before M10, and M10 is after 1.0 ([ADR-0072](./0072-mesh-1-0-is-the-port-gate.md), decision D3: "The SQL evaluator, `translate-or-error` on filters, sorts and policies, SQL for rollups" are "after 1.0 (M10)"). Until then such a position is "a build or run-time error that names the milestone, never an in-memory scan" ([roadmap](../roadmap/roadmap.md), principle 2). On `main` at `be9f6ee` a read policy that reads the record is the build error `MESH_NOT_IMPLEMENTED` naming M10 (a probe confirms it; the rule is in `packages/compiler/src/model/lifecycle-limits.ts`), while a read's own declared `filter` or `sort` builds and its generated body throws a `FrameworkError` at run time saying it "cannot run in this version … arrives in M10" (the read body in `packages/compiler/src/typescript/views/actions.ts`).

So before M10 there is no translated expression for a fragment to sit in. "Before 1.0" can only mean one of three things:

1. **A different feature under the same name**: SQL run from plain code, which is `Ash.Query`'s last rung ("using Ecto directly"), not its fragment. Options A and E (and, as a declaration, F).
2. **Ash's feature, with M10 moved before 1.0.** Option B. That reverses decision D3 of ADR-0072, which the roadmap calls "the largest single saving of the revision" (M4, "What moved, and why"); M10 is sized L in the roadmap's section 6.
3. **The one piece of Ash's feature that needs no translator**: a read's whole filter written as SQL. Option D.

Option C is A now and B when M10 comes.

### What else bears on the choice

- **The port does not need raw SQL.** The roadmap's principle 10 has two halves: "no new construct is added before the port unless the port needs it, and as many planned constructs as possible are added before 1.0". The Hyper port in `examples/hyper` passes conformance groups 01 to 09 (`examples/hyper/conformance/README.md`) with no SQL of its own: on `main` at `be9f6ee`, nothing under `examples/hyper/src` imports Drizzle or `bun:sqlite` or holds a SQL template. The roadmap gives the reason: "Hyper's reads are served by plain-data filters; its five `exists` calculations are in-memory computed fields" (section 6). So only the second half of the principle, and the operator's move, argue for building this before 1.0.
- **The data-layer contract forbids it today.** "No query-library type or SQL string crosses the contract; a filter is plain data", and "`runtime` imports no Drizzle" ([data layer](../in-depth/data-layer.md)). `DataOperations` in `packages/runtime/src/data-layer.ts` has `insert`, `select`, `selectByKey`, `selectByKeyForUpdate`, `updateByKey`, `deleteByKey`, `max`, `count` and the optional outbox operations, and nothing that takes SQL.
- **The `Mesh` namespace is closed, and it cannot reach a project's transaction.** [ADR-0086](./0086-entity-values-privileged-barrels-and-fqns.md) rules that every function Mesh gives application code that is the same in every project is a member of `Mesh`, and that functions bound to one project stay exports of the generated `#mesh`: "`meshfw` cannot import an application's `#mesh`, so a `Mesh.transaction` would need a process-wide registry, which is ambiguous when two projects are connected in one process." In code, `Mesh` is one frozen object with six members, `privileged`, `isSystem`, `checkPolicies`, `can`, `fqnOf` and `handler` (`packages/runtime/src/mesh.ts`), and a member it does not have, written in an entity file, is the build error `MESH_UNKNOWN_MESH_FUNCTION` (`meshMember` in `packages/compiler/src/front-end/expression.ts`). Its members find a project's running transaction only through an entity value: `packages/runtime/src/entity.ts` keeps the project's async frame in a WeakMap keyed by entity value (`frames`, filled by `bindDomain`), and `privileged(entity)` reads it from there. A Mesh function that takes no entity value has no way to find the transaction or the binding. The frame-bound functions that take none are generated: `#mesh` exports `transaction`, and in event projects `published` and `readEvents`.
- **Raw SQL outside the query bypasses access rules; a fragment inside it does not.** ZenStack: "Raw SQL queries executed via `$executeRaw()` and `$queryRaw()` are not subject to access control enforcement" ([expression language research](../research/expression-language.md), section 3.3). Ash's "using Ecto directly" bypasses its policies the same way, while its fragment does not, because it sits inside the query Ash authorizes. The expression-language page concludes that an escape hatch "must be named as local-only in the type and the docs" when it cannot be pushed down; the mirror rule, for one that can only run in the database, is question 15 below.
- **Mesh's in-memory evaluator "is never a fallback for a missing database capability"** ([expressions](../in-depth/expressions.md)).

### What the code does today

Probes were run for this record on 2026-11-14, against `main` at `be9f6ee` with Bun 1.4.2. They are small scripts kept outside the repository; each result below can be reproduced by building the named entity file with `buildModel` from `packages/compiler`, or by running the named statements on `bun:sqlite`.

- `Mesh.sql` written in a computed field or a check is a build error, `MESH_UNKNOWN_MESH_FUNCTION`. The file parses: MX hands Mesh the function as a syntax tree, and a tagged template is one node with its text pieces and its `${…}` expressions apart.
- A tag **imported from a project module** already builds, with no diagnostic, both in a computed field and in a synchronous one-expression check (`that=() => sql\`${&views} < 10\``). Any function holding a tagged template is classified as plain code (reason: "a tagged template literal", the `TaggedTemplateExpression` entry in `packages/compiler/src/front-end/expression.ts`). Inside its `${…}`, `&title` is rewritten to the record's in-memory value and `%.now` to the transaction's instant. So in plain code an interpolated member is a **value**, not a column, even in a one-expression arrow. Option C below depends on this.
- SQLite, inside an open write transaction: `PRAGMA query_only = ON` lets a select see the transaction's uncommitted rows and makes an insert or update fail ("attempt to write a readonly database"). **It is not a read-only guarantee.** Under it, a raw `commit` ran and ended the transaction, and a raw `pragma query_only = off` was accepted, after which the next statement wrote. The [SQLite documentation](https://www.sqlite.org/pragma.html#pragma_query_only) says so: "any attempt to CREATE, DELETE, DROP, INSERT, or UPDATE will result in an SQLITE_READONLY error. However, the database is not truly read-only. You can still run a checkpoint or a COMMIT". Other single statements change the connection that every later Mesh transaction shares without writing a row: `PRAGMA foreign_keys`, `PRAGMA journal_mode` (`@meshfw/data-sqlite` sets WAL itself), `PRAGMA busy_timeout` (the data layer requires 0) and `ATTACH`. `bun:sqlite` 1.4.2, the version the repository pins, exposes no read-only test of a prepared statement (SQLite's `sqlite3_stmt_readonly`); its type declarations have none. (Correction, 2026-11-17: Bun 1.4.4 has one, `Statement.readonly`, but it answers `true` for `begin`, `commit`, `attach` and `pragma query_only = off`, so it could not replace the allow-list even once the pin moves.)
- `bun:sqlite` has silent behaviours an adapter must not pass on. A `Date` given as a parameter is bound as `NULL` (on 1.4.2; Bun 1.4.4 throws instead); an object given as the parameter is read as a map of named parameters, so the `?` it was meant for is left `NULL`. A **prepared** statement (`db.query`, `db.prepare`, the path Drizzle's driver uses) runs the first statement of its text and ignores the rest: `select 1; delete from t` deletes nothing. `Database.run` and `exec` run every statement: the same text through `db.run` empties the table. And a failed statement leaves the transaction open and usable.

## Decision

**Option E, accepted by the lead on 2026-11-17, pending the operator's review**: before 1.0, a read-only raw query that application code and helpers call through a function, `query`, exported by the generated `#mesh`, with no change to the entity-file language; Ash's fragment (Option B) is left to M10's design, with no spelling committed now. M10 does not move. The names `query` and `raw-sql` are Option E's. `Mesh.sql`, `MESH_SQL_FORM` and `MESH_SQL_PLACEMENT` belong to options that are not accepted, and none exists: `Mesh.sql` stays the build error `MESH_UNKNOWN_MESH_FUNCTION`. Nothing is built yet: the [Docs page](../../docs/using-your-domain.md#raw-sql-queries) describes it first ([ADR-0063](./0063-user-docs-first-and-the-hold.md)).

**What the lead ruled for Option E** (the questions at the end, as answered on 2026-11-17):

- **2.** M10 does not move before 1.0.
- **3.** Only behind helpers and application code; an entity file cannot name `query` (`#mesh` is not an import path an entity file may use, `MESH_UNKNOWN_IMPORT`).
- **4.** `query` from `#mesh`, a template tag, with `query.as(schema)` for typed rows.
- **5.** Read-only, enforced by the adapter: the leading-keyword allow-list (`select`, `with`, `values`; a leading comment is refused), a small lexer that refuses a second statement and a parameter written in the text (`?`, `?1`, `:name`, `@name`, `$name`, or a `${…}` inside quotes or a comment), `PRAGMA query_only` for the statement's duration, the prepared path, and a check afterwards that the transaction is still open.
- **6.** The guarantee never weakens on SQLite. On Postgres the read-only window holds for rows only (Option A, point 5): M9 must close the session-level side effects (advisory locks, `pg_notify`, `dblink`) or bring this question back to the operator before `@meshfw/data-postgres` declares `raw-sql`.
- **8.** The binding in scope, else the connected one, as a `privileged` read: it joins a running transaction and otherwise opens its own through the data layer.
- **9.** Results as stored, frozen (each row and the array), typed `unknown` unless a Standard Schema is passed; the adapter converts `Date` and boolean parameters. An integer comes back exactly: a `number` when it is a safe integer, a `bigint` beyond 2^53. A result that names a column twice is refused, since a row keeps one value per name.
- **10.** Neither arrays nor table handles. A value is bound only if it is a string, a finite number, a `bigint` within signed 64 bits, a boolean, a valid `Date` or `null`; anything else is refused, never bound as `NULL`.
- **11.** Mesh's own tables are not refused and are not a stable interface.
- **12.** The contract gains the optional `query` operation and the seventh capability `raw-sql`; the `#mesh` export exists exactly when the configured data adapter declares `raw-sql`.
- **13.** A failed raw query fails the running transaction even when the caller catches the error, through the existing join; inside a `Mesh.can` question the question's probe layer takes the failure instead.
- **15.** If B comes with M10, a fragment is SQL-only, to be confirmed by M10's design.
- Every refusal and every database failure is a `FrameworkError` naming the reason, never a parameter value.

**Open for the operator** (ruling D49 of the lead's log): **question 1** (which feature the move of 2026-10-18 meant), **question 7** (accepting a second way, beside `Mesh.privileged`, to read without read policies) and **question 14** (stored names as a compatibility surface from 1.0). Option E is built with the proposed "yes" to 7 and 14 in force provisionally; if the operator answers either "no", the `query` export and the `raw-sql` capability are removed, which `tsc` reports in any project that adopted `query`. The tracker item `mesh-raw-sql-escape-hatch` stays open after Option E lands. If the operator's answer to question 1 is a feature Option E does not cover (a read's filter, a read policy, a rollup), a follow-up item for Option B, designed with M10, takes it over.

## Options considered

Each option answers the same six questions:

1. **Where** it may appear: a read's filter, a sort key, a read policy, a rollup or computed field, a `set` value, a check, or only plain code.
2. **How it is spelled** in an entity file, which is static and which Mesh never reads as text.
3. **How parameters bind** (`&member`, `input`, `actor`, `%.now`) and what prevents building SQL by string interpolation.
4. **What happens in memory**: a check on a new instance, a `Mesh.can` question, a loaded computed field.
5. **What changes in the data-layer contract**: operations, the closed capability set, conformance checks, the rule that Drizzle is imported only under `packages/data-*`, SQLite now and Postgres in M9.
6. **Results and visibility**: result types, table and column names, read policies, `mesh explain`, errors.

Options A and E share a run-time core, described once under A: the read-only enforcement, the contract, the conformance block, results and errors. They differ in spelling and in whether an entity file may hold the query.

### Option A: a raw query written in entity files and plain code, before 1.0

`Mesh.sql` is a template tag that returns a statement: the text pieces and the values, kept apart and frozen. The query runs through an entity value, `Mesh.privileged(Task).query(statement)`, because a `Mesh` member can find the project's transaction only through one (Context). This is not Ash's fragment; it is Mesh's form of "using Ecto directly", inside Mesh's transaction.

The first check below holds the query in the entity file; the second calls a helper that holds it.

```mx "src/domain/work/task.mesh.mx (excerpt; illustration of Option A, not valid today)"
check :titleFree [
  that=async ({ input }) => (await Mesh.privileged(Task).query(Mesh.sql`select 1 from tasks where lower(title) = lower(${input.title}) and id <> ${&id} limit 1`)).length === 0
  code="task.title_taken"
  message="another task already has this title"
]
check :noCycle [
  that=async ({ input }) => !(await underItself(&id, input.parent))
  code="task.cycle"
  message="a task cannot move under its own descendant"
]
```

```ts "src/domain/work/work.helpers.ts (excerpt; illustration of Option A)"
import { Mesh } from "meshfw";
import { Task } from "#mesh/domain/work";

export async function underItself(task: string, newParent: string | null): Promise<boolean> {
  if (newParent === null) return false;
  const rows = await Mesh.privileged(Task).query(Mesh.sql`
    with recursive up(id) as (
      select ${newParent}
      union
      select t."parentId" from tasks t join up on t.id = up.id
    )
    select 1 from up where id = ${task} limit 1`);
  return rows.length > 0;
}
```

1. **Where.** Exactly where `Mesh.privileged` may be called, and nowhere else: a `run` step, a plain `set` value, a check, a write policy's plain code ([ADR-0074](./0074-write-policies-may-read-through-tx.md)), the helpers those call, and application code inside or outside `transaction`. Not in a read's `filter` or `sort`, a read policy, a rollup or a computed field. Reusing one existing placement rule means no new rule to learn, but the enforcement is new work: today the run-time marks refuse entity calls, `privileged` reads and `Mesh.can`/`Mesh.checkPolicies` questions, and the build errors name those calls ([action lifecycle](../in-depth/action-lifecycle.md), "Where `Mesh.privileged` may not run"). The handle's `query` must be added to both, and to the probe layer a `Mesh.can` question runs on, which must forward it as a read.
2. **Spelling.** `Mesh.sql` followed by a template, and the handle's `query(…)`, written in a function body. The function is plain code as a whole, as the probe shows for an imported tag, so the build translates nothing; it adds `sql` to the `Mesh` namespace and `query` to the privileged handle, and checks that `Mesh.sql` is used only as a tag (`MESH_SQL_FORM`) and only in an allowed place (`MESH_SQL_PLACEMENT`). The handle names an entity the query need not read; any entity value of the project finds the frame. The alternative spellings are question 4.
3. **Parameters.** Every `${…}` is a bound parameter, never text, unless it is a statement made by the tag, which is spliced in as SQL with its own parameters (statements compose that way). In plain code `&member` is the record's in-memory value, `input` and `actor` are values and `%.now` is a `Date`, so each is bound as a value; a column is named in the SQL text. Four things prevent string interpolation: no Mesh function takes SQL as a string; `query` accepts only a statement the tag made, which needs new work, a module-private brand (a WeakSet of the statements `Mesh.sql` returned); there is no `raw()` (Drizzle has one, which "allows you to include raw SQL statements … without any additional processing or escaping", [Drizzle documentation](https://orm.drizzle.team/docs/sql)); and composition goes through the brand, never through text. This stops accidents, not intent: code that forges what a template tag receives can still pass text to the tag, and TypeScript cannot prevent that. The adapter converts a boolean and a `Date` to the stored form and refuses any value it cannot bind; it must never bind `NULL` silently as `bun:sqlite` does. An array (for `in (…)`) and a table handle are refused under this option's first version (question 10).
4. **In memory.** A raw query is not an expression of the tree, so the two-evaluator promise of [ADR-0010](./0010-one-expression-tree-two-evaluators.md) does not apply: there is nothing to evaluate in memory, and it always goes to the database. A check on a create runs before the insert, so the query does not see the new row, and `&member` there is the new instance Mesh builds before the member inputs ([ADR-0053](./0053-validate-then-do.md), amendment of 2026-10-11); a query that needs the caller's value interpolates `input`. A `Mesh.can` or `Mesh.checkPolicies` question "writes nothing" ([action lifecycle](../in-depth/action-lifecycle.md), "Permission questions") but does run write policies, so a raw statement reached through one must be unable to write, end the transaction or change the connection. `PRAGMA query_only` alone does not do that (Context). Under this option the adapter refuses any statement that is not a query, by three means together: an allow-list of the leading keyword after whitespace (`select`, `with`, `values`; a leading comment is refused), which refuses `pragma`, `begin`, `commit`, `rollback`, `savepoint`, `release`, `attach`, `detach`, `vacuum` and every write; `PRAGMA query_only = ON` for the statement's duration, which stops a `with … delete` that the allow-list lets through; and a check after each call that the transaction is still open, failing the transaction otherwise. (Correction, 2026-11-17: this record first also read `query_only` back after each call. That read-back is dropped: a statement that could turn it off is a `pragma`, which the allow-list refuses, so it would cost a statement per call and catch nothing.) A computed field cannot call it: computed bodies are synchronous (`MESH_COMPUTED_ASYNC`).
5. **Contract.** One optional operation, `query(statement)`, on the transaction's operations; the statement is plain data, and the adapter writes the placeholders, so `?` against `$1` never reaches the author. A seventh name, `raw-sql`, joins the closed set `CAPABILITIES`; `@meshfw/data-sqlite` declares it. A direct call in an entity file built against an adapter without it is `MESH_CAPABILITY`; a call from a helper or from application code fails at run time with a typed error. The sentence "No query-library type or SQL string crosses the contract" changes: SQL text crosses in this one operation, and still no query-library type. The Drizzle rule ([ADR-0014](./0014-sql-adapters-on-drizzle.md)) does not change: the tag lives in `@meshfw/runtime` and builds plain data; rendering is the adapter's. The lead proposes not handing out Drizzle's own `sql` and transaction handle: a query-library type would cross the contract, and it would not be Mesh's transaction, since "Drizzle's `bun-sqlite` driver runs transactions synchronously … So `@meshfw/data-sqlite` runs them itself" ([data layer](../in-depth/data-layer.md)). One statement per call is part of the contract, so the adapter must run the text through the prepared path, which never runs a second statement, and must refuse text after the first; how `@meshfw/data-sqlite` detects it is an action item. A conformance block, run only for adapters that declare `raw-sql` (as the `gapless-positions` checks of `outboxConformance` run only for adapters that declare that capability), checks: a value is bound and not spliced; the statement runs inside the running transaction, in call order, and sees its uncommitted rows; a write is refused and the transaction still writes afterwards; a `commit`, a `rollback`, a `savepoint`, a `pragma` (including `pragma query_only = off`) and an `attach` are each refused and leave the transaction open and unchanged; a `with … delete` is refused; a value that cannot be bound is refused, never null; a boolean and a `Date` round-trip; and a refused statement raises the raw-SQL error. **Postgres**: the capability rule ([data layer](../in-depth/data-layer.md), "The capability rule across parallel milestones") obliges M9 to implement `raw-sql` on Postgres the day it merges. When this record was proposed it did not know how Postgres can guarantee a read-only statement inside a transaction that has already written. (Correction, 2026-11-17: probed since on Postgres 16, inside a transaction that had inserted a row. `SAVEPOINT s; SET LOCAL transaction_read_only = on;` lets a `select` see the uncommitted row and refuses a `delete` and a `select` of a SQL function that inserts; it cannot be switched back inside the window; `ROLLBACK TO SAVEPOINT s` restores read-write. So the guarantee holds **for rows**. It does not hold for the connection: `pg_advisory_lock` and `pg_notify` still run, and the advisory lock is a session lock that outlives the savepoint and the transaction, on a pooled connection every later transaction shares; `dblink`, where installed, is another such door. A `COMMIT` sent inside the window still commits, so the leading-keyword allow-list is needed on Postgres too.) Whether the guarantee may weaken per adapter is question 6. SQL text and stored values differ per database, so an application that changes adapter rewrites its raw statements; whether a statement may carry one text per dialect is M9's to decide.
6. **Results and visibility.** Rows are plain objects with **stored** values, not attribute values: on SQLite a `datetime` comes back as an integer of milliseconds and a `boolean` as 0 or 1 (the column table in `packages/data-sqlite/src/schema-view.ts` maps `boolean` to `integer { mode: "boolean" }` and `date`, `datetime` and `timestamp` to `integer { mode: "timestamp_ms" }`). The type is `readonly Record<string, unknown>[]` unless the caller passes a schema as the second argument, which validates and types each row. The schema is a Standard Schema (`StandardSchemaV1`, the interface `@meshfw/runtime` already validates input through, with zero run-time dependencies); a Zod schema is the usual one, since Zod is a direct dependency of the project ([ADR-0062](./0062-direct-dependencies-zod-drizzle-opentelemetry.md)), not of the runtime. Under this option there is no bare type argument, because a type nobody checks is the opposite of what Mesh is for; Drizzle says of its own: "`sql<T>` does not perform any runtime mapping". **Names**: the author writes stored names, so they become a compatibility surface from 1.0: the table is the `table=` value or `snake_case(Name)` ([ADR-0086](./0086-entity-values-privileged-barrels-and-fqns.md)), a column "is named exactly like its attribute", and a relationship has its own column (`belongs-to :parent` is `parentId` in the Hyper example's schema). A rename in an entity file breaks a raw statement at run time, not at build. Mesh's own tables (`mesh_outbox`, `mesh_outbox_state`, `mesh_handler_progress`, `mesh_subscription_progress`) can be read too and are not a stable interface (question 11). **Read policies do not apply**: a raw query returns what the SQL selects, the standing a `Mesh.privileged` read has, which is why it is allowed only where that is. **`mesh explain`** prints one `raw sql` line per call written in the entity file, with the text and a `?` for each parameter; a call inside a helper is not printed, because the build does not read helpers. **Errors**: the two build errors above and `MESH_CAPABILITY`; at run time a `FrameworkError` that names the reason and carries the database's error as `cause`, and never a parameter value, since values may be personal data. A failed raw statement fails the running transaction even when the caller catches it, as a failed joined call does today ([action lifecycle](../in-depth/action-lifecycle.md), "A call that fails fails the transaction"). On SQLite a failed statement leaves the transaction usable, and the mark comes from the join that already exists: a raw query runs as a call joined to the running transaction, and the data layer marks the transaction failed when a joined call rejects (correction, 2026-11-17: this record first said Mesh must mark it itself; nothing new marks it). On Postgres the server already aborts the transaction block: every later command is refused with the error `current transaction is aborted, commands ignored until end of transaction block` (SQLSTATE `25P02`, `in_failed_sql_transaction`, [PostgreSQL error codes](https://www.postgresql.org/docs/current/errcodes-appendix.html); the [tutorial on transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html) covers savepoints, the way out of it). The Postgres adapter may run a raw statement inside a savepoint that only scopes the read-only window (`SET LOCAL transaction_read_only`) and is always rolled back to; it lets no caller recover, since core's join still fails the running transaction on any rejection (question 13). (Correction, 2026-11-17: this record first said the Postgres adapter must not wrap raw statements in savepoints at all.)

**Where it runs outside an action.** The query uses the binding in scope, else the connected one, as a `privileged` read does. Outside a transaction (application code, the `beforeTransaction` and `afterCommit` seams, a handler's `listen` body) it opens one of its own through the data layer, as a `privileged` read outside a transaction does; in `@meshfw/data-sqlite` that is a queued `BEGIN IMMEDIATE`, so a stand-alone raw read takes its place in the queue and the write lock, and never bypasses the queue. Inside a handler's `process` body it joins the handler's transaction (question 8).

**Pros:** Ships before 1.0 without touching M10. Follows principle 11, "plain code is a first-class answer". Gives applications what they cannot do at all today: a query Mesh cannot express, inside Mesh's transaction. `mesh explain` shows the calls written in entity files.
**Cons:** It is not the feature the six passages describe: a read's filter, sort or policy still cannot use SQL. It bypasses read policies, so reading the policies no longer tells the whole story of who can read what. Stored names and one database's SQL enter entity files and application code. It adds a member to a namespace that was closed on purpose, a method to the privileged handle that has nothing to do with its entity, and two build errors. The port does not need it. Unsized: the triage brief (`notes/triage-2026-11-14/mesh-raw-sql-escape-hatch.json`, outside this site) guessed L for the whole item, not for this option.

### Option B: Ash's fragment, inside translated expressions

The same tag, written inside a one-expression arrow, becomes a node of the expression tree. This is the feature the six passages name.

```mx "src/domain/work/task.mesh.mx (excerpt; illustration of Option B, not valid today)"
read :titled
  filter=({ input }) => Mesh.sql`lower(${&title}) like ${input.pattern}`
```

1. **Where.** The positions M10 evaluates in SQL ([ADR-0072](./0072-mesh-1-0-is-the-port-gate.md)): a read's `filter`, a `sort` key, a read policy that reads the record, a rollup, a computed field used by any of those, and a `set` value only where M10 makes the update one statement. Not a check or a write policy, which run in memory on the record.
2. **Spelling.** The tag as the body, or part of the body, of a one-expression arrow. The build turns it into a `fragment` node: the text pieces and one expression per `${…}`. Its type comes from the position (a filter is a boolean; a computed field declares its type). A fragment nested in a larger expression has no declared type; M10 must either require one or refuse nesting.
3. **Parameters.** Each `${…}` is an expression of the language, lowered by M10: `&member` becomes a **column** of the row being considered; `%.now` is the transaction's instant, bound. `input`, `actor` and `context` are bound as parameters under the rule ADR-0056 takes from the research, "Parameters, never closures" ([expression language research](../research/expression-language.md), section 6, item 6); ADR-0056 applies the same treatment to calls to imported pure functions: "Such a call is evaluated once in memory before the query and bound as a parameter" ([ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md)). A captured variable is already a build error there. String interpolation is prevented as in Option A.
4. **In memory.** A SQL fragment has no in-memory form; Ash's answers `:unknown`. Three rules are possible. (i) **SQL-only**: a build error wherever the expression that holds it would be evaluated in memory. (ii) **Two forms**: the author also writes an in-memory form, as `Ash.CustomExpression` asks. (iii) **Unknown in memory**, as Ash does. The lead proposes (i) and proposes rejecting (iii), because the two evaluators would then disagree silently, which principle 2 ("No silent fallback") and ADR-0010 exist to prevent. Under (i), whether a computed field holding a fragment can be loaded depends on whether M10 computes loaded fields in SQL, which is not designed.
5. **Contract.** Everything M10 needs: today "a filter is plain data", and M10 must carry an expression across the contract and compile it under `packages/data-*`. The fragment adds one node that carries SQL text. An entity file that holds one builds only against an adapter with the capability, and it is tied to one database's SQL, which the shared function tables exist to avoid. Conformance can check binding, column rendering and the refusal in memory, not arbitrary SQL.
6. **Results and visibility.** Rows stay entity records, typed as today, because a fragment changes a condition, a sort key or a computed value, never the shape of the result. Columns come from `&member`, so a rename is a build error and no stored name is exposed unless the author writes one in the text. **Read policies apply in full**: the fragment is inside the read. `mesh explain`, which today "prints a plan, not SQL" ([command line](../../docs/command-line.md)), prints the fragment's text in the filter line. Until M10 a fragment is the build error `MESH_NOT_IMPLEMENTED` naming M10 ([ADR-0018](./0018-not-implemented-is-a-build-error.md)), as a record-reading read policy is today (a read's own declared filter is instead a run-time error naming M10; the lead proposes the build error for the fragment).

**Pros:** It is what was planned and what "like Ash's `fragment`" says. It stays inside reads and policies: no bypass, typed records, renames caught at build.
**Cons:** It cannot ship before 1.0 unless M10, or its first half, moves before 1.0. That reverses decision D3 of ADR-0072 and undoes the largest saving of roadmap revision 5; the triage brief says it "either pulls M10 before 1.0 or cannot ship before 1.0". The roadmap's own trigger for moving M10 in is the port finding declared filters indispensable (M4, risks: "If that proves unacceptable, M10's first half moves in"), and the port passed without them. It also does nothing for the cases Option A serves: a query whose result is not an entity record.

### Option C: Option A before 1.0, Option B with M10

One tag, two homes. Before 1.0, `Mesh.sql` is accepted in plain code only (Option A, in full). With M10, the tag is also accepted inside a translated expression (Option B, with the SQL-only rule).

The rule that tells the two apart must be stated now, because today's classifier would blur them. Any function holding a tagged template is plain code, so a synchronous one-expression arrow that builds a statement already builds as plain, with `&member` as a value (Context, second probe). At M10 that same text is a one-expression arrow in which B makes `Mesh.sql` a fragment and `&member` a column: the meaning of an existing file would change silently. So under C, before M10, `Mesh.sql` is accepted only as the direct argument of the query call, or inside a function the build classifies as plain for a reason other than the tagged template itself (it is `async`, awaits, has a block body, or calls `Mesh.privileged`); everywhere else it is `MESH_NOT_IMPLEMENTED` naming M10. With that rule, allowing the fragment later breaks no file.

The six answers are Option A's before 1.0 and Option B's from M10. Three things are shared and built once: the tag and the statement value, the `raw-sql` capability, and the binding checks of the conformance block.

**Pros:** Honours both the move of 2026-10-18 and the wording "like Ash's `fragment`", without moving M10.
**Cons:** Compared with A alone, it reverses nothing more and keeps M10 where it is just the same; the only thing it adds is a commitment made now, before M10 is designed: the fragment will be spelled `Mesh.sql`, and the positions above will answer `MESH_NOT_IMPLEMENTED` naming M10. The same text means two things: `${&title}` is the record's value in plain code and the column in a translated expression. The form already decides which rules apply ([ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md)), so this follows an existing rule, but it will surprise, and the placement rule above is one more to learn. Between 1.0 and M10, authors will use the bypassing form for filters the policy-respecting form would have served, and that code stays. All the costs of Option A.

### Option D: a read's whole filter as a raw statement, before M10

The one part of Ash's fragment that needs no translator: a read's `filter=` (and a sort key) is a function that returns a statement.

```mx "src/domain/work/task.mesh.mx (excerpt; illustration of Option D, not valid today)"
read :titled
  filter=({ input }) => Mesh.sql`lower(title) like ${input.pattern}`
```

1. **Where.** A read's `filter` and `sort` only.
2. **Spelling.** An arrow whose whole body is a `Mesh.sql` template, recognised by form. Mesh translates nothing: it calls the function before the query, as plain code, and gets the statement.
3. **Parameters.** `input`, `actor`, `context` and `%.now` are values, bound. `&member` is a build error: no record exists yet, and turning a member into a column is the first piece of M10's work. Columns are written in the text.
4. **In memory.** No in-memory form, and the SQL-only rule of Option B from the start.
5. **Contract.** The plain-data query that `select` and `count` take gains a raw condition, combined by AND with the caller's filter, and raw sort keys; the same capability. The generated read needs a new path: today a read with a declared filter throws at run time, naming M10.
6. **Results and visibility.** Entity records. Read policies that do not read the record still run; those that do stay with M10. Stored column names are exposed, as in Option A. `mesh explain` prints the text.

**Pros:** Before 1.0, a declared read can filter by something plain-data filters cannot say, and the policies still apply.
**Cons:** It fixes the surface of Option B (the tag in a filter, how it combines with the caller's filter, limits and `on:load`) before M10 is designed, and M10 then gives the same position a second meaning by allowing `&member`. The port serves its four declared-filter reads with the caller's filter and does not need it. It does nothing for a query whose result is not an entity record. Unsized; the record's author guesses it adds about M to the contract work Options A and E share.

### Option E: a run-time function only, no language change (the lead's proposal)

Option A's run-time core with nothing added to the entity-file language. The generated `#mesh` exports one function, `query`, bound to the project's async frame as `transaction` is (it lives in the generated `binding.ts`, beside `transaction`). It is a template tag that runs at once: `await query\`…\``. Entity files reach it only through helpers, which checks, steps and write policies may already call.

```ts "src/domain/work/work.helpers.ts (excerpt; illustration of Option E)"
import { query } from "#mesh";

export async function underItself(task: string, newParent: string | null): Promise<boolean> {
  if (newParent === null) return false;
  const rows = await query`
    with recursive up(id) as (
      select ${newParent}
      union
      select t."parentId" from tasks t join up on t.id = up.id
    )
    select 1 from up where id = ${task} limit 1`;
  return rows.length > 0;
}
```

The entity file keeps `that=async ({ input }) => !(await underItself(&id, input.parent))`, valid today.

The walk uses `union`, not `union all` (correction, 2026-11-17, in this example and in Option A's): the check guards against a cycle, so the stored ancestors it walks may already hold one, and `union all` would then never end. `union` drops a row it has already produced, so the walk terminates.

1. **Where.** Application code and helpers. Since a helper may be called from a step, a check, a `set` value or a write policy, the reach is Option A's, and the placement is enforced the same way, at run time only: the frame marks gain `query`, so a call made while a computed field or a read policy is evaluated throws, as a hidden `privileged` read does; the probe layer of `Mesh.can` forwards it as a read. The build sees nothing, as it sees no hidden `privileged` read.
2. **Spelling.** None in an entity file: `query` is an ordinary TypeScript export of `#mesh`, which an entity file does not import (its one non-relative import is `meshfw`); the documented way to reach it is a helper. `MESH_UNKNOWN_MESH_FUNCTION` keeps refusing `Mesh.sql`, and no build error is added. A change of the function later is caught by `tsc`, not by an entity-file migration.
3. **Parameters.** Every `${…}` is a bound parameter, without exception: the first version has no statement values and no composition, so no brand is needed beyond checking that the first argument is a frozen template-strings array. An array and a table handle are refused, as in Option A (question 10). In a helper there is no `&member` or `%.now`; the entity file passes values, as it already passes `%.today` to helpers.
4. **In memory.** As Option A: no in-memory form, read-only by the three means of Option A, point 4.
5. **Contract.** As Option A, point 5: the optional `query` operation, the `raw-sql` capability, the conformance block, the same Postgres open point. A call against an adapter without the capability fails at run time with a typed error; the build cannot tell, since no entity file names it. (Correction, 2026-11-17: as accepted, `#mesh` exports `query` only when the configured adapter declares `raw-sql`, so a project on an adapter without it fails `tsc`, not at run time; Decision, item 12.)
6. **Results and visibility.** As Option A, point 6, with the schema spelled `query.as(schema)\`…\`` (a Standard Schema; rows untyped otherwise). `mesh explain` prints nothing, since no call is in an entity file; a review must search helpers for `query`, as it searches for `Mesh.privileged`.

**Where it runs outside an action**, and which binding: as Option A. Two projects in one process each have their own `#mesh` and their own `query`, so the binding is never ambiguous.

**Pros:** The most reversible option that ships before 1.0. It changes no entity-file syntax, no closed namespace, no diagnostic list, and it commits nothing about B's spelling: M10 designs the fragment from scratch. It follows ADR-0086's own rule for frame-bound functions. It serves every case A serves, through one helper.
**Cons:** The build cannot place it or check its capability, and `mesh explain` cannot show it. A query must live in a helper, one file away from the rule it serves. All of A's run-time costs: read policies bypassed, stored names and one database's SQL in application code, the read-only enforcement to build. The port does not need it. Unsized.

### Option F: a read-only entity backed by a declared SQL query

A declaration whose rows come from a SQL query instead of a table, for example an entity with a `query=` option in place of `table=`, read-only, its attributes declaring the columns the query returns. The recursive case becomes a "task ancestors" entity whose rows are every (task, ancestor) pair; the cycle check reads it through `Mesh.privileged` with a plain-data filter.

1. **Where.** One declaration per such entity; read like any entity, by its `read` actions and by `Mesh.privileged`.
2. **Spelling.** A new option and a new kind of entity: no actions but reads, no relationships declared from it in the first version.
3. **Parameters.** None: the query is fixed, and the caller narrows the rows with today's plain-data filter. A query that needs a parameter (a recursive walk from one task) must be written over every starting row, which can be slow.
4. **In memory.** None; the rows come from the database.
5. **Contract.** `select` and `count` over a view instead of a table; `mesh db push` creates the view, or the adapter wraps the query as a subquery. The same capability.
6. **Results and visibility.** Typed by the declared attributes and validated as rows. Read policies apply, actor-only (a record-reading one is M10's). Stored names are confined to one declaration per query.

**Pros:** Typed rows, policies apply, stored names in one place, no new run-time function.
**Cons:** The largest language change of all: a new kind of entity, its interplay with relationships, loading, schema push and migrations. It cannot take parameters, so it does not serve "is this task under that one?" efficiently. It needs design work the triage did not foresee. Unsized; the lead guesses larger than A. It could follow any other option later without conflict.

## Trade-off analysis

| | A: entity files and code | B: fragment | C: A, then B | D: raw filter | E: `#mesh` function | F: SQL-backed entity |
|---|---|---|---|---|---|---|
| Ships before 1.0 | yes | only if M10 moves | first half yes | yes | yes | yes |
| Is "like Ash's `fragment`" | no | yes | from M10 | in part | no | no |
| Needs the SQL translator | no | yes | not before 1.0 | no | no | no |
| Language change before 1.0 | `Mesh.sql`, handle `query`, two build errors | none before M10 | A's, plus B's spelling and placement fixed now | a new filter form | none | a new kind of entity |
| Read policies | bypassed | apply | bypassed, then both | apply (those that read no record) | bypassed | apply (actor-only) |
| Stored names in user code | yes | no | yes | columns, yes | yes (helpers) | one declaration |
| Tied to one database's SQL | entity files and code | entity files | both | entity files | application code | entity files |
| Serves a query that returns no entity record | yes | no | yes | no | yes | through a declared entity |
| Size | unsized (triage guessed L for the whole item) | M10's L (roadmap) plus the fragment | unsized now; the fragment with M10 | unsized (author: about M over the shared core) | unsized, smaller than A | unsized, larger than A |

The choice turns on what the move of 2026-10-18 was for, which no record says. If it was "an application must never be stuck for want of SQL", Options A and E answer it completely, and B answers a different question. If it was "a declared read must be able to filter by raw SQL before 1.0", only B or D answers it, and the price of B is ADR-0072's central saving.

**Reversibility.** A, C and E all keep M10 where ADR-0072 put it; none reverses anything. They differ in what they commit. E commits a run-time function and a contract operation, both changeable later with a type check and no entity-file migration. A adds names to the entity-file language that later code relies on. C adds to A a commitment about B's spelling and placement made before the translator is designed. The lead proposes E because it is the least commitment that answers the move: if entity files need the query directly later, A's spelling can be added without breaking anything E allowed, and B stays free for M10 to design. What E gives up is the build's view of the calls (placement, capability and `mesh explain`), which A would have.

The earlier draft of this record proposed C as "the only option that needs no reversal". That reason was wrong: A and E need none either. C is not proposed because what it adds over A is a decision about M10 taken before M10 is designed.

D is not proposed. It buys part of B early by fixing B's design before the translator that B belongs to exists, for a need the port did not show. F is not proposed before 1.0: it is the largest language change, it does not serve parameterised queries, and it can be added after any other option.

Whatever is chosen, two costs are the same and should be accepted knowingly: SQL written by hand is specific to one database, in a framework whose contract otherwise lets a domain run on any adapter with the needed capabilities; and stored names, once users write them, can no longer be changed freely.

## Consequences

With Option E accepted:

- An application can run a query Mesh cannot express, inside Mesh's transaction, from its own code or from a helper that a check, a step or a write policy calls. It cannot change data that way before 1.0.
- A raw query is a second way, beside `Mesh.privileged`, to read without read policies. A review of who can read what must look for both, in helpers as well as in entity files.
- The data-layer contract gains its first operation that carries SQL text, and the capability set its seventh name. Every adapter that follows either implements `raw-sql` or declares that it does not; M9 owes it on Postgres, with the read-only guarantee (question 6).
- Column and table naming rules become something users depend on from 1.0.
- The entity-file language, the `Mesh` namespace and the diagnostic codes do not change; `#mesh` gains one export.
- A declared `filter`, `sort` or record-reading read policy still cannot use SQL before M10. The six passages are corrected to say what ships when, not simply moved to "before 1.0".
- When M10 is designed, it designs the fragment from nothing: spelling, typing, nesting, the SQL-only rule and one text per dialect.

If nothing is accepted, nothing changes: the hatch stays a tracker item with no design, and an application that needs such a query opens its own connection, outside Mesh's transaction.

## Action items

- [ ] Operator: answer questions 1, 7 and 14, and review the lead's acceptance of Option E.
- [x] Lead, 2026-11-17: write the Docs page first ([ADR-0063](./0063-user-docs-first-and-the-hold.md)), from the answers above ([Using your domain: raw SQL queries](../../docs/using-your-domain.md#raw-sql-queries)).
- [ ] Lead: build the function, the operation, the capability, the SQLite implementation with its read-only enforcement, the frame marks and probe-layer forwarding, and the conformance block.
- [x] Lead, 2026-11-17: update the passages that describe the hatch (the roadmap, the vocabulary page, the open-questions page, the data-layer and action-lifecycle pages), with dated amendment notes on ADR-0056 and ADR-0050, whose decision text is not rewritten.
- [x] Lead, 2026-11-17: correct the sentence about fragments in [Ash runtime internals](../research/ash-runtime-internals.md), section 5.5.
- [x] Lead, 2026-11-17: find how `@meshfw/data-sqlite` detects text after the first statement on the prepared path. The adapter's lexer refuses anything after the first statement's `;` but whitespace and comments (one trailing `;` is accepted); the prepared path, which never runs a second statement, stays as a second guard.
- [ ] M9: `raw-sql` on Postgres: the savepoint and `SET LOCAL transaction_read_only` window, the same allow-list, closing the session-level side effects or bringing question 6 back to the operator, and whether a statement carries one text per dialect.
- [ ] M10: whether to add Ash's fragment, and if so its spelling, typing, nesting and in-memory rule.

## Questions for the operator

Accepting this record means answering these. Each carries the lead's proposed answer. On 2026-11-17 the lead accepted Option E and ruled every question but 1, 7 and 14 (Decision); each question below says which it is.

1. **Which feature did the move of 2026-10-18 mean?** A raw query in entity files and code (A), Ash's fragment in translated expressions (B), A now and B with M10 (C), a read's whole filter as SQL (D), a run-time function only (E), or a SQL-backed read-only entity (F). *Proposed: E now; B is weighed when M10 is designed.* **Open for the operator.**
2. **If the answer includes B before 1.0: does M10, or its first half, move before 1.0**, reversing decision D3 of ADR-0072? *Proposed: no.* **Ruled by the lead, 2026-11-17: no.**
3. **May the hatch appear in entity files at all, or only behind helpers and application code?** *Proposed: only behind helpers and application code before 1.0 (E). A direct form can be added later without breaking anything.* **Ruled by the lead, 2026-11-17: as proposed.**
4. **How is it spelled?** (a) `query`, a tag exported by the generated `#mesh` and bound to the project's frame, as `transaction` and `published` are; (b) an entity-anchored handle, `Mesh.privileged(Task).query(Mesh.sql\`…\`)`, which reaches the frame through the entity value and works in entity files; (c) a method of the binding, `binding.query`, which a check or a helper does not hold. A plain `Mesh.query` is not offered: a member of `Mesh` cannot find the running transaction or tell two projects' bindings apart (ADR-0086). Handing out Drizzle's own `sql` and transaction handle is also possible; the lead proposes not to, since a query-library type would cross the contract. *Proposed: (a), with `query.as(schema)` for typed rows.* **Ruled by the lead, 2026-11-17: (a), with `query.as(schema)`.**
5. **Queries only, or writes too?** *Proposed: queries only before 1.0. A raw write would skip checks, policies, seams and events, and a `Mesh.can` question must be unable to write. The adapter enforces it by a leading-keyword allow-list, `PRAGMA query_only` and a check afterwards that the transaction is still open.* **Ruled by the lead, 2026-11-17: queries only (Decision, item 5).**
6. **May the read-only guarantee weaken per adapter, or is `raw-sql` refused on any adapter that cannot keep it?** This matters for Postgres, where the record does not know how to keep it inside a transaction that has written. *Proposed: it does not weaken; an adapter that cannot keep it does not declare `raw-sql`. If Postgres cannot, M9 brings it back to the operator before merging, since the capability rule would then need an exception.* **Ruled by the lead, 2026-11-17: never weakens on SQLite; on Postgres, M9 closes the session-level side effects or brings this question back to the operator before declaring `raw-sql` (Decision, item 6).**
7. **Is it accepted that a raw query bypasses read policies**, and is therefore allowed exactly where `Mesh.privileged` is and nowhere else? *Proposed: yes.* **Open for the operator.** The proposed yes is in force provisionally for Option E.
8. **Which binding and which transaction does it use outside an action?** *Proposed: the binding in scope, else the connected one, as a `privileged` read. Inside a transaction (an action, an application `transaction`, a handler's `process` body) it joins it; outside one (application code, `beforeTransaction`, `afterCommit`, a handler's `listen` body) it opens its own through the data layer, which on SQLite is a queued `BEGIN IMMEDIATE`, never a read that bypasses the queue.* **Ruled by the lead, 2026-11-17: as proposed.**
9. **Are results returned as stored**, typed `unknown` unless a Standard Schema is passed, and are `Date` and boolean parameters converted by the adapter? *Proposed: yes.* **Ruled by the lead, 2026-11-17: yes, with rows frozen, integers exact and a duplicate column name refused (Decision, item 9).**
10. **What may be interpolated besides a value?** An array, for `in (…)`; a table or column handle from `tables`, rendered as an escaped name, which would move a rename's breakage to type checking. *Proposed: neither in the first version: an array or an object is refused, never expanded or bound as `NULL`; on SQLite a list is passed as JSON and read with `json_each`. Either can be added later without breaking a statement, since both are refused now.* **Ruled by the lead, 2026-11-17: neither (Decision, item 10).**
11. **May Mesh's own tables be read** (`mesh_outbox`, `mesh_outbox_state`, `mesh_handler_progress`, `mesh_subscription_progress`)? *Proposed: they are not refused, because refusing them would mean parsing SQL; the Docs page says they are not a stable interface. An application's own entities, such as Hyper's `audit.Idempotency`, are ordinary tables.* **Ruled by the lead, 2026-11-17: as proposed.**
12. **Does the data-layer contract gain an optional `query` operation and the capability `raw-sql`**, with the sentence that forbids SQL strings changed to allow this one operation, and with statements specific to one database until M9 decides otherwise? *Proposed: yes.* **Ruled by the lead, 2026-11-17: yes.**
13. **Does a failed raw statement fail the running transaction even when the caller catches the error**, as a failed joined call does, with no adapter recovering through a savepoint? *Proposed: yes.* **Ruled by the lead, 2026-11-17: yes.**
14. **Do stored names become a compatibility surface from 1.0**: a column named as its attribute, a relationship's column, the table name? *Proposed: yes; it is the cost of any raw SQL.* **Open for the operator.** The proposed yes is in force provisionally for Option E.
15. **If B is taken up with M10: is a fragment SQL-only**, a build error wherever its expression would be evaluated in memory? The alternatives are that the author supplies an in-memory form too, or that it is unknown in memory as in Ash. *Proposed: SQL-only; to be confirmed when M10 is designed.* **Ruled by the lead, 2026-11-17: SQL-only, to be confirmed by M10's design.**
