---
title: "0051. Entity files end in `.mesh.mx`; Mesh ships an MX host named `mesh`"
description: "Decision record 0051: the file extension, the MX host package, and the MX features entity file syntax v2 depends on. Status: Accepted."
---

# 0051. Entity files end in `.mesh.mx`; Mesh ships an MX host named `mesh`

## Status

Accepted. Amends [ADR-0002](./0002-resource-files-are-mx.md) (the file name).

## Date

2026-10-05

## Deciders

operator (Saulo Vallory) for the extension; the lead, delegated by the operator, for the host package (following MX decision 148, which the MX lead relayed as an operator ruling on the MX side)

## Context

Entity files were plain `.mx` files ([ADR-0002](./0002-resource-files-are-mx.md)). MX is the separate project that parses them. Two things changed on 2026-10-05.

First, a plain `.mx` name says nothing about Mesh: a `.mx` file anywhere in a project could be a Marko-syntax file for another tool. A distinct extension lets an editor, a search and an agent tell entity files apart. `.mesh` alone was considered and rejected: a search for "mesh language" finds another project.

Second, MX already gives the segment before `.mx` a meaning: in `name.host.mx`, `host` names an MX *host* (MX decision 136). A host is a package that tells MX tooling how to read a file kind: its target, its contracts and its defaults. So `invoice.mesh.mx` makes MX tooling look for a host called `mesh`.

Entity file syntax v2 ([ADR-0050](./0050-entity-file-syntax.md)) also needs MX features that were not on MX `main` on 2026-10-05:

| Feature | MX decision | State on 2026-10-05 |
|---|---|---|
| `#name` after a space (`update #pay`); today only the glued form `update#pay` parses | 146 | Next in MX's queue |
| `:label` sugar (`check :dueAfterIssue [...]`); also fixes a crash on `value:Todo` | 146 | Next in MX's queue |
| A default tag for tagless `#field=value` lines under `set`: the parent contract's `defaultTag`, else `package.json#mx.data.defaultTag`, else the built-in `object` | 145 | The ladder and `object` landed; the per-parent `defaultTag` is in review |
| `imports: "pass" \| "reject"` on `parseData`: with `"pass"` the tree gains `imports: [{ code, span }]` in file order and control flow stays rejected | none (an additive option) | Scheduled |
| `on:load="visible"` arrives as one attribute named `on:load` | none | Final |
| A third-party host on the data target, registered through `mx.host` | 148 | Scheduled after 146 |

(MX project notes, updates; the MX lead's answers of 2026-10-05, recorded with the syntax rulings.)

## Decision

Operator, 2026-10-05, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Entity file syntax, continued (2026-10-05 morning, operator)", row "File extension":

> Entity and step files end in `.mesh.mx` (`invoice.mesh.mx`). Not `.mesh`: a search for "mesh language" finds another project.

The lead, delegated by the operator, same file, section "Decisions delegated to the lead (2026-10-05)", row "MX host":

> Mesh ships an MX host package named `mesh` on the data target, so `.mesh.mx` resolves in MX tooling (MX decision 148). Until MX's side lands, files run through MX tooling stay `.mx`.

The host descriptor is where Mesh sets its default-tag override and permits a per-parent `defaultTag` (on `set`). A file holds exactly one entity.

Mesh keeps calling `parseData` directly in the build, with its contracts passed in ([ADR-0043](./0043-mx-is-core.md)); the host is for MX tooling (the editor and other MX commands), not for the build.

## Options considered

### Option A: `.mesh.mx` with a `mesh` host (chosen)

**Pros:** entity files are recognisable by name; MX tooling finds Mesh's contracts through the host instead of a scan; the host is the one place for Mesh's MX settings.
**Cons:** one more package to ship; depends on MX decision 148.

### Option B: plain `.mx`

**Pros:** works today.
**Cons:** entity files cannot be told from other Marko-syntax files; contracts are found only by scanning.

### Option C: `.mesh`

**Pros:** shortest.
**Cons:** MX tooling would not treat the file as MX; the name collides in searches with another project.

## Trade-off analysis

Option A costs one host package and a wait on MX; both are needed anyway for editor support. Until MX lands 146 and 148, the code and any file run through MX tooling use plain `.mx` and the glued `kind#name` form; the docs already show the target form.

## Consequences

- The build discovers `**/*.mesh.mx` under `src/domain/` ([ADR-0057](./0057-one-domain-modules-as-folders.md)).
- The composed contracts module ([ADR-0021](./0021-composed-contracts-module.md)) becomes what the host hands to MX tooling.
- Until decision 146 lands, a file with `update #pay` does not parse; the realignment task writes `update#pay` in fixtures or waits.
- Mesh reads helper imports from `imports: "pass"`; until that option lands, an entity file with an `import` line does not parse.
- Reusable step files, when they come, use the same extension ([ADR-0053](./0053-validate-then-do.md)).

## Action items

- [ ] After MX 148 lands: build the `mesh` host package; the MX lead says what it must export.
- [ ] After MX 145 (per-parent `defaultTag`) lands: declare `defaultTag` on `set`.
- [ ] After MX 146 and `imports: "pass"` land: switch fixtures to `#name` after a space and to `.mesh.mx`.
