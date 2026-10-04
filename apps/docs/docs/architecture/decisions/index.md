---
title: "Decisions"
description: "Architecture decision records for Mesh."
---

# Decisions

One page per decision, in ADR (architecture decision record) format. A record captures a choice, the options that were considered and why one won, so that a later reader does not have to reconstruct them.

- Start from the [template](./_template.md).
- Name files `NNNN-short-title.md`. See [Contributing to these docs](../contributing.md).
- Records are never deleted. A reversed decision gets a new record, and the old one is marked `Superseded by NNNN`.

<!-- records:start -->

## The records

Every architecture decision for Mesh has one record here, an ADR (architecture decision
record), in the format of the `engineering:architecture` skill: status, date, deciders,
context, decision, options considered, trade-off analysis, consequences, action items
([ADR-0032](./0032-docs-site-and-decision-records.md)).

How to read the status:

- **Accepted**: decided. The record quotes the ruling and says who made it. Deciders are named by role: the
  **operator** is the project owner (Saulo Vallory); the **lead** is the team lead who
  coordinates the work, and the operator may overrule the lead; the **roadmap author** wrote
  the roadmap and proposed parts of the design, and the lead or the operator may overrule.
- **Proposed**: open. The record gives the options and a recommendation, and says who must
  rule and what the decision blocks.
- **Superseded**: reversed by a later record. Kept so that nobody proposes it again without
  knowing it was tried and why it was dropped.

The roadmap ([roadmap](../roadmap/roadmap.md)) says in which milestone each decision
is built; its section 8 maps every ruling to its ADR and milestone. The rulings themselves are
recorded in [rulings of 2026-10-04](./rulings-2026-10-04.md).

## Foundations

| ADR | Decision | Status | Deciders |
|---|---|---|---|
| [0001](./0001-three-rings.md) | Three rings: core, adapters, extensions | Accepted | operator |
| [0002](./0002-resource-files-are-mx.md) | Resource files are `.mx`, read through MX as a static data tree | Accepted | operator |
| [0043](./0043-mx-is-core.md) | MX is core, not an adapter; no front-end adapter slot | Accepted | operator |
| [0003](./0003-generated-code-carries-behaviour.md) | Generated code carries the behaviour; the run-time library stays thin | Accepted | operator |
| [0004](./0004-no-measurement-gate.md) | Mesh is built regardless; measuring the agent benefit is not a gate | Accepted | operator |
| [0005](./0005-core-interface-is-a-function-call.md) | The core's interface is a function call; transports are optional adapters, none in v1 | Accepted | operator |
| [0006](./0006-cli-first-transport.md) | The first transport is a CLI | Superseded by 005 | lead |
| [0007](./0007-scope-is-a-plain-argument.md) | The scope `{ actor, context }` is a plain argument on every action call | Accepted | lead |
| [0047](./0047-actions-are-bound-to-a-data-layer.md) | Actions are bound to a data layer | Accepted | operator |
| [0008](./0008-actor-resolver-adapter.md) | Transports obtain the scope through an actor-resolver adapter | Superseded by 007 | lead |
| [0009](./0009-tenancy-placement.md) | Where tenancy lives: core or extension | Proposed | operator |
| [0019](./0019-v1-scope.md) | v1 is milestones M0 to M9; what comes after | Accepted | operator |
| [0033](./0033-core-split-build-time-run-time.md) | Core packages are split by when the code runs | Accepted | roadmap author |

## Data and expressions

| ADR | Decision | Status | Deciders |
|---|---|---|---|
| [0010](./0010-one-expression-tree-two-evaluators.md) | One expression tree, evaluated in memory and in SQL | Accepted | operator; roadmap author for how the forms are produced |
| [0011](./0011-sql-only-expressions.md) | Translatable expressions run only as SQL | Superseded by 010 | roadmap author (never accepted) |
| [0012](./0012-expression-semantics.md) | Expression semantics where SQL and JavaScript differ | Proposed | operator or lead |
| [0013](./0013-data-layer-contract-and-capabilities.md) | Data-layer contract: a mandatory set plus declared capabilities | Accepted | operator |
| [0014](./0014-sql-adapters-on-drizzle.md) | SQL adapters are built on Drizzle and drizzle-kit | Accepted | operator's position, lead's choice of tool |
| [0015](./0015-sql-printed-by-mesh.md) | Mesh prints SQL and diffs schemas itself | Superseded by 014 | roadmap author (recommendation) |
| [0016](./0016-in-memory-data-via-sqlite.md) | In-memory data for tests is SQLite's in-memory mode | Accepted | roadmap author |
| [0048](./0048-schema-inside-the-process-for-tests.md) | Schema inside the process for tests | Accepted | lead |
| [0017](./0017-atomic-by-default-and-classification.md) | Updates are atomic by default; changes and validations are classified | Accepted | operator, lead, roadmap author |
| [0018](./0018-not-implemented-is-a-build-error.md) | A valid but unimplemented tag is a build error | Accepted | roadmap author |
| [0044](./0044-folding-record-reading-validations.md) | Folding record-reading validations into the atomic statement (after v1) | Proposed | lead and operator |
| [0045](./0045-has-one-uniqueness.md) | How `has-one` is kept to one row | Proposed | operator |

