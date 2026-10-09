# CLAUDE.md

**Mesh** is a Bun-only TypeScript framework. The compiler parses `.mesh.mx` entity file syntax v4 through closed MX contracts into a plain-data entity model. `:name` declares, `&name` refers, and an imported `Name` names another entity. MX lowers `&name` in every position through Mesh's syntax module (`packages/compiler/src/syntax.ts`). The production compiler never rewrites source or executes expressions.

The emitters write per-entity types and validators plus `model.json`; they emit no `index.ts` or action functions, and no code performs data access (adapters are descriptors). [Entities](./apps/docs/docs/docs/entities.md) is the language reference; [the decision records](./apps/docs/docs/architecture/decisions/0049-vocabulary-is-meshs-own.md), starting at ADR-0049, explain the design.

## Layout

Bun workspace (`workspaces`: `packages/*`, `apps/*`, `examples/*`), one root `bun.lock`.
- `packages/compiler` (`@meshfw/compiler`): closed v4 MX contracts (`src/contracts.ts`), Mesh's `&` syntax module (`src/syntax.ts`, exported as the frozen `MESH_SYNTAX`), entity builder and type/validator emitters (tests in `test/`). `parseEntitySource` in `src/build.ts` is the one `parseData` call: contracts, `syntax: MESH_SYNTAX`, `structural`/`unknownTags: "reject"`, `imports: "pass"`; the test helper and the docs checks use it too (two unit tests, `test/syntax.test.ts` and `test/tree.test.ts`, call `parseData` with only `MESH_SYNTAX` on purpose, to pin the lowered shapes without contracts)
- `packages/model` (`@meshfw/model`): plain-data entity model, ten attribute types and four action types, diagnostic types; imports nothing
- `packages/runtime` (`@meshfw/runtime`): flat, project-augmented `ActionContext`, errors, Standard Schema input validation, `DataAdapter` descriptors and data-layer contract v0; zero run-time dependencies; adapter conformance checks at `@meshfw/runtime/testing`
- `packages/data-sqlite` (`@meshfw/data-sqlite`, private): `sqlite({ file })` returns a frozen descriptor only; it has no connection and no `createSchema`
- `packages/cli` (`meshfw`): the Bun-only `mesh` developer command, a thin compiler shell; re-exports `defineConfig` for project configuration
- `packages/create-mesh` (`create-mesh`, public): the starter behind `bun create mesh`; today a placeholder bin that prints "Mesh is coming soon" and the site URL, published by the operator to reserve the name
- `apps/docs`: the docs site (docmd)
- `examples/blog` (`blog-example`, private): entity files under `src/domain/blog/`, committed output under `.mesh/`; `#mesh` maps to `.mesh/index.ts`, which the emitters do not write, so nothing imports it
- `tsconfig.base.json`: shared strict config that packages extend (root `tsconfig.json` covers `scripts/`); `scripts/verify.ts`: the `verify` runner

## Commands

