---
title: "How Mesh uses MX"
description: "How Mesh reads static entity files through MX, the syntax-v4 parser and highlighting gaps, and what each side enforces."
---

# How Mesh uses MX

Status: the M1 loader and contracts are built, and `verify` checks the MX import boundary and complete MX samples in the Docs pages. The realignment task rewrites the contracts for entity file syntax v4 ([ADR-0067](../decisions/0067-members-imports-input-static-files.md)); the composed contracts module is built in M6; the `mesh` MX host package follows MX decision 148 ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)).

::: callout info "The code still uses the old names"
`packages/compiler/src/contracts.ts` on `main` declares the 26 contracts of the M1 vocabulary, copied from Ash (`resource`, `attribute`, `defaults`, `change`, `calculations`, `aggregates`, policy check calls). Syntax v4 replaces them in the realignment task ([ADR-0064](../decisions/0064-order-of-work-after-approval.md)). The mechanisms below (the call, the tree, `analyze`, the import boundary) are unchanged.
:::

## What MX is, and why it is core

MX is the separate language project that parses entity files. `@mxlang/data` returns a static tree of tags and attributes with contracts enforced at parse time. Mesh's target design builds on `tree`, the renamed static target (MX decision 187 addendum 2); the package remains `@mxlang/data`. Nothing in an entity file is evaluated to produce declarations. Mesh contributes its vocabulary through contracts now, and its `:name`/atom/member triggers through the syntax table when that lands (MX decision 182 addendum 1). [ADR-0067](../decisions/0067-members-imports-input-static-files.md) records this division and the static-file ruling.

MX is core, not an adapter: it is not replaceable, there is no front-end slot and no front-end package, and the tag contracts live in `@meshfw/compiler` ([ADR-0043](../decisions/0043-mx-is-core.md)). `compiler` depends on MX; `model` and `runtime` never import it. `packages/compiler/test/repository-checks.test.ts` checks this boundary as **M1 test 8**, so the compiler's `test` script makes it part of root `verify`. It reads every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` and `.json` file under `packages/`, `apps/` and `examples/` as text, without parsing syntax. Any occurrence of the substring `@mxlang` outside the one allow-list constant, currently `packages/compiler`, fails: comments and strings count intentionally, and the diagnostic names the file and the line of its first occurrence. This also forbids MX dependencies in any `package.json` dependency field outside the allow-list. The MX host package and tag-contract extensions join the allow-list when they exist. Only paths with a `node_modules` segment, `apps/docs/site`, `apps/docs/docs`, and lock files are excluded; unrelated folders called `build`, `dist`, `site` or `coverage` remain scanned. Planted reviewer reproductions and dependency declarations prove the check fails, while MX-free angle-bracket assertions and JSX pass. A specifier assembled at run time from separate pieces can evade a substring check; the dependency rule and code review are the backstop.

The same test file reads every `apps/docs/docs/docs/*.md` page and parses complete `mx` fenced blocks with the contracts and both rejection options. Blocks whose first non-blank line does not start with the root tag are fragments and are skipped. Until the realignment task teaches the contracts the `entity` tag, the check rewrites a leading `entity=` to `resource=` in memory and parses the result; only a diagnostic that names something the rename itself will change is deferred, counted and printed. Syntax-v4 samples need the realignment task's contracts. Their contracts parse is deferred under `syntax v4, pending the MX syntax table`; one in-memory `normaliseV4` bridge adapts unsupported spellings before a real parse with structural rejection. The stricter `checkDocsSyntaxV4` companion rejects v3 input and reference forms before parsing. The check prints parsed/skipped counts, rejects an empty set of complete blocks and names the page, fence line and MX diagnostic on failure; a planted invalid sample tests that failure path.

Entity files use MX concise syntax ([ADR-0041](../decisions/0041-mx-concise-syntax.md)) and end in `.mesh.mx` ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)).

## The vocabulary

