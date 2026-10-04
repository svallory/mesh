---
title: "0001. Core, adapters and extensions (three rings)"
description: "Decision record 0001: Core, adapters and extensions (three rings). Status: Accepted."
---

# 0001. Core, adapters and extensions (three rings)

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory). The operator corrected the first version of the research synthesis on 2026-10-01; the rule was decided before the rulings of 2026-10-04 and recorded in the project's agent instructions.

## Context

Mesh is a planned TypeScript framework modelled on Ash, the Elixir framework in which one resource file declares data, operations and rules and everything else is derived. Mesh talks to databases, may one day sit behind a server or other transport, and runs jobs. The question is which parts Mesh is built on directly (core), which it reaches only through a contract it owns (adapters), and which are optional features (extensions).

The first synthesis called Bun "integral" because its name would appear in generated code. The operator reviewed that and the synthesis was revised: "That was the wrong test" ([research synthesis](../research/synthesis.md), Step 2 preamble).

## Decision

The rule, as recorded in the agent instructions and in the synthesis (Step 2 preamble): hardcoded (core) means Mesh cannot run without it; anything replaceable is an adapter behind a core contract; anything optional is an extension; and "It was in the plan" is never a reason to hardcode something. The original wording of the adapter sentence listed the runtime among the replaceable parts, and the synthesis ring table also put the authoring syntax in the adapter ring. Later rulings removed both: Mesh runs on Bun only ([ADR-0025](./0025-bun-only.md)) and MX, which parses resource files, is core ([ADR-0043](./0043-mx-is-core.md)). The rule itself stands; those rulings applied it. What the rings hold is in [research synthesis](../research/synthesis.md), section 15, and [roadmap](../roadmap/roadmap.md), section 3. In v1 the adapters are the SQL data layers ([ADR-0014](./0014-sql-adapters-on-drizzle.md)); a transport ([ADR-0005](./0005-core-interface-is-a-function-call.md)) and a job runner come later. Of the synthesis's adapter slots, the front end and the expression parser are gone ([ADR-0043](./0043-mx-is-core.md)), the runtime host is Bun only, the actor resolver was dropped ([ADR-0007](./0007-scope-is-a-plain-argument.md)), and the tracer slot has no package because generated code calls the OpenTelemetry API directly ([ADR-0029](./0029-tracing-opentelemetry-api.md)).

## Options considered

### Option A: Three rings (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Higher: each replaceable part needs a contract owned by core |
| Cost | More design up front; each contract needs tests ([ADR-0013](./0013-data-layer-contract-and-capabilities.md)) |
| Reversibility | High for adapters: swapping a database touches one package |
| Fit with serving any kind of program ([ADR-0005](./0005-core-interface-is-a-function-call.md)) | Good: no transport is assumed |

**Pros:** A database or server can change without touching core. Mesh can serve programs with no web server.
**Cons:** Contracts cost effort and can be wrong. Ash's data-layer contract has 46 callbacks, 44 optional, and degrades inconsistently ([research synthesis](../research/synthesis.md), section 2.2); a contract designed too early repeats that.

### Option B: A web framework as the core (Elysia)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lower: plugins, scoped lifecycle and dependency injection exist |
| Cost | Low to start |
| Reversibility | Low: everything hangs off a request |
| Fit with Mesh's actions | Poor: actions must run with no request (jobs, tests, agent tools, daemons) |

**Pros:** Elysia has 12 official plugins and 96 community plugins ([research synthesis](../research/synthesis.md), section 11).
**Cons:** Everything hangs off an HTTP request, with ten request phases. One person wrote 86% of its commits and it had one release in the last 90 days (same section).

### Option C: Core owns the data layer; only features are plugins

This is the shape of Rails or Django: one query library built in, extensions for features.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest: fewer contracts |
| Cost | Lowest now, highest to undo |
| Reversibility | Low: Drizzle and SQLite types leak into core |
| Fit with the research | Weak: Ash keeps its data layer behind a behaviour, with databases as separate packages ([research synthesis](../research/synthesis.md), sections 2.2 and 4) |

**Pros:** Fastest to a running example.
**Cons:** Hardcodes the risky part. The research lists Drizzle v1 as a release candidate whose relations v2 is a mandatory upgrade (same file, section 12, risk 1).

## Trade-off analysis

Three rings cost contract design that a monolith avoids. The cost is accepted where something can really change: the database and query library, and transports. Where the operator later ruled that something cannot change (Bun, MX), it is core, and no contract is built for it. The roadmap makes each package state why it sits in its ring ([roadmap](../roadmap/roadmap.md), section 2, principle 4).

## Consequences

- Easier: replacing a database; core has no web concepts.
- Harder: each contract is designed before a second implementation exists (one real data adapter until M9; [roadmap](../roadmap/roadmap.md), M3 risks).
- Revisit: [ADR-0030](./0030-established-tools-first.md) (established tools first) pulls toward adopting tools; this rule says to put each behind a contract.

## Action items

- [ ] M1: state in each package, as it is created, which ring it is in and why (M1 and M2 create the first packages).
- [ ] M3: write the data-layer contract ([ADR-0013](./0013-data-layer-contract-and-capabilities.md)).
