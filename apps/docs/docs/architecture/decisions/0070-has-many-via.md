---
title: "0070. A `has-many` names the inverse it follows with `via=`"
description: "Decision record 0070: when the other entity has several `belongs-to` back to this one, `via=:name` chooses the key. Status: Accepted."
---

# 0070. A `has-many` names the inverse it follows with `via=`

## Status

Accepted

## Date

2026-10-10

## Deciders

operator (Saulo Vallory), accepting [roadmap revision 5](../roadmap/roadmap.md) on 2026-10-10 at 09:05, decision D7 with its recommended option.

## Context

A `has-many :memberships entity=Membership` follows the key that Membership holds back to this entity. Hyper's Membership has three `belongs-to` to Collaborator (`collaborator`, `grantedBy`, `revokedBy`) and its Dependency two to Task; the compiler accepts the `has-many` without saying which key it follows, and the model records no key ([gap G28](../research/hyper-port-gap-analysis.md)). The [entities page](../../docs/entities.md#names-and-references) reserves `&name` for a member of this entity, so `via=&collaborator` would name a member of the other entity with a spelling that means something else everywhere ([ADR-0067](./0067-members-imports-input-static-files.md)).

## Decision

`has-many` takes an optional `via=`, an **atom** naming the other entity's `belongs-to`:

```text
has-many :memberships entity=Membership via=:collaborator
```

- With exactly one `belongs-to` from the other entity back to this one, `via` may be left out and that key is followed.
- With more than one, `via` is required; omitting it is a build error that lists the candidates.
- A `via` that names no `belongs-to` of the other entity, or one that points at a different entity, is a build error at the attribute, with a did-you-mean.
- `has-one` is unchanged.

## Options considered

1. **`via=:collaborator`, an atom (chosen).** An atom names a declaration or a fixed-set value ([ADR-0066](./0066-names-and-references-are-atoms.md)); here it names a declaration in another entity.
2. **`via=&collaborator`.** Reads as a member of this entity, which it is not.
3. **Infer from the name** (`:memberships` follows `membershipsId`): breaks as soon as names differ from the keys.

## Trade-off analysis

An atom is the only spelling in the file that names something without referring to this entity's members. The build cannot check an atom against this entity's members, so the check is a cross-file one (the other entity's relationships), which the build already makes for `entity=`. The cost is one more option on `has-many`.

## Consequences

- The model records the key a `has-many` follows, which relationship loading (M7) needs.
- [Entities](../../docs/entities.md#relationships) documents the option.

## Action items

- [x] M7: the contract attribute, the cross-file check and the loader (`front-end/relationships.ts`, `runtime/src/load.ts`).
- Lead ruling, pending operator review (decisions log 2026-10-10 14:50): anything the build knows will fail is a build error that names the milestone ([ADR-0018](./0018-not-implemented-is-a-build-error.md)). So a rollup or a computed field that goes through a `has-many` or `has-one` with no `belongs-to` back, a `sum`, `avg` or `min` rollup, and a rollup over a join are build errors. A relationship that nothing uses builds, and loading it is a run-time error. A `has-one` with several `belongs-to` back is a build error, because it takes no `via`.