The vocabulary is Mesh's own, informed by Ash ([ADR-0049](../decisions/0049-vocabulary-is-meshs-own.md)). Every declaration is `kind :name options` ([ADR-0050](../decisions/0050-entity-file-syntax.md), amended by [ADR-0067](../decisions/0067-members-imports-input-static-files.md)): `entity :Invoice`, `string :number unique`, `belongs-to :customer entity=Customer`, `update :pay`, `policy :staffWrites types=[:update]`. `Customer` is imported; `&customer` refers to that relationship. `input` is the action's only input section. The [Ash-to-Mesh mapping](../roadmap/vocabulary-mapping.md) says where each Ash concept went.

## The MX features syntax v4 depends on

| Feature | Used for | State on the pinned parser, alpha.5 |
|---|---|---|
| Atoms and `kind :name` | Declarations and fixed-set/enum values | Parses; whole-value atoms are `DataAttr { kind: "atom", name, value }`; expression atoms have `extra.mxAtom` |
| Entity imports and `entity=Customer` | Cross-file identity | Both parse with `structural: "reject", imports: "pass"`, verified on alpha.5; without the imports option, imports are rejected |
| `&name` after a kind | `asc &dueOn` | Invalid attribute name until the syntax table |
| `&name` at an operand position | `() => &status === :sent`, `load=[&customer]`, `on:load=&visible` | Unexpected token until the syntax table |
| A tagless member line | `&title` in `input`, `&status=:sent` in `set` | Accepted syntactically, but the table supplies its intended lowering and meaning |
| `lineTriggers`, `attributeTriggers`, `expressionTriggers` | Mesh's layer-2 member syntax | MX decision 182 addendum 1, pending the parser port |
| A `mesh` host with `builtOn: "tree"` | `.mesh.mx` tooling | Target design, MX decisions 148 and 187 addendum 2 |

The docs bridge only these unsupported spellings in memory, then parse. It maps tagless/after-kind member spellings to the older name form and operand members to record reads, leaving strings, expression comments and infix operators alone. Imports pass unchanged with alpha.5's verified `imports: "pass"` option. Structural rejection stays on. Because the pin also rejects comments, leading file comments are blanked without removing lines; in-body comments remain untouched and rejected, an MX gap. MX decision 131 addendum 5 schedules `tree-comments-not-structural` for the next alpha: comments remain `Comment` nodes even under structural rejection, with no new option. Realignment pins that release and removes the comment bridge. Remove `normaliseV4` when the syntax-table release is pinned. Runtime/compiler code must still consume MX's tree, never this bridge.

The highlighter's separate gap is `input`: alpha.2 treats it as an HTML void tag, even with a plain `string :x` child and no sigil. The named `MX_V4_INPUT_PENDING_SYNTAX_TABLE` allowance uses same-width stand-ins for nested input sections and bare member lines, renders the authored text, and counts and prints affected lines. Imports already highlight. Member-reference semantic colour awaits MX item `mesh-syntax-highlighting-route`; uncoloured members are accepted for the docs review. Other ERROR nodes still stop the site build. [Open questions](../open-questions.md#syntax-v4) has the measured matrix.

## The call

`compiler` calls `parseData(source, file, options)` and gets `{ tree, diagnostics }` (MX project notes, getting-started, section 1). The options ([roadmap](../roadmap/roadmap.md), M1; `packages/compiler/test/helpers.ts`):

| Option | Value | Effect |
|---|---|---|
| `customTags` | Mesh's contracts, one `CustomTag` per tag name | Declares the allowed attributes, children and parents. |
| `structural` | `"reject"` | Mesh wants tags and attributes only; `if`, `for` and text are errors. |
| `unknownTags` | `"reject"` | A tag at any depth with no contract is a positioned error with a did-you-mean hint (MX project notes, updates, entry of 2026-10-03 23:05). |

