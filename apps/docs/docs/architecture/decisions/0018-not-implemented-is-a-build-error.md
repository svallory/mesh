---
title: "0018. A valid but unimplemented tag is a build error"
description: "Decision record 0018: A valid but unimplemented tag is a build error. Status: Accepted."
---

# 0018. A valid but unimplemented tag is a build error

## Status

Accepted

## Date

2026-10-04

## Deciders

roadmap author; the lead may overrule

## Context

The 26 tag contracts on `main` (merged in PR #1; PR #2 only adopted an MX option) describe the whole resource-file vocabulary: relationships, policies, calculations, aggregates and more ([roadmap](../roadmap/roadmap.md), section 0 and M1). A contract tells MX, the separate project that parses `.mx` files, which tags and attributes a file may contain. The compiler will implement that vocabulary over several milestones, so for a long time a file can be valid for MX and still use something Mesh does not handle. A `policies` block that is silently ignored would look like protection and give none.

## Decision

The roadmap author decided this in plan revision 2: "A tag or attribute that is valid but not implemented is a build error. PR #1's contracts already accept the whole vocabulary; the compiler grows into it milestone by milestone. Silently ignoring a `policies` block would be the worst kind of fallback" ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 8, D5). The roadmap states the rule in M1: such a tag or attribute is "a build error naming it and the milestone that will" implement it. The M1 list is `relationships`, `belongs-to`, `has-many`, `change`, `validate`, `filter`, `sort`, `policies`, `policy`, `authorize-if`, `calculations`, `calculate`, `value`, `aggregates`, `count`. It follows the vocabulary alignment that opens M1, which renames tags to follow Ash's DSL ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md)), so the names will change with it. `public` is not on the list: it is recorded in the model and nothing in v1 reads it ([roadmap](../roadmap/roadmap.md), M1; [ADR-0035](./0035-meaning-of-public.md), Proposed, on what it means). The rule follows the principle "No silent fallback" ([roadmap](../roadmap/roadmap.md), section 2, item 2; [research synthesis](../research/synthesis.md), section 8, "Silent fallbacks"). Nothing in the rulings file overrules it.

## Options considered

### Option A: Build error naming the milestone (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: a list per milestone, shrinking |
| Cost | Low; every milestone must delete entries from the list |
| Safety | A project cannot appear to work while ignoring a rule |
| Reversibility | Easy: remove the check |

**Pros:** a stated rule is either honoured or reported; authors and agents see which milestone brings the feature.
**Cons:** the example `post.mx` cannot build in full until M8 (M1 test 5; M8 test 6); users cannot try a later feature early; the list must stay current.

### Option B: Warning, then ignore
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Cost | Lowest |
| Safety | Poor: warnings are missed; Ash turns verifier errors into warnings and had to build a test helper to recover the signal ([research synthesis](../research/synthesis.md), section 8, "Do differently") |
| Reversibility | Easy, but behaviour changes silently when implemented |

**Pros:** the full example file builds from M1.
**Cons:** an ignored `policies` block, or an ignored `filter`, produces working but wrong software.

### Option C: Shrink the contracts to what is implemented
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: contracts change in every milestone |
| Cost | Higher; each milestone edits contracts and their negative fixtures |
| Safety | MX itself rejects the tag |
| Reversibility | Easy, but churn |

**Pros:** the error comes from MX, with no Mesh rule.
**Cons:** discards the full fixture and the contracts' coverage of the vocabulary, and the mapping to Ash's DSL ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md)) is done against the whole vocabulary, so contracts would be edited twice.

## Trade-off analysis

The three options differ in where the error comes from and whether the file stays valid. A keeps the file valid and the error honest, at the cost of a maintained list.

## Consequences

Easier: staged delivery with no hidden gaps. Harder: every milestone must remove its entries and the user docs must say what is not yet available. Revisit the list after the vocabulary alignment at the start of M1.

## Action items
- [ ] M1: implement the list and the error with file, line and milestone.
- [ ] M3 to M8: remove entries as tags land.
- [ ] M8: no entries remain; the full example builds.
