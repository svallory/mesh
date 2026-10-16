---
title: "Core, adapters and extensions"
description: "Core, adapters and extensions: the test for each ring and where every package sits."
---

# Core, adapters and extensions

Status: the ring split is applied from M0. `model`, `compiler`, `cli`, `runtime`, `data-drizzle`, `data-sqlite` and `jsonrpc` exist; `data-postgres` comes with M9 and the extension host with M11, both after Mesh 1.0 ([roadmap](../roadmap/roadmap.md), section 3).

## Why rings

Mesh's rule is that only what Mesh cannot run without is hardcoded, and "it was in the plan" is never a reason to hardcode something ([roadmap](../roadmap/roadmap.md), section 2, principle 4; [ADR-0001](../decisions/0001-three-rings.md)). The rule was set after the first proposal classed tools as "integral" because their names would appear in generated code, which the operator judged the wrong test ([research synthesis](../research/synthesis.md), Step 2 preamble).

The core is split by when its code runs: `compiler` and `model` at build time, `runtime` in the deployed program. Types that cross a run-time contract live in `runtime`, so the deployed half depends on nothing from the build half ([ADR-0033](../decisions/0033-core-split-build-time-run-time.md)). Mesh runs on Bun only, not on Node, and the run-time library keeps to web-standard APIs where it can ([ADR-0025](../decisions/0025-bun-only.md)).

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
| `jsonrpc` | adapter | run | Newline-delimited JSON-RPC 2.0 over a Unix socket, dispatching to a method table given as plain data ([ADR-0077](../decisions/0077-surfaces-and-file-kinds.md)). It does its own envelope validation and dispatch and has no run-time dependency: Bun supplies the socket and JSON, and `@meshfw/runtime` is a peer dependency. The one candidate library, `json-rpc-2.0`, covers about 60 of some 400 lines, answers batches, which Hyper's protocol forbids, and would add a public dependency to an adapter whose contract is small and fixed. |

([roadmap](../roadmap/roadmap.md), section 3 and the milestones cited.)

Why the split between `compiler` and `runtime`: a deployed program must not carry the compiler ([ADR-0033](../decisions/0033-core-split-build-time-run-time.md)). Contract types the generated code needs (the action context, errors, query, expression tree) therefore live in `runtime`.

Why SQL adapters are adapters: the data-layer contract is Mesh's own and "the query library inside an adapter is that adapter's private choice" ([research synthesis](../research/synthesis.md), section 11), which is Drizzle ([ADR-0013](../decisions/0013-data-layer-contract-and-capabilities.md), [ADR-0014](../decisions/0014-sql-adapters-on-drizzle.md)).

Why authorization is core: `policies` is a section of the entity file, and an entity without one forbids every action. A configuration in which authorization is not installed would make that rule depend on a package being present, so the engine is part of core ([ADR-0055](../decisions/0055-policies-are-core.md)). The research had proposed "a fixed slot in the core lifecycle, filled by a first-party policy extension" ([research synthesis](../research/synthesis.md), section 10); the slot stays, and core fills it. Its simple tier is unchanged ([ADR-0022](../decisions/0022-policies-simple-tier-as-extension.md)).

## Why MX is core and not an adapter

The research proposed "front end" and "expression parser" adapter slots ([research synthesis](../research/synthesis.md), section 15). The operator ruled otherwise: MX is not replaceable, so there is no front-end slot and no front-end package ([ADR-0043](../decisions/0043-mx-is-core.md)). Reason: tag contracts, `analyze` rules, positioned errors and the composed contracts module are MX concepts and would leak through any neutral contract; a contract with one implementation is a guess. The expression-parser slot disappears for the same reason: MX hands each expression over as a parsed Babel node. The cost is a hard dependency on a project Mesh does not control.

## Adapter slots with no package

| Slot | Why no package in 1.0 |
|---|---|
| Transport (command line, HTTP, server) | The core interface is an in-process function call, and every transport is an optional adapter over it, so Mesh serves a command-line tool, a daemon, a web app or an API equally. One transport is built before 1.0, `@meshfw/jsonrpc`; the others are built when something needs them ([ADR-0005](../decisions/0005-core-interface-is-a-function-call.md)). |
| Tracer | After Mesh 1.0: generated code will call the OpenTelemetry API directly ([ADR-0029](../decisions/0029-tracing-opentelemetry-api.md), [ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)). |
| Runtime host | Bun only ([ADR-0025](../decisions/0025-bun-only.md)). |

([roadmap](../roadmap/roadmap.md), section 3.) There is no actor-resolver slot: the caller passes the action context as an argument ([ADR-0059](../decisions/0059-action-context.md)). Jobs and workflows, with a job runner, come after 1.0 ([ADR-0023](../decisions/0023-workflows-and-jobs-deferred.md)).

## Extensions in 1.0

No first-party extension ships in 1.0. The extension host comes after 1.0, in M11, for project-local extensions in `src/extensions/` ([ADR-0057](../decisions/0057-one-domain-modules-as-folders.md)) and for later first-party ones (multitenancy, for example, which reads a key of the action context it declares, [ADR-0059](../decisions/0059-action-context.md)). See [extension host](./extension-host.md).

## Where does new code go

A procedure derived from the three tests above, not a separate rule.

1. Does it run when `mesh build` runs, or inside the deployed program? Build-time code goes to `model`, `compiler`, `cli` or an adapter's build half. Run-time code goes to `runtime` or an adapter's run-time half.
2. Can Mesh not function without it? Then it is core. If it is one way to do a core job, it is an adapter behind a contract core owns; write the contract first.
3. Is it a feature some projects will not use? Then it is an extension and may touch the model only through a declared contribution point ([ADR-0020](../decisions/0020-extension-contributions-through-declared-points.md)). Until M11 there is no extension host.
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
