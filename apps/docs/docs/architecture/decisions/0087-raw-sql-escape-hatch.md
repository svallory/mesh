---
title: "0087. The raw-SQL escape hatch: what ships before 1.0"
description: "Decision record 0087: four designs for the raw-SQL escape hatch, why 'like Ash's fragment' and 'before 1.0' cannot both hold as written, and the questions the operator must answer. Status: Proposed."
---

# 0087. The raw-SQL escape hatch: what ships before 1.0

## Status

Proposed. Nothing is built from this record until the operator accepts it.

## Date

2026-11-14

## Deciders

operator. The questions at the end are language questions, which the lead does not rule. Proposed by the lead under its ruling D24 (run of 2026-11-14, in the lead's ruling log `notes/decisions.md`, which is outside this site): "This run writes a design for the raw-SQL escape hatch as a proposed ADR in a pull request left open for the operator; nothing is built from it until the operator accepts it." Every recommendation below is the lead's proposal, not a ruling.

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

On 2026-10-18 the operator moved the hatch before 1.0. That move is recorded in two places only, both outside this site: the tracker item `mesh-raw-sql-escape-hatch` ("Moved before 1.0 by the operator on 2026-10-18 … Its design is not written yet: where it may appear (filters, read policies, rollups), how it binds parameters, how it relates to SQL translation, which comes in M10, after 1.0. Design first, then build.") and one line of the language spec notes, `notes/spec/expressions.md` ("A raw-SQL escape hatch comes before 1.0. Not built."). Neither holds the operator's words, and neither says which feature was meant. The six passages above are still to be updated; the tracker item `mesh-docs-scope-2026-10-18` owns that.

### What Ash's `fragment` is

This section is taken from Ash's published documentation, read on 2026-11-14 (Ash 3.37.4, AshPostgres 2.15.2, AshSqlite 0.3.1), not from memory. (Ash also uses the word "fragment" for a shared piece of resource DSL, such as the one every Hyper resource includes, [gap analysis](../research/hyper-port-gap-analysis.md), section 1. That is another feature and is not meant here.)

A `fragment` is SQL written **inside an expression**, with `?` slots filled by other expressions. The [Expressions guide](https://hexdocs.pm/ash/expressions.html) says: "Fragments come in two forms. For SQL/query-backed data layers, they will be a string with question marks for interpolation. For example: `fragment("(? + ?)", foo, bar)`. For elixir-backed data layers, they will be a function or an MFA that will be called with the provided arguments." The [AshPostgres guide](https://hexdocs.pm/ash_postgres/expressions.html) shows a whole subquery in one: `fragment("points > (SELECT SUM(points) FROM games WHERE user_id = ? AND id != ?)", user_id, id)`, and calls that "a last resort". The [AshSqlite guide](https://hexdocs.pm/ash_sqlite/expressions.html) says the same for SQLite.

Three facts about it matter here:

1. **It lives where expressions live.** [`Ash.Query`](https://hexdocs.pm/ash/Ash.Query.html), under "Escape Hatches": "Fragments only barely count as an escape hatch. … You can use data-layer-specific expressions in your expressions for filters, calculations, etc." A slot filled with an attribute becomes a column of the row being considered; the data layer writes the surrounding query.
2. **The string form cannot run in memory.** In Ash's source, [`Ash.Query.Function.Fragment`](https://github.com/ash-project/ash/blob/v3.37.4/lib/ash/query/function/fragment.ex) evaluates a function or an MFA and answers `:unknown` for everything else. Our [Ash runtime internals](../research/ash-runtime-internals.md) page, section 5.5, says of fragments that "both can be evaluated in-memory too"; that is wrong for the string form, and an action item below corrects it. Ash's answer for an expression that needs both forms is another feature, [`Ash.CustomExpression`](https://hexdocs.pm/ash/Ash.CustomExpression.html), where the author writes one expression per data layer ("It is good practice to always define an expression for `Ash.DataLayer.Simple`").
3. **It is the lowest rung of a ladder.** `Ash.Query` lists its escape hatches "in the order that you should prefer them", the least powerful first. The [research synthesis](../research/synthesis.md) counted this ladder among Ash's strengths ("Escape hatches are layered and real").

| Ash's rung | What it is | What Mesh has |
|---|---|---|
| String `fragment` | SQL inside an expression the data layer translates | Nothing. It needs SQL translation, which is M10 |
| Function `fragment` | A function called with the arguments, for data layers written in Elixir | Already there: a function body in an entity file that is not one expression runs in memory as plain code ([ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md)) |
| `Ash.CustomExpression` | A named expression with one form per data layer | Nothing. [ADR-0010](./0010-one-expression-tree-two-evaluators.md) keeps the rule for later: "extension-supplied functions must bring both forms" |
| [Manual read action](https://hexdocs.pm/ash/manual-actions.html), `modify_query` | Replace how a read is performed, or edit the query before it runs | Not planned ([roadmap](../roadmap/roadmap.md), section 6: "Not planned at all … manual and generic actions") |
| "Using Ecto directly" | Query the tables with the query library, beside Ash: "every `Ash.Resource` is an `Ecto.Schema`" | Nothing inside Mesh's transaction. An application can open a second connection of its own, which sees nothing the running transaction has not committed |

### The conflict

Every passage that describes the hatch says "like Ash's `fragment`": SQL inside a translated expression. Mesh translates no expression to SQL before M10, and M10 is after 1.0 ([ADR-0072](./0072-mesh-1-0-is-the-port-gate.md), decision D3: "The SQL evaluator, `translate-or-error` on filters, sorts and policies, SQL for rollups" are "after 1.0 (M10)"). Until then a declared `filter` or `sort` on a read, and a read policy that reads the record, are "a build or run-time error that names the milestone, never an in-memory scan" ([roadmap](../roadmap/roadmap.md), principle 2). A probe on `main` (commit `be9f6ee`) confirms it: such a read policy fails with `MESH_NOT_IMPLEMENTED` naming M10.

So before M10 there is no translated expression for a fragment to sit in. "Before 1.0" can only mean one of three things:

1. **A different feature under the same name**: SQL run from plain code, which is Ash's top rung ("using Ecto directly"), not its fragment. Option A.
2. **Ash's feature, with M10 moved before 1.0.** Option B. That reverses decision D3 of ADR-0072, which the roadmap calls "the largest single saving of the revision" (M4, "What moved, and why"); M10 is sized L in the roadmap's section 6.
3. **The one piece of Ash's feature that needs no translator**: a read's whole filter written as SQL. Option D.

Option C is the first now and the second when M10 comes.

### What else bears on the choice

- **The port does not need raw SQL.** The roadmap's principle 10 has two halves: "no new construct is added before the port unless the port needs it, and as many planned constructs as possible are added before 1.0". The Hyper port in `examples/hyper` passes conformance groups 01 to 09 (`examples/hyper/conformance/README.md`) with no SQL of its own: on `main` at `be9f6ee`, nothing under `examples/hyper/src` imports Drizzle or `bun:sqlite` or holds a SQL template. The roadmap gives the reason: "Hyper's reads are served by plain-data filters; its five `exists` calculations are in-memory computed fields" (section 6). So only the second half of the principle, and the operator's move, argue for building this before 1.0.
- **The data-layer contract forbids it today.** "No query-library type or SQL string crosses the contract; a filter is plain data", and "`runtime` imports no Drizzle" ([data layer](../in-depth/data-layer.md)). `DataOperations` in `packages/runtime/src/data-layer.ts` has `insert`, `select`, `selectByKey`, `selectByKeyForUpdate`, `updateByKey`, `deleteByKey`, `max`, `count` and the optional outbox operations, and nothing that takes SQL.
- **The `Mesh` namespace is closed.** It is one frozen object ([ADR-0086](./0086-entity-values-privileged-barrels-and-fqns.md)); a member it does not have is the build error `MESH_UNKNOWN_MESH_FUNCTION`. Adding a member is a language change.
- **Raw SQL bypasses access rules in the one framework we studied that has both.** ZenStack: "Raw SQL queries executed via `$executeRaw()` and `$queryRaw()` are not subject to access control enforcement" ([expression language research](../research/expression-language.md), section 3.3). The same page concludes that an escape hatch "must be named as local-only in the type and the docs" when it cannot be pushed down; the mirror rule, for one that can only run in the database, is question 6 below.
- **Mesh's in-memory evaluator "is never a fallback for a missing database capability"** ([expressions](../in-depth/expressions.md)).

### What the code does today

Four probes were run for this record on 2026-11-14, against `main` at `be9f6ee` with Bun 1.4.2. They are small scripts kept outside the repository; each result below can be reproduced by building the named entity file with `buildModel` from `packages/compiler`, or by running the named statements on `bun:sqlite`.

- `Mesh.sql` written in a computed field or a check is a build error, `MESH_UNKNOWN_MESH_FUNCTION`. The file parses: MX hands Mesh the function as a syntax tree, and a tagged template is one node with its text pieces and its `${…}` expressions apart.
- A tag **imported from a project module** already builds, in a check and in a computed field, with no diagnostic. The body is classified as plain code (reason: "a tagged template literal"). Inside its `${…}`, `&title` is rewritten to the record's in-memory value and `%.now` to the transaction's instant. So in plain code an interpolated member is a **value**, not a column.
- SQLite, inside an open write transaction: `PRAGMA query_only = ON` lets a select see the transaction's uncommitted rows and makes an insert or update fail ("attempt to write a readonly database"); after `PRAGMA query_only = OFF` the same transaction writes again. The [SQLite documentation](https://www.sqlite.org/pragma.html#pragma_query_only) describes the pragma: "any attempt to CREATE, DELETE, DROP, INSERT, or UPDATE will result in an SQLITE_READONLY error."
- `bun:sqlite` has three silent behaviours an adapter must not pass on: a `Date` or an object given as a parameter is bound as `NULL`; a text holding two statements runs the first and drops the second (`select 1; delete from t` deletes nothing); and a failed statement leaves the transaction open and usable.

## Decision

Not decided. The operator rules, by answering the questions at the end.

The lead proposes **Option C**: before 1.0, a read-only raw query called from plain code (Option A), spelled `Mesh.sql` and `Mesh.query`; with M10, the same tag inside a translated expression (Option B), which is what "like Ash's `fragment`" means. M10 does not move. The names `Mesh.sql`, `Mesh.query`, `raw-sql`, `MESH_SQL_FORM` and `MESH_SQL_PLACEMENT` are proposals; none exists.

## Options considered

Each option answers the same six questions:

1. **Where** it may appear: a read's filter, a sort key, a read policy, a rollup or computed field, a `set` value, a check, or only plain code.
2. **How it is spelled** in an entity file, which is static and which Mesh never reads as text.
3. **How parameters bind** (`&member`, `input`, `actor`, `%.now`) and what prevents building SQL by string interpolation.
4. **What happens in memory**: a check on a new instance, a `Mesh.can` question, a loaded computed field.
5. **What changes in the data-layer contract**: operations, the closed capability set, conformance checks, the rule that Drizzle is imported only under `packages/data-*`, SQLite now and Postgres in M9.
6. **Results and visibility**: result types, table and column names, read policies, `mesh explain`, errors.

### Option A: a raw query called from plain code, before 1.0

`Mesh.sql` is a template tag that returns a statement: the text pieces and the values, kept apart and frozen. `Mesh.query(statement)` runs it and returns rows. This is not Ash's fragment; it is Mesh's form of "using Ecto directly", inside Mesh's transaction.

The first check below holds the query in the entity file; the second calls a helper that holds it.

```mx "src/domain/work/task.mesh.mx (excerpt; illustration of Option A, not valid today)"
check :titleFree [
  that=async ({ input }) => (await Mesh.query(Mesh.sql`select 1 from tasks where lower(title) = lower(${input.title}) and id <> ${&id} limit 1`)).length === 0
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

export async function underItself(task: string, newParent: string | null): Promise<boolean> {
  if (newParent === null) return false;
  const rows = await Mesh.query(Mesh.sql`
    with recursive up(id) as (
      select ${newParent}
      union all
      select t."parentId" from tasks t join up on t.id = up.id
    )
    select 1 from up where id = ${task} limit 1`);
  return rows.length > 0;
}
```

1. **Where.** Exactly where `Mesh.privileged` may be called, and nowhere else: a `run` step, a plain `set` value, a check, a write policy's plain code ([ADR-0074](./0074-write-policies-may-read-through-tx.md)), the helpers those call, and application code inside or outside `transaction`. Not in a read's `filter` or `sort`, a read policy, a rollup or a computed field. Reusing one existing rule matters because it adds no new placement rule to learn or to enforce: the build errors and the run-time frame marks that stop `Mesh.privileged` in a computed field or a read policy ([action lifecycle](../in-depth/action-lifecycle.md), "Where `Mesh.privileged` may not run") stop this too.
2. **Spelling.** `Mesh.sql` followed by a template, and `Mesh.query(…)`, written in a function body. The function is plain code as a whole, as the probe shows for an imported tag, so the build translates nothing; it adds the two names to the `Mesh` namespace and checks that `Mesh.sql` is used only as a tag (`MESH_SQL_FORM`) and only in an allowed place (`MESH_SQL_PLACEMENT`).
3. **Parameters.** Every `${…}` is a bound parameter, never text. In plain code `&member` is the record's in-memory value, `input` and `actor` are values and `%.now` is a `Date`, so each is bound as a value; a column is named in the SQL text. Four things prevent string interpolation: no Mesh function takes SQL as a string; `Mesh.query` accepts only a statement the tag made; there is no `raw()` (Drizzle has one, which "allows you to include raw SQL statements … without any additional processing or escaping", [Drizzle documentation](https://orm.drizzle.team/docs/sql)); and statements compose by interpolating one statement into another. This stops accidents, not intent: code that forges the array a template tag receives can still pass text, and TypeScript cannot prevent that. The adapter converts a boolean and a `Date` to the stored form and refuses any value it cannot bind; it must never bind `NULL` silently as `bun:sqlite` does.
4. **In memory.** A raw query is not an expression of the tree, so the two-evaluator promise of [ADR-0010](./0010-one-expression-tree-two-evaluators.md) does not apply: there is nothing to evaluate in memory, and it always goes to the database. A check on a create runs before the insert, so the query does not see the new row, and `&member` there is the new instance Mesh builds before the member inputs ([ADR-0053](./0053-validate-then-do.md), amendment of 2026-10-11); a query that needs the caller's value interpolates `input`. A `Mesh.can` or `Mesh.checkPolicies` question "writes nothing" ([action lifecycle](../in-depth/action-lifecycle.md), "Permission questions") but does run write policies, so a raw statement reached through one must be unable to write: the operation is read-only by contract and the adapter enforces it (on SQLite with `PRAGMA query_only`, which the probe shows works inside an open transaction). A computed field cannot call it: computed bodies are synchronous (`MESH_COMPUTED_ASYNC`).
5. **Contract.** One optional operation, `query(statement)`, on the transaction's operations; the statement is plain data, and the adapter writes the placeholders, so `?` against `$1` never reaches the author. A seventh name, `raw-sql`, joins the closed set `CAPABILITIES`; `@meshfw/data-sqlite` declares it. A direct call in an entity file built against an adapter without it is `MESH_CAPABILITY`; a call from a helper or from application code fails at run time with a typed error. The sentence "No query-library type or SQL string crosses the contract" changes: SQL text crosses in this one operation, and still no query-library type. The Drizzle rule ([ADR-0014](./0014-sql-adapters-on-drizzle.md)) does not change: the tag lives in `@meshfw/runtime` and builds plain data; rendering is the adapter's. Handing out Drizzle's own `sql` and transaction handle is rejected: a query-library type would cross the contract, and it would not be Mesh's transaction, since "Drizzle's `bun-sqlite` driver runs transactions synchronously … So `@meshfw/data-sqlite` runs them itself" ([data layer](../in-depth/data-layer.md)). A conformance block, run only for adapters that declare `raw-sql` as `outboxConformance` is for the outbox, checks that a value is bound and not spliced; that the statement runs inside the running transaction, in call order, and sees its uncommitted rows; that a write is refused and the transaction still writes afterwards; that a value that cannot be bound is refused, never null; that a boolean and a `Date` round-trip; and that a refused statement raises the raw-SQL error. One statement per call is part of the contract; how `@meshfw/data-sqlite` detects text after the first statement is not checked. **Postgres**: the capability rule ([data layer](../in-depth/data-layer.md), "The capability rule across parallel milestones") obliges M9 to implement `raw-sql` on Postgres the day it merges. SQL text and stored values differ per database, so an application that changes adapter rewrites its raw statements; whether a statement may carry one text per dialect is M9's to decide, as is how Postgres refuses a write inside a transaction that has already written, which this record has not checked.
6. **Results and visibility.** Rows are plain objects with **stored** values, not attribute values: on SQLite a `datetime` comes back as an integer of milliseconds and a `boolean` as 0 or 1 ([data layer](../in-depth/data-layer.md), storage types). The type is `readonly Record<string, unknown>[]` unless the caller passes a Zod schema as the second argument, which validates and types each row (Zod is a direct dependency, [ADR-0062](./0062-direct-dependencies-zod-drizzle-opentelemetry.md)). There is no bare type argument, because a type nobody checks is the opposite of what Mesh is for; Drizzle says of its own: "`sql<T>` does not perform any runtime mapping". **Names**: the author writes stored names, so they become a compatibility surface from 1.0: the table is the `table=` value or `snake_case(Name)` ([ADR-0086](./0086-entity-values-privileged-barrels-and-fqns.md)), a column "is named exactly like its attribute", and a relationship has its own column (`belongs-to :parent` is `parentId` in the Hyper example's schema). A rename in an entity file breaks a raw statement at run time, not at build; accepting a table handle from `tables` as an interpolation, rendered as an escaped name, would move that to type checking and is left to the Docs page. Mesh's own tables can be read too and are not a stable interface. **Read policies do not apply**: a raw query returns what the SQL selects, the standing a `Mesh.privileged` read has, which is why it is allowed only where that is. **`mesh explain`** prints one `raw sql` line per call written in the entity file, with the text and a `?` for each parameter; a call inside a helper is not printed, because the build does not read helpers. **Errors**: the two build errors above and `MESH_CAPABILITY`; at run time a `FrameworkError` that names the reason and carries the database's error as `cause`, and never a parameter value, since values may be personal data. A failed raw statement fails the running transaction even when the caller catches it, as a failed joined call does today ([action lifecycle](../in-depth/action-lifecycle.md), "A call that fails fails the transaction"); on SQLite Mesh must mark it itself, and on Postgres the database already behaves so: "a statement in a transaction block that generates an error aborts the entire transaction" ([PostgreSQL 18 documentation](https://www.postgresql.org/docs/current/app-psql.html), `ON_ERROR_ROLLBACK`).

**Pros:** Ships before 1.0 without touching M10; the triage brief (`notes/triage-2026-11-14/mesh-raw-sql-escape-hatch.json`, outside this site) sizes it L and calls that a guess until the design exists. Follows principle 11, "plain code is a first-class answer". Gives applications what they cannot do at all today: a query Mesh cannot express, inside Mesh's transaction.
**Cons:** It is not the feature the six passages describe: a read's filter, sort or policy still cannot use SQL. It bypasses read policies, so reading the policies no longer tells the whole story of who can read what. Stored names and one database's SQL enter application code. It adds two members to a namespace that was closed on purpose. The port does not need it.

### Option B: Ash's fragment, inside translated expressions

The same tag, written inside a one-expression arrow, becomes a node of the expression tree. This is the feature the six passages name.

```mx "src/domain/work/task.mesh.mx (excerpt; illustration of Option B, not valid today)"
read :titled
  filter=({ input }) => Mesh.sql`lower(${&title}) like ${input.pattern}`
```

1. **Where.** The positions M10 evaluates in SQL ([ADR-0072](./0072-mesh-1-0-is-the-port-gate.md)): a read's `filter`, a `sort` key, a read policy that reads the record, a rollup, a computed field used by any of those, and a `set` value only where M10 makes the update one statement. Not a check or a write policy, which run in memory on the record.
2. **Spelling.** The tag as the body, or part of the body, of a one-expression arrow. The build turns it into a `fragment` node: the text pieces and one expression per `${…}`. Its type comes from the position (a filter is a boolean; a computed field declares its type). A fragment nested in a larger expression has no declared type; M10 must either require one or refuse nesting.
3. **Parameters.** Each `${…}` is an expression of the language, lowered by M10: `&member` becomes a **column** of the row being considered; `input`, `actor` and `context` are "evaluated once in memory before the query and bound as a parameter" ([ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md), "parameters, never closures"); `%.now` is the transaction's instant, bound. A captured variable is already a build error there. String interpolation is prevented as in Option A.
4. **In memory.** A SQL fragment has no in-memory form; Ash's answers `:unknown`. Three rules are possible. (i) **SQL-only**: a build error wherever the expression that holds it would be evaluated in memory. (ii) **Two forms**: the author also writes an in-memory form, as `Ash.CustomExpression` asks. (iii) **Unknown in memory**, as Ash does. The lead proposes (i) and rejects (iii), because the two evaluators would then disagree silently, which principle 2 ("No silent fallback") and ADR-0010 exist to prevent. Under (i), whether a computed field holding a fragment can be loaded depends on whether M10 computes loaded fields in SQL, which is not designed.
5. **Contract.** Everything M10 needs: today "a filter is plain data", and M10 must carry an expression across the contract and compile it under `packages/data-*`. The fragment adds one node that carries SQL text. An entity file that holds one builds only against an adapter with the capability, and it is tied to one database's SQL, which the shared function tables exist to avoid. Conformance can check binding, column rendering and the refusal in memory, not arbitrary SQL.
6. **Results and visibility.** Rows stay entity records, typed as today, because a fragment changes a condition, a sort key or a computed value, never the shape of the result. Columns come from `&member`, so a rename is a build error and no stored name is exposed unless the author writes one in the text. **Read policies apply in full**: the fragment is inside the read. `mesh explain`, which today "prints a plan, not SQL" ([command line](../../docs/command-line.md)), prints the fragment's text in the filter line. Until M10 it is `MESH_NOT_IMPLEMENTED` naming M10 ([ADR-0018](./0018-not-implemented-is-a-build-error.md)), as a declared filter is today.

**Pros:** It is what was planned and what "like Ash's `fragment`" says. It stays inside reads and policies: no bypass, typed records, renames caught at build.
**Cons:** It cannot ship before 1.0 unless M10, or its first half, moves before 1.0. That reverses decision D3 of ADR-0072 and undoes the largest saving of roadmap revision 5; the triage brief says it "either pulls M10 before 1.0 or cannot ship before 1.0". The roadmap's own trigger for moving M10 in is the port finding declared filters indispensable (M4, risks: "If that proves unacceptable, M10's first half moves in"), and the port passed without them. It also does nothing for the cases Option A serves: a query whose result is not an entity record.

### Option C: Option A before 1.0, Option B with M10 (the lead's proposal)

One tag, two homes. Before 1.0, `Mesh.sql` is accepted in plain code only (Option A, in full). In an expression position it is `MESH_NOT_IMPLEMENTED` naming M10, so allowing it later breaks no file. With M10, the tag is also accepted inside a translated expression (Option B, with the SQL-only rule).

The six answers are Option A's before 1.0 and Option B's from M10. Three things are shared and built once: the tag and the statement value, the `raw-sql` capability, and the binding checks of the conformance block.

**Pros:** Honours both the move of 2026-10-18 and the wording "like Ash's `fragment`", without moving M10. Each half can be judged alone: accepting this record commits only the first; the second is confirmed or changed when M10 is designed.
**Cons:** The same text means two things: `${&title}` is the record's value in plain code and the column in a translated expression. The form already decides which rules apply ([ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md)), so this follows an existing rule, but it will surprise. Between 1.0 and M10, authors will use the bypassing form for filters the policy-respecting form would have served, and that code stays. All the costs of Option A.

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
5. **Contract.** The plain-data query that `select` and `count` take gains a raw condition, combined by AND with the caller's filter, and raw sort keys; the same capability. The generated read needs a new path: today a read with a declared filter throws, naming M10.
6. **Results and visibility.** Entity records. Read policies that do not read the record still run; those that do stay with M10. Stored column names are exposed, as in Option A. `mesh explain` prints the text.

**Pros:** Before 1.0, a declared read can filter by something plain-data filters cannot say, and the policies still apply.
**Cons:** It fixes the surface of Option B (the tag in a filter, how it combines with the caller's filter, limits and `on:load`) before M10 is designed, and M10 then gives the same position a second meaning by allowing `&member`. The port serves its four declared-filter reads with the caller's filter and does not need it. It does nothing for a query whose result is not an entity record. Size: the record's author estimates M on top of Option A's contract work; no triage sized it.

## Trade-off analysis

| | A: plain code | B: fragment | C: A, then B | D: raw filter |
|---|---|---|---|---|
| Ships before 1.0 | yes | only if M10 moves | first half yes | yes |
| Is "like Ash's `fragment`" | no | yes | from M10 | in part |
| Needs the SQL translator | no | yes | not before 1.0 | no |
| Read policies | bypassed | apply | bypassed, then both | apply (those that read no record) |
| Stored names in user code | yes | no | yes | columns, yes |
| Tied to one database's SQL | application code | entity files | both | entity files |
| Serves a query that returns no entity record | yes | no | yes | no |
| Size | L (the triage's guess) | M10's L (roadmap) plus the fragment | L now; the fragment with M10 | A plus M (author's estimate) |

The choice turns on what the move of 2026-10-18 was for, which no record says. If it was "an application must never be stuck for want of SQL", Option A answers it completely, and B answers a different question. If it was "a declared read must be able to filter by raw SQL before 1.0", only B or D answers it, and the price of B is ADR-0072's central saving.

The lead proposes C because it is the only option that needs no reversal: it keeps the move, keeps the planned feature under its planned name, and keeps M10 where ADR-0072 put it. What it gives up is honesty of naming before M10: what ships under "raw-SQL escape hatch" at 1.0 is not what the six passages describe, and the docs must say so plainly.

D is not proposed. It buys part of B early by fixing B's design before the translator that B belongs to exists, for a need the port did not show.

Whatever is chosen, two costs are the same and should be accepted knowingly: SQL written by hand is specific to one database, in a framework whose contract otherwise lets a domain run on any adapter with the needed capabilities; and stored names, once users write them, can no longer be changed freely.

## Consequences

If Option C is accepted as proposed:

- An application can run a query Mesh cannot express, inside Mesh's transaction, from a check, a step, a write policy or its own code. It cannot change data that way before 1.0.
- A raw query is a second way, beside `Mesh.privileged`, to read without read policies. A review of who can read what must look for both.
- The data-layer contract gains its first operation that carries SQL text, and the capability set its seventh name. Every adapter that follows either implements `raw-sql` or declares that it does not; M9 owes it on Postgres.
- Column and table naming rules become something users depend on from 1.0.
- `Mesh` gains two members.
- A declared `filter`, `sort` or record-reading read policy still cannot use SQL before M10. The six passages are corrected to say what ships when, not simply moved to "before 1.0".
- When M10 is designed, it inherits a tag and a statement value, and must settle fragment typing, nesting, the SQL-only rule and one text per dialect.

If nothing is accepted, nothing changes: the hatch stays a tracker item with no design, and an application that needs such a query opens its own connection, outside Mesh's transaction.

## Action items

- [ ] Operator: answer the questions below.
- [ ] Lead, once accepted: write the Docs page first ([ADR-0063](./0063-user-docs-first-and-the-hold.md)), including how a list is passed for `in (…)` and whether a table handle may be interpolated; then build the tag, the operation, the capability, the SQLite implementation, the conformance block and the `mesh explain` line.
- [ ] Lead, once accepted: update the six passages through the tracker item `mesh-docs-scope-2026-10-18`, with dated amendment notes on ADR-0056 and ADR-0050, whose decision text is not rewritten.
- [ ] Lead: correct the sentence about fragments in [Ash runtime internals](../research/ash-runtime-internals.md), section 5.5.
- [ ] Lead, during the build: find how `@meshfw/data-sqlite` detects text after the first statement, and refuse it.
- [ ] M9: `raw-sql` on Postgres, the read-only guarantee inside a transaction that has written, and whether a statement carries one text per dialect.
- [ ] M10: the `fragment` node, its typing and nesting, and the SQL-only rule.

## Questions for the operator

Accepting this record means answering these. Each carries the lead's proposed answer.

1. **Which feature did the move of 2026-10-18 mean?** A raw query from plain code (A), Ash's fragment in translated expressions (B), A now and B with M10 (C), or a read's whole filter as SQL (D). *Proposed: C.*
2. **If the answer includes B before 1.0: does M10, or its first half, move before 1.0**, reversing decision D3 of ADR-0072? *Proposed: no.*
3. **Queries only, or writes too?** *Proposed: queries only before 1.0. A raw write would skip checks, policies, seams and events, and a `Mesh.can` question must be unable to write.*
4. **Is the spelling `Mesh.sql` as a template tag plus `Mesh.query(statement, schema?)`**, two new members of the closed `Mesh` namespace? The alternatives are awaiting the template directly, with no `query`, or handing out the adapter's own handle. *Proposed: yes, as written.*
5. **Is it accepted that a raw query bypasses read policies**, and is therefore allowed exactly where `Mesh.privileged` is and nowhere else? *Proposed: yes.*
6. **With M10, is a fragment SQL-only**, a build error wherever its expression would be evaluated in memory? The alternatives are that the author supplies an in-memory form too, or that it is unknown in memory as in Ash. *Proposed: SQL-only.*
7. **Are results returned as stored**, typed `unknown` unless a schema is passed, and are `Date` and boolean parameters converted by the adapter? *Proposed: yes.*
8. **Does the data-layer contract gain an optional `query` operation and the capability `raw-sql`**, with the sentence that forbids SQL strings changed to allow this one operation, and with statements specific to one database until M9 decides otherwise? *Proposed: yes.*
9. **Does a failed raw statement fail the running transaction even when the caller catches the error**, as a failed joined call does? *Proposed: yes.*
10. **Do stored names become a compatibility surface from 1.0**: a column named as its attribute, a relationship's column, the table name? *Proposed: yes; it is the cost of any raw SQL.*
