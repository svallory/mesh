---
title: "Decisions"
description: "Architecture decision records for Mesh: the current records and the superseded ones."
---

# Decisions

One page per decision, in ADR (architecture decision record) format. A record captures a choice, the options that were considered and why one won, so that a later reader does not have to reconstruct them.

- Start from the [template](./_template.md).
- Name files `NNNN-short-title.md`. See [Contributing to these docs](../contributing.md).
- Records are never deleted or rewritten. A reversed decision gets a new record; the old one is marked **Superseded** (replaced) or **Amended** (partly changed), gains one line at the top linking its successor, and keeps its body as history.

<!-- records:start -->

## How to read a record

Every record has the same sections: status, date, deciders, context, decision, options considered, trade-off analysis, consequences, action items ([ADR-0032](./0032-docs-site-and-decision-records.md)).

- **Accepted**: decided. The record quotes the ruling and says who made it.
- **Accepted, amended**: decided, but a later record changed part of it. Read the successor first.
- **Proposed**: open. The record gives the options and a recommendation, and says who must rule and what the decision blocks.
- **Superseded**: replaced by a later record. Kept so that nobody proposes it again without knowing it was tried and why it was dropped.

Deciders are named by role. The **operator** is the project owner (Saulo Vallory). The **lead** coordinates the work; the operator may overrule the lead, and on 2026-10-05 delegated every open decision to the lead ("the lead, delegated by the operator"). The **roadmap author** wrote the roadmap and proposed parts of the design.

The rulings the records quote are in the dated log, [rulings of 2026-10-04](./rulings-2026-10-04.md). The [roadmap](../roadmap/roadmap.md) says in which milestone each decision is built.

## What changed on 2026-10-04 evening and 2026-10-05

The operator's rulings of those two days replaced the vocabulary copied from Ash with Mesh's own entity file syntax and renamed most things a user sees. Records 0049 to 0065 hold them:

- **Terms and syntax**: `resource` became `entity` and the vocabulary is Mesh's own ([0049](./0049-vocabulary-is-meshs-own.md)); every line is `kind #name options` ([0050](./0050-entity-file-syntax.md), with the reference file); files end in `.mesh.mx` ([0051](./0051-mesh-mx-files-and-the-mesh-host.md)); actions, `auto` and `on:load` ([0052](./0052-actions-auto-and-on-load.md)); `validate` then `do` ([0053](./0053-validate-then-do.md)); the write strategy is inferred ([0054](./0054-write-strategy-is-inferred.md)); policies are core, fail closed and combine without order ([0055](./0055-policies-are-core.md)); a function whose body is one expression is translated ([0056](./0056-translated-expressions-are-one-expression-arrows.md)).
- **Project shape**: one domain at `src/domain/` with modules as folders ([0057](./0057-one-domain-modules-as-folders.md)); generated code in `.mesh/`, imported as `#mesh` ([0058](./0058-generated-code-in-mesh-imported-as-hash-mesh.md)); the flat `ActionContext` ([0059](./0059-action-context.md)); packages `@meshfw/*` ([0060](./0060-meshfw-package-scope.md)); Jig templates ([0061](./0061-generators-are-jig-templates.md)); Zod 4, Drizzle and OpenTelemetry as direct dependencies ([0062](./0062-direct-dependencies-zod-drizzle-opentelemetry.md)).
- **Process**: docs first in the 1.0 voice, and the hold ([0063](./0063-user-docs-first-and-the-hold.md)); the order of work after approval ([0064](./0064-order-of-work-after-approval.md)); highlighting `mx` code on this site ([0065](./0065-mx-highlighting-on-the-docs-site.md)).

The code on `main` still uses the names of 2026-10-04 morning until the realignment task ([0064](./0064-order-of-work-after-approval.md)).

## Current records

