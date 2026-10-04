# Blog example

A Mesh project that grows milestone by milestone. In M1, `resources/post.mx` builds the model and types for all seven registered attribute types and the four action kinds; it does not run actions yet.

From this folder, run `bunx mesh build` after changing a resource file or an emitter, and commit `generated/` with the change. `bun run validate` runs `mesh build --check` without writing; root `bun run verify` discovers it and also type-checks the generated files.

`not-yet/post.full.mx` is the full vocabulary fixture: valid MX, but not buildable until M8 (expressions in M4, relationships/calculations/aggregates in M7, policies in M8). It lives outside the configured `resources/` folder so M1 never picks it up.
