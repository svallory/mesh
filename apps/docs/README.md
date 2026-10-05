# Mesh docs site

Run `bun run build` for the static site and `bun run validate` for links and Docker dependency pins.

`mx` fences are highlighted with MX's own tree-sitter highlighter, vendored under `plugins/mx/`
(see `plugins/mx/SOURCE.md`); other fences keep docmd's Shiki highlighting. `plugins/mx-highlight.js` is
the docmd plugin: it routes the fences, fails the build with the page and the line when a fence cannot
be highlighted, and maps the grammar's capture names to the GitHub light and dark colours. `bun test
test/` covers the coloured forms, the annotated figure and the error propagation.
