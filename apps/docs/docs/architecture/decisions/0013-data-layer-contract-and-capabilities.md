---
title: "0013. Data-layer contract with declared capabilities"
description: "Decision record 0013: Data-layer contract with declared capabilities. Status: Accepted."
---

# 0013. Data-layer contract with declared capabilities

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Ruling 4); the manifest, closed union and conformance suite are the roadmap author's design (roadmap M3), which the lead or the operator may overrule

## Context

A *data layer* is the part of a framework that talks to a database. Mesh must work with more than one (SQLite and Postgres in v1). Ash, the Elixir framework Mesh is modelled on, defines the data layer as one behaviour with 46 callbacks, 44 of them optional, plus a `can?/2` probe with 47 distinct feature names. When a feature is missing, core reacts inconsistently: "sometimes an exception, sometimes a string, sometimes a silent in-memory fallback" ([research synthesis](../research/synthesis.md), section 2.2; [Ash runtime internals](../research/ash-runtime-internals.md), sections 3.1 to 3.3). The feature type is also not exhaustive: core queries features it never declares ([Ash runtime internals](../research/ash-runtime-internals.md), section 3.2).

## Decision

Ruling 4, operator, 2026-10-04, [rulings of 2026-10-04](./rulings-2026-10-04.md), table of eight rulings:

> Select, insert, update, delete, transactions, filters, sort, pagination. Joins, aggregates, upserts and atomic expressions are declared capabilities; using one an adapter lacks is a build-time error, never a silent in-memory fallback.

The roadmap author's design on top ([roadmap](../roadmap/roadmap.md), M3): each adapter publishes a *capability manifest*, static data and a closed union of names, which the build reads without starting the adapter. A resource that uses a capability the adapter lacks fails the build at the resource-file position. A conformance suite, which every adapter must pass, tests the mandatory set and each declared capability. The contract is Mesh's own and sits at the level of resources, not of a query library ([research synthesis](../research/synthesis.md), section 11).

## Options considered

### Option A: Mandatory set plus static capability manifest (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: a closed union, a build check, a conformance suite |
| Cost | Moderate in M3; each new capability adds suite cases |
| Failure timing | Build time, with file and line |
| Reversibility | Names can be added to the union; removal breaks adapters |

**Pros:** missing features surface before deployment; agents and people can read the manifest.
**Cons:** the manifest can lie; only the suite catches that. A static manifest cannot express capabilities that depend on the server (a Postgres version, SQLite compile options). With one real adapter until M9, the contract is untested against a second dialect ([roadmap](../roadmap/roadmap.md), M3 risks).

### Option B: Ash-style run-time probe with fallbacks
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: every call site decides how to degrade |
| Cost | Low at first, high later |
| Failure timing | Run time, sometimes silent |
| Reversibility | Hard; behaviour depends on fallbacks |

**Pros:** more programs run on weak adapters.
**Cons:** the inconsistency the research documents, including silent in-memory evaluation of filters. The ruling forbids it.

### Option C: Run-time probe that throws, with no fallback
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: adapter answers a probe at start-up or per call |
| Cost | Moderate |
| Failure timing | Start-up or first use, not build |
| Reversibility | Easy to add later beside a manifest |

**Pros:** honest about version-dependent capabilities; no silent fallback.
**Cons:** the error appears after deployment, or only on the code path that uses the capability; the build cannot report it.

### Option D: Expose the query library directly
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low at first |
| Cost | Leaks into generated code |
| Failure timing | The library's own |
| Reversibility | Very hard |

**Pros:** no contract to write.
**Cons:** filters, joins and aggregates have four different shapes across Drizzle, Kysely, TypeORM and Prisma; relation loading, schema ownership, migrations and pooling cannot be covered ([research synthesis](../research/synthesis.md), section 11).

## Trade-off analysis

The ruling removes B. A beats C for v1 on one point: a missing capability is found at build time, not after deployment. C addresses what A cannot see; it can be added beside A if a version-dependent capability appears.

## Consequences

Easier: adding an adapter; reading what it supports. Harder: each capability needs conformance cases before merging. Revisit the closed union when upserts and bulk work arrive after v1 ([ADR-0019](./0019-v1-scope.md)), and A against C if a capability depends on server version.

## Action items
- [ ] M3: manifest type, build check, conformance suite.
- [ ] M5, M7: add atomic expressions, joins and aggregates in every merged adapter.
- [ ] M9: Postgres passes the whole suite.
