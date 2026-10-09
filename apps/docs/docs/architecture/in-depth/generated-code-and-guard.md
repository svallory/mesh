---
title: "Generated code and the guard"
description: "What Mesh generates and commits, why the behaviour lives there, and how the guard keeps it honest."
---

# Generated code and the guard

Status: the M1 model, types, `mesh build`, `mesh build --check` and `mesh inspect` are built; the blog example's committed tree is guarded and type-checked by `verify`; M2 added input validators and the generated-import preflight ([PR #21](https://github.com/svallory/mesh/pull/21)). Action functions and the Drizzle schema come in the rest of M2, expression forms in M4, the contracts module in M6.

::: callout info "The code still uses the old names"
On `main` the emitters are TypeScript functions, the example writes `generated/`, the generated names follow `resource` and the M1 vocabulary, and handlers will take a `scope`. The design is: output in `.mesh/`, imported as `#mesh` ([ADR-0058](../decisions/0058-generated-code-in-mesh-imported-as-hash-mesh.md)); emitters as a view plus a Jig template ([ADR-0061](../decisions/0061-generators-are-jig-templates.md)); the action context as the second argument ([ADR-0059](../decisions/0059-action-context.md)). The realignment task and the Jig port bring the code there ([ADR-0064](../decisions/0064-order-of-work-after-approval.md)).
:::

## The rule

Generated code carries the behaviour; the run-time library stays thin ([ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)). The operator's ruling: "As much as Ash puts in its resources, or more. Generated code carries the behaviour; the shared engine stays thin" ([rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), table row 2).

Why: Ash keeps behaviour in its library, so stack traces are unhelpful and test coverage of a user's own resource reads 0% ([research synthesis](../research/synthesis.md), section 6, item 2). If generated handlers were thin calls into a shared engine, Mesh would inherit both problems (section 8, "Gaps", item 1).

The test: the run-time library never reads the model ([roadmap](../roadmap/roadmap.md), section 2, principle 1).

## What Mesh generates and commits

