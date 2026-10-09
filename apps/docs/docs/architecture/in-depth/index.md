---
title: "In depth"
description: "Full descriptions of single subsystems and mechanisms."
---

# In depth

This area holds one page per subsystem or mechanism, described in full: the build-time pipeline, the run-time action lifecycle, extension points and similar topics that span several files.

Each page says what the thing is, how it works, and which code implements it. Link the [decision records](../decisions/index.md) that explain why. Where a page describes design that the code on `main` does not implement yet (for example expression evaluation, policies, `mx-contracts.js`), it says so once, in a callout at the top.

<!-- pages:start -->

## Pages

- [Action lifecycle](./action-lifecycle.md)
- [The build-time pipeline](./build-pipeline.md)
- [Data layer: contract and capabilities](./data-layer.md)
- [Expressions: one tree, two evaluators](./expressions.md)
- [Extension host and composed contracts](./extension-host.md)
- [Generated code and the guard](./generated-code-and-guard.md)
- [How Mesh uses MX](./mx-integration.md)
- [Core, adapters and extensions](./three-rings.md)


Each in-depth page is written in the milestone that builds the thing it describes. Pages for relationships and computed fields (M7) and for policies (M8) come with those milestones; until then [ADR-0050](../decisions/0050-entity-file-syntax.md) and [ADR-0055](../decisions/0055-policies-are-core.md) hold their design.
