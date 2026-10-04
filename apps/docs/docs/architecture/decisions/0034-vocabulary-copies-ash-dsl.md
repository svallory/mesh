---
title: "0034. The resource vocabulary copies Ash's DSL for v1"
description: "Decision record 0034: The resource vocabulary copies Ash's DSL for v1. Status: Accepted."
---

# 0034. The resource vocabulary copies Ash's DSL for v1

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory) (the ruling); lead (the spelling rule), the operator may overrule

## Context

The *vocabulary* is the set of tag and attribute names a resource file may use, such as `resource`, `attribute`, `policy`. MX, the separate project that parses `.mx` files, checks a file against one *tag contract* per name ([ADR-0002](./0002-resource-files-are-mx.md)). PR #1 put 26 such contracts on `main`, now in `packages/compiler/src/contracts.ts` ([roadmap](../roadmap/roadmap.md), section 0, "PR #1, PR #2").

They were not designed from a reference. The names were copied from an MX test fixture, `packages/targets/data/fixtures/ash-resource/post.mx` (MX project notes, getting-started, section 1). Several rules were then inferred by the developer or required by the lead during code review: for example, that `values` is rejected when `type` is not `enum`, that a `policy` takes exactly one of `action` or `action-type`, and the fixed lists of attribute types and action types ([vocabulary mapping](../roadmap/vocabulary-mapping.md), section 1; [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief"). Milestones M3, M5, M7 and M8 add more tags (roadmap, section 9, risk 9). The vocabulary needed a reference.

Ash, the Elixir framework Mesh is modelled on, is that reference. Its resource DSL has 14 sections (`attributes`, `relationships`, `actions`, `calculations` and others; policies are a separate extension in Ash, which fits Mesh's own policies extension, [ADR-0022](./0022-policies-simple-tier-as-extension.md)), though a typical resource uses about half of them ([research synthesis](../research/synthesis.md), section 1; [Ash features](../research/ash-features.md); [Ash DSL and extensions](../research/ash-dsl-and-extensions.md)).

## Decision

Operator ruling, 2026-10-04, [rulings of 2026-10-04](./rulings-2026-10-04.md), "Rulings after the decision review", row "Vocabulary":

> Copy Ash's DSL for now (names and structure). After v1, review it and optimise for what feels natural in MX. Resource files and every example always use MX concise syntax.

Consequence for the work: where the current contracts or the roadmap deviate from Ash in names, defaults or inferred rules, they are aligned with Ash unless MX cannot express it. Only those exceptions go to the operator. The page [vocabulary mapping](../roadmap/vocabulary-mapping.md) is now a mapping from each Ash DSL section, entity and option that Mesh v1 touches to a Mesh tag or attribute.

**Spelling.** The MX maintainers measured that `_` is accepted in tag and attribute names (recorded in [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief", and in [vocabulary mapping](../roadmap/vocabulary-mapping.md), section 0). A trailing `?` is disallowed by the operator's ruling of 2026-10-04, in attribute names and in tag names (see the row "Trailing `?` in attribute names" in [rulings of 2026-10-04](./rulings-2026-10-04.md), table "Rulings after the decision review"); MX itself bans it in attribute names (MX decision 144) and allows it in tag names. The lead then decided the spelling rule (not an operator ruling): Mesh names are Ash's names in kebab-case with `?` dropped, so `belongs_to` becomes `belongs-to`, `allow_nil?` becomes `allow-nil` and `require_atomic?` becomes `require-atomic`. The mapping is mechanical and one to one, matches what is on `main`, and avoids renaming twice, since the operator will revisit naming for MX after v1.

## Options considered

### Option A: Copy Ash now, optimise after v1 (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: a mapping table and alignment edits |
| Cost | Small now; a rename pass after v1 |
| Reversibility | Poor for users: renames break every resource file |
| Evidence base | Ash's names are documented and the research already describes them |

**Pros:** every naming question has a default answer; Ash's docs and the research explain each option; agents trained on Ash see familiar words; no new design work blocks M1.
**Cons:** Ash's names come from Elixir keyword syntax and may read oddly in MX concise syntax. A later optimisation is a breaking change to every resource file.

### Option B: Design an MX-native vocabulary now
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: every tag and attribute decided from scratch |
| Cost | Delays M1 until the operator rules on each |
| Reversibility | Same as A once published |
| Evidence base | None yet for how Mesh files read |

**Pros:** names fit the syntax from the start; no later breaking rename.
**Cons:** large decision load before any code runs; no reference, so the same inferred-rule problem reappears.

### Option A2: Ash's exact spelling with `_` (alternative for the spelling rule)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: the mapping is almost the identity |
| Cost | A rename of the multi-word names on `main` now |
| Reversibility | Poor: a second rename is likely after v1 |
| Evidence base | Names match Ash's documentation character for character, apart from `?` |

**Pros:** names are searchable in Ash's documentation exactly.
**Cons:** `?` still has to be dropped, so the spelling is never exact; the multi-word names on `main` would be renamed now and possibly again after v1.

### Option C: Keep the fixture-derived vocabulary, fix ad hoc
| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest |
| Cost | Lowest now |
| Reversibility | Poor |
| Evidence base | One test fixture and inferred rules |

**Pros:** nothing changes; contracts and tests stand.
**Cons:** milestones M3 to M8 extend a vocabulary nobody ruled on, with no principle for new names.

## Trade-off analysis

B front-loads decisions that code would answer better. C has no principle. A gives a principle at the cost of a possible rename later, which is the operator's stated trade. A2 would make names searchable in Ash's documentation but is never exact (`?` is dropped) and would rename the multi-word names twice, so the lead's kebab-case rule wins.

## Consequences

Easier: choosing names; checking Mesh against Ash's docs. Harder: the review after v1 must plan a migration for existing resource files. Revisit after v1.

## Action items
- [ ] M1: apply the spelling rule (kebab-case, `?` dropped) to every new name; make the alignment edits to the contracts that [vocabulary mapping](../roadmap/vocabulary-mapping.md) lists; bring only the exceptions to the operator.
- [ ] M1 onward: every `.mx` example uses concise syntax.
- [ ] After v1: review the vocabulary for MX naturalness and plan the migration.
