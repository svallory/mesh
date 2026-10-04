---
title: "0035. What `public` means on an attribute"
description: "Decision record 0035: What `public` means on an attribute. Status: Proposed."
---

# 0035. What `public` means on an attribute

## Status

Proposed

## Date

2026-10-04

## Deciders

open; the operator rules when the first transport is designed

## Context

The `attribute` contract on `main` has a `public` flag (`packages/compiler/src/contracts.ts`), and the example `post.mx` uses it. The flag is recorded in the model as Ash records `public?`, and nothing in v1 reads it ([roadmap](../roadmap/roadmap.md), M1 and M2). What it means for a transport is open. Ash, the Elixir framework Mesh is modelled on, has `public?` on attributes (and on relationships, calculations, aggregates and actions), default `false`: "Whether it appears over public interfaces. Attributes are private by default" ([Ash features](../research/ash-features.md), section 2.2). The default is an Ash 3.0 reversal, made because "It was too easy to add an attribute and not realize that you had exposed it over your api" ([Ash strengths and weaknesses](../research/ash-strengths-weaknesses.md), section 4). Mesh's goals include "private unless exposed" ([research synthesis](../research/synthesis.md), section 14, goal 4). One caution from the ecosystem: in `ash_ai`, which exposes actions as agent tools, public or private decides which fields come back, not who may call; policies are the security boundary ([Ash ecosystem packages](../research/ash-ecosystem-packages.md), sections 8 and "Implications for Mesh").

Since the operator ruled that Mesh copies Ash's DSL for v1 ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md)), Ash's `public?` semantics carry more weight than before: a Mesh `public` that differs from Ash's needs a stated reason.

There is no transport in v1 ([ADR-0005](./0005-core-interface-is-a-function-call.md)), so nothing is "public" yet. The flag is not a build error; it is recorded and ignored.

## Decision

Not decided. Recommendation: Option A, with the exposure rule decided together with the first transport. It blocks nothing in v1; it blocks the first transport and the typed client. Until then the flag has no effect.

## Options considered

### Option A: `public` means "may leave through a transport"
Plan revision 2, D10, by the roadmap author: in-process callers get the full record; a transport returns only public attributes ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 8, D10).

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: a filter in each transport |
| Cost | Nothing before the first transport |
| Fit with Ash | Close: Ash's flag concerns public interfaces |
| Risk | Each transport must apply the filter; a forgotten one leaks |

**Pros:** matches Ash and the 3.0 lesson; trusted in-process code can read everything.
**Cons:** untestable until a transport exists, so the rule is unverified; the filter lives in adapters, outside core.

### Option B: `public` is part of the typed result for all callers
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: generated result types differ from the stored record |
| Cost | Moderate, in M2 and M5 emitters |
| Fit with Ash | Weaker: Ash describes `public?` as exposure "over public interfaces"; whether in-process callers see private fields was not checked |
| Risk | The application's own code cannot read private fields without a second API |

**Pros:** enforced by the compiler in every call, with or without a transport.
**Cons:** needs a second path for internal reads, which Mesh would invent.

### Option C: Drop the flag until a transport exists
| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest |
| Cost | Another edit to the contracts and the fixture |
| Fit with Ash | Loses a copied name |
| Risk | Reintroduction later is a vocabulary change |

**Pros:** no half-meaning on `main`.
**Cons:** contradicts the copy-Ash direction; the flag costs nothing while it is recorded and unread.

## Trade-off analysis

A keeps Ash's meaning and costs nothing now. B changes what a call returns. C undoes a copied name for no gain, since the recorded flag does nothing today.

## Consequences

If A: transport authors own the filter, and the conformance tests for a transport must include it. Revisit when the first transport is designed (e.g. the command-line adapter for agents, [ADR-0027](./0027-no-mcp-agent-surface.md)); the roadmap does not order the after-v1 items.

## Action items
- [ ] M1: record `public` in the model, as Ash records `public?`; nothing reads it.
- [ ] After v1, with the first transport: rule on this ADR and implement the filter.
