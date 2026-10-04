---
title: "Data layer: contract and capabilities"
description: "The data-layer contract, declared capabilities, the conformance suite and the SQL adapters on Drizzle."
---

# Data layer: contract and capabilities

Status: contract v0 is implemented in `@mesh/runtime`, with `@mesh/data-drizzle` shared operations and `@mesh/data-sqlite` as its first adapter (M2). M3 replaces it with the full contract below; capabilities are first used in M5 and M7, and Postgres and migrations arrive in M9 ([roadmap](../roadmap/roadmap.md), M2, M3, M5, M7, M9). Updated 2026-10-04 with M2 column naming, binding and in-process schema decisions.

Vocabulary note: tag and attribute names are working names. For v1 the vocabulary copies Ash's DSL, and the final name follows [vocabulary mapping](../roadmap/vocabulary-mapping.md) ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)). Examples use MX concise syntax ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).

The data layer stores and fetches records. Related: [overview](../overview/architecture.md), [three rings](./three-rings.md), [expressions](./expressions.md), [action lifecycle](./action-lifecycle.md), [generated code and the guard](./generated-code-and-guard.md).

## Why the contract is Mesh's own

A contract that covers Drizzle, Kysely, TypeORM and Prisma can cover select, insert, update, delete, transactions and raw SQL. Filters, joins and aggregates have four different shapes there, and relation loading, schema ownership, migrations and pooling cannot be covered. So the contract is Mesh's own, at the level of resources, as Ash's is. The query library inside an adapter is that adapter's private choice ([research synthesis](../research/synthesis.md), section 11; [ADR-0013](../decisions/0013-data-layer-contract-and-capabilities.md)).

The contract and its query and expression-tree types live in `runtime`, which a deployed program carries. `runtime` imports no Drizzle ([roadmap](../roadmap/roadmap.md), section 3 and M3, test 5; [ADR-0033](../decisions/0033-core-split-build-time-run-time.md)).

## Contract v0 (M2)

`@mesh/runtime` exports this deliberately small contract for generated handlers and adapters. Operations exist only inside `transaction`; a handler always opens one. M3 replaces this version with the full contract, including filters, sorting, pagination and capabilities ([roadmap](../roadmap/roadmap.md), M2 and M3).