Attribute tags (written `@name`) are governed by the parent's `attributeTags`, not by `unknownTags` (same entry). Mesh imports its contracts directly and passes them as `customTags` instead of letting MX scan for contract files, so a stray local tag file in a user's project cannot change the build ([roadmap](../roadmap/roadmap.md), M1; Mesh's answers to MX on `mx.contracts`, 2026-10-04, "For decision 142", item 1).

## The tree

`DataDocument { statements, children }`. A `DataTag` has `name`, `nameSpan`, `span`, `attrs`, `args`, `params`, `attrTags` and `children`. An attribute is a `string`, a `boolean`, an `expression` or a `spread`. A tag's default attribute arrives as `value`; v4 relationships instead have an explicit `entity` expression referring to an imported binding. The `:name` sugar arrives as the attribute `name`. Member references await the syntax table's lowering. Reserved names that cannot be data tags: `if`, `else`, `else-if`, `for`, `const`, `define`, `return`, `import`, `export`, `static`, `try`. Duplicate attribute names on one tag: last wins, with a warning (all: MX project notes, getting-started, section 1).

Diagnostics carry `severity`, `message`, `line`, `column`, `offset` (UTF-16) and `file`. `tree` is `undefined` when there is an error. `line` is 1-based and `column` is 0-based: Mesh's tests assert `line: 1, column: 0` for a bad tag at the start of line 1 (`packages/compiler/test/contracts.test.ts`), and MX's note of 2026-10-04 00:32 reports `1:0` for the root tag and `2:2` for an indented child (MX project notes, updates). MX change #227 ("every printed position 1-based") concerns printed positions, not these fields (MX project notes, updates, entry of 2026-10-03 23:02). Which convention Mesh itself prints in its own messages is not decided.

## Expressions

An attribute that holds code arrives as `DataExpr { code, shape, span, node }`. `node` is a Babel expression node. `code` is Marko's printed form; slicing the source at `span` gives the authored text (MX project notes, getting-started, section 1). Mesh uses both:

- `compiler` converts the Babel node of a function whose body is one expression (an arrow, or a method body that is a single `return`) to Mesh's expression tree (M4).
- Any other body is plain code, emitted as TypeScript by slicing the authored text at the span ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md); [roadmap](../roadmap/roadmap.md), M4).

This is why there is no expression-parser slot: MX already did the parsing.

## Tag contracts and `analyze`

A *tag contract* tells MX which attributes, children and parents a tag allows. Contracts can declare attribute `type` (`string`, `number`, `boolean`, `enum` with `values`, `array` with `items`, `function`) and `required`; `attributeTags`; `children` (closed once present); `parents`, including `"#root"`; and attributes on attribute tags (MX project notes, getting-started, section 1; MX project notes, updates, entry of 2026-10-03 17:45).

Rules a declaration cannot express go in an `analyze` hook that reports positioned errors. Examples in syntax v4: `values` required on `enum` and nowhere else; `min` and `max` only on types they apply to; a `policy`'s `types=` items are action types. The same hook is where an unsupported construct inside a one-expression body is reported, so the editor shows it as the author types: as an error where SQL is required (a filter, a sort, a policy), and otherwise as a notice that the expression runs in memory ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)). `analyze` runs under `parseData` with directly passed `customTags` and `structural: "reject"` (MX project notes, updates, entry of 2026-10-03 22:10).

The contracts in `packages/compiler/src/contracts.ts` make every contract closed and every statically read value `literalOnly`: a static tree has no scope, so an identifier would reach Mesh as an unevaluable expression. Function attributes (`filter=`, `that=`, `authorize-if=`, a `set` value) and method bodies are exceptions because they are code. The v4 realignment must also recognise imported entity identifiers and member references; it cannot make every non-function value `literalOnly`.

## Who enforces what

| MX enforces (inside `parseData`) | Mesh enforces (after `parseData`) |
|---|---|
| Known tags, nesting, parents | Exactly one `entity` per file; `:name` unique within its scope |
| Attribute types, required attributes; member-reference checks through the syntax table and contracts | Imported entity identity, relationship targets, `of=` paths and input-name collisions |
| Structural rejection of non-data constructs | The not-implemented rule ([ADR-0018](../decisions/0018-not-implemented-is-a-build-error.md)) |
| Conditional rules written in `analyze`, including unsupported constructs in a translated expression | Free variables, the write strategy, capabilities |

