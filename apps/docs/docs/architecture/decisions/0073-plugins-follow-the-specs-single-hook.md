---
title: "0073. Plugins follow the spec: one `task.claim` hook, before the transaction"
description: "Decision record 0073: which plugin tiers the Hyper port keeps. Status: Accepted."
---

# 0073. Plugins follow the spec: one `task.claim` hook, before the transaction

## Status

Accepted

## Date

2026-10-10

## Deciders

operator (Saulo Vallory), accepting [roadmap revision 5](../roadmap/roadmap.md) on 2026-10-10 at 09:05, decision D4 with its recommended option.

## Context

The spec's v0 has one hook, `task.claim`. Its handlers run after the shape, permission and content phases pass and outside the write transaction, with a 5,000 ms killable deadline, and the engine revalidates at commit (`PROTOCOL.md` sections 9 and 10, `PLUGIN-HOST.md`). A TypeScript engine `import()`s plugins in the same process. The Elixir v2 adds a Lua tier inside the transaction, under the write lock, and a second hook point (`task.complete`); that is 755 lines of plugin host and Lua ([gap G11](../research/hyper-port-gap-analysis.md)). The gate ([ADR-0072](./0072-mesh-1-0-is-the-port-gate.md)) includes the suite's plugin group (8 cases).

## Decision

The port keeps the spec's plugin model and nothing more:

- one hook point, `task.claim`, implemented by the `beforeTransaction` seam ([ADR-0075](./0075-seams-use-the-extension-hosts-names.md)), which may throw to refuse;
- plugins are loaded by `import()`, in a Worker or in the process, with the spec's 5,000 ms deadline;
- the commit-time revalidation is a `check` that re-runs inside the transaction;
- no Lua tier and no `task.complete` hook.

The plugin host is application code in `examples/hyper`, not a Mesh feature.

## Options considered

1. **Follow the spec (chosen).**
2. **Also keep the Lua tier.** Embed a Lua VM in Bun: an extra dependency and sandbox work for a tier the spec does not have.
3. **Drop plugins from the gate.** Exclude suite group 10 and lose a part of the contract the operator named.

## Trade-off analysis

Option 1 is the contract the gate tests and needs one seam Mesh builds anyway. It gives up the in-transaction tier that makes a work-in-progress limit race-free in the Elixir engine; under one SQLite writer the commit-time revalidation gives the same result.

## Consequences

- Mesh's seams need no tier for plugins: `beforeTransaction` and a `check` are enough.
- A plugin SDK for `examples/hyper` follows the spec's; Mesh ships none.

## Action items

- [ ] M6: `beforeTransaction` (see ADR-0075). Hyper application: the host and the revalidation.
