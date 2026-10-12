---
title: "0058. Generated code lives in `.mesh/`, is committed, and is imported as `#mesh`"
description: "Decision record 0058: the generated folder's name, its place in version control, and the import specifier. Status: Accepted, amended 2026-10-11 (generated imports follow folder modules), amended 2026-10-12 (entity values and barrels)."
---

# 0058. Generated code lives in `.mesh/`, is committed, and is imported as `#mesh`

## Status

Accepted

**Amended 2026-10-11 (operator, CMP-12/CMP-17).** Generated imports follow folder modules. `#mesh` stays the specifier of `.mesh/index.ts`, but it now exports only the framework's names: `bind`, `connect`, `disconnect`, `transaction`, `privileged`, the `Binding` and `Privileged` types and the adapter's `tables`. A folder's entities (each a value with its actions, and its types) are imported from `#mesh/domain/<folder>` (`#mesh/domain/tasks`, `#mesh/domain/sales/billing`), and those of the domain root from `#mesh/domain`. The project's `package.json` has three entries:

```json
"imports": {
  "#mesh": "./.mesh/index.ts",
  "#mesh/domain": "./.mesh/domain/index.ts",
  "#mesh/domain/*": "./.mesh/domain/*/index.ts"
}
```

Each module's generated files, its `index.ts` among them, live in `.mesh/domain/<module>/`, apart from Mesh's own top-level files, so a module named `schema`, `load` or `index` cannot collide with them. Application code still never imports a folder path. The operator ruled the move (CMP-12) and the folder-module rule (CMP-17) on 2026-10-11, recorded in the project's decision log; that `#mesh` keeps only the framework's names is the lead's reading of CMP-17, for operator review. See [generated code and the guard](../in-depth/generated-code-and-guard.md#what-mesh-generates-and-commits). The rest of this record is unchanged and kept as history.

**Amended 2026-10-12 (operator, CMP-16, CMP-18).** The 2026-10-11 amendment's export list was `bind`, `connect`, `disconnect`, `transaction`, the `Actions` and `Reads` types and `tables`; it is now the list above, and an action function's name no longer has to be unique across the project ([finding 21](../open-questions.md#dx-findings) is settled). Each domain folder has one barrel `index.ts` (its entities, plus one namespace per subfolder), which `.mesh/binding.ts` walks; see [ADR-0086](./0086-entity-values-privileged-barrels-and-fqns.md).

## Date

2026-10-04 (the folder and the specifier); 2026-10-05 (the folder name confirmed)

## Deciders

operator (Saulo Vallory); the lead, delegated by the operator, for keeping the name `.mesh/`

## Context

Generated code carries Mesh's behaviour, so it is committed and guarded: `mesh build --check` regenerates it and fails on any difference ([ADR-0003](./0003-generated-code-carries-behaviour.md); [generated code and the guard](../in-depth/generated-code-and-guard.md)). Until 2026-10-04 the folder was `generated/`, set by the configuration's `output` key, and application code imported it by path (`import { createTodo } from "../generated"`, [ADR-0047](./0047-actions-are-bound-to-a-data-layer.md)).

A path import ties every application file to where the folder is. A visible top-level `generated/` also invites people to read or edit it when they should not have to think about it.

## Decision

Operator, 2026-10-04 evening, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings on the user docs, layout and terms (2026-10-04 evening, operator)", rows "Generated folder" and "Import specifier":

> Named `.mesh`, committed, guarded, marked `linguist-generated`. Users should not have to care about it; it is not hidden from them.

> Generated code is imported as `#mesh` (package.json `imports`), never by folder path.

The lead, delegated by the operator, 2026-10-05, same file, section "Decisions delegated to the lead (2026-10-05)", row "Generated folder":

> Stays `.mesh/` (the rename to `.mesh-out` was only considered together with a `.mesh` file extension, which was rejected).

So the project's `package.json` has `"imports": { "#mesh": "./.mesh/index.ts" }`, application code imports `#mesh`, and `.gitattributes` marks `.mesh/** linguist-generated` so code review tools collapse it. `.mesh/index.ts` exports `connect`, `disconnect`, `bind` and every action function and type.

## Options considered

### Option A: `.mesh/`, committed, `#mesh` (chosen)

**Pros:** one stable specifier whatever the layout; the dot keeps the folder out of the way in listings without hiding it from Git; review tools collapse it.
**Cons:** dot-folders are skipped by some tools by default (globs, some editors), so Mesh's own discovery must include them.

### Option B: `generated/`, imported by path

**Pros:** what M1 built.
**Cons:** path imports break when files move; a prominent folder invites edits.

### Option C: gitignored output, like Prisma's client

**Pros:** smaller diffs.
**Cons:** reviewers no longer see what runs, which defeats [ADR-0003](./0003-generated-code-carries-behaviour.md); the guard cannot catch hand edits to a file nobody commits.

## Trade-off analysis

Option A keeps the reason for committing (reviewers read what runs) and removes the two costs of `generated/`: path coupling and visual weight.

## Consequences

- The guard, the writer and the config loader treat `.mesh/` like any output folder; dot-prefixed paths are already discovered ([build pipeline](../in-depth/build-pipeline.md), stage 1).
- The code on `main` and the blog example still write `generated/` until the realignment task.
- [ADR-0047](./0047-actions-are-bound-to-a-data-layer.md)'s example imports change to `#mesh`.

## Action items

- [ ] Realignment task: default output `.mesh/`, the `imports` entry and `.gitattributes` in the example and in `mesh init`.