| ADR | Decision | Status | Deciders |
|---|---|---|---|
| [0001](./0001-three-rings.md) | Three rings: core, adapters, extensions | Accepted | operator |
| [0002](./0002-resource-files-are-mx.md) | Entity files are MX, read as a static data tree | Accepted, amended by 0049, 0050, 0051 | operator |
| [0003](./0003-generated-code-carries-behaviour.md) | Generated code carries the behaviour; the run-time library stays thin | Accepted | operator |
| [0004](./0004-no-measurement-gate.md) | Mesh is built regardless; measuring the agent benefit is not a gate | Accepted | operator |
| [0005](./0005-core-interface-is-a-function-call.md) | The core's interface is a function call; transports are optional adapters, none in v1 | Accepted | operator |
| [0010](./0010-one-expression-tree-two-evaluators.md) | One expression tree, evaluated in memory and in SQL | Accepted, amended by 0056 | operator; roadmap author |
| [0012](./0012-expression-semantics.md) | Expression semantics where SQL and JavaScript differ | Proposed (blocks M4) | operator or lead |
| [0013](./0013-data-layer-contract-and-capabilities.md) | Data-layer contract: a mandatory set plus declared capabilities | Accepted | operator |
| [0014](./0014-sql-adapters-on-drizzle.md) | SQL adapters are built on Drizzle and drizzle-kit | Accepted | operator's position, lead's choice of tool |
| [0016](./0016-in-memory-data-via-sqlite.md) | In-memory data for tests is SQLite's in-memory mode | Accepted | roadmap author |
| [0017](./0017-atomic-by-default-and-classification.md) | Updates are atomic by default; a step never runs twice | Accepted, amended by 0053, 0054 | operator, lead, roadmap author |
| [0018](./0018-not-implemented-is-a-build-error.md) | A valid but unimplemented tag is a build error | Accepted | roadmap author |
| [0019](./0019-v1-scope.md) | v1 is milestones M0 to M9; what comes after | Accepted | operator |
| [0020](./0020-extension-contributions-through-declared-points.md) | Extensions contribute to each other only through declared points | Accepted | operator |
| [0021](./0021-composed-contracts-module.md) | Mesh generates one self-contained MX contracts module | Accepted | lead |
| [0022](./0022-policies-simple-tier-as-extension.md) | Policies: a simple tier, solver-ready | Accepted, amended by 0055 | operator |
| [0023](./0023-workflows-and-jobs-deferred.md) | Workflows and jobs come after v1; the adapter interface stays a design document | Accepted | operator |
| [0025](./0025-bun-only.md) | Mesh runs on Bun only | Accepted | operator |
| [0027](./0027-no-mcp-agent-surface.md) | No MCP server; the agent surface is a rules file, later a generated CLI | Accepted | operator |
| [0028](./0028-validation-zod-behind-standard-schema.md) | Input validation is Zod behind Standard Schema (confirmed by 0062) | Accepted | lead |
| [0029](./0029-tracing-opentelemetry-api.md) | Tracing calls the OpenTelemetry API directly | Accepted | lead |
| [0030](./0030-established-tools-first.md) | Established tools first, behind Mesh contracts | Accepted | operator |
| [0031](./0031-no-ci-until-mx-is-published.md) | No CI until the MX packages are published | Accepted | operator |
| [0032](./0032-docs-site-and-decision-records.md) | Docs site in the repo; decisions as ADRs; the repo is the source of truth | Accepted | operator |
| [0033](./0033-core-split-build-time-run-time.md) | Core packages are split by when the code runs | Accepted | roadmap author |
| [0035](./0035-meaning-of-public.md) | What `public` on an attribute means (syntax v2 has no `public`) | Proposed | operator |
| [0037](./0037-vocabulary-source-of-truth.md) | Contracts or registries as the source of truth for the vocabulary | Proposed | operator or lead |
| [0038](./0038-elysia-is-not-core.md) | Elysia is not core; a candidate HTTP adapter | Accepted | operator |
| [0039](./0039-run-time-error-positions.md) | Run-time errors: embedded positions or source maps | Proposed | operator or lead |
| [0041](./0041-mx-concise-syntax.md) | Entity files and examples always use MX concise syntax | Accepted | operator |
| [0042](./0042-open-source-mit.md) | Mesh is open source under MIT; the docs are public | Accepted | operator |
| [0043](./0043-mx-is-core.md) | MX is core, not an adapter; no front-end adapter slot | Accepted | operator |
| [0044](./0044-folding-record-reading-validations.md) | Folding record-reading checks into the atomic statement (after v1) | Proposed | lead and operator |
| [0045](./0045-has-one-uniqueness.md) | How `has-one` is kept to one row | Proposed | operator |
| [0046](./0046-denied-atomic-write-outcome.md) | What a denied write reports on an atomic action | Proposed | operator |
| [0047](./0047-actions-are-bound-to-a-data-layer.md) | Actions are bound to a data layer: `bind` and `connect` | Accepted, amended by 0059 | operator |
| [0048](./0048-schema-inside-the-process-for-tests.md) | Schema inside the process for tests; the stable Drizzle pin | Accepted | lead |
| [0049](./0049-vocabulary-is-meshs-own.md) | The vocabulary is Mesh's own; `resource` becomes `entity` | Accepted | operator |
| [0050](./0050-entity-file-syntax.md) | Entity file syntax: `kind #name options`, with the reference file | Accepted | operator |
| [0051](./0051-mesh-mx-files-and-the-mesh-host.md) | Entity files end in `.mesh.mx`; Mesh ships an MX host named `mesh` | Accepted | operator; lead, delegated |
| [0052](./0052-actions-auto-and-on-load.md) | Actions are always named; `auto`; `on:load`; `arguments` | Accepted | operator |
| [0053](./0053-validate-then-do.md) | `validate`, then `do`; steps `set`, `when`, `load`, `run`; `always`; reusable steps planned | Accepted | operator; lead, delegated |
| [0054](./0054-write-strategy-is-inferred.md) | Mesh infers the write strategy; no `require-atomic` | Accepted | lead, delegated |
| [0055](./0055-policies-are-core.md) | Policies are core; every covering policy must pass; no policies means forbidden | Accepted | operator; lead, delegated |
| [0056](./0056-translated-expressions-are-one-expression-arrows.md) | A function whose body is one expression is translated; Mesh builds its own translator | Accepted | operator; lead, delegated |
| [0057](./0057-one-domain-modules-as-folders.md) | One domain at `src/domain/`; its folders are modules | Accepted | operator |
| [0058](./0058-generated-code-in-mesh-imported-as-hash-mesh.md) | Generated code in `.mesh/`, committed, imported as `#mesh` | Accepted | operator; lead, delegated |
| [0059](./0059-action-context.md) | The second argument is the flat `ActionContext`; tenancy is a user key | Accepted | operator |
| [0060](./0060-meshfw-package-scope.md) | Packages are `@meshfw/*`; the command is `mesh` | Accepted | operator |
| [0061](./0061-generators-are-jig-templates.md) | Generators are Jig templates; export and per-template override | Accepted | operator |
| [0062](./0062-direct-dependencies-zod-drizzle-opentelemetry.md) | Zod 4 stays; direct dependencies on Zod, Drizzle, OpenTelemetry | Accepted | operator; lead, delegated |
| [0063](./0063-user-docs-first-and-the-hold.md) | User docs first, in the 1.0 voice; development on hold until approved | Accepted | operator |
| [0064](./0064-order-of-work-after-approval.md) | After approval: realignment, Jig port, then M2 | Accepted | lead, delegated |
| [0065](./0065-mx-highlighting-on-the-docs-site.md) | The docs site highlights `mx` code with MX's tree-sitter highlighter | Accepted | lead, delegated, with the MX lead |

