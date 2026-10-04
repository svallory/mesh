---
title: "0045. How `has-one` is kept to one row"
description: "Decision record 0045: How `has-one` is kept to one row. Status: Proposed."
---

# 0045. How `has-one` is kept to one row

## Status

Proposed

## Date

2026-10-04

## Deciders

operator. The lead accepted option A for v1 on 2026-10-04 as a working assumption; proposed by the roadmap author.

## Context

A `has-one` relationship says that a record has at most one related record: a user has one profile. In the database it is the same as `has-many`: the related table carries a foreign key. Nothing in that shape stops two profiles from pointing at one user.

Ash, the Elixir framework Mesh is modelled on, does not stop it either: when several rows match, a `has_one` is truncated to one ([research synthesis](../research/synthesis.md), section 6, item 7, among the run-time surprises). Ash logs a warning when that happens and says it will become an error ([Ash runtime internals](../research/ash-runtime-internals.md), section 12.B, item 2). Ash also has an option for the case where picking one of many is intended: `from_many?` on `has_one`, used with a sort, as in "the latest comment" ([Ash features](../research/ash-features.md), section 3). Mesh's principle is that nothing fails silently ([roadmap](../roadmap/roadmap.md), section 2, principle 2).

The natural fix is a declared unique key on the foreign key. Ash calls declared unique keys *identities*. In Mesh identities come after v1 ([rulings of 2026-10-04](./rulings-2026-10-04.md), "Rulings after the decision review", row "After v1"), while `has-one` is in v1 ([roadmap](../roadmap/roadmap.md), M7). Mesh's vocabulary copies Ash's DSL ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md)), so anything Mesh does here beyond what Ash does is a deviation that needs recording.

## Decision

Not decided. Working assumption for v1, accepted by the lead: option A, an implicit unique index. It blocks M7.

## Options considered

### Option A: An implicit unique index on the foreign key of a `has-one` target

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: the schema emitter adds one index |
| Cost | Low |
| Fidelity to Ash | Deviates: Ash adds no constraint |
| Surprise for authors | An index and a constraint appear that no tag declared |

**Pros:** The database enforces the meaning of the relationship. No new vocabulary, so the "identities after v1" ruling stands.
**Cons:** A second writer gets a constraint error from the database, which Mesh must turn into a readable error. Implicit schema is harder to see; it shows only in the emitted schema file and in `mesh explain`.

### Option B: A build error unless the foreign key is declared unique

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low once identities exist |
| Cost | Needs identities, which are after v1 |
| Fidelity to Ash | Uses Ash's own construct; stricter than Ash |
| Surprise for authors | None: what is declared is what exists |

**Pros:** Explicit. Fits "one way to do each thing".
**Cons:** Not available in v1 without pulling identities forward, which would override an operator ruling.

### Option C: Do as Ash does today

| Dimension | Assessment |
|-----------|------------|
| Complexity | None |
| Cost | None |
| Fidelity to Ash | Exact, for now: Ash plans to turn its warning into an error |
| Surprise for authors | A relationship that returns one of several rows, with a logged warning |

**Pros:** Strict copy of Ash's current behaviour.
**Cons:** A quiet fallback of the kind Mesh's principles forbid, one of the documented complaints about Ash, and a behaviour Ash itself intends to remove.

### Option D: Unique index unless `from-many` is set

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: one new option, a required sort, a different load query |
| Cost | New vocabulary in M7 |
| Fidelity to Ash | Closest: it is Ash's own construct (`from_many?`, spelled `from-many` in Mesh) plus the constraint Ash lacks |
| Surprise for authors | Low: uniqueness is the default, and choosing one of many is written down |

**Pros:** Covers the pattern option A makes impossible: a resource with `has-many comments` and `has-one latest-comment` over the same foreign key. Under A the index would reject the second comment. Never truncates silently, because picking one of many requires both the option and a sort.
**Cons:** More vocabulary and one more query shape in a milestone that is already large. The vocabulary mapping lists `has_one` with no options for v1.

## Trade-off analysis

C copies Ash exactly, and copies a defect Ash has said it will remove. D is the most faithful to Ash's vocabulary and the only option that keeps the "one of many, by a sort" use; A rules that use out until `from-many` exists. A and B both enforce the relationship; they differ in whether the constraint is implied or declared. B is the cleaner end state and A is the one that fits v1. They are compatible: when identities arrive, the implicit index can become a required declaration, with a build error that tells the author what to add.

## Consequences

- v1 schemas contain an index that no tag declared; the docs for `has-one` must say so.
- Under A, a `has-one` and a `has-many` cannot share a foreign key in v1; the build should reject that combination with an error that names `from-many` as not yet available.
- A unique-constraint violation needs its own run-time error class or a mapping to the invalid-input class.
- Moving from A to B later is a breaking change for resource files that use `has-one`, softened by a precise build error.

## Action items

- [ ] M7: emit the unique index; map the constraint violation to a Mesh error; cover it in the conformance suite on every adapter.
- [ ] M7: build error when a `has-one` shares its foreign key with a `has-many`.
- [ ] After v1, with identities: decide between keeping A and requiring the declaration (B), and whether to add `from-many` (D).
