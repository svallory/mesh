---
title: "0062. Zod 4 stays; a project depends directly on Zod, Drizzle and the OpenTelemetry API"
description: "Decision record 0062: the outcome of the validation-library research, the stable Drizzle pin, and which libraries a project installs itself. Status: Accepted, amended by ADR-0072."
---

# 0062. Zod 4 stays; a project depends directly on Zod, Drizzle and the OpenTelemetry API

> **Amended** by [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) on 2026-10-10: The OpenTelemetry API is not a project dependency until tracing returns after Mesh 1.0. The body below is kept as history.

## Status

Accepted. Confirms [ADR-0028](./0028-validation-zod-behind-standard-schema.md) and [ADR-0048](./0048-schema-inside-the-process-for-tests.md).

Amended by [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md) (2026-10-10): The OpenTelemetry API is not a project dependency until tracing returns after Mesh 1.0.

## Date

2026-10-05

## Deciders

operator (Saulo Vallory) for the direct dependencies and the request to research; the lead, delegated by the operator, for keeping Zod (the operator agreed)

## Context

Generated code imports three libraries itself: the validation library for input validators (Zod 4, [ADR-0028](./0028-validation-zod-behind-standard-schema.md)), `drizzle-orm` in the emitted schema, and `@opentelemetry/api` for tracing ([ADR-0029](./0029-tracing-opentelemetry-api.md)). Mesh's run-time library sees validators only through Standard Schema, a shared interface validation libraries implement.

The operator asked to re-choose the validation library: "there are better options than zod (more readable and more typescript native). Research and pick the best as long as it pairs well with drizzle." The research is [validation library](../research/validation-library.md). It recommends ArkType 2 on readability, with Zod 4 as the runner-up, and lists what would change the pick: type-check cost on a realistic app, ArkType's maintainer situation, and readability of the string syntax as rules grow.

## Decision

Operator, 2026-10-05, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Entity file syntax, continued (2026-10-05 morning, operator)", row "Direct dependencies":

> A project depends directly on the validation library, `drizzle-orm` and `@opentelemetry/api`, for now.

The lead, delegated by the operator, same file, section "Decisions delegated to the lead (2026-10-05)", row "Validation library":

> Zod 4 stays for v1 (operator agreed). Research: `notes/research/10-validation-library.md` recommends ArkType 2 on readability; rejected for Mesh because nobody hand-writes validators, its measured costs (type-check time, startup) grow with the number of entities, and it has one maintainer. Switching later is one emitter behind Standard Schema, or one overridden template.

The SQL adapters stay on the stable Drizzle pair pinned in M2, `drizzle-orm@0.45.3` and `drizzle-kit@0.31.11`, not the v1 release candidate ([ADR-0048](./0048-schema-inside-the-process-for-tests.md)).

## Options considered

### Option A: Zod 4 (chosen)

**Pros:** cheapest type-check of the candidates measured; the richest error payload (`code`, `params`, locales); the largest user base; the existing emitter.
**Cons:** less readable than ArkType for the rare reader of generated validators.

### Option B: ArkType 2 (the research's pick)

**Pros:** reads like the TypeScript type; exact optional semantics.
**Cons:** measured about 8 times Zod's type-check time and about 480 ms startup for 400 schemas, costs that grow with every entity; one maintainer; readability matters little in files nobody writes by hand.

### Option C: Valibot

**Pros:** smallest bundle, fastest import.
**Cons:** not more readable than Zod, which was the reason to switch ([validation library](../research/validation-library.md), section 8).

## Trade-off analysis

The research ranks readability first because the operator did. The lead's counter-argument is that validators are generated, so their readers are few, while type-check and startup costs reach every user on every edit and grow with the project. Standard Schema keeps a later switch to one emitter, or one overridden template ([ADR-0061](./0061-generators-are-jig-templates.md)).

## Consequences

- Nothing changes in code: the validators emitter keeps emitting Zod 4.
- The user docs list `zod`, `drizzle-orm` and `@opentelemetry/api` as ordinary dependencies of a project, and `mesh build` checks they resolve ([build pipeline](../in-depth/build-pipeline.md), stage 7).
- Revisit when ArkType's costs are measured on a real Mesh app, or when Drizzle v1 is released.

## Action items

- [ ] At Drizzle v1 release or M7: revisit the pin ([ADR-0048](./0048-schema-inside-the-process-for-tests.md)).
