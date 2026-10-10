---
title: "0072. Mesh 1.0 is the Hyper port gate: the spec's v0 on SQLite, the 126-case suite"
description: "Decision record 0072: what Mesh 1.0 is, which contract the port follows, what the gate covers, and what leaves the 1.0 line (SQL translation, atomic updates, the extension host, Postgres, tracing, on:load). Status: Accepted."
---

# 0072. Mesh 1.0 is the Hyper port gate: the spec's v0 on SQLite, the 126-case suite

## Status

Accepted. Supersedes [ADR-0019](./0019-v1-scope.md) in part (the v1 line). Amends [ADR-0010](./0010-one-expression-tree-two-evaluators.md), [ADR-0017](./0017-atomic-by-default-and-classification.md), [ADR-0020](./0020-extension-contributions-through-declared-points.md), [ADR-0021](./0021-composed-contracts-module.md), [ADR-0022](./0022-policies-simple-tier-as-extension.md), [ADR-0029](./0029-tracing-opentelemetry-api.md), [ADR-0052](./0052-actions-auto-and-on-load.md), [ADR-0054](./0054-write-strategy-is-inferred.md), [ADR-0055](./0055-policies-are-core.md), [ADR-0062](./0062-direct-dependencies-zod-drizzle-opentelemetry.md) and [ADR-0063](./0063-user-docs-first-and-the-hold.md).

## Date

2026-10-10

## Deciders

operator (Saulo Vallory), accepting [roadmap revision 5](../roadmap/roadmap.md) on 2026-10-10 at 09:05: decisions D1, D2, D3, D8, D9 and D12 with their recommended options, and two answers (the Hyper application lives in `examples/hyper` until it works; the port follows the spec and nothing else).

This record merges six decisions of the draft because they are one cut: what Mesh 1.0 is, and so what is not on the way to it.

## Context

On 2026-10-07 the operator ruled (MX decision 185) that Mesh 1.0 is done when the Hyper engine can be ported to Mesh. [ADR-0019](./0019-v1-scope.md) predates that ruling: it ranks work by what a framework should have and ends v1 at M9, migrations and Postgres.

The [Hyper gap analysis](../research/hyper-port-gap-analysis.md) ranks every Mesh feature by one question: does the port need it? Hyper's engine has two contracts. The specification repository holds v0 (`PROTOCOL.md` and a 126-case black-box conformance suite on its `protocol-phases` branch): newline-delimited JSON-RPC over a Unix socket, SQLite. The engine's own v2 replaced it with AshTypescript RPC over HTTP and Postgres, and does not pass the suite. The operator's ruling names the specification.

## Decision

1. **The gate (D1, D2, D8).** Mesh 1.0 is done when Hyper built on Mesh passes the spec's 126 conformance cases (`conformance/01..10-*.test.ts` on the `protocol-phases` branch of the Hyper specification repository), run as `ENGINE_CMD="bun <the port>/main.ts" bun test conformance`, with no case skipped.
   - The port follows the spec's v0 and nothing else; the engine's own TypeScript implementation is not a source.
   - It runs on SQLite, with one writer. Postgres comes after 1.0.
   - The gate covers the spec's twelve entities. Run, Attempt, Invocation, Machine, SessionReference and workspace export and import are ported after the gate.
   - The Hyper application lives in this repository as `examples/hyper` until it works, and the gate runs in `bun run verify`. After that it moves to its own repository.
2. **What leaves the 1.0 line.**

   | Item | Was | Now | Decision |
   |:--|:--|:--|:--|
   | The SQL evaluator, `translate-or-error` on filters, sorts and policies, SQL for rollups | M4, M7 | after 1.0 (M10). Expressions run in memory; a declared `filter` or `sort` on a read is a build or run-time error until then, never an in-memory scan | D3 |
   | Atomic one-statement updates | M5 | after 1.0 (M10). Every update reads the row first, locked, and then writes | D3 |
   | Record-reading read policies folded into the query | M8 | after 1.0 (M10). Until then such a policy is a loud error. A policy that reads only the actor still becomes a bound value in the query | D3 |
   | The extension host: composed contracts, named phases, cross-extension write conflicts, attribute-type contributions, loading, named reusable checks | M6 | after 1.0 (M11). The seams of [ADR-0075](./0075-seams-use-the-extension-hosts-names.md) come first | D9 |
   | Postgres, `mesh migrate`, the destructive-change refusal | M9 | after 1.0 | D2 |
   | Tracing (eight OpenTelemetry spans per action) and the `@opentelemetry/api` dependency | M5 | after 1.0 | D12 |
   | `on:load` | M7 | after 1.0. A relationship load uses the auto read | D12 |

   Everything else in revision 4 that the port does not need (bulk actions, `lock`, `relate`, `after-commit`, `can` beyond `ForbiddenError.breakdown`, keyset pagination, `sum`, `avg` and `min` rollups) moves after 1.0 with them; the roadmap's section 6 lists each with the evidence.
3. **The user docs follow.** Three sentences of the approved user docs change (ADR-0063): "One statement or two" in [Using your domain](../../docs/using-your-domain.md#update); the rollup sentence in the loading section; and "`filter=` ... must translate to SQL" in [Entities](../../docs/entities.md#reads-filter-and-sort). Tracing and `on:load` leave the user docs. Where other approved text assumes SQL translation, it stays until the lead rules.

## Options considered

1. **The port as the gate, on the spec's v0 (chosen).** The gate is a black-box suite that runs under Bun as it stands, it pins SQLite, and it is what the operator's ruling names.
2. **The engine's v2 as the gate.** Keeps all 18 entities and the current clients, but the gate is about 380 ExUnit tests that cannot drive a Bun program and would be ported by hand. The engine's own notes say the v0 wire "no longer binds". Rejected.
3. **v2's envelope with v0's behaviour.** Keeps clients and passes neither suite. Rejected.
4. **Postgres inside the gate** (D2 option b), **SQL translation kept whole** (D3 option b), **spans kept** (D12 option b), **a minimal named-check point kept** (D9 option b). Each adds scope to the gate for an advantage Hyper does not use; each is available as the first item after 1.0.

## Trade-off analysis

The gate is narrower than revision 4's v1: the two-evaluator promise of [ADR-0010](./0010-one-expression-tree-two-evaluators.md) is half delivered at 1.0, the atomic half of Ruling 3 is a later optimisation, and hosted mode (several engines on one Postgres, which an advisory lock exists to make correct in the Elixir engine) cannot be tested on SQLite. The port's own run of the suite's lease and race cases (groups 05, 07 and 10) tests the single-writer hypothesis. In exchange the critical path is six milestones, not nine, and the largest single saving is the SQL evaluator.

[ADR-0054](./0054-write-strategy-is-inferred.md)'s inference stays as design: `mesh explain` prints "read-then-write" for every update, which is true at 1.0.

## Consequences

- The roadmap is rewritten as revision 5. Its order is M3, M4, M7, M5, then M6 and M8 in parallel, then the gate.
- Several records are amended; each carries a note at the top.
- The "no silent fallback" principle holds: a construct that needs M10 fails loudly and names it.
- `examples/hyper` is a Mesh-team deliverable; its plugin hook, events and error shapes follow v0 ([ADR-0073](./0073-plugins-follow-the-specs-single-hook.md)).
- How `verify` obtains the suite (a pinned checkout of the spec's `protocol-phases` branch, or a vendored copy) is settled by the task that adds `examples/hyper`.

## Action items

- [ ] Rewrite the roadmap as revision 5 (this pull request).
- [ ] Scope M3 from revision 5.
- [ ] Pin the suite's source for `verify`.
