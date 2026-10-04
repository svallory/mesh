---
title: "Core, adapters and extensions"
description: "Core, adapters and extensions: the test for each ring and where every package sits."
---

# Core, adapters and extensions

Status: design; the ring split is applied from M0 and fully exercised by M6 (extension host) and M8 (first extension). M0 is done: `packages/compiler` holds the tag contracts and their tests; the other packages do not exist yet ([roadmap](../roadmap/roadmap.md), M0).

## Why rings

Mesh's rule is that only what Mesh cannot run without is hardcoded, and "it was in the plan" is never a reason to hardcode something ([roadmap](../roadmap/roadmap.md), section 2, principle 4; [ADR-0001](../decisions/0001-three-rings.md)). The rule was set after the first proposal classed tools as "integral" because their names would appear in generated code, which the project owner judged the wrong test ([research synthesis](../research/synthesis.md), Step 2 preamble).

## Definitions and tests

| Ring | Definition | Test |
|---|---|---|
| Core | Hardcoded; Mesh cannot run without it | Remove it: does Mesh stop working? |
| Adapter | One replaceable implementation of a contract core owns | Can a project pick another implementation of the same contract? |
| Extension | Optional feature built on core's extension points | Can a project do without it, or do most projects not use it? |

([research synthesis](../research/synthesis.md), Step 2 preamble; [roadmap](../roadmap/roadmap.md), section 0.)

## Packages

Names are working names; npm availability was not checked. The final names are open: [ADR-0040](../decisions/0040-package-and-command-names.md) is Proposed and the project owner must rule on it. The roadmap's working assumption is `@mesh/*` and the `mesh` command ([roadmap](../roadmap/roadmap.md), section 3).

| Package | Ring | Runs when | Why it sits there |
|---|---|---|---|
| `model` | core | build | Every build-time package reads the model. Plain JSON-serialisable types, registries (attribute types, expression functions, check kinds), the diagnostic type. |
| `compiler` | core | build | The pipeline is what makes Mesh a framework. Owns stage order, the extension host and the emitters every project needs. It is also where MX is used: the tag contracts and the load and check-structure stages live here. |
| `cli` | core | build | The `mesh` command is the only entry to the pipeline. It builds a project; it does not run actions. Commands such as `mesh db push` and `mesh migrate` are contributed by the data adapter, so `cli` imports no query library and never imports drizzle-kit ([roadmap](../roadmap/roadmap.md), section 3 and M2). |
| `runtime` | core | run | What generated code imports: scope type, error classes, the data-layer contract with query and expression-tree types, the transaction helper, in-memory implementations of registered expression functions. |
| `data-drizzle` | adapter | run (inferred) | Shared code of the SQL adapters: turns Mesh queries and expression trees into Drizzle's builder when a query runs (M3, M4). |
| `data-sqlite` | adapter | both | Data layer on SQLite. A build-time half emits Drizzle table definitions; a run-time half implements the contract (M2). |
| `data-postgres` | adapter | both | Data layer on Postgres (M9); `mesh migrate generate` needs its schema emitted at build time. |
| `ext-policies` | extension | both | Authorization rules: a verifier at build time (M8), the authorizer slot at run time (M5, M8). |

([roadmap](../roadmap/roadmap.md), section 3 and the milestones cited. The "Runs when" entries marked inferred are not stated in the roadmap.)

Why the split between `compiler` and `runtime`: a deployed program must not carry the compiler ([ADR-0033](../decisions/0033-core-split-build-time-run-time.md)). Contract types the generated code needs (scope, errors, query, expression tree) therefore live in `runtime`.

Why SQL adapters are adapters: the data-layer contract is Mesh's own and "the query library inside an adapter is that adapter's private choice" ([research synthesis](../research/synthesis.md), section 11), which is Drizzle ([ADR-0013](../decisions/0013-data-layer-contract-and-capabilities.md), [ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md)).

