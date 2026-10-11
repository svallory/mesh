---
title: "Data layer: contract and capabilities"
description: "The data-layer contract, declared capabilities, the conformance suite and the SQL adapters on Drizzle."
---

# Data layer: contract and capabilities

Status: contract v1 is implemented in the run-time library (M3, with filters, sort, paging, re-entrant transactions, key fill and the capability manifest; contract v0 came in M2, [PR #20](https://github.com/svallory/mesh/pull/20)). The SQLite adapter, its schema generator and `mesh db push` are merged (M2, task `m2-data`, PR #53), reimplemented from the held [PR #22](https://github.com/svallory/mesh/pull/22) under the documented names. The build reads the capability manifest from M3; Postgres and migrations arrive in M9 ([roadmap](../roadmap/roadmap.md)).

::: callout info "What the code does today"
`@meshfw/runtime` and its testing entry `@meshfw/runtime/testing` ([ADR-0060](../decisions/0060-meshfw-package-scope.md)) hold the data-layer contract v1, the `DataAdapter` descriptor type, `defineConfig` and the conformance suite. `@meshfw/data-drizzle` holds the operations shared by SQL adapters. `@meshfw/data-sqlite` has two entries: the main one, `sqlite({ file })` and `createSchema(db, tables)`, and `@meshfw/data-sqlite/build`, the schema generator and `mesh db push`. Generated action functions call the contract through `bind(layer)`, and `connect()` binds the layer `mesh.config.ts` configures ([PR #54](https://github.com/svallory/mesh/pull/54)); `close()` releases the connection and a later transaction reopens it, so `disconnect()` then `connect()` reuses that one layer.
:::

The data layer stores and fetches records. Related: [overview](../overview/architecture.md), [three rings](./three-rings.md), [expressions](./expressions.md), [action lifecycle](./action-lifecycle.md), [generated code and the guard](./generated-code-and-guard.md).

## Why the contract is Mesh's own

A contract that covers Drizzle, Kysely, TypeORM and Prisma can cover select, insert, update, delete, transactions and raw SQL. Filters, joins and aggregates have four different shapes there, and relation loading, schema ownership, migrations and pooling cannot be covered. So the contract is Mesh's own, at the level of entities, as Ash's is. The query library inside an adapter is that adapter's private choice ([research synthesis](../research/synthesis.md), section 11; [ADR-0013](../decisions/0013-data-layer-contract-and-capabilities.md)).

The contract and its query and expression-tree types live in `runtime`, which a deployed program carries. `runtime` imports no Drizzle ([roadmap](../roadmap/roadmap.md), section 3 and M3, test 5; [ADR-0033](../decisions/0033-core-split-build-time-run-time.md)).

## Contract v1 (M3)

The run-time library exports this deliberately small contract for generated action functions and adapters. Operations exist only inside `transaction`; a handler always opens one.

```ts "packages/runtime/src/data-layer.ts"
export type Row = Record<string, unknown>;
export type Key = Readonly<Record<string, unknown>>;
export type TableHandle = object;

export interface DataOperations {
  insert(table: TableHandle, row: Row): Promise<Row>;
  selectByKey(table: TableHandle, key: Key): Promise<Row | undefined>;
  selectByKeyForUpdate(table: TableHandle, key: Key): Promise<Row | undefined>;
  select(table: TableHandle, query?: Query): Promise<Row[]>; // { filter, sort, limit, offset }
  updateByKey(table: TableHandle, key: Key, changes: Row): Promise<Row | undefined>;
  deleteByKey(table: TableHandle, key: Key): Promise<boolean>;
  max(table: TableHandle, attribute: string, filter?: Filter): Promise<Scalar | null>;
  count(table: TableHandle, attribute: string, filter?: Filter): Promise<number>;
}

export interface DataLayer {
  transaction<T>(run: (tx: DataOperations) => Promise<T>): Promise<T>;
  refuseIfFailed(): boolean;
  close(): Promise<void>;
}
```

Rows use attribute names and generated TypeScript values: `Date` for datetime, `boolean`, and `string` for UUID. The adapter converts these to and from storage. `Key` maps primary-key attribute names to values. `TableHandle` is opaque to handlers: the emitted schema exports it and only the adapter interprets it. No query-library type or SQL string crosses the contract; a filter is plain data.

Insert and update return the stored row. A missing select or update returns `undefined`; delete returns `false` when absent and `true` when removed. A transaction commits when its callback resolves, returning that result; it rolls back every write and rethrows the same error when the callback rejects. The caller closes the layer when finished.

Once a call joined to a transaction has failed, the transaction rolls back whatever follows, so the layer refuses any later call that joins it before the call's callback runs, with a `FrameworkError` whose `cause` is the first failure; a joined call that was queued before the failure is refused when its turn comes. `refuseIfFailed()` gives the same refusal without joining, and says whether a call made in the caller's async context would join a running transaction. Every generated function calls it first, before it casts its input. Inside a transaction that a joined call failed it throws, so a call made after a caught failure does no work at all (decisions log, 2026-10-11, N6 ruling). Inside a running transaction that has not failed it returns `true`. Anywhere else it returns `false`: at top level, after the transaction settled, and from another request's async context while a transaction, failed or not, is still open. The answer comes from the caller's async context, never from state shared across the layer, so one request's failure never refuses another's call. It opens nothing, takes no lock and waits for nothing. A generated function whose input fails to cast at top level therefore rejects at once with that error and never takes the write lock; inside a transaction the failed cast marks it (decisions log, 2026-10-11, N7 ruling).

Joined calls run one at a time, so a joined call must never await a call that was joined after it from the same frame: that call's turn comes only once the awaiting call settled, so neither settles and the transaction hangs, holding the write queue (decisions log, 2026-10-11, N8 ruling).

The separate `testing` entry of the run-time library exports `dataLayerConformance(makeLayer)`, a record of named async checks to register with an adapter's test runner. The factory supplies `{ layer, table, sampleRow, key, secondRow, secondKey, changes }`: a fresh isolated layer, an empty prepared table, two complete schema-valid rows with distinct primary keys, and non-key changes that change the sample row. `key` and `secondKey` name the same primary-key attributes and match their respective rows. Every call uses the same schema and values for both rows. Checks cover CRUD, selecting/updating/deleting only the named row among two rows, missing keys with unrelated data present, commit, rollback and isolation; each closes its layers even on failure. The runtime tests use a test-only double, excluded from the package archive by its source-only `files` whitelist. An archive test checks that neither the double nor any tests ship and that both public entries load from the archive.

The suite also checks the queue rules every adapter shares: two concurrent transactions never interleave their statements; a throw or a rejected promise after a write leaves no row; the queue continues after a failed transaction; `close()` with a transaction in flight rejects and leaves the layer open; a nested `transaction` call joins the running transaction, and a failure in it rolls the whole transaction back even when the caller catches it; calls joined to one transaction run one at a time, and a call joined from inside a joined call does not wait for itself. Contract v1 adds that a call joining a failed transaction is refused before it runs; that `refuseIfFailed()` refuses only inside a failed transaction, even while that transaction is held open and another async context asks, and that a top-level transaction queued meanwhile commits; that `refuseIfFailed()` returns `true` inside a transaction, a joined call and a call joined from one, and `false` at top level, from another async context while a transaction is open, and after it settled; and that `selectByKey` and `selectByKeyForUpdate` return the same row by value, which the check before an update's write relies on ([action lifecycle](./action-lifecycle.md)). Each check has a negative proof against a deliberately broken double.

`verify` enforces the runtime half of M2 test 4 and test 7 with deliberately plain-text compiler repository checks. Every runtime source file and the **whole text** of its package manifest must contain none of the model package, the compiler package (`@meshfw/model` and `@meshfw/compiler`), `drizzle-orm` or `drizzle-kit`; this includes dependency alias targets and non-dependency metadata. Runtime source must contain neither `bun:` nor `node:` anywhere, nor the whole word `Bun` (`\bBun\b`). Comments and strings fail on purpose, so inter-token comments cannot hide a forbidden mention. Planted violations prove each rule. The Drizzle half of test 4 is a third text rule: no file in the checkout outside `packages/data-*`, a project's `.mesh/schema.ts` (with the generated header), manifests, lockfiles, the docs and the rule's own files mentions `drizzle-orm` or `drizzle-kit` ([ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md)). The generated-action import check arrives with the action functions.

## Mandatory set and declared capabilities

Every data adapter must implement select, insert, update, delete, transactions, filters, sort and pagination. Four things are optional and declared: **joins, aggregates, upserts, atomic expressions** ([rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), Ruling 4; [roadmap](../roadmap/roadmap.md), M3). Atomic expressions is what lets a `set` value fold into one `UPDATE` ([action lifecycle](./action-lifecycle.md)). Pagination has two kinds, offset and keyset. M5 adds a "read for update" call to the contract: it reads one row with a write lock (a row lock on Postgres, an immediate transaction on SQLite) for read-then-write actions, which the build chooses from the action body ([ADR-0054](../decisions/0054-write-strategy-is-inferred.md)) ([roadmap](../roadmap/roadmap.md), M5; [action lifecycle](./action-lifecycle.md)).

## Filters in M3 and trees in M4

In M3 a filter is plain data (field, operator, literal), also the form a caller passes at run time ([roadmap](../roadmap/roadmap.md), M3). In M4 the expression tree "crosses the data-layer contract" and the adapter compiles it into Drizzle's builder when a query runs. Queries are assembled at run time from the action's filter, the caller's filter and, later, policies ([roadmap](../roadmap/roadmap.md), M4). Still not decided: whether the tree replaces or extends the M3 filter type, whether a caller's filter is converted to a tree, and how the three sources combine. See [expressions](./expressions.md).

## The capability manifest

Each adapter ships a manifest: static data, a closed union of capability names, readable by the build without starting the adapter ([roadmap](../roadmap/roadmap.md), M3). A manifest naming something outside the union fails the build (M3, test 2). The build then checks each entity: an entity that uses a capability the adapter lacks fails the build at the entity-file position. M3 checks the one it needs, `integer-key-fill` for an integer primary key; the others are checked as the constructs that need them arrive.

## No silent in-memory fallback

The ruling: using a capability the adapter lacks "is a build-time error, never a silent in-memory fallback" ([rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), Ruling 4). The evidence is Ash. Its data-layer behaviour has 46 callbacks, two required, one of which is `can?/2`, the capability probe that knows 47 features ([Ash runtime internals](../research/ash-runtime-internals.md), sections 3.1 and 3.2). The list is also incomplete: core asks about features the type does not declare, such as `:timeout` and `:atomic_update` (same, 3.2). Core reacts to a missing feature in three ways (same, 3.3):

1. a hard error, sometimes a structured class, sometimes a plain string;
2. a strategy downgrade, for example bulk updates falling back to `:stream`;
3. an in-memory fallback, for example calculations evaluated over fetched records.

A reader cannot predict which applies. Mesh keeps one reaction, the build-time hard error ([roadmap](../roadmap/roadmap.md), section 2, item 2). Mesh does have an in-memory evaluator ([expressions](./expressions.md)); it runs expressions on records already loaded, never in place of a database feature.

## Conformance suite

Contract v0 provides the small suite above; M3 expands it into the full suite every data adapter must pass ([roadmap](../roadmap/roadmap.md), M3). It includes a throwing transaction leaving no row, and keyset pagination under concurrent inserts returning each row that existed at the start exactly once (M3, tests 3 and 4). The M4 function tables are part of what each adapter runs (M9, test 5). The roadmap names the risk that M3 has one real implementation until M9, and its answer is that M9 may start right after M5 ([roadmap](../roadmap/roadmap.md), M3, risks).

## The capability rule across parallel milestones

M9 (Postgres) can start once M5 is merged and run alongside M6 to M8 ([roadmap](../roadmap/roadmap.md), section 4). A milestone that adds an optional capability (M5 atomic expressions, M7 joins and aggregates) implements it in every data adapter merged when it is merged. M9 implements on Postgres every capability in the suite on the day M9 merges. Whichever merges second owes the missing combination. v1 is done when SQLite and Postgres both pass the whole suite (same place).

## SQL adapters on Drizzle

**Drizzle** is a TypeScript query builder with SQLite and Postgres drivers. **drizzle-kit** generates SQL migrations from a Drizzle schema. Mesh uses both behind its own contract because the project owner holds that "the more we can rely on well-established tools the better" ([rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), Review note, on plan ruling Q3; [ADR-0030](../decisions/0030-established-tools-first.md)). Choosing Drizzle specifically was a later choice that applies that position, not a ruling ([ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md)).

| Package | Role |
|---|---|
| `data-drizzle` | Shared code: turns a Mesh query (plain data) into Drizzle's builder, and compiles expression trees at query time ([roadmap](../roadmap/roadmap.md), M3 and M4). Joins are compiled here, not through Drizzle's relations API (M7). |
| `data-sqlite` | SQLite, file or in-memory, over Bun's SQLite driver (M2, M3). |
| `data-postgres` | Postgres on Drizzle, added in M9. |

What a dialect adds beyond its driver is not detailed in the roadmap: not decided.

Each adapter has two halves: a build-time half that emits Drizzle table definitions as a guarded generated file, and a run-time half that implements the contract with Drizzle ([roadmap](../roadmap/roadmap.md), M2). Guarded means `mesh build --check` regenerates the file and fails on any difference ([generated code and the guard](./generated-code-and-guard.md)).

### One value: the descriptor and the data layer

`sqlite({ file })` returns one frozen value that is both the `DataAdapter` a project names in `mesh.config.ts` (`kind`, `name: "sqlite"`, `build: "@meshfw/data-sqlite/build"`, `options: { file }`) and its run-time `DataLayer`. The same value is passed to `createSchema`, to `bind` and closed with `close()`, so there is one way to name a database. Making it opens nothing: the connection opens on the first transaction, so the build can import `mesh.config.ts` freely. A missing or empty `file` is a `FrameworkError`; after `close()` the next transaction opens a new connection; `close()` twice does nothing. `defineConfig` lives in the runtime, so a program that imports its configuration at run time loads no compiler code ([ADR-0033](../decisions/0033-core-split-build-time-run-time.md)).

### Transactions are Mesh's own on SQLite

Drizzle's `bun-sqlite` driver runs transactions synchronously: an async callback would commit before its promise settles. So `@meshfw/data-sqlite` runs them itself, on one connection per layer: a promise queue lets one transaction run at a time; each sends `BEGIN IMMEDIATE`, awaits the callback, then `COMMIT`, or `ROLLBACK` on any failure and rethrows the same error. A failed transaction releases the queue. A call from inside a running callback is detected with `AsyncLocalStorage` and joins that transaction instead of queueing behind it. Each callback and each joined call is a frame with its own queue: the calls joined from one frame run one at a time, in the order they were made, and a call joined from inside a joined call queues on that call's frame, so it never waits for itself. A joined call that fails marks the transaction, and from then on a call that joins it, or that `refuseIfFailed()` is asked about, is refused. The operations object stops working when its transaction ends. There is no timer: a callback that never settles holds the queue, and `close()` then rejects, stating how many transactions are running and queued, and leaves the layer open. A failed `ROLLBACK` throws a `FrameworkError` holding both errors and makes the layer unusable until it is closed, because its connection may still be inside a transaction. Closing returns the layer to its unopened state: the next transaction opens a new connection to the same file (a `:memory:` database starts empty), which is what lets `disconnect()` and then `connect()` reuse the one layer `mesh.config.ts` built. After a failed `ROLLBACK` on a file database, the reopened connection can find the file locked until the old native handle is garbage-collected (`Bun.gc(true)` forces it); until then a transaction fails with `SQLITE_BUSY`. The conformance suite checks that a transaction after `close()` succeeds. The rejected alternative is the libSQL client, whose Drizzle driver has asynchronous transactions: it adds a native dependency where `bun:sqlite` is built into Bun.

### The build half: a generator and a command

`DataAdapter.build` is a module specifier. The compiler resolves it from the project root with `Bun.resolveSync`, imports it at build time only, and requires a default export `AdapterBuild { generators; commands? }` (`MESH_ADAPTER_BUILD` otherwise, at `mesh.config.ts`). The adapter's generators run after the core ones, under the same rule that two generators never write one path. Each sets `templateDir`, the absolute folder of its template; `.mesh-generators/<template>` still overrides it, and `mesh export generators` writes it too ([ADR-0061](../decisions/0061-generators-are-jig-templates.md)).

`@meshfw/data-sqlite/build` has one generator, `sqlite-schema`, which writes `.mesh/schema.ts`: one `<entity>Table` per entity (camelCase name) and `export const tables = { post: postTable, ... }`. A column has its attribute's name; relationship key columns follow the attributes; computed members have none. Types: `uuid` and `string` are `text`, `integer` is `integer`, `float` and `decimal` are `real`, `boolean` is `integer` in boolean mode, `enum` is `text` with its values, and `date`, `datetime` and `timestamp` are `integer` in `timestamp_ms` mode, so each column's TypeScript type equals the record type the `types` generator writes (a type-level test checks it). There are no defaults: the generated actions write every default themselves ([ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)). A table or column name with a backtick or control character (`MESH_SCHEMA_IDENTIFIER`), two entities on one table (`MESH_SCHEMA_DUPLICATE_TABLE`), on one export (`MESH_SCHEMA_DUPLICATE_EXPORT`) or two columns that differ only in ASCII case (`MESH_SCHEMA_DUPLICATE_COLUMN`) fail the build.

`mesh db push [--force]` is the build half's `db push` command. The `mesh` command runs the guard first and refuses an out-of-date generated tree; the adapter then imports the committed `schema.ts` and pushes it to the configured file through the same function as `createSchema`. `:memory:` is refused, statements that lose data are printed and refused without `--force`, and a second push prints `schema is up to date`. Both `createSchema` and `mesh db push` make the database match `tables` exactly, so a table absent from `tables` is dropped. drizzle-kit counts data loss only for tables that hold rows, so an empty table is dropped without a warning or `--force`. `mesh db push` resolves a relative `file` from the project root, while the run-time layer opens it relative to the working directory; the two agree because `mesh` runs from the project root.

**Column names (lead ruling, 2026-10-04).** A column is named exactly like its attribute: `dueOn` stays `dueOn`, with no camelCase-to-snake_case transform.

**Table placement.** `table` is an attribute of the entity line, `entity :Invoice table="invoices"` ([ADR-0050](../decisions/0050-entity-file-syntax.md)). The operator's ruling of 2026-10-04 to move it to a data-layer section once the extension host exists ([rulings before M2](../decisions/rulings-2026-10-04.md)) predates syntax v2, which keeps it on the entity line ([ADR-0066](../decisions/0066-names-and-references-are-atoms.md) changes how the entity is named, not where `table` goes).

**Isolation rule.** Drizzle is imported only under `packages/data-*` and in the emitted schema file. Generated action functions never import Drizzle, the model or `model.json`; `verify` checks it ([roadmap](../roadmap/roadmap.md), M2, test 4).

**Pins.** Drizzle v1 is a release candidate, its relations API is being replaced and drizzle-kit is mid-rewrite ([research synthesis](../research/synthesis.md), section 12, risk 1). M2 pins the stable pair `drizzle-orm@0.45.3` and `drizzle-kit@0.31.11` ([ADR-0048](../decisions/0048-schema-inside-the-process-for-tests.md)), and the pin stays ([ADR-0062](../decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md)); `drizzle-orm` is a direct dependency of the user's project; an upgrade is its own pull request and must pass the suite, and Mesh avoids the relations API ([roadmap](../roadmap/roadmap.md), section 9, risk 3).

## Migrations

`mesh migrate generate` runs drizzle-kit over the emitted Drizzle schema and commits the SQL it writes. drizzle-kit owns snapshot and diff. Nothing is applied automatically; `mesh migrate apply` is explicit ([roadmap](../roadmap/roadmap.md), M9). In development `mesh db push` wraps drizzle-kit's schema push (M2). `mesh db push` and `mesh migrate` are commands contributed by the SQL adapters (`mesh db push` is merged); the core `cli` imports no query library and never imports drizzle-kit ([roadmap](../roadmap/roadmap.md), section 3 and M2).

Before calling drizzle-kit, Mesh compares the old and new model and refuses a destructive or ambiguous change (drop, type change, rename, making a column required) unless a flag names it (M9). How drizzle-kit behaves without a terminal on an ambiguous change is not checked; M9's first task is to test it (M9, risks). Data migrations and automatic renames are out of scope.

## SQLite in-memory mode for tests

Tests use SQLite's `:memory:` mode through `data-sqlite`, not a hand-written in-memory adapter ([ADR-0016](../decisions/0016-in-memory-data-via-sqlite.md); [roadmap](../roadmap/roadmap.md), M3). A data adapter also needs sort, pagination, joins, aggregates, transactions and unique constraints, which SQLite already does. Ash ships in-memory data layers for tests, so the other option is real; the cost is that every implementation is SQL-shaped until the contract meets a non-SQL one ([ADR-0016](../decisions/0016-in-memory-data-via-sqlite.md)).

`bind(dataLayer)` gives a test all generated action functions bound to its own database; the action context never carries the data layer ([ADR-0047](../decisions/0047-actions-are-bound-to-a-data-layer.md), [ADR-0059](../decisions/0059-action-context.md)). Two bindings can coexist in one process.

Preparing the schema must also happen in that process, on the same connection. [ADR-0048](../decisions/0048-schema-inside-the-process-for-tests.md) selects the adapter's test/development schema function, using drizzle-kit's `pushSQLiteSchema` on the pinned stable pair. The call and compatibility cast live in exactly one adapter function, covered by an in-memory create/insert/select regression test. It dynamically imports drizzle-kit, a project development dependency, and fails clearly if it is missing. Production uses migrations. In the code: `createSchema(db, tables)`, with `tables` from the emitted schema, checks every table and column name first, then plans and applies the push through `planSchemaPush` in `packages/data-sqlite/src/push-schema.ts`, the only file that mentions `drizzle-kit/api`; statements that would lose data are refused. The pinned API draws a progress spinner on standard output, which that function mutes for the length of the call. Drizzle v1 RC `1.0.0-rc.4` has no `drizzle-kit/api`; revisit on v1 release or M7 and use guarded emitted DDL unless push is restored.

## What an author of a new data adapter must provide

From the roadmap:

1. a capability manifest in the closed union (M3);
2. the run-time half, implementing the mandatory set with no query-library types leaking through (M3, test 5);
3. for each declared capability, an implementation that passes the conformance suite (M3; section 4);
4. an SQL form for every registered function that entities use, including functions from extensions, or the build fails (M4; M6, test 5);
5. a build-time half that emits the adapter's schema as a guarded file, if it has one (M2);
6. passing the M4 function tables (M4, test 1).

Whether a non-SQL adapter can reuse any of `data-drizzle` is not decided, and neither is how an adapter is registered.
