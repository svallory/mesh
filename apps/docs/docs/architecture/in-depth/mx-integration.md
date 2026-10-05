---
title: "How Mesh uses MX"
description: "How Mesh reads entity files through MX, the MX features syntax v2 needs, and what each side enforces."
---

# How Mesh uses MX

Status: the M1 loader and contracts are built, and `verify` checks the MX import boundary and complete MX samples in the Docs pages. The realignment task rewrites the contracts for entity file syntax v2 ([ADR-0050](../decisions/0050-entity-file-syntax.md)); the composed contracts module is built in M6; the `mesh` MX host package follows MX decision 148 ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)).

::: callout info "The code still uses the old names"
`packages/compiler/src/contracts.ts` on `main` declares the 26 contracts of the M1 vocabulary, copied from Ash (`resource`, `attribute`, `defaults`, `change`, `calculations`, `aggregates`, policy check calls). Syntax v2 replaces them in the realignment task ([ADR-0064](../decisions/0064-order-of-work-after-approval.md)). The mechanisms below (the call, the tree, `analyze`, the import boundary) are unchanged.
:::

## What MX is, and why it is core

MX is a separate project that parses Marko-syntax files. For Mesh it offers a "data" target: `@mxlang/data` returns a static tree of tags and attributes with contracts enforced at parse time. Nothing in the file is executed; Mesh decides what the tree means (MX project notes, getting-started, section 1). Mesh invents tag names, not syntax ([ADR-0002](../decisions/0002-resource-files-are-mx.md)). Entity file syntax v2 relies on existing MX syntax wherever possible ([ADR-0050](../decisions/0050-entity-file-syntax.md)): the tag is the kind of declaration, MX's `#id` shorthand carries its name, and attributes carry its options.

MX is core, not an adapter: it is not replaceable, there is no front-end slot and no front-end package, and the tag contracts live in `@meshfw/compiler` ([ADR-0043](../decisions/0043-mx-is-core.md)). `compiler` depends on MX; `model` and `runtime` never import it. `packages/compiler/test/repository-checks.test.ts` checks this boundary as **M1 test 8**, so the compiler's `test` script makes it part of root `verify`. It reads every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` and `.json` file under `packages/`, `apps/` and `examples/` as text, without parsing syntax. Any occurrence of the substring `@mxlang` outside the one allow-list constant, currently `packages/compiler`, fails: comments and strings count intentionally, and the diagnostic names the file and the line of its first occurrence. This also forbids MX dependencies in any `package.json` dependency field outside the allow-list. The MX host package and tag-contract extensions join the allow-list when they exist. Only paths with a `node_modules` segment, `apps/docs/site`, `apps/docs/docs`, and lock files are excluded; unrelated folders called `build`, `dist`, `site` or `coverage` remain scanned. Planted reviewer reproductions and dependency declarations prove the check fails, while MX-free angle-bracket assertions and JSX pass. A specifier assembled at run time from separate pieces can evade a substring check; the dependency rule and code review are the backstop.

The same test file reads every `apps/docs/docs/docs/*.md` page and parses complete `mx` fenced blocks with the contracts and both rejection options. Blocks whose first non-blank line does not start with the root tag are fragments and are skipped. Until the realignment task teaches the contracts the `entity` tag, the check rewrites a leading `entity=` to `resource=` in memory and parses the result; only a diagnostic that names something the rename itself will change is deferred, counted and printed. Samples in syntax v2 (`entity #Todo`) need the realignment task's contracts. The check prints parsed/skipped counts, rejects an empty set of complete blocks and names the page, fence line and MX diagnostic on failure; a planted invalid sample tests that failure path.

Entity files use MX concise syntax ([ADR-0041](../decisions/0041-mx-concise-syntax.md)) and end in `.mesh.mx` ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)).

## The vocabulary

The vocabulary is Mesh's own, informed by Ash ([ADR-0049](../decisions/0049-vocabulary-is-meshs-own.md)). Every declaration is `kind #name options` ([ADR-0050](../decisions/0050-entity-file-syntax.md)): `entity #Invoice`, `string #number unique`, `belongs-to=Customer #customer`, `update #pay`, `policy #staffWrites types=["update"]`. The [Ash-to-Mesh mapping](../roadmap/vocabulary-mapping.md) says where each Ash concept went.

## The MX features syntax v2 depends on

