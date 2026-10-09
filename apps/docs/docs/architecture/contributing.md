---
title: "Contributing to these docs"
description: "How to add a page, a decision record or a research document, and how to build and preview the site."
---

# Contributing to these docs

The site is a [docmd](https://docmd.io) project in `apps/docs`. Pages are Markdown files. You do not need to know docmd to write one.

## Two sections, two rules

**Docs** is for people who will use Mesh. **Architecture** is for contributors: what cannot be understood by looking at a single code file.

**Docs** is written as if Mesh 1.0 were released. There is no "exists today", no milestone number, no "not decided yet" callout and no link to a decision record in the flow of a page. Every Docs page carries one short callout, identical on every page:

```markdown
::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::
```

The same line on every page is deliberate: a per-page reworded warning is what made the earlier pages contradict each other.

**Architecture** documents everything else, in particular what a Docs page could not say. If a change adds a contract, a pipeline stage or a cross-package rule, its Architecture page is updated in the same pull request.

Where a decision is Proposed or open, a page takes the option the decision record recommends and never picks silently. Where nothing is decided at all, design the simplest thing a TypeScript developer would expect, write it into the page, and record it on [Open questions and findings](./open-questions.md) with the alternative you rejected: that list is the most valuable output of the work. Anything the Docs pages removed as "not decided", and every point where writing a page forced an invention, belongs on [Open questions and findings](./open-questions.md) with the record it touches. A contributor-only page may also say what exists today; a user page may not.

The practice: **user docs are written first, in the 1.0 voice, and the code follows them or changes them in the same pull request** ([ADR-0063](./decisions/0063-user-docs-first-and-the-hold.md)). A pull request that adds behaviour adds or edits the Docs page for it. A pull request that finds the page wrong changes the page and the design together, or records on the open-questions page that the page is now wrong and why.

The reason is that writing the page is a test of the design. A page that has to say "the architecture does not say what this command is called" has found a gap; a page that has to contradict two architecture pages has found a contradiction. Neither shows up by reading the architecture.

## The hold, and who decides

The hold on development ([ADR-0063](./decisions/0063-user-docs-first-and-the-hold.md)) was lifted on 2026-10-09, when the operator approved the user docs. The move to the documented names was merged in PR #47 and PR #48 on 2026-10-09; the Jig port and M2 follow ([ADR-0064](./decisions/0064-order-of-work-after-approval.md); [roadmap](./roadmap/roadmap.md)).

- The **operator** (the project owner) rules on design. On 2026-10-05 he delegated every open decision to the **lead**.
- The **lead** decides what is delegated and records it. Contributors never ask the operator; questions go to the lead.
- Every decision is a record under [Decisions](./decisions/index.md). Past records are never rewritten: a changed decision gets a new record, and the old one is marked Superseded or Amended with one line linking its successor.
- Where a decision is open and you need an answer to write a page, take the simplest consistent option, write it, and list it on [open questions and findings](./open-questions.md) with the alternative.

## What the checks enforce

The sample checks run in `bun run verify`:

- **Complete `.mx` samples** are checked by `packages/compiler/test/repository-checks.ts` and its stricter companion, `apps/docs/test/docs-mx-syntax.test.ts`. Both scan the user pages and ADR-0050's reference. For legacy fixtures only, the contracted path rewrites `entity=` to `resource=`; that is not the syntax-v4 path.
- **Syntax v4 samples** (`entity :Todo`, `&title`, imported entities) first pass a bounded text guard: obsolete spellings, undeclared member heads, unimported `entity=X` values and unbound `self.` reads fail. Then each fence parses as authored through the compiler's own parse: `parseData` with the production contracts, Mesh's `&` syntax module (`packages/compiler/src/syntax.ts`), `structural: "reject"`, `unknownTags: "reject"` and `imports: "pass"`. Misplaced member lines and assignments in `input` are parse errors. The check prints the entity files checked and the findings. This guard is not full contract/type checking.
- **MX highlighting** has one named, counted allowance, `MX_V4_INPUT_PENDING_SYNTAX_TABLE`: alpha.2 treats nested `input` as an HTML void tag, so same-width stand-ins let it parse while the renderer keeps the authored text. Other grammar errors still fail the build. [MX integration](./in-depth/mx-integration.md) records both bridges and the MX items that remove them.
- **TypeScript samples** are type-checked by `apps/docs/test/docs-samples.test.ts` against `apps/docs/samples/mesh-api.d.ts`, the declarations of the API the pages describe. Every `ts` block must be a complete file: it declares what it uses and its calls match the documented signatures. A fence titled `excerpt` is a signature shown in prose and is not compiled.

None of these checks runs a sample. They are not a claim that Mesh exists as a runtime.

## Build and preview locally

Use Bun, never npm. The repository is a Bun workspace, so install once at the repository root. The docs site's scripts run from `apps/docs`:

```bash
bun install        # at the repository root
cd apps/docs
bun run dev        # live preview, default port 3000
bun run build      # static site into apps/docs/site/
bun run validate   # check internal links
```

A docmd plugin that `docmd.config.json` enables must also be declared in `apps/docs/package.json` (for example `@docmd/plugin-search`), or docmd shells out to npm at build time because it does not recognise Bun's text `bun.lock`. The `ai` plugin is a docmd core plugin that is auto-loaded on every build; `"ai": false` in `plugins` opts out of it, which is why this site has no floating assistant bar.

Run `bun run build` and `bun run validate` before you open a pull request. From the repository root, `bun run verify` runs them together with the tests and the type check. Stop the dev server when you are done.

## What exists today

This section is for contributors. Nothing under [Docs](../docs/index.md) says any of it, because those pages are written as if 1.0 were released.

- **`packages/compiler`** (`@meshfw/compiler`) holds the closed entity tag contracts for entity files (`src/contracts.ts`), the loader, the model builder and the `types` and `validators` emitters. Its tests include the Docs `.mx` sample check described above.
- **`packages/model`** holds the plain-data entity model: fields, actions, relationships, the type registries and the diagnostic type. It imports nothing.
- **`packages/runtime`** holds the run-time library generated code will import: the flat, project-augmented `ActionContext` (the second argument's type), the errors (`MeshError`, `InvalidInputError`, `NotFoundError(entity, key)`, and `ForbiddenError` with its `breakdown`, built on the documented `Issue`), Standard Schema input validation, the `DataAdapter` descriptors and the data-layer contract v0, with conformance checks under its `testing` entry. It has no run-time dependencies.
- **`packages/cli`** (`meshfw`) holds the Bun-only `mesh` developer command, still a thin compiler shell. It re-exports `defineConfig`, which takes `{ domain, output, data, extensions? }`.
- **`packages/data-sqlite`** (`@meshfw/data-sqlite`, private) returns a frozen `sqlite({ file })` descriptor; it opens no connection until M2.
- **`packages/create-mesh`** (`create-mesh`) is the starter behind `bun create mesh`; today a placeholder bin that prints "Mesh is coming soon".
- **`examples/blog`** is the fixture project: entity files under `src/domain/blog/`. `mesh build` there writes `.mesh/` (`model.json` and the `types` and `validators` files per entity), which is committed. `.mesh/index.ts`, which `#mesh` maps to, is not written yet, so nothing imports it.
- **`apps/docs`** is this site.

From the repository root:

```bash
bun install        # at the repository root; the @mxlang scope resolves from the registry
bun run verify      # every package's tests, type check, build and validate, plus the docs checks
bun run test        # tests only
bun run typecheck   # type checks only
```

`bun install` at the repository root is all there is. The compiler's two MX dependencies, `@mxlang/core` and `@mxlang/data`, are pinned to an exact version and installed from the registry; there is no `bun link` step, no local MX checkout and no token. The install and `bun run verify` are also what a GitHub Actions run does for every pull request and every push to `main`; see [Continuous integration](#continuous-integration).

To work against an MX commit that is not published yet — the MX lead's own workflow, and useful when a change to MX has to land in Mesh the same day — run `bun link` inside the MX checkout once, then point the two `@mxlang` dependencies in `packages/compiler/package.json` at `link:@mxlang/core` and `link:@mxlang/data` and run `bun install`. That edit is local and never committed: a committed `link:` entry breaks every machine that has no MX checkout, including the CI runner. Revert it and re-run `bun install` before you commit or push. Never run `bun link @mxlang/...` at the repository root: `bun link <package>` writes a `link:` dependency into the `package.json` of the directory it runs in.

To try the example:

```bash
cd examples/blog
mesh build
```

With `meshfw` installed, the command runs from the project root containing `mesh.config.ts`, with no upward search. For another project in this checkout, invoke it as `bun /absolute/path/to/packages/cli/src/bin.ts` from that project. `mesh build` never deletes files; move stray output yourself. Exit codes: `0` success, `1` build, configuration or guard errors, `2` usage errors.

## Vocabulary and what is pending

The Docs pages, the Architecture section and the code use the same terms and the entity syntax (`entity`, `.mesh.mx`, modules under `src/domain/`, `.mesh/` imported as `#mesh`, the `ActionContext`, `@meshfw/*`); PR #47 and PR #48 (merged 2026-10-09) brought the code there. What is pending is the remaining emitters (the action functions, `index.ts` and the rest) and MX's lowering of the `&` member positions; see the [roadmap](./roadmap/roadmap.md). Architecture pages that describe design the code does not implement yet say so once, in a callout at the top.

The [Ash-to-Mesh mapping](./roadmap/vocabulary-mapping.md) section 3 is in the current spelling, and a compiler test reads that table.

## Code highlighting

`mx` fences are highlighted by MX's own highlighter: the published
`@mxlang/tree-sitter-mx` package with its `queries/highlights.scm` and `queries/injections.scm`, run at
build time through `web-tree-sitter` 0.26.9, which the package depends on. TypeScript inside an MX file (a
function body, an attribute value) is injected and highlighted with the TypeScript grammar, so a lambda
in a `check` is coloured the same way the `ts` fence above it is. Every other language is highlighted by
docmd itself, with highlight.js and the light and dark stylesheets docmd ships
([ADR-0065](./decisions/0065-mx-highlighting-on-the-docs-site.md)).

Two files, two jobs:

- `@mxlang/tree-sitter-mx` is the highlighter: the grammar, the two query files and the TypeScript
  grammar the injections need. It comes from the registry, not from this repository, so there is nothing
  here to edit and nothing to refresh. To change a colour, change the `PALETTE` table in
  `apps/docs/plugins/mx-highlight.js`; to change what is coloured, that is the MX lead's
  `queries/*.scm`. A new capture name in a new package version shows up as a failing test until the
  table decides it.
- `apps/docs/plugins/mx-highlight.js` is the docmd plugin and the only entry point for `mx`. It routes
  the fences, it fails the build with the page and the line when a fence cannot be highlighted, and it
  holds the `PALETTE` table that maps each capture name to the light and dark colours docmd's own
  highlight stylesheets use for the other languages, so an `mx` block sits beside a `ts` block without
  a seam.

`mx-figure` fences (the annotated figure on the Introduction page) go through the same highlighter.
The figure is one entity file cut into segments, so it is parsed once as a whole file and each segment
reads its own lines out of the result: a segment that starts at an indented `attributes` tag is not a
document on its own and would colour as nothing.

A fence is read as a whole file, so a line the grammar cannot read would leave the lines below it
uncoloured. It does not get that far: the grammar reports such a line as an ERROR node, and a block with
one fails the build like any other bad fence, naming the page, the line of the fence and the line inside
it. The case that comes up is the language's own rule, not a fault: in concise syntax a line at the left
margin ends the root tag's block, a comment included, so a comment inside an entity is indented with the
block it sits in (`[Entities](../docs/entities.md)` says so where it explains the shape of a file). The
annotated figure's `// @key:` lines are the figure's own notation rather than part of the entity file,
and the figure renderer blanks them before it parses, which is also what keeps them from ending the
entity where they are written.

## Dependencies and the registry

The `@mxlang` scope resolves from `https://npm.saulo.tech`, the operator's own npm registry. The
repository's `bunfig.toml` says so, once:

```toml
[install.scopes]
"@mxlang" = "https://npm.saulo.tech"
```

It is read-only for everyone and has no uplink to the public registry, so an `@mxlang` version that is
not published there cannot be installed by accident, and nothing outside the `@mxlang` scope is resolved
from it: every other package comes from the default registry. `@mxlang/core` and `@mxlang/data` are
published there as pre-release versions, and `packages/compiler` depends on them by exact version (no
range, so a new pre-release is never pulled in silently). `bun.lock` records the registry URL and the
integrity hash of each tarball, which is what lets `bun install --frozen-lockfile` reproduce the
install without asking the registry for a version range, on this machine and on a CI runner.

The docs Docker image is the one place that needs the entry twice: it builds from `apps/docs` and never
sees the repository root, so `apps/docs/docker/bunfig.toml` repeats the same two lines, and the
Dockerfile copies it next to the manifest it installs from. The two lockfiles — the workspace's and
`apps/docs/docker/bun.lock` — record the registry URL and the integrity hash of the package, so an
install from either is reproducible without asking the registry for a version range.

## Continuous integration

`.github/workflows/verify.yml` runs `bun run verify` on GitHub Actions, on every pull request and on
every push to `main`. One job on `ubuntu-latest`: check out the repository, install Bun 1.3.14 (the
version `package.json#packageManager` pins), `bun install --frozen-lockfile`, `bun run verify`. The
same script contributors run locally is the whole check; nothing in it needs a browser or a Docker
daemon, so nothing is skipped or split out on the runner.

What the workflow deliberately does not do:

- **No secrets.** Every dependency resolves either from the public registry or from `https://npm.saulo.tech`,
  which is read-only for everyone. If that registry ever needs a token, the workflow does not have one and
  the fix is a public read for the `@mxlang` scope, not a stored credential.
- **Least privilege.** `permissions: contents: read`, and `persist-credentials: false` on the checkout, so the
  job's token is not written into the git config for a later step to pick up.
- **Actions pinned by commit SHA**, with the version in a comment, so a moved tag cannot change what runs.
  A bump is a one-line comment change plus a new SHA.
- **`--frozen-lockfile`**, which fails if `bun.lock` would change: a pull request cannot pass CI on a
  lockfile it forgot to commit.
- **Concurrency cancellation.** One run per ref; a newer push cancels the run it supersedes, so a branch
  with five pushes does not queue five full installs.

ADR-0031 recorded why this file did not exist: the `@mxlang` packages came from a `link:` checkout a
hosted runner cannot have. They are published now, which is what removed the blocker.

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

The site is deployed at <https://mesh.hyperlab.sh> (the former address, <https://mesh.saulo.tech>, redirects there permanently; the rule is in `apps/docs/nginx.conf`) by a [Coolify](https://coolify.io) instance running on the operator's server. In Coolify it is the application `mesh-docs` in the project `mesh`, built from `https://github.com/svallory/mesh`, branch `main`, base directory `apps/docs`, build pack `dockerfile`. HTTPS is forced and the certificate is issued by Let's Encrypt through Coolify's Traefik proxy.

The build is defined in the repository, not in the Coolify UI: `apps/docs/Dockerfile` (an `oven/bun:1.3.14` stage that installs the docs app and runs `bun run build`, then an unprivileged `nginxinc/nginx-unprivileged` stage that serves `site/` on port 8080) plus `apps/docs/nginx.conf`. Both base images are pinned by version and `sha256` digest; bump the tag and the digest together. The Dockerfile installs the docs app on its own, not through the root workspace, because the deployment builds from `apps/docs` alone (Coolify's base directory) and the build context never contains the repository root. The image therefore has its own lockfile: `apps/docs/docker/package.json` and `apps/docs/docker/bun.lock`, installed with `bun install --frozen-lockfile`, so every dependency version is pinned. `bun run validate` fails when the docmd versions in that lockfile differ from `apps/docs/package.json`; after changing a docmd version, update `docker/package.json` to match and regenerate `docker/bun.lock` with `bun install` in a copy of `docker/` outside the workspace. The image build never sees the workspace root, so root-level `overrides`, `patchedDependencies` and `trustedDependencies` do not apply to it, and it repeats the `@mxlang` scope entry in `apps/docs/docker/bunfig.toml`.

The application depends on these Coolify settings: build pack `dockerfile`, base directory `/apps/docs`, branch `main`, exposed port 8080, health check path `/` on port 8080, and watch paths `apps/docs/**`. Coolify stores the proxy labels when the application is created and does not regenerate them when the exposed port changes. After a port change, reset or edit the stored labels so they point at the new port; otherwise the proxy returns 502 even though the container is healthy.

A deploy is triggered automatically by a push to `main` that touches `apps/docs/**`: a GitHub webhook on the repository (push events) calls the Coolify webhook endpoint, and Coolify rebuilds and redeploys the application. The application's watch paths are set to `apps/docs/**`, so pushes that touch only other packages do not rebuild the site. A manual redeploy needs operator access: press **Redeploy** on the `mesh-docs` application in the operator's Coolify dashboard, or run `coolify deploy uuid <application-uuid>` with the `coolify` CLI and a Coolify API token.

Changes to `apps/docs/Dockerfile`, `apps/docs/nginx.conf`, `apps/docs/.dockerignore` or `apps/docs/docker/` take effect on the next deploy; test them first with `docker build apps/docs` from the repository root.