The generated tree lives in `.mesh/` at the project root (the configuration's `output` key), is committed and guarded, and is marked `linguist-generated` in `.gitattributes` so review tools collapse it. Application code imports it only as `#mesh`, through the `imports` field of the project's `package.json` (`"#mesh": "./.mesh/index.ts"`), never by path ([ADR-0058](../decisions/0058-generated-code-in-mesh-imported-as-hash-mesh.md); [roadmap](../roadmap/roadmap.md), section 2, principle 6).

| File | What it is | Milestone |
|---|---|---|
| `.mesh/model.json` | One file holding one document per entity, with source positions | M1 |
| `.mesh/<module>/<entity>.types.ts` | TypeScript types for the entity | M1 |
| `.mesh/<module>/<entity>.actions.ts` | One exported function per action, for example `createInvoice(input, context)` | M2 |
| `.mesh/index.ts` | `bind`, `connect`, `disconnect` and default-bound action exports ([ADR-0047](../decisions/0047-actions-are-bound-to-a-data-layer.md)) | M2 |
| `.mesh/<module>/<entity>.validators.ts` | Zod schemas, seen by the rest of Mesh only through Standard Schema ([ADR-0028](../decisions/0028-validation-zod-behind-standard-schema.md)) | M2 |
| Drizzle schema file | Table definitions emitted by `data-sqlite`'s build half | M2 |
| Expression forms | For each translated expression, the tree as a data literal and the in-memory form as TypeScript; plain code (block bodies) as TypeScript | M4 |
| `.mesh/mx-contracts.js` | One self-contained contracts module for MX tooling ([ADR-0021](../decisions/0021-composed-contracts-module.md)) | M6 |
| `.mesh/rules.md` | A description of the project's entities and of the vocabulary for coding agents ([ADR-0027](../decisions/0027-no-mcp-agent-surface.md)) | after v1 |

([roadmap](../roadmap/roadmap.md), M1, M2, M4, M6.) The example's `mesh explain` output is also committed, as a guarded fixture; it is not stated that every project commits it (M5, acceptance test 5). The file names follow the user page [project structure](../../docs/project-structure.md). Whether migrations written by `mesh migrate generate` (M9) are under the guard is not stated.

### The tree emitted in M1

Built in M1 (task `m1-emit`). `<output>` is the configuration's `output` key, `.mesh` by convention. M1 code places files by the M1 `domain=` attribute; after the realignment task the module folder takes its place.

- **`<output>/model.json`.** The whole model document, one entry per entity, written by Mesh's own stable serialiser: keys in lexicographic order, two-space indentation, one trailing newline. A formatter is not involved, and nothing that varies per run may reach the file.
- **One types file per entity**, at `<output>/<module>/<entity>.types.ts`. The file opens with a do-not-edit header naming the entity file it came from, with any line terminator in that name spelled out, and imports nothing: not `model`, not `compiler`, not `model.json` ([ADR-0033](../decisions/0033-core-split-build-time-run-time.md)). It holds the record type (one member per attribute, with the TypeScript type its registry entry names, `T | null` when the attribute is `nullable`, and a union of string literals for an `enum` with `values`) and one input type per action that has one.
- **Inputs follow the action's one `input` section** ([ADR-0067](../decisions/0067-members-imports-input-static-files.md)). Member lines take attributes or belongs-to relationships as declared; typed lines declare arguments. A create requires members with no default unless nullable. An update takes its required id selector and optional member inputs; typed arguments keep their declared requiredness. A destroy also takes its id and any declared input. A relationship input uses the relationship name and related id (`list: List["id"]`), while the record keeps `listId`. Optional members include `| undefined`: omission and an own undefined value both mean not provided, including under `exactOptionalPropertyTypes`. A selector is not a payload field and a create never carries one. Empty input is emitted as a `never` index signature, accepting `{}` but no unknown field or primitive. A read adds `{ filter?, sort?, limit?, offset?, load? }` beside its typed input arguments. The M1 code still implements the older split input vocabulary until realignment.
- **An action generated by `auto`** gets its input type like a written one, named after its type (`read` is `ReadInvoiceInput`), and accepts nothing ([ADR-0052](../decisions/0052-actions-auto-and-on-load.md)). An entity may write several actions of one type (`update :send` next to `update :pay`); they get one input type each. (M1 code still reads `defaults`, where a declared action of a kind replaced the default action of that kind.)
- **Names.** An entity's record type is its name in PascalCase, and an input type is `<Action><Entity>Input`, so the names line up with the action functions (`payInvoice`). Only ASCII letters and digits survive the conversion, and a leading underscore is kept: `blog-post` reads as `BlogPost`, `café` as `Caf`. An attribute whose name is not a TypeScript identifier is emitted as a quoted property, keeping the name the author wrote. These are build errors at the name, never a silent rename: an entity or action name that cannot become a type name; two entities that would generate the same record type name; two names in one file that would generate the same type name; two generated paths that differ only in letter case, which would alias one file on a case-insensitive file system. A generated type name is also refused when it would capture a global type name **the file's own attribute types use** — the set comes from the registry entry of each attribute the entity has, so an entity named `date` is fine until it has a `datetime` attribute, where declaring `Date` would swallow that attribute's type. A property name, a string literal in an `enum` union and anything in a comment are values, not references to a global, and can never trigger it.
- **One name, one path segment.** A module or entity name becomes a folder or a file name, so it must be exactly one segment: not empty, not `.` or `..`, and holding no `/` or `\`, no NUL and no line break. A backslash is refused rather than read as a folder, because on POSIX it is an ordinary character of a file name and reading it as a separator would let one name point at a different existing file. This is one rule for every name that becomes a path (`isPathSegment` in `packages/compiler/src/emitters/order.ts`), checked before anything is written.
- **The formatter.** Generated TypeScript is rendered from templates (Jig templates after the port, [ADR-0061](../decisions/0061-generators-are-jig-templates.md)) and passed through Prettier, pinned to an exact version, with the configuration fixed in `packages/compiler/src/format.ts`. The user's `.prettierrc`, `.editorconfig` or a `prettier` plugin is not read: a project cannot change what Mesh writes, so an upgrade of the formatter is a deliberate edit that rewrites the committed tree on purpose.
- **Determinism.** The same model gives the same bytes: entities are ordered by name, so the order of the entity files on disk or in `mesh.config.ts` does not reach the output, and no timestamp, absolute path, machine name or random id is written. A finite number keeps its spelling through the round trip, a negative zero included.
- **Writing is confined and never destructive.** The writer joins each generated path with the host separator and never rewrites it: on POSIX a backslash in a file name is that file's name. It then inspects, with `lstat`, which does not follow links, every existing component **from the output directory itself down to the target**: a symlinked output folder is refused as firmly as a symlinked directory in the middle of the path or a symlinked file at the leaf, whatever any of them points at, and the error names the folder and says to point `output` at a real directory. Every existing target must be a regular file, and every existing component above it, from the output directory down, must be a directory. The whole tree is preflighted before the first write: FIFOs, sockets, devices and directory/file obstructions are refused with their path and type, without opening them. Each target is then replaced, never truncated: the writer exclusively creates a temporary file in the same directory, sets its mode to `0644`, writes the bytes and renames it over the target. This breaks hard-link aliases and restores readable permissions. Temporary names cannot be produced paths; a failed write or rename cleans up its temporary file and reports the target. A crash-left temporary file is an ordinary stray. Replacement is atomic per file, not a transaction across the tree: a later I/O failure can follow earlier replacements. No existing stray is deleted.

### Input validators (M2)

Each entity has a `.validators.ts` file beside its `.types.ts` file, with the same header and pinned formatter. Each input type has one exported schema with a lower-case first letter (`CreateInvoiceInput` becomes `createInvoiceInput`). Both emitters consume one shared input plan: accepted fields, selector, nullability and optionality cannot diverge through separate field-selection logic.

The schemas use Zod 4.6.5 `strictObject`: unknown fields are errors, never dropped. Registry types map to string, integer, number, boolean, UUID and Date schemas; an `enum`'s `values` become a Zod enum in declared order; shape rules (`min`, `max`, `match`) become the matching Zod checks. Nullable and optional modifiers follow the generated types, in that order. Generated schemas satisfy `z.ZodType<Input>` and also check declared keys and assignability in both directions between `z.output<typeof schema>` and the input type. Exported type-only assertions use `Keys`, `SameShape` (returning true or false) and `Assert<T extends true>`; they emit no run-time constants and compile with unused-symbol checks. The key check catches added or removed optional fields; its empty-input special case preserves the `never` index signature. The reverse assignability check catches a required schema for an optional field or a non-nullable schema for a nullable field, which the one-way `satisfies` check alone permits. Negative type tests cover keys, requiredness, nullability and scalar width, with strict, unused-symbol, exact-optional, verbatim-module and isolated-module flags together. Attribute names matching the fixed built-in object property list are rejected by the model builder before emit, for all attribute-declaring tags, preventing prototype-sensitive validation bypasses.

The compiler emits text and never loads Zod. The consuming application installs Zod as an ordinary dependency ([ADR-0062](../decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md), which keeps Zod 4 after the [validation-library research](../research/validation-library.md)). Emitters declare imported packages through `requires`; before writing, `mesh build` resolves every requirement from the project root and reports all missing packages at `mesh.config.ts:1:1`, with a `bun add` fix. `--check` and `inspect` do not require those packages to be installed. The validators are guarded and type-checked with the rest of the example tree; run-time consumers call only `schema["~standard"].validate` ([ADR-0028](../decisions/0028-validation-zod-behind-standard-schema.md)).

## Why the tree is a data literal

Each translated expression is written into the generated file twice ([roadmap](../roadmap/roadmap.md), M4):

1. As the tree itself, a data literal that the data adapter compiles into Drizzle's builder when a query runs. Queries are assembled at run time from the action's filter, the caller's filter and, later, policies, so the SQL cannot be fixed at build time.
2. As its in-memory form, emitted TypeScript that calls the registered functions' in-memory implementations in `runtime`.

The build checks that every function used has a SQL form in the configured adapter. See [expressions.md](./expressions.md).

## What an action function contains

The function body holds the lifecycle steps in order: validate input, open a transaction, run `validate` and the `do` steps, call the data layer, commit, return a typed record. They are written out per action, not delegated to a generic `runAction` ([roadmap](../roadmap/roadmap.md), M2). From M5 the body covers all eight phases, the plan is chosen at build time, and a span is opened per phase through the OpenTelemetry API ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md); [action-lifecycle.md](./action-lifecycle.md)).

A reader should expect to see:

- The action context as the required second argument, typed `ActionContext` ([ADR-0059](../decisions/0059-action-context.md)). A call without one is a type error (M2, acceptance test 5).
- Checks and steps as TypeScript. Translated expressions have an in-memory form emitted here; block bodies are the authored text sliced from the entity file (M4).
- For atomic updates, the `set` values folded into the `UPDATE` statement; for read-then-write actions, read the row with a write lock, run `validate` and `do` in memory, write, in one transaction. The build chooses which from the body ([ADR-0054](../decisions/0054-write-strategy-is-inferred.md); M5).
- Calls to the data-layer contract and never to Drizzle (M2).

### Binding and the flat export surface (M2)

`.mesh/index.ts` exports `bind(dataLayer)`, returning every entity's action functions with their original names and `(input, context)` signatures. `connect()` constructs the data layer of the adapter `mesh.config.ts` configures and stores `bind(thatDataLayer)` as the default binding; top-level action exports delegate to it and throw `FrameworkError` before connection. `disconnect()` closes the default connection. Explicit bindings can target two databases in one process; the data layer is never in the action context ([ADR-0047](../decisions/0047-actions-are-bound-to-a-data-layer.md), [ADR-0059](../decisions/0059-action-context.md)).

Two entities that would export the same action function name are a **build error naming both entities** (lead ruling, 2026-10-04; [rulings before M2](../decisions/rulings-2026-10-04.md)). Check the composed identifier, not just the authored action names; different modules do not resolve a collision in the flat index. There is no silent rename or module prefix.

## What the run-time library may contain

`runtime` holds the `ActionContext` type; error classes; the data-layer contract with the query and expression-tree types; the transaction helper; and the in-memory implementations of registered expression functions ([roadmap](../roadmap/roadmap.md), section 3, `runtime` row). That is all.

- **No model.** `runtime` imports nothing from `model`, `compiler`, MX or Drizzle.
- **Helpers take values.** When a pattern repeats across handlers, it may become a small pure helper in `runtime` that takes values, never the model (M5, risks).

If handlers become unreadable, the point of the ruling is lost (section 9, risk 6). The concrete check is that a failing validation's first stack frame outside `node_modules` and Mesh packages is the generated handler (M2, acceptance test 3).

## The import rule

Checked by `verify` from M2 ([roadmap](../roadmap/roadmap.md), M2, acceptance test 4):

- Nothing in `runtime` imports `model`, `compiler` or Drizzle.
- No generated handler imports them or `model.json`.
- Drizzle is imported only under `packages/data-*` and in the emitted schema file.

Reasons are in [three-rings.md](./three-rings.md).

## The guard

Hand edits to generated files, or a stale tree after an entity file changes, would make committed code disagree with its source. Wasp's checksum manifest protects a gitignored directory and would not catch hand edits to a committed one, so Mesh needs its own check ([research synthesis](../research/synthesis.md), section 8, "Gaps", item 8).

How it works:

1. `mesh build --check` runs the same load, checks and emit as `mesh build`, but regenerates in memory and writes nothing, even on failure.
2. It compares exact bytes with the generated tree on disk, which the project commits: missing produced files, changed bytes and stray regular files all fail. A missing output directory means every produced file is missing. It does not query Git's index or history.
3. The walk uses `lstat` from the output directory itself down. Every symlink is an error, including a symlinked output directory, nested directory or file; the guard never descends into or reads through one. The config loader also checks the output directory with `lstat` before canonicalising it, so inside, outside, dangling and cyclic output-root links all receive the same diagnostic at the output path. The blocking path is reported, rather than claiming to have checked its descendants. Unsupported filesystem entries and unreadable paths also fail. Like the writer, the walk assumes files are not concurrently replaced during a build.
4. Every difference names its project-relative path, with `/` separators, in the [command-line diagnostic shape](../../docs/command-line.md#what-a-build-error-looks-like). Diagnostics go to standard error, ordered by file, line, column and message, then one count summary. A difference exits 1; a matching tree exits 0 ([roadmap](../roadmap/roadmap.md), M1, acceptance test 3).
5. The repository's `verify` runner discovers `examples/blog`'s `validate` script, which runs `mesh build --check`; its `typecheck` script checks the generated TypeScript too. `packages/cli/test/example-guard.test.ts` checks the real example and a temporary copy with a planted hand edit, proving that this script rejects stale bytes without writing. After changing an entity file, an emitter or a template, run `cd examples/blog && mesh build` and commit the generated diff.

A **stray file** is a regular file under the output directory that this build does not produce. `mesh build` deletes no existing stray: after writing successfully, it runs the full guard comparison, checking readability, missing files and exact bytes as well as reporting each stray file as an error telling you to delete or move it. Symlinks and unsupported entries also fail. The guard reads only entries that `lstat` identified as regular files. Thus, with unchanged inputs and disk, **after `mesh build` exits 0, `mesh build --check` exits 0**. Removing or renaming an entity may leave an old generated file to remove explicitly; the build never assumes it owns that file.

The guard depends on determinism: same input, same bytes, from templates plus a pinned formatter (see [build-pipeline.md](./build-pipeline.md)). It grows with the milestones: handlers and the schema in M2, the example's `explain` output in M5, the contracts module in M6 (M2 test 6, M5 test 5, M6 test 4).

The guard runs wherever `verify` runs: locally, and on every pull request, since the `@mxlang` packages are installable from a registry and `.github/workflows/verify.yml` runs the script ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md), amended 2026-10-05). A guard difference is a red build rather than something nobody sees ([roadmap](../roadmap/roadmap.md), section 9, risk 4).

## Run-time errors point at entity files

A declared rule that fails at run time (for example a `check` with its `code` and `message`) reports its `.mesh.mx` position. The roadmap's working assumption is that the position is carried as data in the generated code ([roadmap](../roadmap/roadmap.md), M5). That is open: [ADR-0039](../decisions/0039-run-time-error-positions.md) is Proposed and records the choice against source maps. One argument against source maps is that Bun's `findSourceMap` returns `undefined` ([research synthesis](../research/synthesis.md), section 12, risk 3).

Errors fall into a class hierarchy built in M5. M2 starts with three classes: invalid input, not found, framework. A read after destroy throws the not-found class (M2, acceptance test 1). A load that cannot be done is a run-time error, never ignored (M7, acceptance test 2).

## Reading generated code

The aim of the ruling is that a reader can follow an action function top to bottom without opening `model.json`; this is an inference from the ruling, not a stated rule. Hand edits to a generated file fail the guard, so change the entity file, or export and override the template ([ADR-0061](../decisions/0061-generators-are-jig-templates.md)).

## Changing what is generated

`mesh export generators` copies Mesh's Jig templates into the project; for each template, the project's copy wins when it exists ([ADR-0061](../decisions/0061-generators-are-jig-templates.md)). The template receives a typed view, not the raw model, so the view types are the contract an overriding project depends on. An overridden template no longer receives Mesh's fixes; the guard still compares the rendered output with what is committed.