```ts "packages/runtime/src/data-layer.ts"
export type Row = Record<string, unknown>;
export type Key = Readonly<Record<string, unknown>>;
export type TableHandle = object;

export interface DataOperations {
  insert(table: TableHandle, row: Row): Promise<Row>;
  selectByKey(table: TableHandle, key: Key): Promise<Row | undefined>;
  selectAll(table: TableHandle): Promise<Row[]>;
  updateByKey(table: TableHandle, key: Key, changes: Row): Promise<Row | undefined>;
  deleteByKey(table: TableHandle, key: Key): Promise<boolean>;
}

export interface DataLayer {
  transaction<T>(run: (tx: DataOperations) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

Rows use attribute names and generated TypeScript values: `Date` for datetime, `boolean`, and `string` for UUID. The adapter converts these to and from storage. `Key` maps primary-key attribute names to values. `TableHandle` is opaque to handlers: the emitted schema exports it and only the adapter interprets it. No query-library type, SQL string or filter crosses this version of the contract.

Insert and update return the stored row. A missing select or update returns `undefined`; delete returns `false` when absent and `true` when removed. A transaction commits when its callback resolves, returning that result; it rolls back every write and rethrows the same error when the callback rejects. Only one transaction runs at a time per layer; unrelated concurrent calls queue, and a failed transaction does not block the queue. That recovery has one stated exception: **a rollback that itself fails is fatal for the layer.** The connection may still be inside the failed transaction and an abandoned write and lock may remain, so the adapter does not attempt to repair, reopen or retry it. The failing call rejects with `FrameworkError` carrying both the callback and rollback errors; every queued and every later `transaction` call then rejects with a message naming the cause, and only `close()` works. The caller closes the layer and creates a new one. A nested call from inside a running transaction fails with `FrameworkError`. Operations expire when their callback settles. The caller closes the layer when finished; `close()` with a running or queued transaction rejects with `FrameworkError` and leaves the layer open. Closing an idle layer twice is harmless.

The separate `@mesh/runtime/testing` entry exports `dataLayerConformance(makeLayer)`, a record of named async checks to register with an adapter's test runner. The factory supplies `{ layer, table, sampleRow, key, secondRow, secondKey, changes }`: a fresh isolated layer, an empty prepared table, two complete schema-valid rows with distinct primary keys, and non-key changes that change the sample row. `key` and `secondKey` name the same primary-key attributes and match their respective rows. Every call uses the same schema and values for both rows. Checks cover CRUD, selecting/updating/deleting only the named row among two rows, missing keys with unrelated data present, commit, rollback, isolation, non-interleaving concurrent transactions, queue recovery, nested-call rejection and busy-close rejection; each closes its layers even on failure. The runtime tests use a test-only double, excluded from the package archive by its source-only `files` whitelist. An archive test checks that neither the double nor any tests ship and that both public entries load from the archive.

`verify` enforces the runtime half of M2 test 4 and test 7 with deliberately plain-text compiler repository checks. Every runtime source file and the **whole text** of its package manifest must contain none of `@mesh/model`, `@mesh/compiler`, `drizzle-orm` or `drizzle-kit`; this includes dependency alias targets and non-dependency metadata. Runtime source must contain neither `bun:` nor `node:` anywhere, nor the whole word `Bun` (`\bBun\b`). Comments and strings fail on purpose, so inter-token comments cannot hide a forbidden mention. Planted violations prove each rule. The Drizzle half of M2 test 4 also scans workspace source, including compiler source and generated handlers: only `packages/data-*` and emitted `schema.ts` files may mention the database libraries. One allow-list excludes package manifests, lockfiles, docs content (including the exact docs navigation configuration file) and the repository-check files themselves; planted violations prove the boundary. The remaining generated-handler checks arrive with that later M2 task.

## Mandatory set and declared capabilities

Every data adapter must implement select, insert, update, delete, transactions, filters, sort and pagination. Four things are optional and declared: **joins, aggregates, upserts, atomic expressions** ([rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), Ruling 4; [roadmap](../roadmap/roadmap.md), M3). Atomic expressions is what lets a change fold into one `UPDATE` ([action lifecycle](./action-lifecycle.md)). Pagination has two kinds, offset and keyset. M5 adds a "read for update" call to the contract: it reads one row with a write lock (a row lock on Postgres, an immediate transaction on SQLite) for non-atomic actions ([roadmap](../roadmap/roadmap.md), M5; [action lifecycle](./action-lifecycle.md)).

## Filters in M3 and trees in M4

In M3 a filter is plain data (field, operator, literal), also the form a caller passes at run time ([roadmap](../roadmap/roadmap.md), M3). In M4 the expression tree "crosses the data-layer contract" and the adapter compiles it into Drizzle's builder when a query runs. Queries are assembled at run time from the action's filter, the caller's filter and, later, policies ([roadmap](../roadmap/roadmap.md), M4). Still not decided: whether the tree replaces or extends the M3 filter type, whether a caller's filter is converted to a tree, and how the three sources combine. See [expressions](./expressions.md).

## The capability manifest

Each adapter ships a manifest: static data, a closed union of capability names, readable by the build without starting the adapter ([roadmap](../roadmap/roadmap.md), M3). A manifest naming something outside the union fails the build (M3, test 2). The build then checks each resource: a resource that uses a capability the adapter lacks fails the build at the resource-file position (M5, test 4). The check is written in M3 and first used in M5.

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
| `data-drizzle` | Shared v0 operations: validates row/key column names, combines every key entry with `eq` and `and`, and wraps driver failures as `FrameworkError` with the driver error as cause. Typed constraint errors arrive in M3. Full query and expression compilation follows in M3/M4; joins, not Drizzle's relations API, follow in M7. |
| `data-sqlite` | SQLite, file or in-memory, over Bun's SQLite driver (M2, M3). |
| `data-postgres` | Postgres on Drizzle, added in M9. |

`sqlite({ file })` returns a lazy, caller-owned data layer plus the plain build metadata `{ adapter: "sqlite", build: "@mesh/data-sqlite/build", options }`. The main entry loads neither the compiler nor the model. The separate build entry exports `sqliteSchemaEmitter`, which emits `<output>/schema.ts`: one table per resource and a sorted `tables` map. Columns retain attribute names and TypeScript values, including booleans and dates. Defaults, ids and timestamps belong to generated handlers, not database defaults ([ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)). Configuration loading and the `mesh db push` command are not wired up yet.

**SQLite transaction rule.** Drizzle's `bun-sqlite` transaction callback is synchronous and would commit before an async callback settles. The adapter therefore serialises work on its one connection, issuing `BEGIN IMMEDIATE`, awaiting the callback, then `COMMIT`, all through Drizzle. Any callback or commit failure triggers `ROLLBACK`; rollback failure reports both errors and makes the layer unusable as described under contract v0. The rejected alternative, a libsql client with Drizzle's async transactions, adds a native dependency where `bun:sqlite` is built in.

**Open and transaction-start failures.** Lazy connection opening and `BEGIN IMMEDIATE` are adapter-owned operations, so their failures are wrapped in `FrameworkError` with the driver error as cause, naming the operation and the configured file. For `SQLITE_BUSY` the message also says that the queue serialises one layer only, that another connection holds the write lock, and that the caller decides whether to retry: the adapter adds no retry policy, and the queue recovers on its own once the other connection finishes. Callback and `COMMIT` failures keep their identity unchanged, as contract v0 requires. There is no callback timer in v0: a callback that never settles holds the queue. `close()` reports how many transactions are running and queued rather than rolling back underneath a still-running callback.

Each adapter has two halves: a build-time half that emits Drizzle table definitions as a guarded generated file, and a run-time half that implements the contract with Drizzle ([roadmap](../roadmap/roadmap.md), M2). Guarded means `mesh build --check` regenerates the file and fails on any difference ([generated code and the guard](./generated-code-and-guard.md)).

**Column names (lead ruling, 2026-10-04).** A column is named exactly like its attribute: `dueOn` stays `dueOn`, with no camelCase-to-snake_case transform.

**Identifier restriction (M2, adapter level).** A table name or a column name containing a backtick or an ASCII control character is refused. The pinned schema tool interpolates names into backtick-quoted DDL without containing an embedded backtick, so such a name would change the SQL structure rather than stay an identifier. The emitter reports this as a positioned build diagnostic at the authored name, and `createSchema` raises `FrameworkError` for callers who pass Drizzle tables directly, before any SQL runs. Names are never renamed silently. Everything else SQLite can quote safely is accepted, including double quotes, spaces, dots and punctuation, and the emitted spelling is exactly the declared one.

**Physical names fold ASCII only.** SQLite compares identifiers case-insensitively for ASCII letters. The build rejects two resources whose `table` names differ only by ASCII case, and two attributes of one resource whose names do, naming both sides, because either pair would target one physical table or column. The declared spelling is preserved in emitted files; a non-ASCII case pair is not treated as a collision.

**Table placement (operator ruling, 2026-10-04).** `table` stays an attribute of `resource` until M6 or the post-v1 vocabulary review ([rulings before M2](../decisions/rulings-2026-10-04.md)).

**Isolation rule.** Drizzle is imported only under `packages/data-*` and in the emitted schema file. Generated handlers never import Drizzle, the model or `model.json`; `verify` checks it ([roadmap](../roadmap/roadmap.md), M2, test 4).

**Pins.** Drizzle v1 is a release candidate, its relations API is being replaced and drizzle-kit is mid-rewrite ([research synthesis](../research/synthesis.md), section 12, risk 1). M2 pins the stable pair `drizzle-orm@0.45.3` and `drizzle-kit@0.31.11` ([ADR-0048](../decisions/0048-schema-inside-the-process-for-tests.md)); an upgrade is its own pull request and must pass the suite, and Mesh avoids the relations API ([roadmap](../roadmap/roadmap.md), section 9, risk 3).

## Migrations

`mesh migrate generate` runs drizzle-kit over the emitted Drizzle schema and commits the SQL it writes. drizzle-kit owns snapshot and diff. Nothing is applied automatically; `mesh migrate apply` is explicit ([roadmap](../roadmap/roadmap.md), M9). In development `mesh db push` wraps drizzle-kit's schema push (M2). `mesh db push` and `mesh migrate` are commands contributed by the SQL adapters; the core `cli` imports no query library and never imports drizzle-kit ([roadmap](../roadmap/roadmap.md), section 3 and M2).

Before calling drizzle-kit, Mesh compares the old and new model and refuses a destructive or ambiguous change (drop, type change, rename, making a column required) unless a flag names it (M9). How drizzle-kit behaves without a terminal on an ambiguous change is not checked; M9's first task is to test it (M9, risks). Data migrations and automatic renames are out of scope.

## SQLite in-memory mode for tests

Tests use SQLite's `:memory:` mode through `data-sqlite`, not a hand-written in-memory adapter ([ADR-0016](../decisions/0016-in-memory-data-via-sqlite.md); [roadmap](../roadmap/roadmap.md), M3). A data adapter also needs sort, pagination, joins, aggregates, transactions and unique constraints, which SQLite already does. Ash ships in-memory data layers for tests, so the other option is real; the cost is that every implementation is SQL-shaped until the contract meets a non-SQL one ([ADR-0016](../decisions/0016-in-memory-data-via-sqlite.md)).

`bind(dataLayer)` gives a test all generated action functions bound to its own database; the scope does not carry the data layer ([ADR-0047](../decisions/0047-actions-are-bound-to-a-data-layer.md)). Two bindings can coexist in one process.

Prepare the schema in that process, on the same connection, with `await createSchema(layer, tables)` from `@mesh/data-sqlite`; `tables` comes from the emitted schema. Schema preparation shares the connection queue, refuses foreign layers and invalid table handles, and rejects data-losing statements reported by the push API. It is intended for empty test and development databases. [ADR-0048](../decisions/0048-schema-inside-the-process-for-tests.md) selects the adapter's test/development schema function, using drizzle-kit's `pushSQLiteSchema` on the pinned stable pair. The call and compatibility cast live in exactly one adapter function, covered by an in-memory create/insert/select regression test. It dynamically imports drizzle-kit, a project development dependency, and fails clearly if it is missing. Production uses migrations. Drizzle v1 RC `1.0.0-rc.4` has no `drizzle-kit/api`; revisit on v1 release or M7 and use guarded emitted DDL unless push is restored.

## What an author of a new data adapter must provide

From the roadmap:

1. a capability manifest in the closed union (M3);
2. the run-time half, implementing the mandatory set with no query-library types leaking through (M3, test 5);
3. for each declared capability, an implementation that passes the conformance suite (M3; section 4);
4. an SQL form for every registered function that resources use, including functions from extensions, or the build fails (M4; M6, test 5);
5. a build-time half that emits the adapter's schema as a guarded file, if it has one (M2);
6. passing the M4 function tables (M4, test 1).

Whether a non-SQL adapter can reuse any of `data-drizzle` is not decided, and neither is how an adapter is registered.
