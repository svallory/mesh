---
title: "0080. An aggregate is a file; a concept is a value object; a repository is a pattern"
description: "Decision record 0080: the `aggregate` file with `root` and `entities`, `concept` as the one construct for value objects, repository as a pattern only, and no prevention of an entity belonging to two aggregates. Status: Accepted (DOM-03, DOM-23, DOM-26, DOM-27, DOM-31)."
---

# 0080. An aggregate is a file; a concept is a value object; a repository is a pattern

> **Amendment, 2026-11-17 (aggregate files built).** The aggregate file is built (rulings D10 and D35 in the lead's decision log; design `notes/architecture/aggregates-design.md`). Mesh's dialect sets MX's `bindingsCallTags: false`, so an imported name is a plain tag name, and the `entities` section claims each part line through a wildcard child whose head is a reference (`Dependency`, `talk.Comment`) and whose only option is `prop=`. The aggregate's name is kept as written, since nothing is generated from it, and binds nothing: an import of it is `MESH_UNKNOWN_IMPORT`. A part's link to the root is the `belongs-to` that `prop=` names, else its only `belongs-to` to the root; none, several with no `prop=`, a `prop=` that names no `belongs-to` to the root, and the root listed as a part are `MESH_AGGREGATE_PART`, a part listed twice `MESH_DUPLICATE_MEMBER`, two aggregates of one FQN `MESH_DUPLICATE_ENTITY`, and a helper or `meshfw` import `MESH_UNKNOWN_IMPORT`. An aggregate's `events` and `commands` sections are an entity's; the actions of its root and of its parts may publish the events it owns. The model records it as `ModelDocument.aggregates` (`model.json`, present only when a project declares one); no TypeScript is generated. The warnings about an entity in two aggregates and an action that calls another aggregate's action belong to the architecture file, not built.

> **Amendment, 2026-11-17 (concept files built).** A concept file, `concepts/Money.mesh.mx` with `concept :Money` and field lines, builds into `ModelDocument.concepts` and generates a type and a Zod schema exported by its module's barrel ([ADR-0092](./0092-concepts-are-found-by-mx-and-stored-as-one-json-value.md), lead ruling D36). A concept use (`Money :total`) resolves to the nearest concept and builds a member stored as one JSON value (concept-typed members, built in the same run; ADR-0092's amendment).

## Status

Accepted. No row is open. DOM-31 is the operator's ruling; the warning note attached to it is a lead reading, for operator review.

Rows: DOM-03, DOM-23, DOM-26, DOM-27, DOM-31.

## Date

2026-10-11

## Deciders

operator (Saulo Vallory), 2026-10-11 (DOM-03 at 06:40 and 07:07; DOM-31 at 09:16).

## Context

Hyper's Task and its Dependency rows form one consistency boundary, which Mesh cannot say today. The [study](../research/domain-concepts.md) (D13 and D17) asked how an aggregate is declared, whether value objects are a construct, and whether a repository is.

## Decision

1. **An aggregate is declared in an aggregate file** (DOM-23, option c). Its root is `aggregate :Name`; a `root entity=Name` line names the root entity; an `entities` section lists one part per line, each written as the entity's name (DOM-03). A part with two links to the root names the one that ties it to the root with `prop=`: `Dependency prop=:dependent`. MX can let `entities` accept any tag name and read each as one tag. `root Task` was dropped because Mesh has no `<tag> <Name>` form anywhere: entity references are `entity=Name`.
2. **An aggregate contains concepts through its entities' attributes** (DOM-23).
3. **`concept` is a shared understanding of something with no identity**, with as many fields as it needs (Country: name, abbreviation, population, flag, languages) (DOM-26). It is the same thing as a value object, so it is one construct; it replaces the study's `value`.
4. **A repository is allowed as a pattern, and is no construct for now** (DOM-27). A construct may come later.
5. **Mesh does not prevent an entity from being a part of two aggregates** (DOM-31, ruled). Different views of the same tasks (Gantt, list, board) are read models, which may share entities freely.

   **Lead reading, for operator review:** the architecture rule ([ADR-0084](./0084-architecture-rules-are-core.md)) may warn about an entity in two aggregates, the warning switchable off in `architecture.mesh.mx`, and it is never a build error. This note is not ruled.

```mx "work.mesh.mx (illustration)"
aggregate :TaskAggregate
  root entity=Task
  entities
    Dependency prop=:dependent
    Comment
```

## Options considered

D13 in the study: (a) a `part-of` flag on the `belongs-to` (recommended); (b) `part-of=&rel` on the entity line; (c) nothing. The ruling replaced them with the aggregate file (DOM-03, DOM-23), which is a new option the study did not list. D17: `value` and `concept` as separate constructs (rejected: one idea, two words), a single `concept` (chosen), nothing; repository: a construct or a pattern (chosen for now).

## Trade-off analysis

A file puts the boundary in one place and lets a reader see a whole aggregate. It costs one more file kind and makes a Task's boundary live apart from the Task. Allowing an entity in two aggregates keeps read models free and lets a project choose; a warning catches the mistake without forbidding the choice.

## Consequences

- No existing record is superseded. [ADR-0057](./0057-one-domain-modules-as-folders.md) is unchanged: an aggregate file sits in its module folder.
- The concept tag has its own file under a `concepts` folder in the tag-discovery design ([ADR-0085](./0085-tag-discovery-for-dialect-tags.md)).
- Aggregate files are built (amendment above); concept files and concept-typed members are built ([ADR-0092](./0092-concepts-are-found-by-mx-and-stored-as-one-json-value.md)). No row dates them. RDM-01 applies: not before the port unless the port needs them, and as many planned constructs as possible before 1.0.

## Action items

- [x] Syntax detail for `entities` (the MX side), done 2026-11-17: see the amendment above.
- [x] Syntax of `concept` fields, done 2026-10-17: a concept file's root line is `concept :Name`, and its fields are field lines written as an event's (a kind, a name, options), for example `concepts/Money.mesh.mx`.
