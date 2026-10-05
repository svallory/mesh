# Vendored MX highlighter

These files are a copy of MX's build-time highlighter for the docs site, made by the MX lead on
2026-10-05 from **svallory/mxlang `main` at `aa73c86d`** (MX decision 150). They are vendored
because the `@mxlang` packages are not published and the docs Docker image is built from the public
repository, which cannot reach the MX checkout ([ADR-0065](../../docs/architecture/decisions/0065-mx-highlighting-on-the-docs-site.md)).

| File | What it is |
|------|------------|
| `mx-highlight.mjs` | the docmd plugin and the highlighter (`renderMx`, `renderFence`, `spansOf`, `parseMx`) |
| `tree-sitter-mx.wasm` | the MX grammar, compiled to WebAssembly |
| `queries/highlights.scm` | the capture names the grammar produces |
| `queries/injections.scm` | where TypeScript is embedded in MX |
| `ts/tree-sitter-typescript.wasm` | tree-sitter-typescript v0.23.2 (`f975a621f4e7f532fe322e13c4f79495e0a7b2e7`), `typescript` dialect |
| `ts/highlights.scm` | that grammar's own highlight query |

Runtime dependency: `web-tree-sitter` 0.26.9 (build time only, a dev dependency of `apps/docs`).

## What Mesh changed

Three things, all in `mx-highlight.mjs`:

- `grammarDir` is this directory instead of `packages/editors/tree-sitter-mx` in the mxlang repo,
  so the wasm and the queries are read from beside the module.
- `tsDir` is `./ts` here instead of `apps/docs/.cache/ts`, so the TypeScript grammar is vendored too
  rather than built during the docs build.
- A three-line comment above them, and the two build hints in the "file is missing" error next to
  them, pointed at mxlang commands and now say where to refresh the copy. The error text itself is
  otherwise the same: a missing file still fails the build rather than falling back to plain text.

Everything else, including the module's own docmd `markdownSetup`, is byte-for-byte the MX lead's
copy. Mesh does not register that `markdownSetup`: `../mx-highlight.js` is the single docmd entry
point for `mx` fences, because it also owns the build-failure diagnostics and the two-theme
stylesheet. It is kept here so the file can be replaced unchanged when the package is published.

## How the upstream files were built

On the MX lead's machine, inside the mxlang checkout:

```bash
bun run --cwd packages/editors/tree-sitter-mx build:wasm   # tree-sitter-mx.wasm
bash apps/docs/scripts/build-ts-grammar.sh                  # ts/tree-sitter-typescript.wasm + ts/highlights.scm
```

(tree-sitter CLI 0.26.x; the TypeScript grammar comes from `tree-sitter-typescript` v0.23.2 at
`f975a621f4e7f532fe322e13c4f79495e0a7b2e7`, `typescript` dialect.)

## How to refresh

1. Ask the MX lead for a new drop (the mxlang commit it came from, the two commands above, and any
   query change).
2. Copy the files over this directory and keep the three changes listed above: the two path constants
   and the comment that names them.
3. Compare the capture names the new queries produce with the `PALETTE` table in
   `../mx-highlight.js`. `bun test test/` fails on any capture name the table does not decide, so the
   failing test names what is new; give each one a colour (or a deliberate blank, which the table
   spells as `null`).
4. Write the new mxlang commit and date at the top of this file.

The wasm files are committed because the Docker build has no tree-sitter command-line tool, and the
site must not fall back to plain text: the module throws at import when a file is missing.
