---
title: "Generated code and the guard"
description: "What Mesh generates and commits, why the behaviour lives there, and how the guard keeps it honest."
---

# Generated code and the guard

Status: design; the model and types are built in M1 (task `m1-emit`) — `model.json` and one types file per resource are generated today, by the emit stage, which `mesh build` will call — while handlers and the Drizzle schema come in M2, expression forms in M4, the contracts module in M6. Tag names are today's working names ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)).

## The rule

Generated code carries the behaviour; the run-time library stays thin ([ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)). The project owner's ruling: "As much as Ash puts in its resources, or more. Generated code carries the behaviour; the shared engine stays thin" ([rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), table row 2).

Why: Ash keeps behaviour in its library, so stack traces are unhelpful and test coverage of a user's own resource reads 0% ([research synthesis](../research/synthesis.md), section 6, item 2). If generated handlers were thin calls into a shared engine, Mesh would inherit both problems (section 8, "Gaps", item 1).

The test: the run-time library never reads the resource model ([roadmap](../roadmap/roadmap.md), section 2, principle 1).

## What Mesh generates and commits

The generated tree is committed and guarded ([roadmap](../roadmap/roadmap.md), section 2, principle 6).

| File | What it is | Milestone |
|---|---|---|
| `<output>/model.json` | One file holding one document per resource, with source positions | M1 |
| `<output>/<domain>/<resource>.types.ts` | TypeScript types for the resource | M1 |
| One handler file per resource | One exported function per action, for example `createPost(input, scope)` | M2 |
| Input validators | Zod schemas, seen by the rest of Mesh only through Standard Schema ([ADR-0028](../decisions/0028-validation-zod-behind-standard-schema.md)) | M2 |
| Drizzle schema file | Table definitions emitted by `data-sqlite`'s build half | M2 |
| Expression forms | For each translatable expression, the tree as a data literal and the in-memory form as TypeScript; the class (translatable or opaque) is recorded in `model.json` | M4 |
| Contracts module | One self-contained module for MX tooling ([ADR-0021](../decisions/0021-composed-contracts-module.md)) | M6 |

([roadmap](../roadmap/roadmap.md), M1, M2, M4, M6.) The example's `mesh explain` output is also committed, as a guarded fixture; it is not stated that every project commits it (M5, acceptance test 5). The directory layout beyond `generated/model.json` and the rule that `domain` sets the output directory is not given by the roadmap. Whether migrations written by `mesh migrate generate` (M9) are under the guard is not stated.

### The tree emitted in M1

Built in M1 (task `m1-emit`). `<output>` is the configuration's `output` key, so the paths follow the project, not a fixed `generated/`.

- **`<output>/model.json`.** The whole model document, one entry per resource, written by Mesh's own stable serialiser: keys in lexicographic order, two-space indentation, one trailing newline. A formatter is not involved, and nothing that varies per run may reach the file.
- **One types file per resource**, at `<output>/<domain>/<resource>.types.ts` when the resource has a `domain` and `<output>/<resource>.types.ts` when it has not. The file opens with a do-not-edit header naming the resource file it came from, with any line terminator in that name spelled out, and imports nothing: not `model`, not `compiler`, not `model.json` ([ADR-0033](../decisions/0033-core-split-build-time-run-time.md)). It holds the record type (one member per attribute, with the TypeScript type its registry entry names, `T | null` when the attribute allows nil, and a union of string literals for an `atom` with `one_of`) and one input type per action that has one. `public` produces nothing ([ADR-0035](../decisions/0035-meaning-of-public.md)).
- **Inputs follow the action spec.** A `create` takes exactly its `accept`ed attributes, required unless the attribute allows nil or carries a default. An `update` takes `{ id, ...accepted }`: the resource's primary key as a required selector, then every accepted attribute optional. A `destroy` takes `{ id }`, the selector alone — the [live action spec](../../docs/calling-actions.md) describes no other field, so a `destroy` that accepts attributes has no input shape in M1 and is a build error at the action rather than a silent reduction. The key stays out of `accept`: a selector is not a payload field, and a `create` never carries one. An input with no field at all is emitted as a `never` index signature, so `{}` is accepted and neither an unknown field nor a primitive is. A `read` has no input type in M1.
- **An action asked for through `defaults`** gets its input type like a declared one, named after its kind (`create` is `CreatePostInput`), and accepts nothing, since no `accept` names attributes. A declared action of a kind replaces the default action of that kind, so a resource never has two actions of one kind.
- **Names.** A resource's record type is its name in PascalCase, and an input type is `<Action><Resource>Input`, so the names line up with the M2 handlers (`createPost`). Only ASCII letters and digits survive the conversion, and a leading underscore is kept: `blog-post` reads as `BlogPost`, `café` as `Caf`. An attribute whose name is not a TypeScript identifier is emitted as a quoted property, keeping the name the author wrote. These are build errors at the name, never a silent rename: a resource or action name that cannot become a type name; two resources that would generate the same record type name; two names in one file that would generate the same type name; a generated type name that would capture a global the file uses (the list is read from the attribute type registry, so a resource named `date` cannot emit a `Date` that swallows every `datetime` attribute); and two generated paths that differ only in letter case, which would alias one file on a case-insensitive file system.
- **The formatter.** Generated TypeScript is built from templates and passed through Prettier, pinned to an exact version, with the configuration fixed in `packages/compiler/src/format.ts`. The user's `.prettierrc`, `.editorconfig` or a `prettier` plugin is not read: a project cannot change what Mesh writes, so an upgrade of the formatter is a deliberate edit that rewrites the committed tree on purpose.
- **Determinism.** The same model gives the same bytes: resources are ordered by name, so the order of the resource files on disk or in `mesh.config.ts` does not reach the output, and no timestamp, absolute path, machine name or random id is written. A finite number keeps its spelling through the round trip, a negative zero included.
- **Writing is confined and never destructive.** The writer resolves the output folder and every target through any symlink on the way and refuses a target whose real location leaves the output folder, and any file or folder inside it that is itself a symlink: it will not write through one, whatever it points at. Every target is checked before the first byte is written, so a refused tree leaves the disk as it was. It writes only the files it was given and deletes nothing; a stale file from an earlier build is the guard's business.

