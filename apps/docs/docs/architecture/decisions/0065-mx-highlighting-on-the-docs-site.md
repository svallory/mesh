---
title: "0065. The docs site highlights `mx` code with MX's own tree-sitter highlighter"
description: "Decision record 0065: how `mx` fences are highlighted, how the highlighter is shared before MX is published, and what was rejected. Status: Accepted."
---

# 0065. The docs site highlights `mx` code with MX's own tree-sitter highlighter

## Status

Accepted. Built: the highlighter is vendored under `apps/docs/plugins/mx/` and wired into the docs
build. Switching to the published `@mxlang/tree-sitter-mx` package is still ahead.

## Date

2026-10-05

## Deciders

the lead, delegated by the operator, agreed with the MX lead (MX decision 150)

## Context

The docs site is built with docmd ([ADR-0032](./0032-docs-site-and-decision-records.md)). Since PR #19 it highlights `mx` fences with Shiki, a highlighter driven by TextMate grammars, using the Marko grammar, because entity files are Marko syntax read by MX ([contributing](../contributing.md)).

Entity file syntax v2 uses forms Shiki's Marko grammar does not know: `#name` after a space, the `:label` sugar, and the data-target forms ([ADR-0050](./0050-entity-file-syntax.md), [ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md)). MX has one grammar, by ruling on the MX side, written for tree-sitter (a parser generator whose grammars can run in the browser or at build time as WebAssembly). No TextMate grammar for MX will exist, so Shiki can never highlight MX itself.

The `@mxlang` packages are not published, and the docs image is built from the public repository, which cannot reach the MX checkout ([ADR-0031](./0031-no-ci-until-mx-is-published.md)).

## Decision

[rulings of 2026-10-04](./rulings-2026-10-04.md), section "MX highlighting on the docs site (2026-10-05, agreed with the MX lead; MX decision 150)":

- `mx` fences are highlighted with MX's own highlighter: the tree-sitter grammar `@mxlang/tree-sitter-mx`, run at docs build time through `web-tree-sitter` 0.26.9. Shiki stays for every other language.
- Until the `@mxlang` packages are published, Mesh vendors the built highlighter under `apps/docs/plugins/mx/`: the plugin module, `tree-sitter-mx.wasm`, the two query files, the TypeScript grammar wasm and its highlights, with a header naming the MX commit. The wasm files are committed so the Docker build of the site needs no tree-sitter command-line tool.
- When `@mxlang/tree-sitter-mx` is published (subpath `@mxlang/tree-sitter-mx/docmd`), Mesh imports it and deletes the vendored copy.
- The work is one docs task after the `docs/syntax-v2` branch merges, because both touch `apps/docs`. It must probe a regex-literal attribute value (`match=/^INV-\d+$/`), which MX did not test.

## Options considered

### Option A: MX's tree-sitter highlighter, vendored until published (chosen)

**Pros:** one grammar for MX, the one MX maintains; it knows every form syntax v2 uses.
**Cons:** a vendored binary in the repository until MX publishes; a second highlighter beside Shiki.

### Option B: keep Shiki with the Marko grammar

**Pros:** nothing to build.
**Cons:** mis-highlights syntax v2.

### Option C: a `@mxlang/textmate` package, or a Mesh-specific TextMate grammar

**Pros:** Shiki could highlight everything.
**Cons:** MX has no TextMate grammar to put in such a package; a Mesh grammar would be a second MX grammar, and Mesh adds tag names, not syntax ([ADR-0002](./0002-resource-files-are-mx.md)). Rejected.

## Trade-off analysis

Only Option A highlights the syntax the docs show. The vendored copy is temporary and is named by its MX commit, so it can be checked and replaced.

## Consequences

- The `mx-highlight` plugin of PR #19 is replaced for `mx` fences; other fences keep Shiki, including
  the dark-mode switch, which only the plugin's own stylesheet applied.
- The grammar is line-tolerant in a way a TextMate grammar is not: a fence is read as one file, so a
  line the grammar cannot parse can leave the lines below it uncoloured. The build still fails loudly on
  a missing or unreadable grammar, not on a line the grammar dislikes.
- Open, the operator's call: a private package registry (Verdaccio on the operator's server, the lead's recommendation over GitHub Packages) to share unpublished `@mxlang` and `@meshfw` packages; it would remove the vendoring step.

## Action items

- [x] Vendor the highlighter, wire it into docmd, probe a regex-literal attribute value (done in the
  `docs/mx-highlighter` branch: `match=/^INV-\d+$/` colours as a regex literal, the `docs` tests cover
  it, and the grammar was not changed to get there).
- [ ] Two gaps found while switching the site over, both for the MX lead: a `//` comment line after the
  root line ends the document for the grammar, and the names in a destructured lambda parameter
  (`that=({ self }) => …`) get no capture.
- [ ] When `@mxlang/tree-sitter-mx` is published: import it and delete `apps/docs/plugins/mx/`.
