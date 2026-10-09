# Blog example

This Mesh project declares posts, users, and comments in [entity file syntax v4](../../apps/docs/docs/docs/entities.md). The compiler builds a plain-data model, TypeScript record and action-input types, and Zod input validators. It does not execute actions or policies.

## Build and check

From this folder, run `bunx mesh build` after changing an entity file or an emitter. Commit `generated/` with the source change.

`bun run validate` runs `mesh build --check` without writing files. At the repository root, `bun run verify` runs this guard and type-checks the generated files.

## Entity files

- [`resources/blog/post.mesh.mx`](resources/blog/post.mesh.mx) is the runnable Post declaration. It covers all ten attribute types, relationships, computed fields, action inputs, validation, steps, a filtered read, and policies. Functions use the supported `self.x` spelling.
- [`resources/blog/post.pending.mesh.mx.txt`](resources/blog/post.pending.mesh.mx.txt) is the full Post declaration with member references after a kind and inside expressions. Those positions await **MX lang-ext-syntax-table: & after a kind / in expressions**. Its `.txt` suffix keeps it out of discovery; it is not a second entity loaded by the project.
- [`user.mesh.mx`](resources/blog/user.mesh.mx) and [`comment.mesh.mx`](resources/blog/comment.mesh.mx) provide the imported entities.

For now, configuration still uses `resources`, and output stays in `generated/`. The planned configuration/layout and emitter realignments are separate from this compiler-model round.
