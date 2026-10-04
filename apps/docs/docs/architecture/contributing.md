---
title: "Contributing to these docs"
description: "How to add a page, a decision record or a research document, and how to build and preview the site."
---

# Contributing to these docs

The site is a [docmd](https://docmd.io) project in `apps/docs`. Pages are Markdown files. You do not need to know docmd to write one.

## Two sections, two rules

**Docs** is for people who will use Mesh. **Architecture** is for contributors: what cannot be understood by looking at a single code file.

**Architecture** documents what exists. If a milestone adds a contract, a pipeline stage or a cross-package rule, its Architecture page is updated in the same pull request.

**Docs** is a **live spec**: pages under Docs are written *before* the implementation, and sometimes before the architecture is settled, to model how using Mesh should feel. This replaces the earlier practice, "the pages under Docs describe only what exists today".

The reason is that writing the page is a test of the design. A page that has to say "the architecture does not say what this command is called" has found a gap; a page that has to contradict two architecture pages has found a contradiction. Neither shows up by reading the architecture.

Two things follow from that rule:

- Every page under Docs opens with the same warning callout, saying it is a live spec of how things **will** be and that Mesh is not released. Copy it verbatim from another Docs page.
- Where a decision is Proposed or open, the page takes the option the decision record recommends and adds a short `::: callout info "Not decided yet"` linking to the record. Never pick silently.
- Where nothing is decided at all, design the simplest thing a TypeScript developer would expect and record it in the task report as an invention, with the alternative you rejected. Those are the most valuable output of the work.

The ruling is in the [rulings of 2026-10-04](./decisions/rulings-2026-10-04.md), row "User docs as live spec".

## Build and preview locally

Use Bun, never npm. The repository is a Bun workspace, so install once at the repository root. The docs site's scripts run from `apps/docs`:

```bash
bun install        # at the repository root
cd apps/docs
bun run dev        # live preview, default port 3000
bun run build      # static site into apps/docs/site/
bun run validate   # check internal links
```

A docmd plugin that `docmd.config.json` enables must also be declared in `apps/docs/package.json` (for example `@docmd/plugin-search`), or docmd shells out to npm at build time because it does not recognise Bun's text `bun.lock`.

Run `bun run build` and `bun run validate` before you open a pull request. From the repository root, `bun run verify` runs them together with the tests and the type check. Stop the dev server when you are done.

## Layout and file names

Pages live under `apps/docs/docs/`.

```text
docs/
  index.md                 site landing page
  docs/                    Docs section (for users)
  architecture/            Architecture section (for contributors)
    roadmap/ decisions/ overview/ in-depth/ research/
```

- File names are lowercase, hyphenated, and end in `.md`: `durable-engines.md`.
- Every folder has an `index.md` that says what belongs in it.
- Decision records are numbered: `0001-use-bun-only.md`. The number never changes and is never reused.
- Research documents are named for the topic, not the date: `durable-engines.md`. Put the date in the page.

## Frontmatter

Every page starts with:

```yaml
---
title: "Page title"
description: "One sentence."
---
```

## Add a page

1. Create the `.md` file in the right folder.
2. Add it to `navigation` in `apps/docs/docmd.config.json`. A page that is not listed is built but not shown in the sidebar. Each area is a group with an "About …" first entry; add your page as another object in that group's `children` array: `{ "title": "Durable engines", "path": "/architecture/research/durable-engines/" }`.
3. Link to it from the folder's `index.md`.
4. Run `bun run build` and `bun run validate`.

## Add a decision record

1. Copy [the template](./decisions/_template.md) to `decisions/NNNN-short-title.md`, with the next free number.
2. Replace the template's frontmatter `title` and `description`, and delete its `noindex: true` and `llms: false` lines. Fill in every heading. Write "none" rather than deleting one.
3. Set the status to `Proposed`. Change it to `Accepted`, `Rejected` or `Superseded by NNNN` when it is settled; never delete a record.
4. Add it to `navigation` under **Decisions** and to the list in `decisions/index.md`.

## Add a research document

1. Create `research/topic.md`.
2. State the question, the date, and what was checked. Link every claim to its source. Check each claim against the source before you write it down.
3. Say what the research changed, and link the decision record if there is one.
4. Add it to `navigation` under **Research** and to `research/index.md`.

## Linking

Link to other pages with a relative path to the `.md` file, for example `./roadmap/index.md` from `architecture/index.md`. `bun run validate` checks these, including links inside code spans, so use real paths in examples. Do not use absolute URLs for pages in this site.

## Deployment

The site is deployed at <https://mesh.saulo.tech> by a [Coolify](https://coolify.io) instance running on the operator's server. In Coolify it is the application `mesh-docs` in the project `mesh`, built from `https://github.com/svallory/mesh`, branch `main`, base directory `apps/docs`, build pack `dockerfile`. HTTPS is forced and the certificate is issued by Let's Encrypt through Coolify's Traefik proxy.

The build is defined in the repository, not in the Coolify UI: `apps/docs/Dockerfile` (an `oven/bun:1.3.14` stage that installs the docs app and runs `bun run build`, then an unprivileged `nginxinc/nginx-unprivileged` stage that serves `site/` on port 8080) plus `apps/docs/nginx.conf`. Both base images are pinned by version and `sha256` digest; bump the tag and the digest together. The Dockerfile installs the docs app on its own, not through the root workspace, because the root `bun.lock` references the local `link:` MX packages of `packages/compiler`, which a build container does not have. The image therefore has its own lockfile: `apps/docs/docker/package.json` and `apps/docs/docker/bun.lock`, installed with `bun install --frozen-lockfile`, so every dependency version is pinned. `bun run validate` fails when the docmd versions in that lockfile differ from `apps/docs/package.json`; after changing a docmd version, update `docker/package.json` to match and regenerate `docker/bun.lock` with `bun install` in a copy of `docker/` outside the workspace. The image build never sees the workspace root, so root-level `overrides`, `patchedDependencies` and `trustedDependencies` do not apply to it.

The application depends on these Coolify settings: build pack `dockerfile`, base directory `/apps/docs`, branch `main`, exposed port 8080, health check path `/` on port 8080, and watch paths `apps/docs/**`. Coolify stores the proxy labels when the application is created and does not regenerate them when the exposed port changes. After a port change, reset or edit the stored labels so they point at the new port; otherwise the proxy returns 502 even though the container is healthy.

A deploy is triggered automatically by a push to `main` that touches `apps/docs/**`: a GitHub webhook on the repository (push events) calls the Coolify webhook endpoint, and Coolify rebuilds and redeploys the application. The application's watch paths are set to `apps/docs/**`, so pushes that touch only other packages do not rebuild the site. A manual redeploy needs operator access: press **Redeploy** on the `mesh-docs` application in the operator's Coolify dashboard, or run `coolify deploy uuid <application-uuid>` with the `coolify` CLI and a Coolify API token.

Changes to `apps/docs/Dockerfile`, `apps/docs/nginx.conf`, `apps/docs/.dockerignore` or `apps/docs/docker/` take effect on the next deploy; test them first with `docker build apps/docs` from the repository root.