## Why the tree is a data literal

Each translatable expression is written into the generated file twice ([roadmap](../roadmap/roadmap.md), M4):

1. As the tree itself, a data literal that the data adapter compiles into Drizzle's builder when a query runs. Queries are assembled at run time from the action's filter, the caller's filter and, later, policies, so the SQL cannot be fixed at build time.
2. As its in-memory form, emitted TypeScript that calls the registered functions' in-memory implementations in `runtime`.

The build checks that every function used has a SQL form in the configured adapter. See [expressions.md](./expressions.md).

## What a handler contains

The handler body holds the lifecycle steps in order: validate input, open a transaction, call the data layer, commit, return a typed record. They are written out per action, not delegated to a generic `runAction` ([roadmap](../roadmap/roadmap.md), M2). From M5 the body covers all eight phases, the plan is chosen at build time, and a span is opened per phase through the OpenTelemetry API ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md); [action-lifecycle.md](./action-lifecycle.md)).

A reader should expect to see:

- The scope as the required second argument, `{ actor, context }` ([ADR-0007](../decisions/0007-scope-is-a-plain-argument.md)). A call without one is a type error (M2, acceptance test 5).
- Changes and validations as TypeScript. Translatable ones have an in-memory form emitted here; opaque ones are the authored text sliced from the resource file (M4).
- For atomic updates, the change folded into the `UPDATE` statement; for `require-atomic=false` actions, read the row with a write lock, run in memory, write, in one transaction (M5; [ADR-0017](../decisions/0017-atomic-by-default-and-classification.md)).
- Calls to the data-layer contract and never to Drizzle (M2).

## What the run-time library may contain

`runtime` holds the scope type; error classes; the data-layer contract with the query and expression-tree types; the transaction helper; and the in-memory implementations of registered expression functions ([roadmap](../roadmap/roadmap.md), section 3, `runtime` row). That is all.

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

Hand edits to generated files, or a stale tree after a resource file changes, would make committed code disagree with its source. Wasp's checksum manifest protects a gitignored directory and would not catch hand edits to a committed one, so Mesh needs its own check ([research synthesis](../research/synthesis.md), section 8, "Gaps", item 8).

How it works:

1. `mesh build --check` runs the whole pipeline but regenerates in memory, writing nothing.
2. It compares the result with the committed files.
3. Any difference fails the check and names the file ([roadmap](../roadmap/roadmap.md), M1, acceptance test 3).
4. `verify`, the one local script that runs every check, runs it (M1).

The guard depends on determinism: same input, same bytes, from templates plus a pinned formatter (see [build-pipeline.md](./build-pipeline.md)). It grows with the milestones: handlers and the schema in M2, the example's `explain` output in M5, the contracts module in M6 (M2 test 6, M5 test 5, M6 test 4).

There is no continuous integration until the MX packages are published, so the guard runs only when someone runs `verify` ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md)). A skipped run is invisible ([roadmap](../roadmap/roadmap.md), section 9, risk 4).

## Run-time errors point at resource files

A declared rule that fails at run time (for example a `validate` with its `message`) should report its `.mx` position. The roadmap's working assumption is that the position is carried as data in the generated code ([roadmap](../roadmap/roadmap.md), M5). That is open: [ADR-0039](../decisions/0039-run-time-error-positions.md) is Proposed and records the choice against source maps. One argument against source maps is that Bun's `findSourceMap` returns `undefined` ([research synthesis](../research/synthesis.md), section 12, risk 3).

Errors fall into a class hierarchy built in M5. M2 starts with three classes: invalid input, not found, framework. A read after destroy throws the not-found class (M2, acceptance test 1). A load that cannot be done is a run-time error, never ignored (M7, acceptance test 2).

## Reading generated code

The aim of the ruling is that a reader can follow a handler top to bottom without opening `model.json`; this is an inference from the ruling, not a stated rule. Hand edits to a generated file fail the guard, so change the resource file or the emitter instead.
