# Blog example

This Mesh project declares posts, users and comments in [entity file syntax v4](../../apps/docs/docs/docs/entities.md), and runs them: a script and a test call the generated action functions against SQLite.

## Run it

From this folder:

```bash
bunx mesh build      # after changing an entity file, a view or a template; commit .mesh/
bun run db:push      # create the tables in blog.db (mesh db push)
bun run start        # src/main.ts: create a user and a post, read, publish, destroy
bun run test         # mesh build --check, then bun test against an in-memory database
```

`bun run start` can run again: it reuses `blog.db` (gitignored). Delete the file to start over.

## What is here

- [`src/domain/blog/post.mesh.mx`](src/domain/blog/post.mesh.mx) is the Post declaration. It covers all ten attribute types, relationships, computed fields, action inputs, validation, steps, a filtered and sorted read, `on:load`, and policies, with `&name` member references in every position. [`user.mesh.mx`](src/domain/blog/user.mesh.mx) and [`comment.mesh.mx`](src/domain/blog/comment.mesh.mx) are the imported entities.
- [`src/context.ts`](src/context.ts) declares the action context: a required `actor`, so every call passes `{ actor }` ([`test/context.check.ts`](test/context.check.ts) checks that leaving it out does not compile).
- [`src/main.ts`](src/main.ts) is the program: `connect()`, the calls, `disconnect()`.
- [`test/blog.test.ts`](test/blog.test.ts) binds its own `sqlite({ file: ":memory:" })` with `createSchema(db, tables)` and `bind(db)`, and covers the M2 acceptance tests.

`mesh.config.ts` reads `src/domain/`, selects the SQLite adapter and writes `.mesh/`. The folder relative to the domain root is the module, so the per-entity files land under `.mesh/blog/`. `package.json` maps `#mesh` to `./.mesh/index.ts`, which exports `connect`, `disconnect`, `bind`, every action function, every record and input type, and `tables`. Code in this example imports `#mesh`, never a path inside `.mesh/`.

## What this version runs

Mesh is at milestone M2 ([roadmap](../../apps/docs/docs/architecture/roadmap/roadmap.md)). A generated action validates its input (an unknown field is rejected), runs one transaction and writes or reads the row. Not yet:

- `validate` checks, and `do` steps other than a `set` whose values are literals or atoms (M4, M5): `publishPost` sets `state` to `published` but does not check `titlePresent`;
- a read with `filter` or `sort` (M4): `publishedPost` throws a `FrameworkError` rather than return unfiltered rows;
- `load`, computed fields and `on:load` (M7);
- policies and `can<Action>` (M8): nothing checks who calls.

Each generated method starts with a comment naming what it does not run yet.
