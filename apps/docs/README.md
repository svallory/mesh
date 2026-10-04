# Mesh docs site

Run `bun run build` for the static site and `bun run validate` for links and Docker dependency pins.

`mx` fences use Shiki's Marko grammar with GitHub light/dark token colors; other fences retain docmd's highlighting.
The local plugin lives in `plugins/mx-highlight.js`; `bun test test/` covers rendering and error propagation.
