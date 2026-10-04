---
title: "Contributing to these docs"
description: "How to add a page, a decision record or a research document, and how to build and preview the site."
---

# Contributing to these docs

The site is a [docmd](https://docmd.io) project in `apps/docs`. Pages are Markdown files. You do not need to know docmd to write one.

## Build and preview locally

Use Bun, never npm. From the repository root:

```bash
cd apps/docs
bun install
bun run dev        # live preview, default port 3000
bun run build      # static site into apps/docs/site/
bun run validate   # check internal links
```

Run `bun run build` and `bun run validate` before you open a pull request. Stop the dev server when you are done.

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
2. Add it to `navigation` in `apps/docs/docmd.config.json`. A page that is not listed is built but not shown in the sidebar.
3. Link to it from the folder's `index.md`.
4. Run `bun run build` and `bun run validate`.

## Add a decision record

1. Copy [the template](./decisions/_template.md) to `decisions/NNNN-short-title.md`, with the next free number.
2. Fill in every heading. Write "none" rather than deleting one.
3. Set the status to `Proposed`. Change it to `Accepted`, `Rejected` or `Superseded by NNNN` when it is settled; never delete a record.
4. Add it to `navigation` under **Decisions** and to the list in `decisions/index.md`.

## Add a research document

1. Create `research/topic.md`.
2. State the question, the date, and what was checked. Link every claim to its source. Check each claim against the source before you write it down.
3. Say what the research changed, and link the decision record if there is one.
4. Add it to `navigation` under **Research** and to `research/index.md`.

## Linking

Link to other pages with a relative path to the `.md` file, for example `./roadmap/index.md` from `architecture/index.md`. `bun run validate` checks these, including links inside code spans, so use real paths in examples. Do not use absolute URLs for pages in this site.
