---
title: "0038. Elysia is not core; it stays a candidate HTTP adapter"
description: "Decision record 0038: Elysia is not core; it stays a candidate HTTP adapter. Status: Accepted."
---

# 0038. Elysia is not core; it stays a candidate HTTP adapter

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

Elysia is a TypeScript web framework for Bun. It is more than a router: it has plugins with scoped lifecycle and typed dependency injection, and macros (declarative per-route options). The synthesis counted 12 official plugins, 96 community plugins and 16 documented integrations on 2026-10-01; the plugin model was read from the documentation, not tested ([research synthesis](../research/synthesis.md), section 11, and section 13). Early in the work the operator gave Elysia extra weight, and the question was whether Mesh's core should be built on it.

Mesh is a TypeScript framework modelled on Ash, the declarative resource framework for Elixir. Like Ash, it must serve a command-line tool, a daemon, a web app or an API equally ([rulings of 2026-10-04](./rulings-2026-10-04.md), Ruling 8). Its core interface is an in-process function call ([ADR-0005](./0005-core-interface-is-a-function-call.md)), and an HTTP server is one optional adapter.

## Decision

The operator agreed on 2026-10-04 ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Elysia"):

> Agreed: Elysia is not core. The operator's earlier weight on Elysia should not shape the transport contract. Elysia stays a candidate HTTP adapter once the generic contract exists.

No HTTP adapter is built in v1. The roadmap lists "HTTP adapter, typed client, OpenAPI" after v1, with "One Fetch handler per action; Elysia as a mount" ([roadmap](../roadmap/roadmap.md), section 6).

## Options considered

### Option A: Elysia as an adapter (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low now (nothing built); moderate later (a mount over a Fetch handler). |
| Cost | None in v1. |
| Reversibility | High. Replacing an adapter does not touch core. |
| Fit with Ruling 8 | Good. |

**Pros:** Core serves jobs, tests, agent tools and daemons, which have no HTTP request. Elysia's ecosystem stays reachable: "Mesh mounts as an Elysia plugin" (synthesis, section 11). It accepts Standard Schema and is first-class on Bun ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), Summary and section 3).
**Cons:** The adapter must be designed against a generic contract, which is more work than using Elysia's types directly. The typed-client coupling is deep: `treaty<App>` bakes the server's types into the client, so swapping frameworks later breaks every frontend consumer (07, section 5, "HTTP").

### Option B: Elysia as core

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low at first; high when a non-HTTP caller appears. |
| Cost | Mesh inherits Elysia's phases and context object. |
| Reversibility | Poor. |
| Fit with Ruling 8 | Poor. |

**Pros:** Rich plugin ecosystem; one less contract to design.
**Cons:** "Everything hangs off an HTTP request (ten request phases)", while Mesh actions must run with no request (synthesis, section 11). Bus factor: one person wrote 86% of commits and the package had one release in the last 90 days (synthesis, section 11; 07, section 1 table: 1 release in 90 days, 21 in 365). Elysia peer-pins an older TypeBox line (07, Summary).

### Option C: Hono as the HTTP choice instead

| Dimension | Assessment |
|-----------|------------|
| Complexity | Similar to A. |
| Cost | Similar. |
| Reversibility | High as an adapter. |
| Maintenance signal | Stronger: 32,400 stars, 22 releases in 90 days, top contributor 68% of commits (07, section 1 table). |

**Pros:** Larger community and steadier releases. Also accepts Standard Schema and needs an adapter on Node (07, Summary).
**Cons:** Not ruled out or in. Ruling 8 says "Neither Elysia nor Hono first", so it is no more chosen than Elysia. Published benchmarks for both are old or self-published (07, Summary).

## Trade-off analysis

The decision keeps core independent of any web framework and defers the Elysia-versus-Hono comparison to when an HTTP adapter is scheduled. Option C is not an alternative to this ADR so much as a competing future adapter.

## Consequences

- Easier: core can be tested and used with no server.
- Harder: an HTTP adapter will have to be designed, not inherited.
- Revisit: at the start of the HTTP adapter work, compare Elysia and Hono on current data; the Elysia plugin model is untested.

## Action items

- [ ] After v1: design the HTTP adapter over a Fetch handler per action and choose between Elysia and Hono as the mount.
