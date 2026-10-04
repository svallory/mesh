---
title: "How Mesh uses MX"
description: "How Mesh reads resource files through MX and what each side enforces."
---

# How Mesh uses MX

Status: the M1 loader and contracts are built, and `verify` checks the MX import boundary and complete MX samples in the Docs pages. M0 moved the contracts into `packages/compiler`; M1 aligned the vocabulary with Ash's DSL; the composed contracts module is built in M6.

## What MX is, and why it is core

MX is a separate project that parses Marko-syntax files. For Mesh it offers a "data" target: `@mxlang/data` returns a static tree of tags and attributes with contracts enforced at parse time. Nothing in the file is executed; Mesh decides what the tree means (MX project notes, getting-started, section 1). Mesh invents tag names, not syntax ([ADR-0002](../decisions/0002-resource-files-are-mx.md)).

MX is core, not an adapter: it is not replaceable, there is no front-end slot and no front-end package, and the tag contracts live in `packages/compiler` ([ADR-0043](../decisions/0043-mx-is-core.md)). `compiler` depends on MX; `model` and `runtime` never import it. `packages/compiler/test/repository-checks.test.ts` checks this boundary as **M1 test 8**, so the compiler's `test` script makes it part of root `verify`. It reads every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` and `.json` file under `packages/`, `apps/` and `examples/` as text, without parsing syntax. Any occurrence of the substring `@mxlang` outside the one allow-list constant, currently `packages/compiler`, fails: comments and strings count intentionally, and the diagnostic names the file and the line of its first occurrence. This also forbids MX dependencies in any `package.json` dependency field outside the allow-list. Tag-contract extensions join the allow-list in M6. Only paths with a `node_modules` segment, `apps/docs/site`, `apps/docs/docs`, and lock files are excluded; unrelated folders called `build`, `dist`, `site` or `coverage` remain scanned. Planted reviewer reproductions and dependency declarations prove the check fails, while MX-free angle-bracket assertions and JSX pass. A specifier assembled at run time from separate pieces can evade a substring check; the dependency rule and code review are the backstop.

The same test file reads every `apps/docs/docs/docs/*.md` page and parses complete `mx` fenced blocks with the contracts and both rejection options. Blocks whose first non-blank line does not start with `resource` are fragments and are skipped. The check prints parsed/skipped counts, rejects an empty set of complete blocks and names the page, fence line and MX diagnostic on failure; a planted invalid sample tests that failure path.

Resource files use MX concise syntax ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).

## The vocabulary

The tag names are not final. For v1 the vocabulary copies Ash's DSL (names and structure) and is reviewed after v1 to see what feels natural in MX; M1 aligns the current contracts with Ash ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md); mapping in [vocabulary mapping](../roadmap/vocabulary-mapping.md)). Tag names quoted below (`resource`, `attribute`, `policy`) are today's contracts.

## The call

`compiler` calls `parseData(source, file, options)` and gets `{ tree, diagnostics }` (MX project notes, getting-started, section 1). The options ([roadmap](../roadmap/roadmap.md), M1; `packages/compiler/test/helpers.ts`):

| Option | Value | Effect |
|---|---|---|
| `customTags` | Mesh's contracts, one `CustomTag` per tag name | Declares the allowed attributes, children and parents. |
| `structural` | `"reject"` | Mesh wants tags and attributes only; `if`, `for` and text are errors. |
| `unknownTags` | `"reject"` | A tag at any depth with no contract is a positioned error with a did-you-mean hint (MX project notes, updates, entry of 2026-10-03 23:05). |

