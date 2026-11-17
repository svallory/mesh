---
title: "0096. Rollups run as one grouped query per route"
description: "Decision record 0096: how a rollup reaches the database: the data layer's rollup operation, one grouped statement per 500 owner rows, a joined route printed with the hops of translated conditions, each reached record once per owner row, and the joins capability only where a route crosses more than one table. Status: Accepted (lead ruling D33, pending operator review)."
---

# 0096. Rollups run as one grouped query per route

## Status

Accepted (lead ruling D33, pending operator review). Amends [ADR-0013](./0013-data-layer-contract-and-capabilities.md) (a new operation, and what `joins` covers) and [ADR-0070](./0070-has-many-via.md) (decision log D14(5): a rollup over a `through=` relationship builds). Builds on [ADR-0088](./0088-translated-conditions-cross-the-data-layer-as-bound-trees.md), whose `Hop` and hop printer it reuses. The design is `notes/architecture/m10-rollups-design.md`, outside this site.

## Date

2026-11-17

## Context

A rollup (`sum :total of=&lines.amount`) aggregates the records a path through relationships reaches ([Entities](../../docs/entities.md#computed)). Until M10 the loader ran `count` and `max` over one `has-many` or `has-one` with the data layer's `count` and `max`, once per owner row, and the build refused the rest: `sum`, `avg` and `min`, a path that starts at a `belongs-to`, a path through more than one relationship, and a path through a link entity. A path through several relationships needs a join, and a load of many rows should not cost one query per row.

## Decision

1. **One operation, `rollup`.** The data layer gains `rollup(query): Promise<RollupRow[]>`: one rollup for up to 500 owner rows (`ROLLUP_ANCHORS`) in one grouped statement, one result row per anchor that reaches a record. It is named after rollups, not aggregates, because [ADR-0083](./0083-names-for-the-new-constructs.md) gives "aggregate" its DDD meaning; the capability it needs keeps its older name, `aggregates`. `count` and `max` over one `has-many` or `has-one` keep their per-row calls for now (design OD3), which changes no running project's queries.
2. **A one-table route needs no join.** Over one relationship with no link entity the rollup reads the target's table, grouped by the column the relationship follows (`select id, max(rating) from customers where id in (...) group by id` for a `belongs-to`, the customer keys the owner rows hold being the anchors; `select invoiceId, sum(amount) from lines where invoiceId in (...) group by invoiceId` for a `has-many`). It needs `aggregates` only.
3. **A joined route is printed with the hops of conditions.** A path through several relationships, or through a link entity, carries `hops`: one `Hop` per relationship, as a translated condition carries it ([ADR-0088](./0088-translated-conditions-cross-the-data-layer-as-bound-trees.md)). The shared Drizzle code joins the tables with the same hop printer (`hopLink`), so the semantics of a `through=` hop (a far row once however many link rows lead to it, a link row with no exit skipped, D14) are written in one place, as ADR-0056 asks of relationship traversal. A joined route needs `joins` as well as `aggregates`; the build says so at the rollup (`MESH_CAPABILITY`), and the operation refuses hops without it.
4. **Each reached record counts once per owner row** (design OD1). The joins sit inside a distinct derived table keyed by the owner and the last table's key, so two lines of one product add its price once to `sum :catalogValue of=&lines.product.price`. This is the rule D14 already chose for `through=`; one semantics serves every path.
5. **Where a route starts.** A path that starts at a `belongs-to` starts from that target's table, anchored on its key, so owner rows that share a target share one anchor and a create's new instance whose key is filled is answered before its row exists; any other path starts from the owner's own table.
6. **Keys that point at nothing.** On a route made only of required `belongs-to` the rollup is not nullable in the model, so a key that points at no row is an error, as loading the relationship is. On any other route it adds nothing (design OD5): the type already admits `0` or `null`, and no schema Mesh emits has foreign keys yet.
7. **Policies.** On a caller's load every entity the path reaches, each link entity included, must admit the caller by its read policies, or the rollup is `0` (a `count`) or `null` with no query (design OD2). A read policy that reads the record is refused at build over any route the batched operation serves, until the operation takes row conditions.
8. **`sum` and `avg` always ask the database** (design OD4), so their value never depends on whether the relationship was already loaded: SQL's summation of floating-point values is not JavaScript's.

## Consequences

- The roadmap's "Rollups translated to SQL" row is built for computing rollups; filtering, sorting and authorizing by a rollup, a rollup under a record-reading read policy and a filter on a rollup are later parts of the same unit.
- An adapter implements one more seam in the shared Drizzle code, the optional `rows` command that runs a statement the shared code built; SQLite and Postgres implement it.
- A project whose data has a dangling required key now fails a read that loads a rollup over it, as it already failed a read that loads the relationship.

## Alternatives

- **A builder of joins of the rollup's own.** Rejected: it would write the `through=` semantics a second time and add a dialect command, against one place for traversal.
- **Count once per path (plain joins).** Rejected: a `through=` count would then count link rows, which D14 rejected, so two semantics would coexist.
- **Move `count` and `max` over one `has-many` to the batched operation now.** Left as a follow-up: it changes running projects' queries and buys no new result.
