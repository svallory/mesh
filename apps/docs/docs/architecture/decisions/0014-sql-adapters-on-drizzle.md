---
title: "0014. SQL adapters are built on Drizzle and drizzle-kit"
description: "Decision record 0014: SQL adapters are built on Drizzle and drizzle-kit. Status: Accepted."
---

# 0014. SQL adapters are built on Drizzle and drizzle-kit

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (the standing position, Q3); lead (choice of Drizzle and drizzle-kit as its application); details by the roadmap author, which the lead or the operator may overrule

## Context

Mesh's SQL adapters (`data-sqlite`, `data-postgres`) need a way to build queries, map types and generate schema migrations. *Drizzle* is an established TypeScript query builder with SQLite and Postgres drivers; *drizzle-kit* is its companion that generates SQL migrations from a Drizzle schema. The question was whether to build on them or to print SQL from Mesh's own code. Plan revision 1 (not published) recommended the second, with medium confidence, against the research's lean towards Drizzle.

## Decision

The operator's ruling is a standing position, recorded as plan ruling Q3 in [rulings of 2026-10-04](./rulings-2026-10-04.md), "Implementation-plan rulings":

> Rely on established tools wherever possible (operator's standing position). SQL adapters use Drizzle for queries and drizzle-kit for migrations, behind Mesh's data-layer contract. Mesh still compiles its own expression tree into Drizzle's SQL builder.

The "Review note" in the same file separates who decided what: the row "records the operator's position ('the more we can rely on well-established tools the better'); choosing Drizzle and drizzle-kit specifically was the lead's application of it."

Details are the roadmap author's ([roadmap](../roadmap/roadmap.md), sections 3 and 9; [plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 8, D11 and D13): Drizzle is imported only in `data-*` packages and in the emitted schema file; versions are pinned exactly; the relations API is not used, so relationships compile to joins in `data-drizzle`; migrations are generated, reviewed and never applied automatically, and before calling drizzle-kit Mesh refuses destructive or ambiguous changes unless a flag names them. The commands that wrap drizzle-kit (`db push`, `migrate`) are contributed by the SQL adapters, so `cli` imports no query library. This supersedes [ADR-0015](./0015-sql-printed-by-mesh.md).

## Options considered

### Option A: Drizzle and drizzle-kit (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: two dialect-specific schema files and a compile step into the builder |
| Cost | Low to build; upgrades are real work |
| Bun fit | Documents `bun:sqlite` and `Bun.sql` ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 3) |
| Stability risk | High: v1 is a release candidate |

**Pros:** established (about 29.5M weekly downloads, [TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 1, "Data access"); schema of record and migrations come with it.
**Cons:** Drizzle v1 is a release candidate, the move from relations v1 to v2 is mandatory, and drizzle-kit is mid-rewrite ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 7, "Stability"; [research synthesis](../research/synthesis.md), sections 10 and 12, risk 1). The top five of the top 100 contributors wrote about 79% of the commits counted there ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 1).

### Option B: Kysely
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | Medium: a Bun SQLite dialect must be solved |
| Bun fit | No documented `bun:sqlite` dialect; the one community dialect pins `kysely@^0.28.2` |
| Stability risk | Lower: stable 0.29.6 |

**Pros:** stable releases; a DDL builder.
**Cons:** no schema-as-source-of-types, and migrations are hand-written without diffing ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 1, "Migrations", and section 4). The Bun gap is "a Kysely-shaped problem to solve" ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), "Implications for Mesh", item 4).

### Option C: SQL printed by Mesh (ADR-0015)
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: printer, drivers, type mapping, own differ |
| Cost | Highest |
| Bun fit | Direct on `bun:sqlite` |
| Stability risk | Own bugs |

**Pros:** no dependency on a release candidate. **Cons:** rebuilds what the operator's position says to reuse.

### Option D: Prisma
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: Mesh would emit `schema.prisma` and run Prisma's generator |
| Cost | Medium |
| Bun fit | Supported since Prisma 7 ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 3) |
| Stability risk | ORM 8 exists on npm only as a release candidate |

**Pros:** the most starred of the four (about 47,700 GitHub stars, against about 35,900 for Drizzle; [TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 1), though Drizzle has more weekly downloads. **Cons:** Prisma owns its schema file and migrations ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 1, "Migrations"), which conflicts with Mesh emitting the schema. TypeORM was not assessed further.

## Trade-off analysis

The operator's principle plus the contract boundary decides it: the risk of Drizzle's instability is contained by exact pins, one package family and the conformance suite.

## Consequences

Easier: SQLite and Postgres adapters; migrations. Harder: every Drizzle upgrade is its own pull request that must pass the suite. How drizzle-kit behaves without a terminal on an ambiguous change is not checked ([roadmap](../roadmap/roadmap.md), M9 risks).

## Action items
- [ ] M2: `data-sqlite` and `data-drizzle`; `db push` contributed by the adapter; import rule in `verify`.
- [ ] M3: Mesh query to Drizzle builder.
- [ ] M9: test drizzle-kit non-interactively first; adapters contribute `migrate`; destructive-change refusal.
