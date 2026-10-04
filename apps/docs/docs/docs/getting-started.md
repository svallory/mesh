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

The contracts depend on MX, a separate project, through `link:` entries in `package.json`. Link your MX checkout first, then install and test, from the repository root:

```bash
bun link @mxlang/data @mxlang/core
bun install
bun test
bunx tsc --noEmit
```

To build this documentation site, read [Contributing to these docs](../architecture/contributing.md).

When Mesh can be used, this page will cover installing it with Bun and declaring a first resource.
