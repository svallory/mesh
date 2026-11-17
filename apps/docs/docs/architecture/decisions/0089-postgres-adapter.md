---
title: "0089. Postgres adapter: serializable transactions, transient errors and SQLite's order"
description: "Decision record 0089: how @meshfw/data-postgres runs transactions (one at a time per layer, SERIALIZABLE, a 5 s lock wait, a failed statement aborts the call), reports transient errors as MESH_DATABASE_BUSY with a reason, stores attribute types for parity with SQLite, pins SQLite's sort order, reads the outbox under a reader rule and orders the claim with a row lock. Status: Accepted (lead ruling D30, pending operator review)."
---

# 0089. Postgres adapter: serializable transactions, transient errors and SQLite's order

## Status

Accepted (lead ruling D30, pending operator review). Implements, for Postgres, the contract of [ADR-0013](./0013-data-layer-contract-and-capabilities.md) and the dialect interface of [ADR-0088](./0088-translated-conditions-cross-the-data-layer-as-bound-trees.md), on the Drizzle pair of [ADR-0014](./0014-sql-adapters-on-drizzle.md) and [ADR-0062](./0062-direct-dependencies-zod-drizzle-opentelemetry.md). This record covers the adapter, the outbox's reader rule and the claim's row lock (decisions 9 and 10, amended with the second pull request); `LISTEN`/`NOTIFY` wake-ups are a later pull request of the same unit and amend it.

## Date

2026-11-17

## Deciders

lead, delegated: ruling D30 of 2026-11-17 takes every recommendation of the reviewed M9 Postgres design (open decisions O1 to O12); it waits for the operator's review with the other rulings of that run.

## Context

M9 adds a second SQL adapter, `@meshfw/data-postgres` ([roadmap](../roadmap/roadmap.md), M9; [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) places it after 1.0). Postgres differs from SQLite in ways the contract leaves open:

- **Isolation.** SQLite has one writer, so every rule that reads and then writes (an integer key fill, a has-one check, a named check over other rows) sees what a single writer sees. Postgres's default, `READ COMMITTED`, lets two processes read the same state and both write; two parallel integer key fills then fail with a unique violation (SQLSTATE `23505`), which is not a transient error.
- **Transient errors.** The spec lists "a serialization failure (Postgres `40001`, with M9) and a lost connection" among the errors that are `retryable` and belong to `DatabaseBusyError` (`MESH_DATABASE_BUSY`). Nothing said whether Mesh repeats the call itself.
- **A failed statement aborts the transaction.** After any failed statement every later one fails with `25P02`, and `COMMIT` resolves with the command tag `ROLLBACK` instead of failing. On SQLite a failed statement leaves the transaction usable.
- **Order.** Postgres sorts nulls last on `asc` (SQLite: first) and orders and compares text by the database's collation (glibc `en_US.utf8` folds case and accents; SQLite compares bytes).

## Decision

