# CLAUDE.md

**Mesh** is a Bun-only TypeScript framework: `.mesh.mx` entity file syntax v4 is parsed through closed MX contracts into a plain-data entity model (`:name` declares, `&name` refers, imported `Name` names another entity); `&` after a kind and inside expressions still wait on MX `lang-ext-syntax-table`, while round 2 (names/layout/runtime) and round 3 (generated functions) remain pending. [Entities](./apps/docs/docs/docs/entities.md) is the language reference; the production compiler never rewrites source or executes expressions.

## Layout

Bun workspace (`workspaces`: `packages/*`, `apps/*`, `examples/*`), one root `bun.lock`.
- `packages/compiler` (`@mesh/compiler`): closed v4 MX contracts, entity builder and legacy-layout emitters (`src/contracts.ts`, tests in `test/`)
- `packages/model` (`@mesh/model`): plain-data entity model, ten attribute types and four action types, diagnostic types; imports nothing
- `packages/runtime` (`@mesh/runtime`): scope, errors, Standard Schema input validation and data-layer contract v0; zero run-time dependencies; adapter conformance checks at `@mesh/runtime/testing`
- `packages/cli` (`@mesh/cli`): the Bun-only `mesh` developer command, a thin compiler shell; re-exports `defineConfig` for project configuration
- `packages/create-mesh` (`create-mesh`, public): the starter behind `bun create mesh`; today a placeholder bin that prints "Mesh is coming soon" and the site URL, published by the operator to reserve the name
- `apps/docs`: the docs site (docmd)
- `examples/blog`: example app, grows milestone by milestone
- `tsconfig.base.json`: shared strict config that packages extend (root `tsconfig.json` covers `scripts/`); `scripts/verify.ts`: the `verify` runner

## Commands

- MX is a separate project, published on `https://npm.saulo.tech`; the root `bunfig.toml` scopes `@mxlang` to that registry and `packages/compiler` depends on `@mxlang/core` and `@mxlang/data` by exact version (currently `0.1.0-alpha.11`, target `tree`, imports/comments supported; `@mxlang/tree-sitter-mx` stays at `0.1.0-alpha.2`). `bun install` at the repo root is all there is: no `bun link`, no token, no local MX checkout. `bun run verify` runs on GitHub Actions (`.github/workflows/verify.yml`) on every pull request and every push to `main`. To work against an unreleased MX commit, run `bun link` inside the MX checkout and temporarily point `packages/compiler`'s two `@mxlang` dependencies at `link:` (or at a `file:` path), then revert before committing; never commit a `link:` entry, and never run `bun link @mxlang/...` at the root, which writes a `link:` dependency into the root `package.json`.
- The MX packages are consumed from their published `dist` directories. `Cannot find module '@mxlang/data'` after a successful install means the installed version is broken or the scope entry was lost; check `bun.lock` for the `@mxlang` entries. Never build inside the MX checkout yourself.
- `bun run verify` runs every workspace package's `test`, `typecheck`, `build` and `validate` scripts (plus a type check for `scripts/`), including the docs build/link check, the blog generated-tree guard and generated-file type check, and compiler tests for the MX import boundary and complete MX fenced samples in `apps/docs/docs/docs/*.md` plus ADR-0050's reference. The Docs pages write **syntax v4** (`entity :Todo`, `belongs-to :list entity=List`, `input` with `&title`, `set` with `&done=true`). Docs checks report deferred 0: the unchanged test-only `normaliseV4` in `packages/compiler/test/repository-checks.ts` normalises unsupported member spellings, then uses a production-derived contract adapter that relaxes only member slots; tripwire tests prove those normalised slots are rejected by production contracts. Alpha.11 passes imports and comments under structural rejection; production never calls this adapter. Remove the bridge when MX's syntax table lands (decision 182 addendum 1). Before normalization, `checkDocsSyntaxV4` and `oldSpellingInV4` reject obsolete spellings, undeclared member heads, misplaced member lines, input assignments, unimported entity identifiers and `self.` without destructured self parameters in that function. This is a bounded text guard, not full contract/type checking; planted tests pin those failures. `apps/docs/plugins/mx-highlight.js` carries one counted allowance, `MX_V4_INPUT_PENDING_SYNTAX_TABLE`: alpha.2 treats `input` as an HTML void tag, so nested input sections and bare member lines get same-width stand-ins for highlighting only. Rendering always uses authored text. MX owns the permanent fix (`mesh-syntax-highlighting-route`); other grammar errors still fail the build. Verification exits non-zero and names the failed step. The full Todo copies (Introduction, Tutorial and Entities) are byte-identical after stripping figure annotations; the home is a deliberate shorter excerpt whose shared lines must match. Quick start now runs the starter's single List entity and contains no MX fence. `apps/docs` also type-checks every TypeScript sample on the Docs pages against `apps/docs/samples/mesh-api.d.ts`, the declarations of the proposed API; a fence titled `(excerpt)` is skipped. `bun run test` and `bun run typecheck` run one kind only. Run `verify` before a PR.
- With `@mesh/cli` installed, run `mesh build`, `mesh build --check`, `mesh inspect [resource]` or `mesh --help` from the project root containing `mesh.config.ts` (no upward search). After changing an entity file or an emitter, rebuild the committed example with `cd examples/blog && bunx mesh build` and commit `generated/` with the source change. The blog's workspace dependency on `@mesh/cli` supplies the local `mesh` command; for another project in this checkout, invoke it with `bun /absolute/path/to/packages/cli/src/bin.ts` from that project. Build never deletes files; move or delete stray output files yourself. The guard writes nothing and compares bytes, rejecting symlinks. Exit codes: 0 success, 1 build/config/guard errors, 2 usage errors.
- Docs site, from `apps/docs`: `bun run dev` (preview), `bun run build` (static site into `apps/docs/site/`), `bun run validate` (link check). How to add pages: `apps/docs/docs/architecture/contributing.md`.

