# CLAUDE.md

**Mesh** is a planned TypeScript framework modelled on Ash (Elixir): one `.mx` resource file declares data, actions and rules, and Mesh derives types, handlers and schema from it. It runs on Bun only.

## Layout

Bun workspace (`workspaces`: `packages/*`, `apps/*`, `examples/*`), one root `bun.lock`.
- `packages/compiler` (`@mesh/compiler`): MX tag contracts for the resource vocabulary (`src/contracts.ts`, tests in `test/`)
- `packages/model` (`@mesh/model`): plain-data resource model, attribute-type and action-type registries, diagnostic type; imports nothing
- `packages/cli` (`@mesh/cli`): the Bun-only `mesh` developer command, a thin compiler shell; re-exports `defineConfig` for project configuration
- `apps/docs`: the docs site (docmd)
- `examples/blog`: example app, grows milestone by milestone
- `tsconfig.base.json`: shared strict config that packages extend (root `tsconfig.json` covers `scripts/`); `scripts/verify.ts`: the `verify` runner

## Commands

- MX is a separate project. Register a local MX checkout once with `bun link` inside it; then `bun install` at the repo root resolves the `link:` deps in `packages/compiler/package.json` (verified in a fresh clone, no per-clone link step). Never run `bun link @mxlang/data @mxlang/core` at the root: `bun link <pkg>` writes a `link:` dependency into the `package.json` of the directory it runs in.
- The linked MX packages are consumed from their built `dist` directories. `Cannot find module '@mxlang/data'` after a successful install means the MX link checkout may not be built; ask the MX maintainers to fix it. Never build inside the MX checkout yourself.
- `bun run verify` runs every package's tests, type check (plus one for `scripts/`), and the docs build and link check; it exits non-zero and names the failed step. `bun run test` and `bun run typecheck` run one kind only. Run `verify` before a PR.
- With `@mesh/cli` installed, run `mesh build`, `mesh build --check`, `mesh inspect [resource]` or `mesh --help` from the project root containing `mesh.config.ts` (no upward search). In this checkout, invoke the command with `bun /absolute/path/to/packages/cli/src/bin.ts` from the target project. Build never deletes files; move or delete stray output files yourself. The guard writes nothing and compares bytes, rejecting symlinks. Exit codes: 0 success, 1 build/config/guard errors, 2 usage errors.
- Docs site, from `apps/docs`: `bun run dev` (preview), `bun run build` (static site into `apps/docs/site/`), `bun run validate` (link check). How to add pages: `apps/docs/docs/architecture/contributing.md`.

## Rules

- `typescript` and `@types/bun` are declared only in the root `package.json`; packages do not repeat them.
- Use bun, never npm.
- Always write "Mesh" (never "Mash").
- Architecture docs hold what cannot be understood from a single code file.
