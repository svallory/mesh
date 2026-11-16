---
title: "0070. A `has-many` names the inverse it follows with `inverse=`"
description: "Decision record 0070: when Mesh cannot guess which `belongs-to` of the other entity a `has-many` follows, `inverse=:name` chooses the key. Status: Accepted, amended 2026-10-11 (DOM-32). Amended 2026-11-14 (a `has-many` through a link entity, `through=`, comes before 1.0). Amended 2026-11-16 (`through=` is built)."
---

# 0070. A `has-many` names the inverse it follows with `inverse=`

> **Amendment, 2026-11-16 (`through=` is built).** `has-many :name entity=Far through=Link` builds and loads ([Entities](../../docs/entities.md#many-to-many-a-has-many-through-a-link-entity)). The lead ruled its open points on 2026-11-14 (decision log D14 and D26, awaiting the operator's review), each the choice that can be relaxed later without breaking a project. (1) The entry is the link's `belongs-to` back to this entity, chosen by the ladder of this record (the only one, the one named after the entity, or the one `inverse=` names; with `through=`, `inverse=` names a `belongs-to` of the link). The exit, the key it leaves by, is the link's only `belongs-to` other than the entry whose target is `entity=`, not "the other key" as the amendment below says: a link may hold `belongs-to` to further entities (Hyper's `Dependency` has `createdBy`). None or several is a build error, and no option names the exit yet. (2) The errors reuse `MESH_UNKNOWN_ENTITY` and `MESH_ENTITY_REFERENCE` for the `through=` value and `MESH_NO_INVERSE` and the `MESH_INVERSE_*` codes for the entry and the exit, with through forms of their messages; a link that is this entity or the listed one is `MESH_ENTITY_REFERENCE` at the value (D26). (3) On a caller's load the read policies of the link and of the listed entity must both admit the caller. (4) The list holds each far record once, in its primary-key order. (5) A rollup over a through relationship is `MESH_NOT_IMPLEMENTED` naming M10. (6) A link row whose exit key is null adds nothing. (7) There was no stopgap: until this amendment the build refused `through=` as an unknown option. A through relationship only reads (the link's own actions write its rows), is loaded with two queries and no join, and `through=` stays an unknown option on `has-one` and `belongs-to`.

> **Amendment, 2026-11-14 (a `has-many` through a link entity comes before 1.0).** A many-to-many relationship is a `has-many` that names its link entity with `through=`: `has-many :courses entity=Course through=Enrollment` in `Student`. `through` is the word Ash, Rails, Sequelize and Django use. The relationship enters the link entity by the link's `belongs-to` back to this entity, chosen as `inverse=` chooses it for any `has-many` (the only one, or the one named when there are several), and leaves by the link's other `belongs-to`, which leads to the far entity. So `has-many :blockers entity=Task through=Dependency inverse=:dependent` in `Task` enters `Dependency` by `dependent` and leaves by its other key. The roadmap listed many-to-many as not planned; the operator moved it before 1.0 on 2026-10-18. No milestone is assigned ([roadmap](../roadmap/roadmap.md), section 5, "Before 1.0, milestone not assigned"). It is not built: the `has-many` contract takes no `through`, so the build refuses the option today as an unknown one (`MESH_UNKNOWN_OPTION`). Nothing else in this record changes.

> **Amendment, 2026-10-11 (DOM-32).** Two changes to the text below.
>
> 1. **The word is `inverse=`, not `via=`** (operator, 2026-10-11 10:12, ruled). The name follows Rails' `inverse_of:` and TypeORM's inverse side. `via` is no longer a Mesh word, with no alias: `via=:x` is an unknown option. The diagnostic codes `MESH_VIA_UNKNOWN`, `MESH_VIA_ENTITY` and `MESH_VIA_REQUIRED` are `MESH_INVERSE_UNKNOWN`, `MESH_INVERSE_ENTITY` and `MESH_INVERSE_REQUIRED`, and the model field `Relationship.via` is `Relationship.inverse`.
> 2. **A default ladder** (lead reading, awaiting operator review): `inverse=` is needed only when Mesh cannot guess. For a `has-many` or `has-one` of entity E with target T, the candidates are T's `belongs-to` that point back at E. No candidate: unchanged (no build error). One candidate: that one. Several: the one named after E in lower camel case (Collaborator's `memberships` follows Membership's `belongs-to :collaborator`, as Ash, Rails, Ecto, Sequelize and Lucid default the key to `<parent>_id`). Several and none named after E: the build error that lists the candidates. An authored `inverse=` always wins over the ladder, and one that names what the ladder would pick is legal and gets no diagnostic.
>
> Everything below is the original record, written with `via=`; read `via=` there as `inverse=`, and "required with more than one" as "required when the ladder cannot pick".

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
