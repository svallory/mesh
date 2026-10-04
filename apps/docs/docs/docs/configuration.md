---
title: "Configuration"
description: "What mesh.config.ts holds, which database adapter to use, and how extensions are enabled."
---

# Configuration

::: callout warning "Live spec, not released"
This page describes how Mesh **will** work, not how it works today. It is a live spec of the developer experience, written before the code. Mesh is not released: nothing here can be installed or run yet, and any detail may change.
:::

One file, `mesh.config.ts`, at the project root. It is ordinary TypeScript, so it is checked by your type checker and can read environment variables.

```ts "mesh.config.ts"
import { defineConfig } from "@mesh/cli";
import { sqlite } from "@mesh/data-sqlite";
import { policies } from "@mesh/ext-policies";

export default defineConfig({
  resources: "resources",
  output: "generated",
  data: sqlite({ file: "todo.db" }),
  extensions: [policies()],
});
```

`bunx mesh init` writes this file and asks the same questions.

## The four keys

| Key | Required | What it is |
|---|---|---|
| `resources` | yes | Folder holding the `.mx` files recursively, relative to the project root; a relative glob or non-empty list of relative file paths is also accepted |
| `output` | yes | Folder the generated tree is written to, relative to the project root |
| `data` | yes from M2; optional in M1 | The data adapter for this project: exactly one |
| `extensions` | no | The enabled extensions, each a call that returns one |

The folder form of `resources` is the primary form; it discovers every `.mx` file beneath that folder and sorts the paths. Globs and explicit file lists are alternatives for selecting a subset. In M1, `data` and `extensions` are carried through unchanged as opaque values: the data adapter is interpreted in M2, extensions in M6. The helper is implemented by `@mesh/compiler`; the M1 command-line package re-exports it from `@mesh/cli`, as the examples above show.

## Choosing the database

The data adapter is one replaceable implementation of a core contract. Mesh does not read anything about the database from a resource file; the project configuration is what names the adapter ([ADR-0001](../architecture/decisions/0001-three-rings.md)).

**SQLite**, which is what the [todo example](./example-todo-list.md) uses, needs no server. The complete configuration above selects it with `data: sqlite({ file: "todo.db" })`.

SQLite is also what tests use, in its in-memory mode, instead of a hand-written in-memory adapter ([ADR-0016](../architecture/decisions/0016-in-memory-data-via-sqlite.md)).

**Postgres** reads a URL. Replace the SQLite configuration with this complete file:

```ts "mesh.config.ts"
import { defineConfig } from "@mesh/cli";
import { postgres } from "@mesh/data-postgres";
import { policies } from "@mesh/ext-policies";

export default defineConfig({
  resources: "resources",
  output: "generated",
  data: postgres({ url: process.env.DATABASE_URL }),
  extensions: [policies()],
});
```

There is no default URL. If `DATABASE_URL` is unset, `connect` throws rather than guessing. Postgres needs a running server; nothing in Mesh creates one.

Both adapters are built on Drizzle, and Mesh does not use Drizzle's relations API ([ADR-0014](../architecture/decisions/0014-sql-adapters-on-drizzle.md)). Exact versions are pinned, so an upgrade is a separate pull request that has to pass the conformance suite.

::: callout info "Not decided yet"
A resource file that uses a capability the configured adapter does not declare fails the build at the position of the offending tag. Nothing falls back to in-memory. This reaction is fixed ([ADR-0013](../architecture/decisions/0013-data-layer-contract-and-capabilities.md)), but the full capability manifest is written in M3.
:::

::: callout info "Not decided yet"
The same connection details appear twice: here, for `mesh db push` and `mesh migrate`, and in `connect()` at run time. Whether the run-time `connect` can read `mesh.config.ts`, or whether the build should generate the connection settings, has no decided answer. See *DX findings* in the task report.
:::

## Enabling extensions

An extension adds to Mesh through declared points: tags a resource file may use, transforms and verifiers, emitted files, expression functions, attribute types, `mesh` subcommands, and named run-time behaviour ([ADR-0020](../architecture/decisions/0020-extension-contributions-through-declared-points.md)). Extensions are listed explicitly here; there is no discovery by scanning `node_modules`, so nothing changes under you.

`@mesh/ext-policies` is the first-party extension that fills the authorizer slot. With it enabled, an action with no matching policy is **forbidden** ([ADR-0036](../architecture/decisions/0036-deny-by-default-arrives-with-policies.md)). Without it, the `policies` block is not a valid tag and the build fails — which is the point: a resource cannot declare a policy that is quietly ignored.

::: callout info "Not decided yet"
"Policies on by default" cannot be a core default, because core must not know about an extension it is not allowed to depend on, and extensions load only from this file. In this page it means what the starter template writes: `extensions: [policies()]`. Whether the ruling means something stronger is [exception X2](../architecture/roadmap/vocabulary-mapping.md) on the vocabulary mapping page; ADR-0036 is a working decision the operator may overrule.
:::

A project-local extension goes in `extensions/` with two entries, a build-time one and a run-time one, and is listed the same way.

## Project-local settings

Mesh keeps its own configuration in one file and does not read your other tool configuration: no `tsconfig.json` path mapping, no environment file of its own. That way `mesh build` gives the same result in your editor, in CI and in a container.

Anything else that varies — which database, whether policies are on — is either a key here or an environment variable the file reads.

## Next

- [Command-line tool](./command-line.md) — what the configuration is used for.
- [Project structure](./project-structure.md) — the folders this file points at.