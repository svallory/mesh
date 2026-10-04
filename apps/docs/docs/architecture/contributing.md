---
title: "Contributing to these docs"
description: "How to add a page, a decision record or a research document, and how to build and preview the site."
---

# Contributing to these docs

The site is a [docmd](https://docmd.io) project in `apps/docs`. Pages are Markdown files. You do not need to know docmd to write one.

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