- MX is a separate project, published on `https://npm.saulo.tech`; the root `bunfig.toml` scopes `@mxlang` to that registry and `packages/compiler` depends on `@mxlang/core` and `@mxlang/data` by exact version (currently `0.1.0-alpha.13`, target `tree`; `@mxlang/tree-sitter-mx` stays at `0.1.0-alpha.2`). Alpha.13 lowers `&` through a syntax module passed as `parseData`'s `syntax` option: an expression member is a `self.x` `MemberExpression` marked `extra.mxMember`, a member after a kind is `DataAttr { kind: "member" }`, a tagless `&x`/`&x=v` line is a `member` child tag, and contracts can declare `type: "member"`. Imports arrive parsed (`DataImport.from`/`names`; names carry no span yet). The tarball ships `dist/` only: `src/syntax.ts` is a copy of MX's test-only `packages/core/src/fixtures/syntax/member-syntax.ts` (MX commit `bc9a87c6c`) with `productName: "Mesh"`; keep it in step with MX's module when the pin moves. Members are read from those shapes only, never from `DataExpr.code` (printed `self.x`); authored text is the source sliced at `DataExpr.span`. `bun install` at the repo root is all there is: no `bun link`, no token, no local MX checkout. `bun run verify` runs on GitHub Actions (`.github/workflows/verify.yml`) on every pull request and every push to `main`. To work against an unreleased MX commit, run `bun link` inside the MX checkout and temporarily point `packages/compiler`'s two `@mxlang` dependencies at `link:` (or at a `file:` path), then revert before committing; never commit a `link:` entry, and never run `bun link @mxlang/...` at the root, which writes a `link:` dependency into the root `package.json`.
- The MX packages are consumed from their published `dist` directories. `Cannot find module '@mxlang/data'` after a successful install means the installed version is broken or the scope entry was lost; check `bun.lock` for the `@mxlang` entries. Never build inside the MX checkout yourself.
- `bun run verify` runs every workspace package's `test`, `typecheck`, `build` and `validate` scripts (plus a type check for `scripts/`), including the docs build/link check, the blog generated-tree guard and generated-file type check, and compiler tests for the MX import boundary and complete MX fenced samples in `apps/docs/docs/docs/*.md` plus ADR-0050's reference. The Docs pages write **syntax v4** (`entity :Todo`, `belongs-to :list entity=List`, `input` with `&title`, `set` with `&done=true`). Docs checks report entity files checked and findings. Docs fences parse as authored through `parseEntitySource`; no normalisation or relaxed contracts. Before parsing, `checkDocsSyntaxV4` and `oldSpellingInV4` reject obsolete spellings, undeclared member heads, unimported entity identifiers and `self.` without destructured self parameters in that function; misplaced member lines and input assignments are parse errors. This is a bounded text guard, not full contract/type checking; planted tests pin those failures. `apps/docs/plugins/mx-highlight.js` carries one counted allowance, `MX_V4_INPUT_PENDING_SYNTAX_TABLE`: alpha.2 treats `input` as an HTML void tag, so nested input sections and bare member lines get same-width stand-ins for highlighting only. Rendering always uses authored text. MX owns the permanent fix (`mesh-syntax-highlighting-route`); both highlighter allowances stay until `@mxlang/tree-sitter-mx` moves past alpha.2, even though the parser pin no longer needs bridging. Other grammar errors still fail the build. Verification exits non-zero and names the failed step. The full Todo copies (Introduction, Tutorial and Entities) are byte-identical after stripping figure annotations; the home is a deliberate shorter excerpt whose shared lines must match. Quick start now runs the starter's single List entity and contains no MX fence. `apps/docs` also type-checks every TypeScript sample on the Docs pages against `apps/docs/samples/mesh-api.d.ts`, the declarations of the proposed API; a fence titled `(excerpt)` is skipped. `bun run test` and `bun run typecheck` run one kind only. Run `verify` before a PR.
- With `meshfw` installed, run `mesh build`, `mesh build --check`, `mesh inspect [entity]` or `mesh --help` from the project root containing `mesh.config.ts` (no upward search). After changing an entity file or an emitter, rebuild the committed example with `cd examples/blog && bunx mesh build` and commit `.mesh/` with the source change. The blog's workspace dependency on `meshfw` supplies the local `mesh` command; for another project in this checkout, invoke it with `bun /absolute/path/to/packages/cli/src/bin.ts` from that project. Build never deletes files; move or delete stray output files yourself. The guard writes nothing and compares bytes, rejecting symlinks. Exit codes: 0 success, 1 build/config/guard errors, 2 usage errors.
- `defineConfig` requires `domain`, `output` and `data`; extensions are optional objects with a `name` string. A folder's path is the domain root; a glob uses its static directory prefix, and a file list its common parent. Entity modules are relative parent paths (`sales/billing`, or empty at the domain root); module segments permit letters, digits, `-` and `_`. Adapter options never enter `model.json`; only the adapter name does. The compiler's runtime-reference test emits real `.d.ts` and checks the documented runtime members against them without changing `apps/docs/samples/mesh-api.d.ts`.
- Docs site, from `apps/docs`: `bun run dev` (preview), `bun run build` (static site into `apps/docs/site/`), `bun run validate` (link check). How to add pages: `apps/docs/docs/architecture/contributing.md`.

## Rules

- The user-facing CLI package is `meshfw` (binary `mesh`, `defineConfig` import from `meshfw`); the starter is `create-mesh` (`bun create mesh todo-app`). Other framework packages remain `@meshfw/*`. These are the workspace package names and the documented 1.0 naming. User docs write `mesh build` and other `mesh` commands; Quick start alone explains the `bunx mesh build` local-binary alternative.
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
