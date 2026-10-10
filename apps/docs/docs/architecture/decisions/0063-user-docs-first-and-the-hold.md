---
title: "0063. User docs are written first, in the voice of a released 1.0; development is on hold until they are approved"
description: "Decision record 0063: the docs-first practice, the 1.0 voice, where contributor material goes, and the hold on development. Status: Accepted, amended by ADR-0072."
---

# 0063. User docs are written first, in the voice of a released 1.0; development is on hold until they are approved

> **Amended** by [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) on 2026-10-10: The user docs describe the target Mesh, not a fixed version, and the roadmap gives the timing. A construct that is documented but not built fails with the not-implemented error, which names its milestone ([ADR-0018](./0018-not-implemented-is-a-build-error.md)). Nothing is removed from the docs because it ships later. The body below is kept as history.

## Status

Accepted

Amended 2026-10-09: the operator approved the user docs and lifted the hold; development resumed.

Amended by [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) (2026-10-10): The user docs describe the target Mesh, not a fixed version, and the roadmap gives the timing. A construct that is documented but not built fails with the not-implemented error, which names its milestone ([ADR-0018](./0018-not-implemented-is-a-build-error.md)). Nothing is removed from the docs because it ships later.

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

The docs site has two sections: **Docs**, for people who will use Mesh, and **Architecture**, for contributors ([ADR-0032](./0032-docs-site-and-decision-records.md)). On 2026-10-04 the operator ruled that Docs pages are written before the code, as a live specification, each opening with a warning that it describes intended behaviour ([rulings of 2026-10-04](./rulings-2026-10-04.md), "Rulings after the decision review", row "User docs as live spec").

The first set of pages showed two things. The warnings, milestone notes and "not decided yet" callouts made the pages hard to read as a product. And writing them found real gaps in the design (the 23 findings on [open questions and findings](../open-questions.md)), which is the reason to write them first. Framework work had started in parallel under the previous order of work: "framework code starts once the roadmap and decision records are published".

## Decision

Operator, 2026-10-04 evening, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings on the user docs, layout and terms (2026-10-04 evening, operator)", rows "User docs voice" and "Hold":

> The pages under Docs are written as if Mesh 1.0 were released. No "exists today", no milestone notes, no "not decided yet" callouts. Each page carries one line saying Mesh is not released yet. Contributor material (open decisions, what exists, findings) moves to Architecture. Replaces the "live spec with warnings" wording of the earlier row; the practice (docs before code) stands.

> All development is on hold until the operator approves the user docs. "A better DX for users and agents is the only chance Mesh has of making it." Only the docs rewrite proceeds.

Practice that follows:

- **Docs first.** A behaviour is described on a Docs page before it is built. Code follows the page, or changes the page in the same pull request.
- **One voice.** Docs pages describe 1.0. Everything a Docs page leaves out (open decisions, what exists today, findings) goes to Architecture, mostly to [open questions and findings](../open-questions.md).
- **The hold.** Until the operator approves the Docs, only documentation work proceeds; open feature pull requests wait.
- **Who decides.** The operator rules; the lead decides what the operator delegates and records it; every decision is an ADR, and past records are never rewritten ([ADR-0032](./0032-docs-site-and-decision-records.md)).

## Options considered

### Option A: docs first, 1.0 voice, hold until approved (chosen)

**Pros:** the developer experience is judged before code fixes it in place; the pages read as a product; contributor detail has one home.
**Cons:** framework work stops; the Docs and the code disagree until the realignment task runs.

### Option B: live spec with warnings, development in parallel (the earlier ruling)

**Pros:** no stop.
**Cons:** warnings everywhere; code built on a design the docs were about to change.

## Trade-off analysis

The operator's bet is that developer experience is Mesh's only advantage. Pausing code until the experience is approved costs days; building on a design that changes costs rework.

## Consequences

- Open pull requests for framework code (PR #22, the SQLite adapter) are held.
- The Architecture section states what exists and what is planned; Docs pages never do.
- After approval the order of work is [ADR-0064](./0064-order-of-work-after-approval.md).

## Action items

- [ ] Operator: approve the Docs.