| Feature | Used for | MX state (2026-10-05) |
|---|---|---|
| `#name` after a space (`update #pay`) | every declaration's name | MX decision 146, next in MX's queue; today only `update#pay` parses |
| `:label` sugar | the label of a `check` | MX decision 146 |
| A per-parent `defaultTag` | tagless `#field=value` lines under `set` | MX decision 145: the ladder and the built-in `object` default landed; per-parent `defaultTag` in review |
| `imports: "pass"` on `parseData` | helper imports at the top of an entity file | scheduled; with `"pass"` the tree gains `imports: [{ code, span }]` in file order and control flow stays rejected |
| `on:load` as one attribute | `actions on:load="visible"` | final |
| A third-party host on the data target, registered through `mx.host` | the `mesh` host that makes `.mesh.mx` resolve in MX tooling | MX decision 148, after 146 |

(MX project notes, updates; the MX lead's answers of 2026-10-05, recorded in [ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md).) Until these land, files run through MX tooling stay plain `.mx` and use the glued `kind#name` form.

## The call

`compiler` calls `parseData(source, file, options)` and gets `{ tree, diagnostics }` (MX project notes, getting-started, section 1). The options ([roadmap](../roadmap/roadmap.md), M1; `packages/compiler/test/helpers.ts`):

| Option | Value | Effect |
|---|---|---|
| `customTags` | Mesh's contracts, one `CustomTag` per tag name | Declares the allowed attributes, children and parents. |
| `structural` | `"reject"` | Mesh wants tags and attributes only; `if`, `for` and text are errors. |
| `unknownTags` | `"reject"` | A tag at any depth with no contract is a positioned error with a did-you-mean hint (MX project notes, updates, entry of 2026-10-03 23:05). |

Attribute tags (written `@name`) are governed by the parent's `attributeTags`, not by `unknownTags` (same entry). Mesh imports its contracts directly and passes them as `customTags` instead of letting MX scan for contract files, so a stray local tag file in a user's project cannot change the build ([roadmap](../roadmap/roadmap.md), M1; Mesh's answers to MX on `mx.contracts`, 2026-10-04, "For decision 142", item 1).

## The tree

`DataDocument { statements, children }`. A `DataTag` has `name`, `nameSpan`, `span`, `attrs`, `args`, `params`, `attrTags` and `children`. An attribute is a `string`, a `boolean`, an `expression` or a `spread`. A default attribute (in concise syntax, `belongs-to=Customer`) arrives as an attribute named `value`; the `#name` shorthand arrives as the attribute `id`. Reserved names that cannot be data tags: `if`, `else`, `else-if`, `for`, `const`, `define`, `return`, `import`, `export`, `static`, `try`. Duplicate attribute names on one tag: last wins, with a warning (all: MX project notes, getting-started, section 1).

Diagnostics carry `severity`, `message`, `line`, `column`, `offset` (UTF-16) and `file`. `tree` is `undefined` when there is an error. `line` is 1-based and `column` is 0-based: Mesh's tests assert `line: 1, column: 0` for a bad tag at the start of line 1 (`packages/compiler/test/contracts.test.ts`), and MX's note of 2026-10-04 00:32 reports `1:0` for the root tag and `2:2` for an indented child (MX project notes, updates). MX change #227 ("every printed position 1-based") concerns printed positions, not these fields (MX project notes, updates, entry of 2026-10-03 23:02). Which convention Mesh itself prints in its own messages is not decided.

## Expressions

An attribute that holds code arrives as `DataExpr { code, shape, span, node }`. `node` is a Babel expression node. `code` is Marko's printed form; slicing the source at `span` gives the authored text (MX project notes, getting-started, section 1). Mesh uses both:

- `compiler` converts the Babel node of a function whose body is one expression (an arrow, or a method body that is a single `return`) to Mesh's expression tree (M4).
- Any other body is plain code, emitted as TypeScript by slicing the authored text at the span ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md); [roadmap](../roadmap/roadmap.md), M4).

This is why there is no expression-parser slot: MX already did the parsing.

## Tag contracts and `analyze`

A *tag contract* tells MX which attributes, children and parents a tag allows. Contracts can declare attribute `type` (`string`, `number`, `boolean`, `enum` with `values`, `array` with `items`, `function`) and `required`; `attributeTags`; `children` (closed once present); `parents`, including `"#root"`; and attributes on attribute tags (MX project notes, getting-started, section 1; MX project notes, updates, entry of 2026-10-03 17:45).

Rules a declaration cannot express go in an `analyze` hook that reports positioned errors. Examples in syntax v2: `values` required on `enum` and nowhere else; `min` and `max` only on types they apply to; a `policy`'s `types=` items are action types. The same hook is where an unsupported construct inside a one-expression body is reported, so the editor shows it as the author types: as an error where SQL is required (a filter, a sort, a policy), and otherwise as a notice that the expression runs in memory ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)). `analyze` runs under `parseData` with directly passed `customTags` and `structural: "reject"` (MX project notes, updates, entry of 2026-10-03 22:10).