## Extensions, policies, workflows, vocabulary

| ADR | Decision | Status | Deciders |
|---|---|---|---|
| [0020](./0020-extension-contributions-through-declared-points.md) | Extensions contribute to each other only through declared points | Accepted | operator |
| [0021](./0021-composed-contracts-module.md) | Mesh generates one self-contained MX contracts module | Accepted | lead |
| [0022](./0022-policies-simple-tier-as-extension.md) | Policies: a simple tier, solver-ready, as a first-party extension | Accepted | operator |
| [0036](./0036-deny-by-default-arrives-with-policies.md) | Deny by default arrives with the policies extension | Accepted | lead |
| [0046](./0046-denied-atomic-write-outcome.md) | What a denied write reports on an atomic action | Proposed | operator |
| [0023](./0023-workflows-and-jobs-deferred.md) | Workflows and jobs come after v1; the adapter interface stays a design document | Accepted | operator |
| [0024](./0024-in-process-runner-first.md) | The in-process workflow runner is the first adapter | Superseded by 023 | operator |
| [0034](./0034-vocabulary-copies-ash-dsl.md) | The resource vocabulary copies Ash's DSL for v1; optimised for MX after v1 | Accepted | operator; lead for the spelling |
| [0041](./0041-mx-concise-syntax.md) | Resource files and examples always use MX concise syntax | Accepted | operator |
| [0035](./0035-meaning-of-public.md) | What `public` on an attribute means | Proposed | operator |
| [0037](./0037-vocabulary-source-of-truth.md) | Which artefact is the source of truth for the vocabulary | Proposed | operator or lead |

## Platform, tooling, process

| ADR | Decision | Status | Deciders |
|---|---|---|---|
| [0025](./0025-bun-only.md) | Mesh runs on Bun only | Accepted | operator |
| [0026](./0026-node-parity.md) | Mesh runs on Bun and Node | Superseded by 025 | operator |
| [0027](./0027-no-mcp-agent-surface.md) | No MCP server; the agent surface is a rules file, later a generated CLI | Accepted | operator |
| [0028](./0028-validation-zod-behind-standard-schema.md) | Input validation is Zod behind Standard Schema | Accepted | lead |
| [0029](./0029-tracing-opentelemetry-api.md) | Tracing calls the OpenTelemetry API directly | Accepted | lead |
| [0030](./0030-established-tools-first.md) | Established tools first, behind Mesh contracts | Accepted | operator |
| [0031](./0031-no-ci-until-mx-is-published.md) | No CI until the MX packages are published | Accepted | operator |
| [0032](./0032-docs-site-and-decision-records.md) | Docs site in the repo; decisions as ADRs; the repo is the source of truth | Accepted | operator |
| [0038](./0038-elysia-is-not-core.md) | Elysia is not core; a candidate HTTP adapter | Accepted | operator |
| [0039](./0039-run-time-error-positions.md) | Run-time errors: embedded positions or source maps | Proposed | operator or lead |
| [0040](./0040-package-and-command-names.md) | Package scope and command name | Proposed | operator |
| [0042](./0042-open-source-mit.md) | Mesh is open source under MIT; the docs are public | Accepted | operator |

The accepted records [ADR-0017](./0017-atomic-by-default-and-classification.md) and [ADR-0022](./0022-policies-simple-tier-as-extension.md) also carry **Proposed amendments dated 2026-10-04**, by the lead: validations see the post-change record plus input; create policies see the proposed record and query relationships inside the transaction before insert.

## Open decisions at a glance

Nine records are Proposed. One blocks v1 work outright: [ADR-0012](./0012-expression-semantics.md) (expression semantics, before
M4). [ADR-0037](./0037-vocabulary-source-of-truth.md) (before M1), [ADR-0039](./0039-run-time-error-positions.md) (before M5), [ADR-0045](./0045-has-one-uniqueness.md) (before M7) and [ADR-0046](./0046-denied-atomic-write-outcome.md) (before M8) have
a working assumption in the roadmap. [ADR-0044](./0044-folding-record-reading-validations.md) is for after v1. [ADR-0009](./0009-tenancy-placement.md), [ADR-0035](./0035-meaning-of-public.md) and [ADR-0040](./0040-package-and-command-names.md) block nothing in v1.

The dated log the records quote: [rulings of 2026-10-04](./rulings-2026-10-04.md).