Attribute tags (written `@name`) are governed by the parent's `attributeTags`, not by `unknownTags` (same entry). Mesh imports its contracts directly and passes them as `customTags` instead of letting MX scan for contract files, so a stray local tag file in a user's project cannot change the build ([roadmap](../roadmap/roadmap.md), M1; Mesh's answers to MX on `mx.contracts`, 2026-10-04, "For decision 142", item 1).

## The tree

`DataDocument { statements, children }`. A `DataTag` has `name`, `nameSpan`, `span`, `attrs`, `args`, `params`, `attrTags` and `children`. An attribute is a `string`, a `boolean`, an `expression` or a `spread`. A default attribute (in concise syntax, `resource="post"`) arrives as an attribute named `value`. Reserved names that cannot be data tags: `if`, `else`, `else-if`, `for`, `const`, `define`, `return`, `import`, `export`, `static`, `try`. Duplicate attribute names on one tag: last wins, with a warning (all: MX project notes, getting-started, section 1).

Diagnostics carry `severity`, `message`, `line`, `column`, `offset` (UTF-16) and `file`. `tree` is `undefined` when there is an error. `line` is 1-based and `column` is 0-based: Mesh's tests assert `line: 1, column: 0` for a bad tag at the start of line 1 (`packages/compiler/test/contracts.test.ts`), and MX's note of 2026-10-04 00:32 reports `1:0` for the root tag and `2:2` for an indented child (MX project notes, updates). MX change #227 ("every printed position 1-based") concerns printed positions, not these fields (MX project notes, updates, entry of 2026-10-03 23:02). Which convention Mesh itself prints in its own messages is not decided.

## Expressions

An attribute that holds code arrives as `DataExpr { code, shape, span, node }`. `node` is a Babel expression node. `code` is Marko's printed form; slicing the source at `span` gives the authored text (MX project notes, getting-started, section 1). Mesh uses both:

- `compiler` converts the Babel node to Mesh's expression tree (M4).
- Opaque expressions, which cannot be converted, are emitted as TypeScript by slicing the authored text at the span ([roadmap](../roadmap/roadmap.md), M4).

This is why there is no expression-parser slot: MX already did the parsing.

## Tag contracts and `analyze`

A *tag contract* tells MX which attributes, children and parents a tag allows. Contracts can declare attribute `type` (`string`, `number`, `boolean`, `enum` with `values`, `array` with `items`, `function`) and `required`; `attributeTags`; `children` (closed once present); `parents`, including `"#root"`; and attributes on attribute tags (MX project notes, getting-started, section 1; MX project notes, updates, entry of 2026-10-03 17:45).

Rules a declaration cannot express go in an `analyze` hook that reports positioned errors. Examples: `constraints` allowed only when `type="atom"`, with a `one_of` list; a `policy` condition is a check call (`action("publish")`, `action_type("read")`) or a list of them (Mesh's answers to MX on `mx.contracts`, 2026-10-04, "What Mesh is", as aligned by the [vocabulary mapping](../roadmap/vocabulary-mapping.md)). `analyze` runs under `parseData` with directly passed `customTags` and `structural: "reject"` (MX project notes, updates, entry of 2026-10-03 22:10).

The contracts in `packages/compiler/src/contracts.ts` make every contract closed and every statically read value `literalOnly`: a static tree has no scope, so an identifier would reach Mesh as an unevaluable expression. Function attributes (`change=`, `validate=`) are the exception, because they are code.

## Who enforces what

| MX enforces (inside `parseData`) | Mesh enforces (after `parseData`) |
|---|---|
| Known tags, nesting, parents | Exactly one `resource` per file |
| Attribute types, required attributes | Duplicate resource names; `accept` naming a missing attribute |
| Structural rejection of non-data constructs | The not-implemented rule ([ADR-0018](../decisions/0018-not-implemented-is-a-build-error.md)) |
| Conditional rules written in `analyze` | Expression classification, free variables, capabilities |

(`packages/compiler/src/contracts.ts` header; [roadmap](../roadmap/roadmap.md), M1.) Two points are open. The contracts file calls "a resource has at least one attribute" a model rule, but the roadmap's M1 checks do not include it: not decided. Whether the build rejects an HTML-style resource file, given that the form may not be visible in the parsed tree, is not decided ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).

The contract's `type` enum should be built from a registry in `model`, with a test that fails if they differ. That is the roadmap's working assumption; [ADR-0037](../decisions/0037-vocabulary-source-of-truth.md) is Proposed and open. Today the list is a constant in `contracts.ts`.

## The composed contracts module

Extensions add tags, but `resource.children` is closed in the contract. MX merges contract modules by whole-entry replacement and does not track imports, so MX cannot compose them. Mesh composes the contracts itself from core plus enabled extensions, and in M6 also writes one self-contained module for MX tooling ([ADR-0021](../decisions/0021-composed-contracts-module.md); Mesh's answers to MX on `mx.contracts`, 2026-10-04, Q3, Q5, Q7). The build composes in memory and passes `customTags` directly. The module is produced with Bun's bundler because it contains `analyze` functions ([roadmap](../roadmap/roadmap.md), M6).

`package.json#mx.contracts` names the module; its default export is a `ContractMap` (`Record<string, CustomTag>`), declarations plus `analyze` only (MX project notes, updates, entry of 2026-10-03 19:51). Today the repository's `package.json` points it at the hand-written contracts file. Tag names carry no prefix. The generated module is guarded like other generated files (M6, acceptance test 4).

## How Mesh consumes MX today

MX is not yet published. Mesh consumes MX's `main` branch through a local link, with nothing pinned, until the packages are published; a breaking MX change stops Mesh the same day ([roadmap](../roadmap/roadmap.md), section 9, risk 2). There is no CI for the same reason ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md)). Consequence for contributors: until the `@mxlang` packages are published, building and testing Mesh needs access to an MX checkout, and this page names no public way to get one. That is a known gap.

## The rule: never re-parse `.mx` text

The tree is the semantics (MX project notes, getting-started, section 5). Re-parsing would give two parsers that can disagree about one file. The one permitted use of text is slicing an opaque expression at its MX span.

## Known limits

- **One error per file.** Parse errors are fail-fast and there is no partial tree (MX project notes, data-target, section 7; MX project notes, getting-started, section 1). A file with three mistakes takes three runs.
- **No editor support for data files yet.** MX has not shipped editor diagnostics for data files (MX project notes, getting-started, section 1). Mesh surfaces diagnostics itself, and the generated contracts module has no consumer until that ships ([roadmap](../roadmap/roadmap.md), M6, risks).
- **A `transform` that emits tags is not supported** on the data target (MX project notes, updates, entry of 2026-10-03 23:05). Mesh does not use `transform`.
