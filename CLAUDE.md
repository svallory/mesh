# CLAUDE.md

**Mesh** is a planned TypeScript framework modelled on Ash (Elixir): one `.mx` resource file declares data, actions and rules, and Mesh derives types, handlers and schema from it. It runs on Bun only.
Today the repo holds MX tag contracts for the resource vocabulary (`src/contracts.ts`, tests in `test/`) and the docs site (`apps/docs`).

## Commands

- `bun install`, `bun test`, `bunx tsc --noEmit` (run from the repo root)
- Docs site, from `apps/docs`: `bun install`, then `bun run dev` (preview), `bun run build` (static site into `apps/docs/site/`), `bun run validate` (link check). Run build and validate before a PR. How to add pages: `apps/docs/docs/architecture/contributing.md`.

## Rules

- Use bun, never npm.
- Always write "Mesh" (never "Mash").
- Architecture docs hold what cannot be understood from a single code file.