The contracts in `packages/compiler/src/contracts.ts` make every contract closed and every statically read value `literalOnly`: a static tree has no scope, so an identifier would reach Mesh as an unevaluable expression. Function attributes (`filter=`, `that=`, `authorize-if=`, a `set` value) and method bodies are the exception, because they are code.

## Who enforces what

| MX enforces (inside `parseData`) | Mesh enforces (after `parseData`) |
|---|---|
| Known tags, nesting, parents | Exactly one `entity` per file; `#name` unique within its scope |
| Attribute types, required attributes | Duplicate entity names; `accept` naming a missing attribute; `of=` paths |
| Structural rejection of non-data constructs | The not-implemented rule ([ADR-0018](../decisions/0018-not-implemented-is-a-build-error.md)) |
| Conditional rules written in `analyze`, including unsupported constructs in a translated expression | Free variables, the write strategy, capabilities |

(`packages/compiler/src/contracts.ts` header; [roadmap](../roadmap/roadmap.md), M1.) Two points are open. The contracts file calls "a resource has at least one attribute" a model rule, but the roadmap's M1 checks do not include it: not decided. Whether the build rejects an HTML-style entity file, given that the form may not be visible in the parsed tree, is not decided ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).

With syntax v2 the attribute types are tag names, so the attribute-type contracts should be generated from the registry in `model`, with a test that fails if they differ. That is the working assumption; [ADR-0037](../decisions/0037-vocabulary-source-of-truth.md) is Proposed and open. Today the list is a constant in `contracts.ts`.

## The composed contracts module

Extensions add tags, but `entity.children` is closed in the contract. MX merges contract modules by whole-entry replacement and does not track imports, so MX cannot compose them. Mesh composes the contracts itself from core plus enabled extensions, and in M6 also writes one self-contained module for MX tooling ([ADR-0021](../decisions/0021-composed-contracts-module.md); Mesh's answers to MX on `mx.contracts`, 2026-10-04, Q3, Q5, Q7). The build composes in memory and passes `customTags` directly. The module is produced with Bun's bundler because it contains `analyze` functions ([roadmap](../roadmap/roadmap.md), M6).

`package.json#mx.contracts` names the module; its default export is a `ContractMap` (`Record<string, CustomTag>`), declarations plus `analyze` only (MX project notes, updates, entry of 2026-10-03 19:51). Today the repository's `package.json` points it at the hand-written contracts file. Once the `mesh` host exists, the host hands the module to MX tooling and sets Mesh's `defaultTag` ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)). Tag names carry no prefix. The generated module is guarded like other generated files (M6, acceptance test 4).

## How Mesh consumes MX today

MX is not yet published. Mesh consumes MX's `main` branch through a local link, with nothing pinned, until the packages are published; a breaking MX change stops Mesh the same day ([roadmap](../roadmap/roadmap.md), section 9, risk 2). There is no CI for the same reason ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md)). Consequence for contributors: until the `@mxlang` packages are published, building and testing Mesh needs access to an MX checkout, and this page names no public way to get one. That is a known gap.

## The rule: never re-parse `.mx` text

The tree is the semantics (MX project notes, getting-started, section 5). Re-parsing would give two parsers that can disagree about one file. The one permitted use of text is slicing plain code at its MX span.

## Known limits

- **One error per file.** Parse errors are fail-fast and there is no partial tree (MX project notes, data-target, section 7; MX project notes, getting-started, section 1). A file with three mistakes takes three runs.
- **No editor support for data files yet.** MX has not shipped editor diagnostics for data files (MX project notes, getting-started, section 1). Mesh surfaces diagnostics itself, and the generated contracts module has no consumer until that ships ([roadmap](../roadmap/roadmap.md), M6, risks). The editor diagnostics for expressions promised by [ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md) depend on it.
- **Highlighting.** The docs site highlights `mx` with MX's own tree-sitter highlighter, the published `@mxlang/tree-sitter-mx` package ([ADR-0065](../decisions/0065-mx-highlighting-on-the-docs-site.md)). A line at the left margin ends the root tag's block, a comment included, so a comment inside an entity has to be indented with the block it sits in; the grammar reports such a line as an ERROR node and a fence with one fails the docs build, naming the page and the line.
- **A `transform` that emits tags is not supported** on the data target (MX project notes, updates, entry of 2026-10-03 23:05). Mesh does not use `transform`.
