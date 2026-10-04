---
title: "0033. Core is split by when the code runs"
description: "Decision record 0033: Core is split by when the code runs. Status: Accepted."
---

# 0033. Core is split by when the code runs

## Status

Accepted

## Date

2026-10-04

## Deciders

roadmap author (the split by when code runs); lead (the MX import rule and the extension entries). The lead may overrule the roadmap author's part.

## Context

Mesh has two halves. At build time the `mesh` command reads `.mx` resource files and writes TypeScript. At run time the deployed application calls that generated TypeScript. The synthesis puts "Compiler pipeline and phases", "Action engine and lifecycle" and "Expression tree" in one core ([research synthesis](../research/synthesis.md), section 15), which would give a deployed program the compiler too. The generated code must carry the behaviour and the run-time library must stay thin, with the test that the run-time library never reads the resource model ([ADR-0003](./0003-generated-code-carries-behaviour.md); [roadmap](../roadmap/roadmap.md), section 2, principle 1). That test needs a boundary a tool can check.

## Decision

The roadmap author chose this in plan revision 2: "Core is split by when the code runs. `compiler` and `model` at build time, `runtime` in the deployed application. Types that cross a run-time contract (scope, errors, query and expression tree) live in `runtime`, so the deployed half depends on nothing from the build half and the import rule in M2 can be checked mechanically" ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 8, D2). The roadmap keeps it ([roadmap](../roadmap/roadmap.md), section 3): `model`, `compiler` and `cli` are build time; `runtime` is run time and imports nothing from `model`, `compiler` or Drizzle. Build-time packages may import `runtime`'s contract types, never the reverse. `compiler` (and extensions, for their tag contracts) import MX; `model` and `runtime` never do ([ADR-0043](./0043-mx-is-core.md)). The MX import rule is the lead's decision ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief"). An extension package has a build-time entry and a run-time entry; the run-time entry follows the same import rule as `runtime` (no `model`, `compiler` or MX), so no extension can carry MX or the compiler into a deployed program ([roadmap](../roadmap/roadmap.md), M6 and its test 6). The import rule is a check in `verify` (M2 acceptance test 4), extended to every extension's run-time entry. Nothing in the rulings file overrules it.

## Options considered

### Option A: Build-time packages and one run-time package (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: three build-time packages, one run-time |
| Cost | Low; one import rule to maintain |
| Checkability | Mechanical: import graph |
| Fit with [ADR-0003](./0003-generated-code-carries-behaviour.md) | Direct |

**Pros:** a deployed program carries no compiler; the "runtime never reads the model" test becomes an import check.
**Cons:** shared types must live in `runtime`, so build-time code imports from the run-time package; `runtime` grows to hold the contracts, the tree type and the in-memory function implementations.

### Option B: One `core` package
| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest at first |
| Cost | Lowest |
| Checkability | Only by discipline or folder rules inside a package |
| Fit with [ADR-0003](./0003-generated-code-carries-behaviour.md) | Weak |

**Pros:** simplest workspace.
**Cons:** the deployed application ships the compiler, and nothing stops run-time code reading the model. Ash keeps behaviour in its library, which is the cause of its poor traces ([research synthesis](../research/synthesis.md), section 6, item 2); the package layout here is a separate matter, but a single package gives the same temptation.

### Option C: Finer split (separate `contracts` and `expr` packages)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Higher: more packages, more version pins |
| Cost | Higher; more cross-package changes per milestone |
| Checkability | Mechanical, as A |
| Fit with [ADR-0003](./0003-generated-code-carries-behaviour.md) | Same as A |

**Pros:** each concept has a clean home.
**Cons:** the contracts are unstable until M6 ([roadmap](../roadmap/roadmap.md), M2 risks); splitting earlier multiplies churn.

### Option D: Contract types in `model`, `runtime` using only type imports
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Cost | Low; the rule becomes "no value imports from `model`" |
| Checkability | Mechanical, but subtler |
| Fit with [ADR-0003](./0003-generated-code-carries-behaviour.md) | Good if enforced |

**Pros:** build-time code never imports from the run-time package; type imports are erased, so the deployed program still carries no compiler.
**Cons:** the in-memory function implementations are values, so `runtime` still needs its own; a slip turns a type import into a value import and drags `model` into deployment. Not taken: this record's assessment is that A's rule is simpler to check; plan revision 2 does not state a reason, and the option was not tested.

## Trade-off analysis

A gets the checkable boundary at the lowest cost. C can be reached from A later by moving files; B cannot be turned into A without untangling imports.

## Consequences

Easier: a mechanical test for thin run-time code; small deployments. Harder: authors must decide which half a new type belongs to; a type used by both goes to `runtime`. Revisit if the run-time package grows past thin ([roadmap](../roadmap/roadmap.md), section 9, risk 6).

## Action items
- [ ] M2: `verify` import rule: `runtime` imports nothing from `model`, `compiler` or Drizzle; handlers import none of them either.
- [ ] M4: place the expression tree type in `runtime`, the registry in `model`.
- [ ] M5: re-check the rule when helpers are added to `runtime`.
- [ ] M6: each extension has separate build-time and run-time entries; `verify` applies the `runtime` import rule to the run-time entry (roadmap M6 test 6).
