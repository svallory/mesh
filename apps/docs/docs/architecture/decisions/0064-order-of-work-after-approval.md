---
title: "0064. After the docs are approved: realignment, then the Jig port, then M2"
description: "Decision record 0064: the order of work once the hold is lifted, and why the rename comes first. Status: Accepted."
---

# 0064. After the docs are approved: realignment, then the Jig port, then M2

## Status

Accepted

## Date

2026-10-05

## Deciders

the lead, delegated by the operator

## Context

The code on `main` (contracts, model, compiler, CLI, runtime, the blog example) was built to the vocabulary and names of 2026-10-04 morning: `resource`, Ash's DSL shapes, `generated/`, the `domain=` attribute, `scope`, `@mesh/*`, policy tags waiting for an extension. The rulings of the evening of 2026-10-04 and of 2026-10-05 changed all of these ([ADR-0049](./0049-vocabulary-is-meshs-own.md) to [ADR-0062](./0062-direct-dependencies-zod-drizzle-opentelemetry.md)). Development is on hold until the operator approves the user docs ([ADR-0063](./0063-user-docs-first-and-the-hold.md)). M2 was partly merged when the hold began: PR #20 (the run-time library) and PR #21 (input validators) are on `main`; PR #22 (the SQLite adapter) is open.

## Decision

The lead, delegated by the operator, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Decisions delegated to the lead (2026-10-05)", row "Order of work after approval":

> (1) realignment task: syntax v2, `entity`, `.mesh`/`#mesh`, `src/domain`, `ActionContext`, `@meshfw/*`, policies in core, across contracts, model, compiler, CLI, example; (2) Jig templates for the existing emitters; (3) M2 resumes.

The two new tasks and their acceptance tests are in the [roadmap](../roadmap/roadmap.md), section 5.

## Options considered

### Option A: rename first, then port, then M2 (chosen)

**Pros:** every later milestone is built on the final names; the port works on emitters that already emit the final names; the rename touches the fewest files now.
**Cons:** two tasks before any new behaviour.

### Option B: finish M2, rename after

**Pros:** the walking skeleton ends sooner.
**Cons:** M2 adds handlers, a schema emitter and an adapter in the old names, all of which the rename then touches.

### Option C: port to Jig first

**Pros:** the rename then edits templates instead of TypeScript emitters.
**Cons:** the port would be checked against output in the old names, and checked again after the rename.

## Trade-off analysis

The rename's cost grows with every file written in the old names, so it goes first. The port goes before M2 so that M2's new emitters are written once, as views and templates ([ADR-0061](./0061-generators-are-jig-templates.md)).

## Consequences

- PR #22 is rebased onto the realigned names before it can merge.
- Until the realignment task merges, every Architecture page that describes code on `main` says once which old names the code still uses.

## Action items

- [ ] Realignment task, then the Jig port, then M2, as the roadmap lists.
