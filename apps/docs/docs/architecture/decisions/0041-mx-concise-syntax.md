---
title: "0041. Resource files and examples use MX concise syntax"
description: "Decision record 0041: Resource files and examples use MX concise syntax. Status: Accepted."
---

# 0041. Resource files and examples use MX concise syntax

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

Mesh resource files are `.mx` files, parsed by MX, a separate project that reads Marko syntax ([ADR-0002](./0002-resource-files-are-mx.md)). Marko has two spellings for the same tree. The HTML-style form writes angle-bracket tags (`<attribute name="title"/>`). The concise form is indentation-based, with no angle brackets. MX parses both. The fixture on `main`, `packages/compiler/test/fixtures/post.mx`, is written in the concise form: it opens with `resource="post" table="posts" domain="blog"` and nests `attributes`, `relationships`, `actions` and `policies` by indentation. MX project notes, data-target describes the fixture as "concise indentation" (section 3, paragraph "How mash uses this"; the paragraph predates the name Mesh).

The project's earliest plan (not published) has a rule list called "Agent legibility principles". It includes "One way to do each thing. No aliases or alternative spellings for the same tag or attribute", and says that "When one conflicts with human ergonomics, agent legibility wins."

## Decision

The operator ruled on 2026-10-04, in the row "Vocabulary" of "Rulings after the decision review" ([rulings of 2026-10-04](./rulings-2026-10-04.md)). The row has three sentences; the third is the one this ADR records:

> Resource files and every example always use MX concise syntax.

The first two sentences ("Copy Ash's DSL for now (names and structure). After v1, review it and optimise for what feels natural in MX.") concern the vocabulary and are recorded elsewhere ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md)).

**Not decided:** whether Mesh must reject an HTML-style resource file at build time. The ruling fixes what files and examples look like, not what the build accepts. Whether the form can be detected from the parsed tree is an open question for the MX maintainers: MX project notes, data-target lists the node kinds (tag, attribute, comment and so on), and it lists no field recording which form the author used.

## Options considered

### Option A: Concise syntax only (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low. One form in docs, fixtures, tests and agent prompts. |
| Cost | Nothing to build; a style rule to keep. |
| Density | Highest. No closing tags or angle brackets. |
| Fit with "one way to do each thing" | Direct. |

**Pros:** Resource files are short, which matters because a file is the whole description of a resource. A single spelling reduces what an agent or a reader must learn.
**Cons:** Indentation carries structure, so a mis-indented line changes meaning. Developers who know HTML-style Marko must learn the other form. Editor support for the form was not checked.

### Option B: Allow both forms

| Dimension | Assessment |
|-----------|------------|
| Complexity | Higher. Docs, examples and error messages must work in two forms. |
| Cost | Ongoing: every example needs a decision. |
| Density | Author's choice. |
| Fit with "one way to do each thing" | Violates it. |

**Pros:** Familiar to Marko users; mixed files tolerated.
**Cons:** Two spellings for each construct, which the project's own principle forbids. Reviewers see inconsistent files.

### Option C: HTML-style only

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low. |
| Cost | None. |
| Density | Lowest; every tag needs a close. |
| Fit with "one way to do each thing" | Satisfied, but against the existing fixture. |

**Pros:** Looks like HTML, which is familiar and well supported in editors.
**Cons:** Longer files; the vocabulary and the fixture would be rewritten.

## Trade-off analysis

A and C both give one way. A wins on density and on matching the fixtures already written. B is the only option that breaks the one-way principle, so its familiarity advantage is outweighed. The open question, enforcement, decides whether the rule is a convention or a build guarantee.

## Consequences

- Easier: examples, docs and tests look alike; an agent copying an example produces the accepted form.
- Harder: nothing stops an author using the other form until a rule exists.
- Revisit: after v1, when the vocabulary is reviewed for what feels natural in MX.

## Action items

- [ ] M1: write every fixture, doc example and ADR sample in concise syntax.
- [ ] M1: decide whether the build rejects HTML-style files; first confirm with the MX maintainers whether the tree or a diagnostic can tell the forms apart.
