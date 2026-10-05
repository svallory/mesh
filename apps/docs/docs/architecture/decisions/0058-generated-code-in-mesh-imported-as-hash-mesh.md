---
title: "0058. Generated code lives in `.mesh/`, is committed, and is imported as `#mesh`"
description: "Decision record 0058: the generated folder's name, its place in version control, and the import specifier. Status: Accepted."
---

# 0058. Generated code lives in `.mesh/`, is committed, and is imported as `#mesh`

## Status

Accepted

## Date

2026-10-04 (the folder and the specifier); 2026-10-05 (the folder name confirmed)

## Deciders

operator (Saulo Vallory); the lead, delegated by the operator, for keeping the name `.mesh/`

## Context

Generated code carries Mesh's behaviour, so it is committed and guarded: `mesh build --check` regenerates it and fails on any difference ([ADR-0003](./0003-generated-code-carries-behaviour.md); [generated code and the guard](../in-depth/generated-code-and-guard.md)). Until 2026-10-04 the folder was `generated/`, set by the configuration's `output` key, and application code imported it by path (`import { createTodo } from "../generated"`, [ADR-0047](./0047-actions-are-bound-to-a-data-layer.md)).

A path import ties every application file to where the folder is. A visible top-level `generated/` also invites people to read or edit it when they should not have to think about it.

## Decision

Operator, 2026-10-04 evening, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings on the user docs, layout and terms", rows "Generated folder" and "Import specifier":

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
