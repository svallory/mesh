---
title: "The build-time pipeline"
description: "The eight build stages that turn resource files into committed, guarded generated code."
---

# The build-time pipeline

Status: stages 1 to 3 and the M1 checks step are built in M1 ([PR #12](https://github.com/svallory/mesh/pull/12)); the emit stage is built in M1 (task `m1-emit`). Stage 8 and the command line are built in M1 (task `m1-cli`); wiring the guard into the repository's example and `verify` follows in `m1-example`. Expression conversion (part of stage 3) and stage 6 arrive in M4, stages 4 and 5 in M6. The tag contracts in `packages/compiler` read the value registries in `packages/model`. Vocabulary alignment with Ash's DSL is complete ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)).

## Why a pipeline

The pipeline is what makes Mesh a framework rather than a library ([roadmap](../roadmap/roadmap.md), section 3, `compiler` row). It is also where Ash's worst extension problems showed up: transformers ordered by module name with contradictions dropped silently, and verifier errors that only print warnings ([research synthesis](../research/synthesis.md), section 2.1). Extensions plug in at named points (section 16 of the same file).

The pipeline is run by `mesh build` and lives in `packages/compiler`. Its output is committed files (see [generated-code-and-guard.md](./generated-code-and-guard.md)).

## The eight stages

| # | Stage | Consumes | Produces | Milestone | Extension point |
|---|---|---|---|---|---|
| 1 | Load | `.mx` source text, found through `mesh.config.ts` | Declarations with source positions | M1 | None: MX is core ([ADR-0043](../decisions/0043-mx-is-core.md)) |
| 2 | Check structure | Declarations | The same, or a structural error | M1 | Vocabulary, types |
| 3 | Build model | Checked declarations | One plain-data document per resource; from M4 each expression's tree and class are part of it | M1, M4 | Core |
| 4 | Transform | The model | A rewritten model | M6 | Model transforms |
| 5 | Verify (the checks step; before M6 the M1 checks) | The model | Nothing, or a stopped build | M6 | Verifiers |
| 6 | Compile expressions (produce the two forms) | The model's trees and classes | The tree literals and in-memory forms | M4 | Expression functions |
| 7 | Emit | The model | Files | M1, M2, M4, M6 | Emitters |
| 8 | Guard | Freshly emitted and committed files | Pass, or a named difference | M1 | Core |

(Stage names, purposes and extension points: [research synthesis](../research/synthesis.md), section 16, where stage 1's extension point was "front end"; that slot was dropped by [ADR-0043](../decisions/0043-mx-is-core.md). Milestones: [roadmap](../roadmap/roadmap.md), M1, M4, M5, M6. The "consumes" and "produces" columns for stages 2 to 5 are inferred; the roadmap has no data-flow table.)

### 1. Load

Built in M1 ([PR #12](https://github.com/svallory/mesh/pull/12)). Project configuration is one trusted executable file, `mesh.config.ts`, whose default export is `defineConfig({ resources, output })` from `@mesh/compiler` (re-exported by the M1 CLI package as `@mesh/cli`). Both fields are required: `resources` primarily names a folder whose `.mx` files are discovered recursively, including dot-prefixed paths and without silently excluded folders; a relative glob or non-empty relative file list can select a subset. `output` is a relative output directory. These names and forms follow the [live configuration spec](../../docs/configuration.md). Paths resolve from the config file; input backslashes are normalised to `/` before resolution. Drive and UNC absolute forms are rejected regardless of host. Resource and output paths must stay inside both the lexical and canonical project root: symlinks cannot point outside it, including the nearest existing ancestor of an output directory that has not been created. Glob branches cannot contain parent traversal components. Resource paths are deduplicated and sorted. An unmatched glob, an unreadable file, an unknown field or a wrong-typed field is an error; required fields have no silent defaults. Optional `data` remains opaque in M1. Optional `extensions` must be an array; its reference and individual opaque elements are carried untouched through the resolved config without execution. M2 interprets the data adapter and makes it required; M6 interprets the enabled extensions ([roadmap](../roadmap/roadmap.md), M1).

`loadConfig(projectRoot)` resolves the project; `loadProject(config)` reads its files and calls `buildModel({ root, files })`. Callers with source text can call `buildModel` directly. Both build entry points return a model document plus diagnostics, with a null document on any error; neither emits files. `compiler` calls MX's `parseData` with directly imported contracts, `structural: "reject"` and `unknownTags: "reject"` (see [mx-integration.md](./mx-integration.md)). Source positions use project-relative paths, 1-based lines, 0-based columns and UTF-16 offsets.

### 2. Check structure

Built in M1 ([PR #12](https://github.com/svallory/mesh/pull/12)). MX does most of this: unknown tags, wrong attribute types, wrong nesting and missing required attributes are MX errors raised inside `parseData` ([roadmap](../roadmap/roadmap.md), M1). One rule is Mesh's own: exactly one `resource` per file, because MX has no root cardinality.

### 3. Build model

Built in M1 ([PR #12](https://github.com/svallory/mesh/pull/12)). The model is plain, JSON-serialisable data with source positions kept ([roadmap](../roadmap/roadmap.md), M1; section 3, `model` row). In M1 it holds resource name, `table`, `domain`, the attribute types of the registry, `uuid-primary-key`, `create-timestamp` and `update-timestamp` and the four action kinds with `accept` and `defaults`. Checks in M1: duplicate resource names, duplicate attribute or explicit action names within a resource, a missing primary-key attribute ([vocabulary mapping](../roadmap/vocabulary-mapping.md), D31), and `accept` naming a missing attribute. A missing key points at the resource name and tells the author to declare `uuid-primary-key`; M1 has no opt-out. The builder runs `findNonJsonValue` before returning a document and reports every incompatible leaf at the positioned value that owns it, including defaults in later files. Atom constraints cannot repeat an object key: MX's contract analysis rejects the second key at its own position. An unexpected tree shape after a passing contract check becomes a named, positioned Mesh diagnostic rather than an exception. When M6 lands, these checks become the Verify stage. The M1 types are in `packages/model` (`Resource`, `ModelDocument`, `SourcePosition`, `Diagnostic`): absent optional values are `null`, never `undefined`, so a document survives a JSON round trip unchanged. The attribute type names (`string`, `integer`, `float`, `boolean`, `uuid`, `datetime`, `atom`) live in the registry there ([ADR-0037](../decisions/0037-vocabulary-source-of-truth.md)); `model` imports nothing from MX, `compiler` or Drizzle, and a test scans its sources for such imports.

From M4, stage 3 also converts each arrow function from MX's Babel node to an expression tree and classifies it as translatable or opaque. The tree and its class are part of the model, so transforms and verifiers see them ([roadmap](../roadmap/roadmap.md), M4). Conversion runs in `compiler`. A translatable expression may use only its parameters and registered functions; a free variable is a build error. Parameters such as the actor are bound from the scope and the input when the expression runs; the mechanism is not decided.

Every tool reads this one model. Ash's map-based state shows the approach scales to 20+ extensions ([research synthesis](../research/synthesis.md), section 8, "Copy from Ash").

### 4. Transform

Extensions rewrite the model in named phases. A cycle between phases is a hard error and the resolved order is printed ([research synthesis](../research/synthesis.md), section 16; [roadmap](../roadmap/roadmap.md), M6). Reason: Ash orders transformers by `before?`/`after?` against module names and silently drops contradictions (section 2.1). A transform may write to another extension's part of the model only through a contribution point the owner publishes and the contributor declares; anything else is a build error ([ADR-0020](../decisions/0020-extension-contributions-through-declared-points.md)).

### 5. Verify

The M1 checks step is built ([PR #12](https://github.com/svallory/mesh/pull/12)); it collects errors across resources before returning. M6 turns it into the extensible Verify stage. Read-only checks across resources. A failure stops the build. A strictness setting for verifiers is out of scope for M6 ([roadmap](../roadmap/roadmap.md), M6), so every verifier failure is an error. Example: a policy's `action` names a real action (M8).

### 6. Compile expressions (produce the two forms)

Stage 6 only produces the two forms of each translatable expression; conversion and classification already happened in stage 3 ([ADR-0010](../decisions/0010-one-expression-tree-two-evaluators.md); [roadmap](../roadmap/roadmap.md), M4). Each translatable expression is written into the generated file twice: as the tree itself, a data literal that the data adapter compiles into Drizzle's builder when a query runs, and as its in-memory form, emitted TypeScript. Opaque expressions are emitted as TypeScript by slicing the authored text at MX's span. The build checks that every function used has a SQL form in the configured adapter (detail in [expressions.md](./expressions.md)). What "equal" means where SQL and JavaScript disagree is open: [ADR-0012](../decisions/0012-expression-semantics.md) is Proposed and must be ruled before M4 starts.

Errors that depend on the class are raised by the checks step, which is the Verify stage from M6 ([roadmap](../roadmap/roadmap.md), M4). They are: a `filter` that is not translatable (M4), an opaque change without `require-atomic=false` and an atomic change against an adapter lacking the capability (M5), and a read policy that is not translatable (M8). The classification rule: `filter` must be translatable; `change` and `validate` may be either.

How an expression contributed by an extension gets a tree is not decided.

### 7. Emit

Text from templates, passed through an established formatter pinned to an exact version ([roadmap](../roadmap/roadmap.md), M1). M1 emits `generated/model.json` and one `types.ts` per resource; `domain` sets the output directory. M2 adds handlers, Zod validators and the Drizzle schema; M4 adds the tree literals and in-memory forms (stage 6); M6 adds the contracts module and makes core and data-adapter emitters register through the same interface extensions use. The output of `mesh explain` is printed by that command; only the example's output is committed and guarded (M5). Migrations are written by `mesh migrate generate` (M9), a separate command.

Built in M1 (task `m1-emit`), the half of this stage that emits: `generateFiles({ document, config })` runs every emitter and returns the whole tree as text, sorted by path and with nothing written; `writeGeneratedFiles(files, config)` writes that text under the configured output folder, inspecting every target with `lstat` from the output directory down, refusing symlinks rather than following them, and writing nothing at all if any target is unsafe. Both take the resolved configuration, and the emitters take the model document and the configuration together, and `mesh build` calls them after loading and checking the project. An emitter is a pure function of those two values; the interface is marked unstable until M6, when the extension host registers emitters through it. What M1 emits, the path rule, the input shapes, the naming rules and the pinned formatter are in [generated-code-and-guard.md](./generated-code-and-guard.md). Stage 8 and the `mesh` command are built in M1 (task `m1-cli`).

### 8. Guard

Built in M1 (task `m1-cli`). `mesh build --check` regenerates in memory and compares bytes without writing: missing, changed and stray files or symlinks fail, naming each path. `mesh build` writes without deleting, then fails on stray files, so a successful build leaves a tree that passes the guard. `mesh inspect [resource]` prints the same model JSON serialisation without writing. The commands use `mesh.config.ts` in the current directory, with no upward search; `@mesh/cli` re-exports `defineConfig`. Wiring the guard into `verify` is task `m1-example` ([roadmap](../roadmap/roadmap.md), M1). Detail in [generated-code-and-guard.md](./generated-code-and-guard.md).

## The not-implemented rule

The tag contracts accept the whole vocabulary before the compiler handles it. A tag or attribute the contracts accept but the compiler does not yet implement is a build error naming it and the milestone that will ([ADR-0018](../decisions/0018-not-implemented-is-a-build-error.md)). Reason: ignoring it is the silent fallback the roadmap forbids ([roadmap](../roadmap/roadmap.md), section 2, principle 2). The single milestone table is `packages/compiler/src/support.ts`: relationships, calculations and aggregates arrive in M7; changes, validations and `filter` in M4; `sort` in M3; policies in M8. Its implemented-tag list also names every consumed attribute. A coverage test compares these lists with the contracts, so a contract addition cannot be silently ignored. The builder walks MX's tree in source order and reports unsupported tags at their tag positions, without descending into an already unsupported subtree. The full fixture's first diagnostic is at `relationships` (M1, acceptance test 5). Each milestone removes entries as it implements their semantics. `public` is not on the list: M1 records it in the model, and nothing in v1 reads it. What it will mean is open: [ADR-0035](../decisions/0035-meaning-of-public.md) is Proposed.

## What a build error looks like

Every build error names the file, the line and the fix ([roadmap](../roadmap/roadmap.md), section 2, principle 2). Two sources feed that:

- MX diagnostics carry `severity`, `message`, `line`, `column` and `file`. Example for a misspelt root tag: `` `<resourse>` is not a known tag: it has no contract in `customTags`; did you mean `<resource>`? `` at line 1 (MX project notes, updates, entry of 2026-10-04 00:32).
- Mesh's own errors (duplicate resource, unknown `accept` name, not-implemented tag) use the positions kept in the model. Messages and stable diagnostic codes are pinned by the compiler tests, together with their exact source positions (M1, acceptance test 4).

MX stops at the first error per file ([mx-integration.md](./mx-integration.md)); the compiler preserves its message and position and continues through the other files. Every Mesh check runs for every file MX parsed, regardless of errors in other files or other Mesh checks. An unsupported subtree does not suppress resource-name, attribute, action or primary-key checks. Only an MX error in that file prevents those checks because there is no tree. Any error makes the returned document null; diagnostics remain available to the caller. Mesh-built filesystem messages retain structured error codes and relative file identities without embedding machine-absolute paths. The same relative-path rule applies to model path fields and every diagnostic's `position.file`. Exceptions thrown while loading executable `mesh.config.ts` are external text: the diagnostic keeps the config's relative position and appends the exception's name and message verbatim, even if that text contains an absolute path. Mesh does not scrub or reinterpret exception prose.

## Determinism

Same input, same bytes ([roadmap](../roadmap/roadmap.md), M1). The formatter is pinned to an exact version, and acceptance test 2 builds twice and compares. Without determinism the guard would fail on harmless differences. File ordering and key order in `model.json` are not stated in the roadmap.