## Rules

- The user-facing CLI package is `meshfw` (binary `mesh`, `defineConfig` import from `meshfw`); the starter is `create-mesh` (`bun create mesh todo-app`). Other framework packages remain `@meshfw/*`. This is the documented 1.0 naming, not a rename of today's M1 workspace packages. User docs write `mesh build` and other `mesh` commands; Quick start alone explains the `bunx mesh build` local-binary alternative.
- User docs separate `configuration.md` (project/context/adapters/environment) from `command-line.md` (commands/flags/exit codes). `using-your-domain.md` replaces the old Calling actions page. Framework integration snippets are explicitly `(excerpt)` fences; the sample checker counts exclusions dynamically rather than claiming they compile.
- `plugins/mx-figure.js` also injects site title/heading CSS and strips paired code backticks from docmd's known plain-text title labels at build time. It must not rewrite authored code blocks, URLs or escaping. `apps/docs/test/browser/docs-structure.mjs` checks the sidebar/home link, heading scale and title labels in both themes; it needs `SHOTS_DIR`, `SITE_DIR` and `PLAYWRIGHT_MODULE` (Playwright Docker), separately from `verify`.
- `typescript` and `@types/bun` are declared only in the root `package.json`; packages do not repeat them.
- Use bun, never npm.
- Always write "Mesh" (never "Mash").
- Architecture docs hold what cannot be understood from a single code file.
- The `@mxlang` scope resolves from `https://npm.saulo.tech`, the operator's read-only npm registry (no uplink);
  `bunfig.toml` points only that scope at it. `@mxlang/tree-sitter-mx` is what the docs site highlights `mx`
  with; a docs fix goes in `apps/docs/plugins/mx-highlight.js` (the docmd plugin, the capture-name palette)
  or goes to the MX lead as a grammar gap.
- `apps/docs/plugins/mx-highlight.js` is MX's highlighter's docmd plugin and not ours to fork: the grammar
  and the queries belong to MX. Change the palette only, except for the explicitly approved, tested,
  counted v4 input allowance above and `MESH_V4_MEMBER_RENDER`: a Mesh-side render-only overlay
  that colours operand/bare/sort `&name` heads as `ts-member`, leaving literals, comments and infix
  operators alone. Both bridges go away with `mesh-syntax-highlighting-route` (MX decision 182
  addendum 1). Do not patch the grammar or broaden either bridge silently.
- Home token explanations live in `apps/docs/plugins/mesh-home-hints.js`, wired by `mesh-home.js`.
  Keep descriptions outside the code so copying and the home-sample hash retain the authored file;
  every token in the fixed excerpt is checked against the commissioned wording. Each note has a shared
  family sentence followed by optional context; inline fragments use `mxHighlighter` at build time
  (TypeScript through its injection grammar), never a browser highlighter. Reference tokens name
  scoped targets for a single dashed SVG connector and outline. Keyboard navigation has one tab stop
  per nonblank line, with Left/Right and Home/End within it. Mutation/resize observers run only while
  a note is open; the panel is re-created after body replacement. Browser interactions and screenshots
  are exercised by `apps/docs/test/browser/home-hints.mjs` in Playwright's Docker image, separately
  from `bun run verify` (see the script header for its environment variables; screenshots default
  under `os.tmpdir()`, not the checkout).
- docmd 0.9.7 reads a raw HTML block until its tags balance, blank lines included, so Markdown (a fence
  above all) inside an open `<div>` is emitted as raw text. Wrap fences in a docmd container (`::: grids`)
  instead, and keep each HTML block self-contained. docmd also hides `<html>` until its theme script runs;
  `plugins/mx-figure.js` adds the `<noscript>` rule that keeps the site readable without JavaScript.
