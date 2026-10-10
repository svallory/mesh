---
title: "0076. The compiler's front end and its TypeScript back end are separate folders"
description: "Decision record 0076: inside @meshfw/compiler, MX IR to MeshModel is a language-neutral front end, the model is the seam, and the TypeScript output is one back end that reads the model only. Status: Accepted."
---

# 0076. The compiler's front end and its TypeScript back end are separate folders

## Status

Accepted.

## Date

2026-10-10

## Deciders

operator (Saulo Vallory), 2026-10-10 at 06:42, corrected at 06:46 (extensions stay open; the expression language is replaceable in MX).

## Context

Mesh will later generate domains in Rust and Go as well as TypeScript. The compiler already has two halves that were never named: the part that reads an entity file into the model (MX, contracts, the builder) and the part that turns the model into files (views, Jig templates, emitters). They shared one flat `src/` folder, so nothing stopped the first from importing the second. The port to MX's `lowerSource` rewrites the first half anyway, so this is the cheap moment to draw the line.

## Decision

Inside `@meshfw/compiler`, with no new package and no plugin system:

| Folder | Holds | May import |
|:--|:--|:--|
| `src/front-end/` | Mesh's dialect, the contracts, the IR reader (`tree.ts`), the builder, rollups, the extension list | `@mxlang/core`, `@meshfw/model`, `src/model/`, `src/paths.ts` |
| `src/model/` | What crosses the seam besides the model itself: `BuildResult`, `ProjectDescription`, and how a diagnostic is made | `@meshfw/model` only |
| `src/typescript/` | Views, Jig templates, emitters, the formatter, the template lookup, the adapter-build loader | `@meshfw/model`, `src/model/`, `src/config.ts`, `src/paths.ts`; never `src/front-end/`, never `@mxlang` |

`src/config.ts`, `src/paths.ts` and `src/index.ts` are the project shell; the shell is the only code that calls both halves. The model is the `@meshfw/model` package: plain data with nothing about MX or about any output language.

- A test (`test/architecture.test.ts`) scans the imports of each folder and fails on the forbidden ones, and on any spelling of an entity-file extension outside the one list.
- The extensions are one exported list (`MESH_EXTENSIONS` in `src/front-end/extensions.ts`, `.mesh.mx` today) that the CLI, file discovery and the generators read. `.mesh` may be added later by adding an entry.
- Expressions today: the model stores an expression as its authored text, its parameter names and a position (`Expression.source`), and `model.json` emits that text, so a back end does see source-language text. The front end's expression reader is the only code that parses it.
- Target: only the expression reader knows the source language, and back ends read expressions from the model ([ADR-0010](./0010-one-expression-tree-two-evaluators.md)'s Mesh expression tree), not source. Carrying authored text is today's form until the M4 expression tree. Opaque expressions (not convertible to the tree) stay bound to the source language, and a second back end decides their handling when it is planned.

## Options considered

1. **Folders and an import test (chosen).** Costs a move and a test; a second back end is an added folder.
2. **Separate packages now.** Cleaner, but guesses the interface of a back end that does not exist.
3. **Leave it flat.** Nothing prevents the first TypeScript concept leaking into the model.

## Consequences

- A second back end is a sibling of `src/typescript/` that reads the model, not a rewrite.
- Splitting into packages waits until that second back end exists.
- The Jig templates moved with the back end, to `packages/compiler/src/typescript/templates/`.

## Action items

- [x] Move the files, add the import test.
- [ ] When a second back end is planned: decide its handling of opaque expressions, and whether the folders become packages.
