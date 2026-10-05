# Mesh docs site

Run `bun run build` for the static site and `bun run validate` for links and Docker dependency pins.

`mx` fences are highlighted with MX's own tree-sitter highlighter, the `@mxlang/tree-sitter-mx`
package (grammar, the two query files and the TypeScript grammar the injections need); other fences keep
docmd's own highlighting, highlight.js with the light and dark stylesheets it ships.
`plugins/mx-highlight.js` is
the docmd plugin: it routes the fences, fails the build with the page and the line when a fence cannot
be highlighted, and maps the grammar's capture names to the light and dark colours docmd's own
highlight stylesheets use. `bun test
test/` covers the coloured forms, the annotated figure and the error propagation.

The package comes from the operator's own registry, `https://npm.saulo.tech`; the repository's
`bunfig.toml` points the `@mxlang` scope at it, and `docker/bunfig.toml` repeats the entry because the
image build never sees the repository root.
