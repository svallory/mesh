---
title: "0065. The docs site highlights `mx` code with MX's own tree-sitter highlighter"
description: "Decision record 0065: how `mx` fences are highlighted, how the highlighter is shared before MX is published, and what was rejected. Status: Accepted."
---

# 0065. The docs site highlights `mx` code with MX's own tree-sitter highlighter

## Status

Accepted. Built: the docs highlighter is the published `@mxlang/tree-sitter-mx` package, wired into the
docs build. The highlighter was vendored under `apps/docs/plugins/mx/` for as long as the package was
unpublished; that directory is gone.

## Date

2026-10-05

## Deciders

the lead, delegated by the operator, agreed with the MX lead (MX decision 150)

## Context

The docs site is built with docmd ([ADR-0032](./0032-docs-site-and-decision-records.md)). Since PR #19 it highlights `mx` fences with Shiki, a highlighter driven by TextMate grammars, using the Marko grammar, because entity files are Marko syntax read by MX ([contributing](../contributing.md)).

Entity file syntax v2 uses forms Shiki's Marko grammar does not know: `#name` after a space, the `:label` sugar, and the data-target forms ([ADR-0050](./0050-entity-file-syntax.md), [ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md)). MX has one grammar, by ruling on the MX side, written for tree-sitter (a parser generator whose grammars can run in the browser or at build time as WebAssembly). No TextMate grammar for MX will exist, so Shiki can never highlight MX itself.

The `@mxlang` packages were not published when this was decided, and the docs image is built from the
public repository, which cannot reach the MX checkout ([ADR-0031](./0031-no-ci-until-mx-is-published.md)).
They are published now, on the operator's own registry, `https://npm.saulo.tech`.

## Decision

[rulings of 2026-10-04](./rulings-2026-10-04.md), section "MX highlighting on the docs site (2026-10-05, agreed with the MX lead; MX decision 150)":

- `mx` fences are highlighted with MX's own highlighter: the tree-sitter grammar `@mxlang/tree-sitter-mx`, run at docs build time through `web-tree-sitter` 0.26.9. Shiki stays for every other language.
- Until the `@mxlang` packages are published, Mesh vendors the built highlighter under `apps/docs/plugins/mx/`: the plugin module, `tree-sitter-mx.wasm`, the two query files, the TypeScript grammar wasm and its highlights, with a header naming the MX commit. The wasm files are committed so the Docker build of the site needs no tree-sitter command-line tool.
- When `@mxlang/tree-sitter-mx` is published (subpath `@mxlang/tree-sitter-mx/docmd`), Mesh imports it and deletes the vendored copy.
- The work is one docs task after the `docs/syntax-v2` branch merges, because both touch `apps/docs`. It must probe a regex-literal attribute value (`match=/^INV-\d+$/`), which MX did not test.

Implemented in one detail differently from the wording above: docmd highlights every other language
with highlight.js and the two stylesheets it ships, not with Shiki, so the `mx` capture names are
mapped to docmd's own light and dark hexes rather than to a Shiki theme ([contributing](../contributing.md)).

Implemented in a second detail, the one the ruling anticipated: the vendoring step is over.
`@mxlang/tree-sitter-mx` is on `https://npm.saulo.tech` as `0.1.0-alpha.1`, `apps/docs` depends on it
at that exact version, and `apps/docs/plugins/mx/` is deleted. The repository's `bunfig.toml` points
the `@mxlang` scope at that registry; it is read-only and has no uplink, so only the `@mxlang` scope
points at it and nothing else in the workspace resolves there. The docs image never sees the repository
root, so `apps/docs/docker/bunfig.toml` repeats the one scope entry for the build inside Docker.

## Options considered

### Option A: MX's tree-sitter highlighter, vendored until published (chosen)

**Pros:** one grammar for MX, the one MX maintains; it knows every form syntax v2 uses.
**Cons:** a vendored binary in the repository until MX publishes; a second highlighter beside Shiki.
Now superseded: the package is published, so the vendoring half of this option is over and only the
choice of MX's grammar stands.

### Option B: keep Shiki with the Marko grammar

**Pros:** nothing to build.
**Cons:** mis-highlights syntax v2.

### Option C: a `@mxlang/textmate` package, or a Mesh-specific TextMate grammar

**Pros:** Shiki could highlight everything.
**Cons:** MX has no TextMate grammar to put in such a package; a Mesh grammar would be a second MX grammar, and Mesh adds tag names, not syntax ([ADR-0002](./0002-resource-files-are-mx.md)). Rejected.

## Trade-off analysis

Only Option A highlights the syntax the docs show. The vendored copy it needed was temporary, named by
its MX commit so it could be checked, and is gone: the published package is the one source for the
grammar, which was the whole point of the ruling.

## Consequences

- The `mx-highlight` plugin of PR #19 is replaced for `mx` fences; every other fence is highlighted by
  docmd, as before, and the dark-mode switch the old plugin carried is gone with it.
- The grammar is line-tolerant in a way a TextMate grammar is not: a fence is read as one file. Since
  the package reports a line it cannot read as an ERROR node, the docs build now fails on one, with the
  page, the line of the fence and the line inside the block to fix, like any other bad fence. The
  commonest case is the language's own rule: in concise syntax a line at the left margin ends the root
  tag's block, a comment included, so a comment inside an entity has to be indented with the block it
  sits in. Nothing on the site needs it today and the annotated figure blanks its own annotation lines.
- Two capture gaps in the vendored queries were reported to MX and fixed there: the names in a
  destructured lambda parameter (`that=({ self }) => …`) and the `?` and `:` of a ternary. Both are
  coloured by `0.1.0-alpha.1`, and both are pinned by tests.
- The `@mxlang` scope resolves from `https://npm.saulo.tech`, a registry the operator hosts. It is read-only
  and has no uplink, so an `@mxlang` version that is not published there cannot be installed by accident.
- Open, the operator's call: the same registry could carry the unpublished `@meshfw` packages once those
  are published; today only `@mxlang` points at it.

## Action items

- [x] Vendor the highlighter, wire it into docmd, probe a regex-literal attribute value (done in the
  `docs/mx-highlighter` branch: `match=/^INV-\d+$/` colours as a regex literal, the `docs` tests cover
  it, and the grammar was not changed to get there).
- [x] The two query gaps, fixed on the MX side and in `@mxlang/tree-sitter-mx@0.1.0-alpha.1`: the names in
  a destructured lambda parameter and the `?` and `:` of a ternary are both coloured, with tests.
- [x] A column-0 line inside an entity is an ERROR node; a fence that has one fails the docs build with the
  page and the line, and the annotated figure still blanks its own annotation lines.
- [x] `@mxlang/tree-sitter-mx` is published: `apps/docs` depends on it at `0.1.0-alpha.1`, the
  `apps/docs/plugins/mx/` copy is deleted, and the `@mxlang` scope resolves from
  `https://npm.saulo.tech` (root `bunfig.toml`, and `apps/docs/docker/bunfig.toml` for the image).
