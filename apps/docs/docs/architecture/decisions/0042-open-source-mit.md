---
title: "0042. Mesh is open source under the MIT licence"
description: "Decision record 0042: Mesh is open source under the MIT licence. Status: Accepted."
---

# 0042. Mesh is open source under the MIT licence

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

A licence says what other people may do with Mesh's code, and publishing decisions say who may read its documents. Mesh is a TypeScript framework modelled on Ash, the declarative resource framework for Elixir. It is early: one repository, `svallory/mesh`, with the resource vocabulary as its only framework code ([roadmap](../roadmap/roadmap.md), section 0).

Two things bear on the choice. First, the repository's documents will be published: the docs site includes the roadmap, every decision record and the research documents ([ADR-0032](./0032-docs-site-and-decision-records.md)), served at https://mesh.saulo.tech. Second, the research shows how source-available licences affect adopters. In the durable-workflow comparison, Inngest's server is under the Server Side Public License (SSPL), "a source-available licence that requires anyone offering the software as a service to publish their whole service stack", and Restate's server is under the Business Source License 1.1 (BSL), "free to use except for a stated competing use ... and converting to an open licence after a set date" ([durable engines](../research/durable-engines.md), sections 2.2 and 2.3). The comparison says the SSPL "matters for anyone self-hosting" (same file, section 2.2); it does not frame the BSL that way, but records the competing-use restriction.

## Decision

The operator ruled on 2026-10-04, in the row "Licence and visibility" of "Rulings after the decision review" ([rulings of 2026-10-04](./rulings-2026-10-04.md)):

> Mesh is fully open source under the MIT licence. Nothing in the docs site is private.

## Options considered

### Option A: MIT (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest. A short permissive licence with no patent clause. One notice to keep: MIT requires the copyright and permission notice to be included in copies. |
| Cost | Dependency licence checks; the `LICENSE` file exists. |
| Adoption | Highest barrier-free reuse, including commercial use. |
| Protection from reuse | None. Anyone may use or host Mesh, closed or open. |

**Pros:** Matches the ecosystem Mesh builds on: Zod, Valibot and drizzle-kit are MIT, and Drizzle itself and the OpenTelemetry API are Apache-2.0 ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), section 1, master-snapshot tables for validation, migrations, data access and observability). Simple for adopters.
**Cons:** No patent grant (Apache-2.0 has one). No protection against a hosted competitor.

### Option B: Apache-2.0

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low; adds a notice file and attribution rules. |
| Cost | Same as A, slightly more paperwork. |
| Adoption | Equal in practice. |
| Protection from reuse | Patent grant and termination clause; otherwise none. |

**Pros:** Explicit patent grant. Drizzle and OpenTelemetry already use it.
**Cons:** Longer and less familiar to casual contributors. The operator did not choose it.

### Option C: Source-available (SSPL or BSL style)

| Dimension | Assessment |
|-----------|------------|
| Complexity | High. Legal terms differ per licence. |
| Cost | Legal review. |
| Adoption | Lower. The research records these terms (SSPL's service-stack clause, BSL's competing-use restriction). |
| Protection from reuse | Strong against hosted competitors. |

**Pros:** Prevents a cloud vendor from offering Mesh as a service.
**Cons:** Not open source by the usual definition. Contradicts "fully open source". Mesh is a library and build tool, not a server, so the threat it defends against is not obvious.

## Trade-off analysis

The operator picked the licence with the least friction and the widest reuse, accepting that Mesh gets no protection from commercial reuse. For a framework whose value rests on adoption and whose dependencies are MIT or Apache-2.0, there is little to gain from restriction.

## Consequences

- Easier: contributors and adopters need no legal review.
- Harder: everything in the repository is public from the start. No secrets, private filesystem paths or personal data may appear in docs, research or decision records. Existing notes that name private paths must be cleaned before they are published.
- Dependencies must be MIT-compatible. Zod, Valibot, drizzle-kit (MIT) and Drizzle, OpenTelemetry API (Apache-2.0) are listed in the research. MX's licence and the licences of the other planned tools (a formatter, docmd) are not checked.

## Action items

- [x] M0: add a `LICENSE` file with the MIT text (done; it exists on `main`).
- [ ] M1: scan the published research for secrets, private paths and personal data, and scan the roadmap and the decision records before they are published.
- [ ] Each milestone: check the licence of any new dependency.
- [ ] After v1: before publishing the packages, confirm the MX packages' licence with the MX maintainers.