1. **Transactions run one at a time per layer, at `SERIALIZABLE`** (O1, O12), each on a connection reserved from the layer's pool of three, through the shared queue of `@meshfw/data-drizzle` (`serialTransactions`). Each waits at most 5 s for any one lock (`SET LOCAL lock_timeout`), or the caller's `waitMs`. Concurrency comes from several processes or several layer objects, never from one layer.
2. **Transient errors are `MESH_DATABASE_BUSY` with a `reason`** (O2, O4, O5, O8): `40001` is `serialization`, `40P01` `deadlock`, `55P03` `lock-timeout`, a lost connection (class `08`, `57P01` to `57P03`, `53300`, or Bun's closed-connection errors) and a server that did not answer are `connection`; each carries the server's `sqlstate` and `retryable: true`, except a connection lost during `COMMIT`, which is `retryable: false` because the commit may have happened. Mesh marks them and never re-runs a callback: a callback may have made effects outside the database, and a double effect is worse than an error. A login or database name the server refuses (`28xxx`, `3D000`) or an unreadable URL is a `FrameworkError` that names the database without credentials.
3. **A failed statement fails the call** (O6): the adapter records every statement failure of a transaction, and the outer call rejects even if the callback caught the failure, with that failure when it is a `DatabaseBusyError`, else with a `FrameworkError` whose cause is the failure. A call resolves only when `COMMIT` reported `COMMIT`. A validation error that never reached the database (an unknown column) does not count.
4. **Columns keep SQLite's value ranges**: `integer` is `bigint`, `float` and `decimal` are `double precision`, `uuid` and `string` are `text`, an enum is `text` with its values, a date is `timestamp(3) with time zone`, `json` is `jsonb` ([ADR-0069](./0069-json-attribute-type.md)). A `jsonb` value is written as its JSON text cast to `jsonb` and read back from its text, so the database holds the value itself.
5. **SQLite's order on Postgres** (O10): the dialect writes `NULLS FIRST` ascending and `NULLS LAST` descending, and `COLLATE "C"` on text in every sort key and on the left side of every range comparison (`lt`, `lte`, `gt`, `gte`), in a caller's `sort` and `filter` as in a translated `order` and `where`. Equality is untouched.
6. **Identifiers.** A table or column name, or the unique-constraint name Drizzle derives from them, longer than 63 bytes is refused at build time (`MESH_SCHEMA_IDENTIFIER`), since Postgres would cut it silently; so is a name holding a double quote or a control character, which drizzle-kit 0.31.11 does not escape. Names that differ only in letter case are distinct, as quoted identifiers are on Postgres.
7. **`mesh db push` ships** (O7), with `createSchema`, through drizzle-kit 0.31.11's `pushSchema`, and both refuse a database whose `public` schema holds a table, view or sequence that is not the project's (drizzle-kit drops sequences outside its table filter and asks interactive questions about foreign tables).
8. **No `gapless-positions`**: on Postgres it would cost a lock held from the first `publish` to the commit. The manifest is `aggregates`, `integer-key-fill`, `conditions` and `joins`.
9. **The outbox's reader rule** (O3): a read returns rows only at or below its `settled` position, below which every transaction that took a position has ended. An appending transaction takes a shared transaction-level advisory lock on a key derived from the outbox's channel name, then its transaction id, both before its position; a read samples the sequence, then lists the transaction ids of that key's holders in this database (`pg_locks` filtered on the database), and a sample clears once none of them still runs. The listing runs before the statement that reads the rows, so every transaction it saw end is visible to that statement. Only appenders hold delivery back, not other writers on the server. The design proposed bounding a sample by the snapshot's `xmax` instead; that bound is one past the latest completed transaction id, so a running appender can sit at or above it, and the sample would let a read skip its row.
10. **The claim's row lock**: `readDeliveryState` reads the state row `FOR UPDATE` (creating it first), so a takeover and a handler transaction or deletion batch of another process are ordered; at `SERIALIZABLE` the side that waited behind a change fails with `40001`, which ends a round without counting a try, and the next transaction sees the new generation. Core's renewal retries such a failure until the lapse.

## Options considered

1. `READ COMMITTED` with the contract's row locks: never raises `40001`, but parallel integer key fills fail with a non-retryable unique violation and every read-then-check rule can race across processes.
2. An isolation option, default `SERIALIZABLE`: a setting and twice the tests for a choice nobody asked to make.
3. `SERIALIZABLE`, transient errors marked, a failed statement failing the call (chosen).
4. A savepoint around every statement, so a caught failure leaves the transaction usable as on SQLite: two more round trips per statement, roughly three times the latency.

## Trade-off analysis

`SERIALIZABLE` is the only level at which Postgres keeps the guarantees the generated code was written against, at the price of `40001` under contention, including false positives from Postgres's page-level predicate locks; callers see those as retryable. Rejecting a transaction whose statement failed changes what a caught failure means compared with SQLite, but it is the only form that never resolves a call that did not commit. Pinning SQLite's order keeps a test on SQLite predictive of production, at the cost that an index on a text column is not used for a `COLLATE "C"` sort unless it is built with that collation.

## Consequences

- A project switches by naming `postgres({ url: process.env.DATABASE_URL })`; `url` may be undefined at build time, and the first call that needs the database throws a `FrameworkError` when it is missing.
- `dataLayerConformanceV1` gains a check that a statement the database refuses and the callback catches never lets a transaction resolve as if it wrote nothing; both adapters pass it, each its own way.
- data-postgres's tests need a server (`MESH_TEST_POSTGRES_URL`); CI runs a `postgres:16.16` service for the group that runs them, and without the variable outside CI they are skipped and `verify` says so.

## Action items

- [x] The adapter without events: transactions, error mapping, the dialect, the schema generator, `createSchema`, `mesh db push`, contract and condition conformance (M9, this pull request).
- [x] The outbox with the reader rule and core's delivery state with the claim's row lock (M9).
- [ ] `LISTEN`/`NOTIFY` wake-ups and the user docs (M9).
