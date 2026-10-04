---
title: "Data layer: contract and capabilities"
description: "The data-layer contract, declared capabilities, the conformance suite and the SQL adapters on Drizzle."
---

# Data layer: contract and capabilities

Status: design; built in milestone M3 ([roadmap](../roadmap/roadmap.md), M3). A first small contract arrives in M2, capabilities are first used in M5 and M7, and Postgres and migrations arrive in M9 ([roadmap](../roadmap/roadmap.md), M2, M5, M7, M9). Nothing on this page exists as code yet.

Vocabulary note: tag and attribute names are working names. For v1 the vocabulary copies Ash's DSL, and the final name follows [vocabulary mapping](../roadmap/vocabulary-mapping.md) ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)). Examples use MX concise syntax ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).

The data layer stores and fetches records. Related: [overview](../overview/architecture.md), [three rings](./three-rings.md), [expressions](./expressions.md), [action lifecycle](./action-lifecycle.md), [generated code and the guard](./generated-code-and-guard.md).

## Why the contract is Mesh's own

A contract that covers Drizzle, Kysely, TypeORM and Prisma can cover select, insert, update, delete, transactions and raw SQL. Filters, joins and aggregates have four different shapes there, and relation loading, schema ownership, migrations and pooling cannot be covered. So the contract is Mesh's own, at the level of resources, as Ash's is. The query library inside an adapter is that adapter's private choice ([research synthesis](../research/synthesis.md), section 11; [ADR-0013](../decisions/0013-data-layer-contract-and-capabilities.md)).

The contract and its query and expression-tree types live in `runtime`, which a deployed program carries. `runtime` imports no Drizzle ([roadmap](../roadmap/roadmap.md), section 3 and M3, test 5; [ADR-0033](../decisions/0033-core-split-build-time-run-time.md)).

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

A suite every data adapter must pass, written in M3 ([roadmap](../roadmap/roadmap.md), M3). It includes a throwing transaction leaving no row, and keyset pagination under concurrent inserts returning each row that existed at the start exactly once (M3, tests 3 and 4). The M4 function tables are part of what each adapter runs (M9, test 5). The roadmap names the risk that M3 has one real implementation until M9, and its answer is that M9 may start right after M5 ([roadmap](../roadmap/roadmap.md), M3, risks).

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

**Isolation rule.** Drizzle is imported only under `packages/data-*` and in the emitted schema file. Generated handlers never import Drizzle, the model or `model.json`; `verify` checks it ([roadmap](../roadmap/roadmap.md), M2, test 4).

**Pins.** Drizzle v1 is a release candidate, its relations API is being replaced and drizzle-kit is mid-rewrite ([research synthesis](../research/synthesis.md), section 12, risk 1). So versions are exact, an upgrade is its own pull request and must pass the suite, and Mesh avoids the relations API ([roadmap](../roadmap/roadmap.md), section 9, risk 3).

## Migrations

`mesh migrate generate` runs drizzle-kit over the emitted Drizzle schema and commits the SQL it writes. drizzle-kit owns snapshot and diff. Nothing is applied automatically; `mesh migrate apply` is explicit ([roadmap](../roadmap/roadmap.md), M9). In development `mesh db push` wraps drizzle-kit's schema push (M2). `mesh db push` and `mesh migrate` are commands contributed by the SQL adapters; the core `cli` imports no query library and never imports drizzle-kit ([roadmap](../roadmap/roadmap.md), section 3 and M2).

Before calling drizzle-kit, Mesh compares the old and new model and refuses a destructive or ambiguous change (drop, type change, rename, making a column required) unless a flag names it (M9). How drizzle-kit behaves without a terminal on an ambiguous change is not checked; M9's first task is to test it (M9, risks). Data migrations and automatic renames are out of scope.

## SQLite in-memory mode for tests

Tests use SQLite's `:memory:` mode through `data-sqlite`, not a hand-written in-memory adapter ([ADR-0016](../decisions/0016-in-memory-data-via-sqlite.md); [roadmap](../roadmap/roadmap.md), M3). A data adapter also needs sort, pagination, joins, aggregates, transactions and unique constraints, which SQLite already does. Ash ships in-memory data layers for tests, so the other option is real; the cost is that every implementation is SQL-shaped until the contract meets a non-SQL one ([ADR-0016](../decisions/0016-in-memory-data-via-sqlite.md)).

## What an author of a new data adapter must provide

From the roadmap:

1. a capability manifest in the closed union (M3);
2. the run-time half, implementing the mandatory set with no query-library types leaking through (M3, test 5);
3. for each declared capability, an implementation that passes the conformance suite (M3; section 4);
4. an SQL form for every registered function that resources use, including functions from extensions, or the build fails (M4; M6, test 5);
5. a build-time half that emits the adapter's schema as a guarded file, if it has one (M2);
6. passing the M4 function tables (M4, test 1).

Whether a non-SQL adapter can reuse any of `data-drizzle` is not decided, and neither is how an adapter is registered.
