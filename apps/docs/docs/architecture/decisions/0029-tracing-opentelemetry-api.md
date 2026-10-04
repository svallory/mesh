---
title: "0029. Generated handlers call the OpenTelemetry API directly"
description: "Decision record 0029: Generated handlers call the OpenTelemetry API directly. Status: Accepted."
---

# 0029. Generated handlers call the OpenTelemetry API directly

## Status

Accepted

## Date

2026-10-04

## Deciders

lead, operator may overrule; the recommendation is the roadmap author's (plan revision 2, question N3)

## Context

Tracing records what a program did, as nested timed spans, so a slow or failing call can be followed. OpenTelemetry (OTel) is the established standard for this. Its API package, `@opentelemetry/api`, "exposes only types, a no-op span and a context manager"; implementations plug in through a separate SDK package. The API package "has not changed version in a long time, which is what a stable contract looks like" ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 4, "Tracing / logging"). The research counts it among four neutral contracts Mesh should use where they fit ([research synthesis](../research/synthesis.md), section 9) and proposes "one event per lifecycle phase" for the observability layer (section 10, "Observability" row).

Mesh's action lifecycle has eight phases: enter, cast, plan, pre-check, transaction, data layer, commit, after commit ([roadmap](../roadmap/roadmap.md), M5). Ash has tracers too, and its telemetry "costing 15–23% of a create" is listed among its run-time surprises (synthesis, section 6, item 7).

Plan revision 2, written by the roadmap author, asked in N3 whether generated code may depend on the OTel API directly or whether Mesh should keep its own tracer contract with OTel as an adapter, and recommended the former ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.2). The lead accepted it: "N3 OpenTelemetry API direct: accepted." ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief").

## Decision

The lead decided, 2026-10-04, on the roadmap author's recommendation: generated handlers emit one span per lifecycle phase through the OpenTelemetry API directly. Mesh defines no tracer contract. With no SDK installed the calls do nothing. The plan's stated cost: "one small dependency in every generated application" ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.2, N3). The operator has not ruled on this specific choice.

## Options considered

### Option A: OTel API directly (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest. No Mesh abstraction to design. |
| Cost | A small dependency in every generated app; span calls in every handler. |
| Reversibility | Medium. Spans are emitted by generated code, so changing means regenerating. |
| Standards fit | OTel is the neutral standard itself (synthesis, section 9). |

**Pros:** Nothing for Mesh to maintain; any OTel-compatible backend works; Elysia and Hono have OTel plugins (07, section 4).
**Cons:** Every generated app carries the dependency. Ash's overhead of 15 to 23% of a create is a warning that tracing calls on the hot path are not free; Mesh must measure its own with no SDK installed (roadmap, M5 risks). How the API's context manager behaves on Bun, given the `AsyncLocalStorage` gaps (synthesis, section 12, risk 4), is not checked.

### Option B: Mesh tracer contract, OTel as an adapter

| Dimension | Assessment |
|-----------|------------|
| Complexity | Higher: design a contract that fits OTel and other tracers. |
| Cost | Contract plus adapter to maintain; an extra indirection per span. |
| Reversibility | Higher: the backend can change without regenerating. |
| Standards fit | Wraps a standard in a non-standard layer. |

**Pros:** Generated code has no third-party import; tracing can be swapped.
**Cons:** The thing it protects against, replacing OTel, has no candidate named in the research. It also puts a design in core for a problem the standard already solves.

### Option C: No tracing in v1

| Dimension | Assessment |
|-----------|------------|
| Complexity | None now. |
| Cost | Zero now; retrofitting spans means changing every handler's generated shape. |
| Reversibility | Cheap to defer, costly to add. |
| Standards fit | n/a |

**Pros:** Smallest v1.
**Cons:** The lifecycle is where Mesh's value is visible; the synthesis lists it as the observability seam. Adding it later changes generated code that will already be committed in users' repositories.

## Trade-off analysis

The decisive point is that OTel already is the neutral contract. A Mesh wrapper adds design work and a small cost per span to defend against a change nobody has proposed. The remaining risk, cost on the hot path, is the same under A and B and is handled by measuring.

## Consequences

- Easier: tracing arrives with the lifecycle at no extra design cost; users get standard tooling.
- Harder: every generated project depends on `@opentelemetry/api`; span names become part of generated output.
- Revisit: if the measured overhead with no SDK is significant, or if a non-OTel tracer is wanted.

## Action items

- [ ] M5: emit one span per phase; test with an OTel test SDK that eight spans appear in order and that none installed produces no error (roadmap, M5 test 7).
- [ ] M5: measure the no-SDK overhead of a create.
