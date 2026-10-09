# Blog example

This Mesh project declares posts, users, and comments in [entity file syntax v4](../../apps/docs/docs/docs/entities.md). The compiler builds a plain-data model, TypeScript record and action-input types, and Zod input validators. It does not execute actions or policies.

## Build and check

From this folder, run `bunx mesh build` after changing an entity file or an emitter. Commit `.mesh/` with the source change. Build never deletes files; remove obsolete output yourself.

`bun run validate` runs `mesh build --check` without writing files. At the repository root, `bun run verify` runs this guard and type-checks the generated files.

## Entity files and output

- [`src/domain/blog/post.mesh.mx`](src/domain/blog/post.mesh.mx) is the runnable Post declaration. It covers all ten attribute types, relationships, computed fields, action inputs, validation, steps, a filtered read, and policies. Functions use the supported `self.x` spelling.
- [`src/domain/blog/post.pending.mesh.mx.txt`](src/domain/blog/post.pending.mesh.mx.txt) is the full Post declaration with member references after a kind and inside expressions. Those positions await **MX lang-ext-syntax-table: & after a kind / in expressions**. Its `.txt` suffix keeps it out of discovery; it is not a second entity loaded by the project.
- [`user.mesh.mx`](src/domain/blog/user.mesh.mx) and [`comment.mesh.mx`](src/domain/blog/comment.mesh.mx) provide the imported entities.

`mesh.config.ts` reads `src/domain/`, selects the SQLite adapter descriptor, and writes `.mesh/`. The folder relative to the domain root is the module: these entities belong to `blog`, so their types and validators land under `.mesh/blog/`. `.mesh/model.json` includes the adapter's name, never its options. SQLite is only a frozen descriptor in this round; no database is opened.

`package.json` maps `#mesh` to `./.mesh/index.ts`. **That file does not exist yet:** round 3 adds the entry point, action functions and `connect`/`disconnect`/`bind` exports. This example has no `src/main.ts` and nothing imports `#mesh` yet. Do not replace that future public entry point with direct imports into `.mesh/`. Handlers and connection behavior belong to M2.