(`packages/compiler/src/contracts.ts` header; [roadmap](../roadmap/roadmap.md), M1.) Two points are open. The contracts file calls "a resource has at least one attribute" a model rule, but the roadmap's M1 checks do not include it: not decided. Whether the build rejects an HTML-style entity file, given that the form may not be visible in the parsed tree, is not decided ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).

With syntax v4 the attribute types are tag names, so the attribute-type contracts should be generated from the registry in `model`, with a test that fails if they differ. That is the working assumption; [ADR-0037](../decisions/0037-vocabulary-source-of-truth.md) is Proposed and open. Today the list is a constant in `contracts.ts`.

## The composed contracts module

Extensions add tags, but `entity.children` is closed in the contract. MX merges contract modules by whole-entry replacement and does not track imports, so MX cannot compose them. Mesh composes the contracts itself from core plus enabled extensions, and in M6 also writes one self-contained module for MX tooling ([ADR-0021](../decisions/0021-composed-contracts-module.md); Mesh's answers to MX on `mx.contracts`, 2026-10-04, Q3, Q5, Q7). The build composes in memory and passes `customTags` directly. The module is produced with Bun's bundler because it contains `analyze` functions ([roadmap](../roadmap/roadmap.md), M6).

`package.json#mx.contracts` names the module; its default export is a `ContractMap` (`Record<string, CustomTag>`), declarations plus `analyze` only (MX project notes, updates, entry of 2026-10-03 19:51). Today the repository's `package.json` points it at the hand-written contracts file. Once the `mesh` host exists, the host hands the module to MX tooling and sets Mesh's `defaultTag` ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)). Tag names carry no prefix. The generated module is guarded like other generated files (M6, acceptance test 4).

## How Mesh consumes MX today

MX is published as pre-release versions on `https://npm.saulo.tech`, the registry the repository's `bunfig.toml` scopes `@mxlang` to. Mesh pins `@mxlang/core` and `@mxlang/data` to exact versions in `packages/compiler/package.json`, so an install resolves them like any other dependency — on a developer machine and on a hosted runner ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md), amended 2026-10-05). The versions are pre-releases, which changes nothing about the risk this section describes: nothing resolves a range, so a new MX release reaches Mesh when Mesh bumps the pin, and never on its own. A contributor who needs an MX commit that is not published yet links a local checkout, which is never committed (the contributing page, "What exists today").

`.github/workflows/verify.yml` runs `bun run verify` on every pull request and on every push to `main`, so an MX change that reaches the pinned version fails the build rather than sitting in a local clone until someone remembers to run the check ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md), amended 2026-10-05).

## The rule: never re-parse `.mx` text

The tree is the semantics (MX project notes, getting-started, section 5). Re-parsing would give two parsers that can disagree about one file. The one permitted use of text is slicing plain code at its MX span.

## Known limits

- **One error per file.** Parse errors are fail-fast and there is no partial tree (MX project notes, data-target, section 7; MX project notes, getting-started, section 1). A file with three mistakes takes three runs.
- **No editor support for data files yet.** MX has not shipped editor diagnostics for data files (MX project notes, getting-started, section 1). Mesh surfaces diagnostics itself, and the generated contracts module has no consumer until that ships ([roadmap](../roadmap/roadmap.md), M6, risks). The editor diagnostics for expressions promised by [ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md) depend on it.
- **Highlighting.** The docs site highlights `mx` with MX's own tree-sitter highlighter, the published `@mxlang/tree-sitter-mx` package ([ADR-0065](../decisions/0065-mx-highlighting-on-the-docs-site.md)). Atoms and declaration names have separate colours; v4 member semantics await the syntax-table route, and the input-section allowance above bridges the void-tag gap. A line at the left margin ends the root tag's block, a comment included, so a comment inside an entity has to be indented with the block it sits in; the grammar reports such a line as an ERROR node and a fence with one fails the docs build, naming the page and the line.
- **A `transform` that emits tags is not supported** on the data target (MX project notes, updates, entry of 2026-10-03 23:05). Mesh does not use `transform`.
