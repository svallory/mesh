---
title: "0027. No MCP server; agents get a rules file and, later, a generated CLI"
description: "Decision record 0027: No MCP server; agents get a rules file and, later, a generated CLI. Status: Accepted."
---

# 0027. No MCP server; agents get a rules file and, later, a generated CLI

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

Mesh is a TypeScript framework modelled on Ash, the declarative resource framework for Elixir. One of its aims is to be easy for coding agents (LLM tools that read and write a project's code) to use. Two things could serve an agent: guidance that tells it how the framework works, and a way for it to call the application's operations.

MCP (Model Context Protocol) is a standard for exposing tools to an LLM over a server. Ash's own `ash_ai` package shows that shape: it exposes actions as LLM and MCP tools, with policies still applied ([research synthesis](../research/synthesis.md), section 4, table row 8). It ships a production MCP server using OAuth 2.1 or API keys. Its README says of the development server, "We are still experimenting to see what tools (if any) are useful while developing with agents" ([Ash ecosystem packages](../research/ash-ecosystem-packages.md), subsection "8. `ash_ai` 1.1.1"). Ash also ships `usage_rules`, which gathers each package's rules file into `AGENTS.md` (same file, section 8, "`ash_ai` and `usage_rules`").

The synthesis recommended copying "Rules files and MCP tools generated from the IR" (the plain-data model every Mesh tool reads) as "the best-evidenced agent aid (Convex +20%, and the Ash maintainer credits it)" (synthesis, section 8, "Copy from Ash"). Section 7 qualifies the evidence: the Convex figure "measures curated rules files, not language design".

## Decision

The operator ruled on 2026-10-04, in "Rulings after the decision review", row "MCP" ([rulings of 2026-10-04](./rulings-2026-10-04.md)):

> Not built. The operator prefers CLIs made for agents (fewer tokens). Agent surface: the generated rules file, later a CLI adapter generated from the action list.

The synthesis recommendation to generate MCP tools is therefore not followed. The "fewer tokens" reasoning is the operator's; the research documents report no such measurement.

## Options considered

### Option A: Rules file now, generated CLI later (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low now (one generated file); a CLI adapter later. |
| Cost | Nothing in v1. The CLI is after v1 ([roadmap](../roadmap/roadmap.md), section 6). |
| Evidence | Rules files have the only quantitative support that measures task success (Convex, about +20% pass rate; Wasp's token benchmark is the other quantitative figure and is weaker, synthesis section 7). |
| Fit with [ADR-0005](./0005-core-interface-is-a-function-call.md) | Good. The CLI is a transport adapter over the function-call core. |

**Pros:** Cheap; no long-running server.
**Cons:** A CLI has no standard discovery protocol, so each agent must learn the command shape. The generated CLI will need a way to obtain a scope, which is that adapter's design (roadmap, section 6). The token saving is a preference, not a result.

### Option B: MCP server (ash_ai's shape)

| Dimension | Assessment |
|-----------|------------|
| Complexity | High: a server, auth (OAuth 2.1 or keys in `ash_ai`), protocol versions. |
| Cost | Real maintenance; `ash_ai` tracks three protocol versions (04, `ash_ai`). |
| Evidence | Closest prior art "by a wide margin" (04), but its own README is tentative. |
| Fit with [ADR-0005](./0005-core-interface-is-a-function-call.md) | Needs a transport before it exists. |

**Pros:** Standard way for many agents to discover and call tools.
**Cons:** The operator's concern is token cost; whether tool schemas cost more than CLI output was not measured. Requires a server process and auth design.

### Option C: Both

| Dimension | Assessment |
|-----------|------------|
| Complexity | Highest: rules file, CLI and a server with auth. |
| Cost | The sum of A and B. |
| Evidence | Same as A and B. |
| Fit with [ADR-0005](./0005-core-interface-is-a-function-call.md) | As B. |

**Pros:** Covers agents that only speak MCP.
**Cons:** Pays both costs. No source argues the second adds enough to justify it.

## Trade-off analysis

The choice is between a standard discovery mechanism and a smaller, cheaper surface the operator prefers. Because the rules file is needed under every option and the CLI can be generated from data that already exists (the action list), deferring the second costs little. If MCP demand appears, a server is another adapter and can be added without touching core.

## Consequences

- Easier: v1 has no agent-facing server and no auth question.
- Harder: agents cannot discover tools by protocol.
- Revisit: when the CLI adapter is designed, compare its token cost against MCP, which nobody has measured.

## Action items

- [ ] After v1: generated rules file describing the project's resources and the vocabulary (roadmap, section 6, "Agent and test surface").
- [ ] After v1: CLI adapter generated from the action list; decide its scope source then.