Why authorization is split: the slot in the lifecycle is core, the rules engine is replaceable. Authorization is "a fixed slot in the core lifecycle, filled by a first-party policy extension" ([research synthesis](../research/synthesis.md), section 10, last paragraph; [ADR-0022](../decisions/0022-policies-simple-tier-as-extension.md)). `ext-policies` is on by default and the policy tags move from the core contracts into it in M8 ([roadmap](../roadmap/roadmap.md), M8).

## Why MX is core and not an adapter

The research proposed "front end" and "expression parser" adapter slots ([research synthesis](../research/synthesis.md), section 15). The project owner ruled otherwise: MX is not replaceable, so there is no front-end slot and no front-end package ([ADR-0043](../decisions/0043-mx-is-core.md)). Reason: tag contracts, `analyze` rules, positioned errors and the composed contracts module are MX concepts and would leak through any neutral contract; a contract with one implementation is a guess. The expression-parser slot disappears for the same reason: MX hands each expression over as a parsed Babel node. The cost is a hard dependency on a project Mesh does not control ([ADR-0043](../decisions/0043-mx-is-core.md)).

## Adapter slots with no package

| Slot | Why no package in v1 |
|---|---|
| Transport (command line, HTTP, server) | The core interface is a function call; a transport is built when something needs it ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)). |
| Tracer | Generated code calls the OpenTelemetry API directly ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md)). |
| Runtime host | Bun only ([ADR-0025](../decisions/0025-bun-only.md)). |

([roadmap](../roadmap/roadmap.md), section 3.) There is no actor-resolver slot: the caller passes the scope as an argument ([ADR-0007](../decisions/0007-scope-is-a-plain-argument.md), which superseded [ADR-0008](../decisions/0008-actor-resolver-adapter.md)). A job runner is deferred past v1 ([ADR-0023](../decisions/0023-workflows-and-jobs-deferred.md)).

## Where does new code go

A procedure derived from the three tests above, not a separate rule.

1. Does it run when `mesh build` runs, or inside the deployed program? Build-time code goes to `model`, `compiler`, `cli` or an adapter's build half. Run-time code goes to `runtime` or an adapter's run-time half.
2. Can Mesh not function without it? Then it is core. If it is one way to do a core job, it is an adapter behind a contract core owns; write the contract first.
3. Is it a feature some projects will not use? Then it is an extension and may touch the model only through a declared contribution point ([ADR-0020](../decisions/0020-extension-contributions-through-declared-points.md)). Until M6 there is no extension host.
4. Is it an application concern: how a caller is identified, how a program is exposed, login? Then it is not Mesh ([roadmap](../roadmap/roadmap.md), section 2, principle 8).
5. Does a well-established tool do it? Put that tool behind a Mesh contract ([ADR-0030](../decisions/0030-established-tools-first.md)).

## Import rules

Checked by `verify`: the MX rule from M1 and the rest from M2 ([roadmap](../roadmap/roadmap.md), M1, acceptance test 8; M2, acceptance test 4):

- `runtime` imports nothing from `model`, `compiler` or Drizzle. The build-time packages may import `runtime`'s contract types, never the reverse ([roadmap](../roadmap/roadmap.md), section 3, `runtime` row; [ADR-0033](../decisions/0033-core-split-build-time-run-time.md)).
- `compiler` depends on MX. `model` and `runtime` never import it; `@mxlang/*` is imported only by packages that declare tag contracts, `compiler` now and extensions from M6 ([ADR-0043](../decisions/0043-mx-is-core.md)).
- No generated handler imports `model`, `compiler`, Drizzle or `model.json`.
- Drizzle is imported only under `packages/data-*` and in the emitted schema file.

Why: a `runtime` that cannot see the model cannot interpret it, so behaviour has to be in the generated code ([ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)). Drizzle is a release candidate whose relations API is being replaced, so confining it limits the cost of an upgrade ([roadmap](../roadmap/roadmap.md), section 9, risk 3).

Not decided: the order of dependency among `model`, `compiler` and `cli`; the roadmap does not give it.
