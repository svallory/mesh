# CLAUDE.md

**Mesh** is a planned TypeScript framework modelled on Ash (Elixir): one `.mx` resource file declares data, actions and rules, and Mesh derives types, handlers and schema from it. It runs on Bun only.

## Layout

Bun workspace (`workspaces`: `packages/*`, `apps/*`, `examples/*`), one root `bun.lock`.
- `packages/compiler` (`@mesh/compiler`): MX tag contracts for the resource vocabulary (`src/contracts.ts`, tests in `test/`)
- `packages/model` (`@mesh/model`): plain-data resource model, attribute-type and action-type registries, diagnostic type; imports nothing
- `apps/docs`: the docs site (docmd)
- `examples/blog`: example app, grows milestone by milestone
- `tsconfig.base.json`: shared strict config that packages extend (root `tsconfig.json` covers `scripts/`); `scripts/verify.ts`: the `verify` runner

## Commands

- MX is a separate project. Register a local MX checkout once with `bun link` inside it; then `bun install` at the repo root resolves the `link:` deps in `packages/compiler/package.json` (verified in a fresh clone, no per-clone link step). Never run `bun link @mxlang/data @mxlang/core` at the root: `bun link <pkg>` writes a `link:` dependency into the `package.json` of the directory it runs in.
- `bun run verify` runs every package's tests, type check (plus one for `scripts/`), and the docs build and link check; it exits non-zero and names the failed step. `bun run test` and `bun run typecheck` run one kind only. Run `verify` before a PR.
- Docs site, from `apps/docs`: `bun run dev` (preview), `bun run build` (static site into `apps/docs/site/`), `bun run validate` (link check). How to add pages: `apps/docs/docs/architecture/contributing.md`.

## Rules

- `typescript` and `@types/bun` are declared only in the root `package.json`; packages do not repeat them.
- Use bun, never npm.
- Always write "Mesh" (never "Mash").
- Architecture docs hold what cannot be understood from a single code file.
