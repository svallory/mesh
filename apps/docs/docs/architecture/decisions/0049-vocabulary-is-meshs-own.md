---
title: "0049. The vocabulary is Mesh's own; `resource` becomes `entity`"
description: "Decision record 0049: The vocabulary is Mesh's own, informed by Ash, and the declared thing is called an entity. Status: Accepted."
---

# 0049. The vocabulary is Mesh's own; `resource` becomes `entity`

## Status

Accepted. Supersedes [ADR-0034](./0034-vocabulary-copies-ash-dsl.md). Amends [ADR-0002](./0002-resource-files-are-mx.md) (the term).

## Date

2026-10-05 (the term on 2026-10-04 evening; the vocabulary on 2026-10-05)

## Deciders

operator (Saulo Vallory)

## Context

The *vocabulary* is the set of tag and attribute names an entity file may use. On 2026-10-04 the operator ruled that it copies Ash's DSL, names and structure, until v1, and is reviewed for MX after v1 ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md)). Ash is the Elixir framework Mesh is modelled on. Milestone M1 aligned the 26 tag contracts on `main` with Ash ([vocabulary mapping](../roadmap/vocabulary-mapping.md)).

Writing the user docs against that vocabulary showed its cost. Ash's names come from Elixir: positional arguments become a default attribute plus named ones (`attribute="title" type="string"`), relationships need `destination=`, policies need check calls such as `action_type("read")`, and the user must remember which of several shapes a line takes. The docs pages had to explain each shape separately ([open questions and findings](../open-questions.md)).

Ash calls the declared thing a *resource*. In TypeScript web code "resource" usually means an HTTP or REST resource, which Mesh is not tied to ([ADR-0005](./0005-core-interface-is-a-function-call.md)).

## Decision

Two operator rulings, recorded in [rulings of 2026-10-04](./rulings-2026-10-04.md):

> **Term.** `resource` becomes `entity` (overrides "copy Ash" for this word).

(section "Rulings on the user docs, layout and terms (2026-10-04 evening, operator)", 2026-10-04 evening), and, on 2026-10-05:

> Supersedes the vocabulary rulings above where they differ ("copy Ash" no longer holds: the vocabulary is Mesh's own, informed by Ash).

(section "Entity file syntax (2026-10-05, operator)", preamble). The same section sets the principle: rely on existing MX syntax wherever possible, minimise the rules a user must remember, and have exactly one way to write each thing.

So the thing a file declares is an **entity**, and the file is an **entity file**. The spelling of each tag is set by [ADR-0050](./0050-entity-file-syntax.md), not by Ash. Ash stays the reference for *what* an entity can declare; [vocabulary mapping](../roadmap/vocabulary-mapping.md) tells an Ash user where each Ash concept went. Entity files still use MX concise syntax ([ADR-0041](./0041-mx-concise-syntax.md)).

## Options considered

### Option A: Mesh's own vocabulary, informed by Ash (chosen)

**Pros:** each line has one shape, chosen for MX; fewer rules to learn; names read naturally in TypeScript.
**Cons:** an Ash user can no longer transfer the DSL word for word; Mesh must design and document every name itself.

### Option B: Keep copying Ash until v1, review after ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md))

**Pros:** no naming work; Ash's documentation is a reference for every name.
**Cons:** the post-v1 review is a breaking rename of every entity file written by then ([roadmap](../roadmap/roadmap.md), section 9, risk 1); the user docs showed the copied shapes read poorly in MX.

### Option C: Copy Ash, but rename only `resource`

**Pros:** the smallest change.
**Cons:** keeps the shapes that made the docs hard to write.

## Trade-off analysis

The rename after v1 was going to happen anyway; doing it before any user exists costs only the contracts, the fixtures and the docs. Option A gives up word-for-word familiarity for Ash users, a small group compared with the TypeScript developers Mesh is for.

## Consequences

- Easier: the user docs teach one line shape; the vocabulary review after v1 is no longer planned.
- Harder: the contracts, the model, the compiler, the CLI and the example still say `resource` until the realignment task ([ADR-0064](./0064-order-of-work-after-approval.md)). The [vocabulary mapping](../roadmap/vocabulary-mapping.md) keeps the old spelling in a column because a test reads it.
- Every name in the Architecture section is now `entity`; `resource` appears only in superseded records and quoted history.

## Action items

- [ ] Realignment task: rename `resource` to `entity` in `packages/compiler`, `packages/model`, `packages/cli` and `examples/blog`.
- [x] Rewrite [vocabulary mapping](../roadmap/vocabulary-mapping.md) as the Ash-to-Mesh map.
