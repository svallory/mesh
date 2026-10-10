---
title: "0069. `json` is an attribute type"
description: "Decision record 0069: a core attribute type for maps and arrays that Mesh stores and validates as JSON and types as `unknown`. Status: Accepted."
---

# 0069. `json` is an attribute type

## Status

Accepted

## Date

2026-10-10

## Deciders

operator (Saulo Vallory), accepting [roadmap revision 5](../roadmap/roadmap.md) on 2026-10-10 at 09:05, decision D7 with its recommended option.

## Context

Entity file syntax has ten attribute types ([ADR-0050](./0050-entity-file-syntax.md)); none holds a map or an array. The [vocabulary mapping](../roadmap/vocabulary-mapping.md) leaves arrays "not scheduled". Hyper stores six such attributes (`Submission.evidence`, `LateResult.evidence`, `Run.inputs`, `Run.outcome`, `Attempt.outcome`, `Event.changes`) and passes two argument shapes of the same kind ([gap G10](../research/hyper-port-gap-analysis.md)). The compiler rejects `json :data` today: `<json> is not a known tag` (probe P02 of the [gap analysis](../research/hyper-port-gap-analysis.md#54-probes-what-the-contracts-reject)).

[Revision 4](../roadmap/roadmap.md) would have delivered a new attribute type as an extension contribution (the extension host, M6). The host now comes after 1.0 ([ADR-0072](./0072-mesh-1-0-is-the-port-gate.md)), so the type has to be core.

## Decision

`json` is a core attribute type. The tag is `json :evidence`.

- **Validation.** The generated validator accepts any JSON value (an object, array, string, number, boolean or null) and rejects anything JSON cannot hold. It does not validate a shape.
- **TypeScript.** The record and input types carry `unknown`. The caller narrows it.
- **Storage.** A SQLite text column holding the JSON text; the adapter serialises and parses it. A Postgres adapter would use `jsonb`.
- **Options.** `nullable` and `default=` (a JSON literal) work as on any attribute. `unique`, `min`, `max` and `match` are build errors on it.
- **Where it cannot go.** A `json` attribute is not a rollup operand and cannot be compared in a `filter`; a caller who needs to query inside it models the field as columns.
- **Count.** The registry has eleven attribute types.

## Amendment (2026-10-10, lead ruling under delegation)

A `json` attribute that is not `nullable` rejects `null`; only a `nullable` one accepts it, and stores it as SQL NULL. The Decision above said the validator accepts `null`. The reason: the Drizzle column (`text` in `json` mode) writes a JavaScript `null` as SQL NULL, so a NOT NULL column refuses it, and in TypeScript the JSON value `null` and "no value" are the same `null`. Storing the text `"null"` would need a custom column type and no caller could tell the difference. None of Hyper's six `json` attributes needs a JSON `null` in a required column. The user docs say so in [Entities](../../docs/entities.md#the-types).

## Options considered

1. **A core `json` type (chosen).**
2. **Join entities for arrays and columns for maps.** Many new columns and entities, and the wire shape of Hyper would change.
3. **JSON text in a `string` attribute.** What the entity drafts did before this record: no validation and no type.

## Trade-off analysis

Option 1 is the smallest change that keeps the data and gets validation. It gives up queries into the value and any typing of its shape: a wrong shape inside a `json` column is found at the validator, not by the database, and a column has no foreign keys or checks. A typed shape (`shape=`) can come later without changing this record's behaviour.

## Consequences

- The attribute-type registry, the contracts, the validators, the types and the adapters gain one case each (M3).
- [Entities](../../docs/entities.md#the-types) lists it.

## Action items

- [ ] M3: the `json` tag, validator, TypeScript mapping and column type in `data-sqlite`.
