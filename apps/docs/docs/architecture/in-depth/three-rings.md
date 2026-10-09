---
title: "Core, adapters and extensions"
description: "Core, adapters and extensions: the test for each ring and where every package sits."
---

# Core, adapters and extensions

Status: the ring split is applied from M0 and fully exercised by M6 (extension host). `model`, `compiler` and `cli` exist since M1; `runtime` since M2 (the action context's type, errors, input validation and [data-layer contract v0](./data-layer.md)). The remaining package roles below are the design ([roadmap](../roadmap/roadmap.md), section 3).

::: callout info "What the code does today"
The workspace packages on `main` are `meshfw` (the `mesh` command and `defineConfig`), `@meshfw/compiler`, `@meshfw/model`, `@meshfw/runtime` (with its `testing` entry) and the private `@meshfw/data-sqlite`, which returns a descriptor only ([ADR-0060](../decisions/0060-meshfw-package-scope.md)). This page shortens them to the part after the scope.
:::

## Why rings

Mesh's rule is that only what Mesh cannot run without is hardcoded, and "it was in the plan" is never a reason to hardcode something ([roadmap](../roadmap/roadmap.md), section 2, principle 4; [ADR-0001](../decisions/0001-three-rings.md)). The rule was set after the first proposal classed tools as "integral" because their names would appear in generated code, which the operator judged the wrong test ([research synthesis](../research/synthesis.md), Step 2 preamble).

## Definitions and tests

| Ring | Definition | Test |
|---|---|---|
| Core | Hardcoded; Mesh cannot run without it | Remove it: does Mesh stop working? |
| Adapter | One replaceable implementation of a contract core owns | Can a project pick another implementation of the same contract? |
| Extension | Optional feature built on core's extension points | Can a project do without it, or do most projects not use it? |

([research synthesis](../research/synthesis.md), Step 2 preamble; [roadmap](../roadmap/roadmap.md), section 0.)

## Packages

All packages are published under the npm scope `@meshfw` ([ADR-0060](../decisions/0060-meshfw-package-scope.md)); the command is `mesh`.

| Package | Ring | Runs when | Why it sits there |
|---|---|---|---|
| `model` | core | build | Every build-time package reads the model. Plain JSON-serialisable types, registries (attribute types, step kinds, expression functions), the diagnostic type. |
| `compiler` | core | build | The pipeline is what makes Mesh a framework. Owns stage order, the extension host, the emitter views and their Jig templates ([ADR-0061](../decisions/0061-generators-are-jig-templates.md)). It is also where MX is used: the tag contracts and the load and check-structure stages live here. |
| `cli` | core | build | The `mesh` command is the only entry to the pipeline. It builds a project; it does not run actions. Commands such as `mesh db push` and `mesh migrate` are contributed by the data adapter, so `cli` imports no query library and never imports drizzle-kit ([roadmap](../roadmap/roadmap.md), section 3 and M2). |
| `runtime` | core | run | What generated code imports: the `ActionContext` type ([ADR-0059](../decisions/0059-action-context.md)), error classes, the data-layer contract with query and expression-tree types, the transaction helper, the policy engine's run-time half, in-memory implementations of registered expression functions. |
| `mesh` (MX host) | core | editor and MX tooling | The MX host package that makes `.mesh.mx` files resolve in MX tooling ([ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)). Its name is fixed by MX. |
| `data-drizzle` | adapter | run | Shared code of the SQL adapters: turns Mesh queries and expression trees into Drizzle's builder when a query runs (M3, M4). |
| `data-sqlite` | adapter | both | Data layer on SQLite. A build-time half emits Drizzle table definitions; a run-time half implements the contract (M2). |
| `data-postgres` | adapter | both | Data layer on Postgres (M9); `mesh migrate generate` needs its schema emitted at build time. |

([roadmap](../roadmap/roadmap.md), section 3 and the milestones cited.)

Why the split between `compiler` and `runtime`: a deployed program must not carry the compiler ([ADR-0033](../decisions/0033-core-split-build-time-run-time.md)). Contract types the generated code needs (the action context, errors, query, expression tree) therefore live in `runtime`.

Why SQL adapters are adapters: the data-layer contract is Mesh's own and "the query library inside an adapter is that adapter's private choice" ([research synthesis](../research/synthesis.md), section 11), which is Drizzle ([ADR-0013](../decisions/0013-data-layer-contract-and-capabilities.md), [ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md)).

Why authorization is core: `policies` is a section of the entity file, and an entity without one forbids every action. A configuration in which authorization is not installed would make that rule depend on a package being present, so the engine is part of core ([ADR-0055](../decisions/0055-policies-are-core.md)). The research had proposed "a fixed slot in the core lifecycle, filled by a first-party policy extension" ([research synthesis](../research/synthesis.md), section 10); the slot stays, and core fills it. Its simple tier is unchanged ([ADR-0022](../decisions/0022-policies-simple-tier-as-extension.md)).

## Why MX is core and not an adapter

The research proposed "front end" and "expression parser" adapter slots ([research synthesis](../research/synthesis.md), section 15). The operator ruled otherwise: MX is not replaceable, so there is no front-end slot and no front-end package ([ADR-0043](../decisions/0043-mx-is-core.md)). Reason: tag contracts, `analyze` rules, positioned errors and the composed contracts module are MX concepts and would leak through any neutral contract; a contract with one implementation is a guess. The expression-parser slot disappears for the same reason: MX hands each expression over as a parsed Babel node. The cost is a hard dependency on a project Mesh does not control.

## Adapter slots with no package

| Slot | Why no package in v1 |
|---|---|
| Transport (command line, HTTP, server) | The core interface is a function call; a transport is built when something needs it ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)). |
| Tracer | Generated code calls the OpenTelemetry API directly ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md)). |
| Runtime host | Bun only ([ADR-0025](../decisions/0025-bun-only.md)). |

