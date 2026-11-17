---
title: "0088. Translated conditions cross the data layer as bound condition trees"
description: "Decision record 0088: how a read's filter, its sort keys and its record-reading read policies reach the database: a plain-data condition tree, bound in memory, set only by generated code, honoured by adapters that declare the conditions capability. Status: Accepted (lead ruling D32, pending operator review)."
---

# 0088. Translated conditions cross the data layer as bound condition trees

## Status

Accepted (lead ruling D32, pending operator review). Amends [ADR-0010](./0010-one-expression-tree-two-evaluators.md) (what crosses the contract) and [ADR-0013](./0013-data-layer-contract-and-capabilities.md) (the contract's new fields and the `conditions` capability). Decides what [the data layer in depth](../in-depth/data-layer.md) lists as still open: whether the tree replaces or extends the M3 filter type, whether a caller's filter is converted to a tree, and how the three sources of a read's rows combine.

## Date

2026-11-17

## Deciders

lead, delegated: ruling D32 of 2026-11-17 takes every recommendation of the reviewed M10 SQL translation design (open decisions O1 to O11); it waits for the operator's review with the other rulings of that run.

## Context

The spec requires SQL in three places: a read's declared `filter=`, a key of a read's `sort`, and every condition of a policy that covers a read or a load ([ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md): "where SQL is required, a function that does not translate is an error"). Until M10 the build had only the in-memory evaluator, so a read with its own filter or sort threw when it ran and a read policy that reads the record was a build error.

The data-layer contract carried one query type, `Filter`, which is plain data over the entity's own attribute names ([ADR-0013](./0013-data-layer-contract-and-capabilities.md)). It is what a caller sends over the wire, so it cannot reach another table. A translated condition can: `&customer.ownerId === actor.id` reads a related row. And a translated condition reads values only the call has (`input`, `actor`, `%.today`, an imported helper's result), which the database cannot compute.

## Decision

1. **A separate, generated-only field.** `Query` gains `where` (a condition every returned row must make true, ANDed with `filter`) and `order` (the order, in place of `sort`; both together is a `FrameworkError`), and `max` and `count` gain a `where` argument. Generated code builds every `Query` itself, so `where` and `order` can only come from the build; a caller's `Filter` is never converted into a condition and never reaches another table.
2. **The tree is the condition, not the model's expression tree.** At build time a translated function in a SQL position is lowered to a `ConditionLiteral` (`@meshfw/runtime`, `condition.ts`): a closed, plain-data `ConditionNode` tree of columns by depth, values, calls of the registered functions, and relationship hops (`one`, `some`, `every`, `count`, `first`, and `rollup` since the 2026-11-17 amendment of [ADR-0096](./0096-rollups-run-as-one-grouped-query-per-route.md), a rollup read over its route), with numbered parameter slots. It names entities by FQN, so it imports no schema.
3. **Parameters are computed in memory.** Each maximal record-independent part of the condition (`input.customerId`, `isStaff(actor)`, `%.today`) is evaluated with the emitted in-memory form when the read runs and bound as a parameter (O2), so both evaluators agree on it by construction. `bindCondition` puts the values in, refuses one whose type differs from the class it meets (SQLite would convert it and answer differently from memory, O5), resolves hops to table handles and folds what no longer reads a row by the Kleene tables, keeping unknown apart from false.
4. **A declared capability, `conditions`.** An adapter that declares it honours `where`, `order` and the aggregates' `where`, and runs every core function (the expression tables through the data layer, [ADR-0012](./0012-expression-semantics.md)). It is a capability and not part of the mandatory set for a security reason: `where` carries the read policies, and an adapter written against the old contract that ignored the unknown field would return rows a policy denies. So the build refuses a condition for an adapter that does not declare it, and the run time refuses too (`whereFor`). A hop is a correlated subquery and also needs `joins` (O8); a per-function declaration waits for extension functions.
5. **One order on every database.** Nulls are the smallest value and strings order by code point (O4); a dialect writes what its database needs for that. The caller's sort keys come first, then the read's declared keys, then the primary key (O3).
6. **The read policies fold per row.** A read whose covering policies read the record returns the rows for which at least one covering policy applies and every applying one passes, written over three-valued parts (`IS TRUE`, `IS FALSE`) so an unknown `when=` fails its policy and an unknown `forbid-if` forbids, as in memory.

The other rulings of D32: a new error code, `MESH_EXPR_NOT_SQL`, for a function in a SQL position that does not translate (O1); a related record read by a condition does not run its own entity's read policies (O7); SQL-position errors are reported by the build only until MX's editor support exists (O9); a `has-one` with several rows reads its lowest-key row in SQL and a dangling key reads as no row (O10); a `json` member is refused in every SQL position (O11); the caller's filter and sort by a translated computed field is the last pull request of the unit (O6).

## Options considered

1. A new branch of `Filter` holding a condition: one query type, but a caller could hand in a condition that reads other tables.
2. The model's `ExprNode` across the contract, evaluated by the adapter with a scope of values (`actor`, `input`, the clock): the adapter would have to evaluate helpers and the clock, and the two evaluators could disagree.
3. A separate `where`/`order` of bound condition trees, set only by generated code (chosen).

## Trade-off analysis

Option 3 keeps the wire type unchanged and closes the hole option 1 opens. Binding in memory (against option 2) means a part that throws in memory throws before the query even where a guard would have skipped it in memory; the answers never differ, and the spec already evaluates a helper's call once before the query. A declared capability costs an adapter a manifest entry; leaving `where` mandatory would make every adapter written before M10 leak rows silently.

## Consequences

- `@meshfw/data-drizzle` prints a condition through a small `SqlDialect` interface (`conditionSql`, `orderSql`); `@meshfw/data-sqlite` implements it and declares `conditions` and `joins`; `data-postgres` implements its own dialect and registers the same conformance.
- `@meshfw/runtime/testing` gains `dataLayerConditionConformance` and `expressionTablesThroughLayer`, which every adapter that declares `conditions` runs.
- Correlated subqueries run per row; without indexes on relationship keys a large table is scanned per row; the [roadmap](../roadmap/roadmap.md) plans indexes in its row "Identities, upsert, partial unique, indexes".

## Action items

- [x] The contract, the binder, the Drizzle printer, SQLite's dialect and the conformance suites (M10, first pull request).
- [x] Lowering, the build error and the generated reads for declared filters and sorts (M10, second pull request).
- [x] The per-row read policy fold and filtered loads (M10, third pull request).
- [x] The Postgres dialect (M9, [ADR-0089](./0089-postgres-adapter.md)).
