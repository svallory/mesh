---
title: "Getting started"
description: "Placeholder: there is nothing to install yet."
---

# Getting started

::: callout info "Stub"
This page is a placeholder. Mesh has no release, so there is no install step and no first project to build.
:::

Until a release exists, the only way to try Mesh is to work on it.

## Run the tests

The contracts live in the `packages/compiler` workspace package. They depend on MX, a separate project, through `link:` entries in `packages/compiler/package.json`. Register your MX checkout with `bun link` first (see the MX project), link it into `packages/compiler`, then install and verify from the repository root:

```bash
cd packages/compiler && bun link @mxlang/data @mxlang/core && cd ../..
bun install
bun run verify      # tests, type check, docs build and link check
bun run test        # tests only
bun run typecheck   # type check only
```

To build this documentation site, read [Contributing to these docs](../architecture/contributing.md).

When Mesh can be used, this page will cover installing it with Bun and declaring a first resource.
