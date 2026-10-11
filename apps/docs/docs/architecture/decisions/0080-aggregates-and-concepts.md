---
title: "0080. An aggregate is a file; a concept is a value object; a repository is a pattern"
description: "Decision record 0080: the `aggregate` file with `root` and `entities`, `concept` as the one construct for value objects, repository as a pattern only, and no prevention of an entity belonging to two aggregates. Status: Accepted (DOM-03, DOM-23, DOM-26, DOM-27, DOM-31)."
---

# 0080. An aggregate is a file; a concept is a value object; a repository is a pattern

## Status

Accepted. DOM-31 is the lead's reading, for operator review. No row is open.

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
5. **Mesh does not prevent an entity from being a part of two aggregates** (DOM-31, lead reading). The architecture rule ([ADR-0084](./0084-architecture-rules-are-core.md)) may warn about it, switchable off in `architecture.mesh.mx`; it is never a build error. Different views of the same tasks (Gantt, list, board) are read models, which may share entities freely.

```mx "work.mesh.mx (illustration)"
aggregate :TaskAggregate
  root entity=Task
  entities
    Dependency prop=:dependent
    Comment
```

## Options considered

D13: an `aggregate` option on each entity (a), an `aggregate` section in the root entity (b), an aggregate file (c, chosen). D17: `value` and `concept` as separate constructs (rejected: one idea, two words), a single `concept` (chosen), nothing; repository: a construct or a pattern (chosen for now).

## Trade-off analysis

A file puts the boundary in one place and lets a reader see a whole aggregate. It costs one more file kind and makes a Task's boundary live apart from the Task. Allowing an entity in two aggregates keeps read models free and lets a project choose; a warning catches the mistake without forbidding the choice.

## Consequences

- No existing record is superseded. [ADR-0057](./0057-one-domain-modules-as-folders.md) is unchanged: an aggregate file sits in its module folder.
- The concept tag has its own file under a `concepts` folder in the tag-discovery design ([ADR-0085](./0085-tag-discovery-for-dialect-tags.md)).
- Aggregates and concepts are not built and are after 1.0 unless the port needs them (RDM-01).

## Action items

- [ ] Syntax detail for `entities` (the MX side) and `concept` fields, when built.