([roadmap](../roadmap/roadmap.md), section 3.) There is no actor-resolver slot: the caller passes the action context as an argument ([ADR-0059](../decisions/0059-action-context.md)). A job runner is deferred past v1 ([ADR-0023](../decisions/0023-workflows-and-jobs-deferred.md)).

## Extensions in v1

No first-party extension ships in v1. The host exists from M6 for project-local extensions in `src/extensions/` ([ADR-0057](../decisions/0057-one-domain-modules-as-folders.md)) and for later first-party ones (multitenancy, for example, which reads a key of the action context it declares, [ADR-0059](../decisions/0059-action-context.md)). See [extension host](./extension-host.md).

## Where does new code go

A procedure derived from the three tests above, not a separate rule.

1. Does it run when `mesh build` runs, or inside the deployed program? Build-time code goes to `model`, `compiler`, `cli` or an adapter's build half. Run-time code goes to `runtime` or an adapter's run-time half.
2. Can Mesh not function without it? Then it is core. If it is one way to do a core job, it is an adapter behind a contract core owns; write the contract first.
3. Is it a feature some projects will not use? Then it is an extension and may touch the model only through a declared contribution point ([ADR-0020](../decisions/0020-extension-contributions-through-declared-points.md)). Until M6 there is no extension host.
4. Is it an application concern: how a caller is identified, how a program is exposed, login? Then it is not Mesh ([roadmap](../roadmap/roadmap.md), section 2, principle 8). The application puts what it needs into its own `ActionContext` keys.
5. Does a well-established tool do it? Put that tool behind a Mesh contract ([ADR-0030](../decisions/0030-established-tools-first.md)).

## Import rules

Checked by `verify`: the MX rule from M1 and the rest from M2 ([roadmap](../roadmap/roadmap.md), M1, acceptance test 8; M2, acceptance test 4):

- `runtime` imports nothing from `model`, `compiler` or Drizzle. The build-time packages may import `runtime`'s contract types, never the reverse ([ADR-0033](../decisions/0033-core-split-build-time-run-time.md)).
- `compiler` depends on MX. `model` and `runtime` never import it; `@mxlang/*` is imported only by packages that declare tag contracts (`compiler` now, the MX host package and extensions later) ([ADR-0043](../decisions/0043-mx-is-core.md)).
- Jig is imported only by `compiler`; it never reaches the run-time library ([ADR-0061](../decisions/0061-generators-are-jig-templates.md)).
- No generated file under `.mesh/` imports `model`, `compiler`, Drizzle or `model.json`, except the emitted schema file, which imports Drizzle.
- Drizzle is imported only under `packages/data-*` and in the emitted schema file.

Why: a `runtime` that cannot see the model cannot interpret it, so behaviour has to be in the generated code ([ADR-0003](../decisions/0003-generated-code-carries-behaviour.md)). Drizzle's v1 is a release candidate whose relations API is being replaced, so confining it limits the cost of an upgrade ([roadmap](../roadmap/roadmap.md), section 9, risk 3).

Not decided: the order of dependency among `model`, `compiler` and `cli`; the roadmap does not give it.