## Superseded records

| ADR | Decision | Superseded by | Deciders |
|---|---|---|---|
| [0006](./0006-cli-first-transport.md) | The first transport is a CLI | [0005](./0005-core-interface-is-a-function-call.md) | lead |
| [0007](./0007-scope-is-a-plain-argument.md) | The scope `{ actor, context }` is a plain argument on every action call | [0059](./0059-action-context.md) | lead |
| [0008](./0008-actor-resolver-adapter.md) | Transports obtain the scope through an actor-resolver adapter | [0007](./0007-scope-is-a-plain-argument.md) | lead |
| [0009](./0009-tenancy-placement.md) | Where tenancy lives: core or extension (was Proposed) | [0059](./0059-action-context.md) | operator |
| [0011](./0011-sql-only-expressions.md) | Translatable expressions run only as SQL | [0010](./0010-one-expression-tree-two-evaluators.md) | roadmap author (never accepted) |
| [0015](./0015-sql-printed-by-mesh.md) | Mesh prints SQL and diffs schemas itself | [0014](./0014-sql-adapters-on-drizzle.md) | roadmap author |
| [0024](./0024-in-process-runner-first.md) | The in-process workflow runner is the first adapter | [0023](./0023-workflows-and-jobs-deferred.md) | operator |
| [0026](./0026-node-parity.md) | Mesh runs on Bun and Node | [0025](./0025-bun-only.md) | operator |
| [0034](./0034-vocabulary-copies-ash-dsl.md) | The vocabulary copies Ash's DSL for v1 | [0049](./0049-vocabulary-is-meshs-own.md) | operator; lead for the spelling |
| [0036](./0036-deny-by-default-arrives-with-policies.md) | Deny by default arrives with the policies extension | [0055](./0055-policies-are-core.md) | lead |
| [0040](./0040-package-and-command-names.md) | Package scope and command name (was Proposed) | [0060](./0060-meshfw-package-scope.md) | operator |

## Open decisions at a glance

Seven records are Proposed. One blocks v1 work outright: [ADR-0012](./0012-expression-semantics.md) (expression semantics, before M4). [ADR-0037](./0037-vocabulary-source-of-truth.md) now also decides where attribute-type tag names come from ([ADR-0050](./0050-entity-file-syntax.md)) and should be ruled in the realignment task. [ADR-0039](./0039-run-time-error-positions.md) (before M5), [ADR-0045](./0045-has-one-uniqueness.md) (before M7) and [ADR-0046](./0046-denied-atomic-write-outcome.md) (before M8) have a working assumption in the roadmap. [ADR-0044](./0044-folding-record-reading-validations.md) is for after v1. [ADR-0035](./0035-meaning-of-public.md) blocks nothing in v1.
