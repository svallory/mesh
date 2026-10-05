# CLAUDE.md

**Mesh** is a planned TypeScript framework modelled on Ash (Elixir): one entity file (`.mesh.mx`, entity file syntax v2) declares data, actions and rules, and Mesh derives types, handlers and schema from it. It runs on Bun only. The code on `main` still uses the M1 names (`resource`, Ash-style tags, `generated/`, `scope`, `@mesh/*`) until the realignment task; the design and its decision records are in `apps/docs/docs/architecture/` (ADR-0049 to ADR-0065 for the rulings of 2026-10-04/05). All development is on hold until the operator approves the user docs (ADR-0063).

## Layout

Bun workspace (`workspaces`: `packages/*`, `apps/*`, `examples/*`), one root `bun.lock`.
- `packages/compiler` (`@mesh/compiler`): MX tag contracts for the resource vocabulary (`src/contracts.ts`, tests in `test/`)
- `packages/model` (`@mesh/model`): plain-data resource model, attribute-type and action-type registries, diagnostic type; imports nothing
- `packages/runtime` (`@mesh/runtime`): scope, errors, Standard Schema input validation and data-layer contract v0; zero run-time dependencies; adapter conformance checks at `@mesh/runtime/testing`
- `packages/cli` (`@mesh/cli`): the Bun-only `mesh` developer command, a thin compiler shell; re-exports `defineConfig` for project configuration
- `apps/docs`: the docs site (docmd)
- `examples/blog`: example app, grows milestone by milestone
- `tsconfig.base.json`: shared strict config that packages extend (root `tsconfig.json` covers `scripts/`); `scripts/verify.ts`: the `verify` runner

## Commands

- MX is a separate project. Register a local MX checkout once with `bun link` inside it; then `bun install` at the repo root resolves the `link:` deps in `packages/compiler/package.json` (verified in a fresh clone, no per-clone link step). Never run `bun link @mxlang/data @mxlang/core` at the root: `bun link <pkg>` writes a `link:` dependency into the `package.json` of the directory it runs in.
- The linked MX packages are consumed from their built `dist` directories. `Cannot find module '@mxlang/data'` after a successful install means the MX link checkout may not be built; ask the MX maintainers to fix it. Never build inside the MX checkout yourself.
- `bun run verify` runs every workspace package's `test`, `typecheck`, `build` and `validate` scripts (plus a type check for `scripts/`), including the docs build/link check, the blog generated-tree guard and generated-file type check, and compiler tests for the MX import boundary and complete MX fenced samples in `apps/docs/docs/docs/*.md`. The Docs pages write entity file **syntax v2** (`entity #Todo`, `belongs-to=List #list`, `check :label [ … ]`, `.mesh.mx`), which the contracts cannot parse yet: every complete v2 block has its contracts parse deferred under one named reason (`syntax v2, pending the rename task`, counted and printed) and is instead parsed with `parseData` and no contracts after an in-memory normalisation of the spellings MX does not parse yet (`kind #name` glued, `:label` dropped) — see `packages/compiler/test/repository-checks.ts`. `apps/docs/test/docs-mx-syntax.test.ts` is the stricter companion and fails a fence whose root is not `entity #Name`. It exits non-zero and names the failed step. `apps/docs` also type-checks every TypeScript sample on the Docs pages against `apps/docs/samples/mesh-api.d.ts`, the declarations of the proposed API; a fence titled `(excerpt)` is skipped. `bun run test` and `bun run typecheck` run one kind only. Run `verify` before a PR.
- With `@mesh/cli` installed, run `mesh build`, `mesh build --check`, `mesh inspect [resource]` or `mesh --help` from the project root containing `mesh.config.ts` (no upward search). After changing a resource file or an emitter, rebuild the committed example with `cd examples/blog && bunx mesh build` and commit `generated/` with the source change. The blog's workspace dependency on `@mesh/cli` supplies the local `mesh` command; for another project in this checkout, invoke it with `bun /absolute/path/to/packages/cli/src/bin.ts` from that project. Build never deletes files; move or delete stray output files yourself. The guard writes nothing and compares bytes, rejecting symlinks. Exit codes: 0 success, 1 build/config/guard errors, 2 usage errors.
- Docs site, from `apps/docs`: `bun run dev` (preview), `bun run build` (static site into `apps/docs/site/`), `bun run validate` (link check). How to add pages: `apps/docs/docs/architecture/contributing.md`.

## Rules

- `typescript` and `@types/bun` are declared only in the root `package.json`; packages do not repeat them.
- Use bun, never npm.
- Always write "Mesh" (never "Mash").
- Architecture docs hold what cannot be understood from a single code file.
- The `@mxlang` scope resolves from `https://npm.saulo.tech`, the operator's read-only npm registry (no uplink);
  `bunfig.toml` points only that scope at it. `@mxlang/tree-sitter-mx` is what the docs site highlights `mx`
  with; a docs fix goes in `apps/docs/plugins/mx-highlight.js` (the docmd plugin, the capture-name palette)
  or goes to the MX lead as a grammar gap.
- `apps/docs/plugins/mx-highlight.js` is MX's highlighter's docmd plugin and not ours to fork: the grammar
  and the queries belong to MX, so the only thing a docs change may touch here is the palette.
