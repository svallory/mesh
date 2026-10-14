# Conformance cases

This folder holds copies of the Hyper engine specification's conformance suite: its harness, its protocol schemas and the cases this daemon passes. They were copied from the specification at commit `ccc00f9` (`ccc00f9abf6f330877f393193a09c457b97056e7`, 2026-09-29).

These copies are the gate for Mesh 1.0 (RDM-02, ruled on 2026-10-14). `bun run conformance` runs them against `main.ts`, and `bun run verify` runs that step on every pull request; it never skips. The specification repository is internal and will be deleted, so nothing here is ever synced back to it: a change to a copied file is a change to the gate, made and reviewed in this repository.

The bracketed references in the case names, such as `[PROTOCOL.md#transport]`, name sections of the specification's own documents, which are not copied.

## What is copied

| Here | Source path at `ccc00f9` | Copy |
| --- | --- | --- |
| `harness/engine.ts` | `harness/engine.ts` | whole |
| `harness/rpc.ts` | `harness/rpc.ts` | whole |
| `harness/world.ts` | `harness/world.ts` | whole |
| `harness/validate.ts` | `harness/validate.ts` | whole |
| `schemas/protocol.ts` | `schemas/protocol.ts` | whole |
| `cases/_setup.ts` | `conformance/_setup.ts` | whole |
| `cases/01-bootstrap-transport.test.ts` | `conformance/01-bootstrap-transport.test.ts` | edited |
| `cases/02-permissions.test.ts` | `conformance/02-permissions.test.ts` | edited |
| `tsconfig.json` | `tsconfig.json` | edited |

The source's `conformance/` folder is `cases/` here, and `harness/` and `schemas/` keep their places beside it, so every relative import is the source's. A whole copy is the source file byte for byte. The edited test files remove cases and narrow their `_setup.ts` import to the names the kept cases use; every other line they keep is the source's:

- `cases/01-bootstrap-transport.test.ts` keeps one case of `01.1 bootstrap` (`workspace.create` on a daemon that has its workspace) and all eight cases of `01.3 transport`. It removes the other three cases of `01.1` (what `workspace.get` returns after bootstrap, the three bootstrap events, `workspace.rename`) and the `01.2 restart keeps state` suite, and drops `types` and `World` from the `_setup.ts` import, which only the removed cases used.
- `cases/02-permissions.test.ts` keeps eight cases of `02.2 only owners manage memberships and collaborators`. It removes the `02.1 guests` suite (five cases), four cases of `02.2` (an owner grants, changes a role and revokes, with events; `collaborator.update` by the collaborator itself or an owner; phase precedence for a guest with a stale `expectedVersion`; a guest claiming a task assigned to someone else) and the `02.3` suite (two cases), and drops `types` from the `_setup.ts` import.
- `tsconfig.json` drops the `paths` entry for `@hyper/plugin-sdk`, which no copied file imports. `bun run typecheck` checks this folder with it (`tsc --noEmit -p conformance`), under the specification's own compiler options.

Not copied, because no copied case uses them: the specification's prose; the other cases and test files (groups 03 to 10); `schemas/bundle.ts`, `schemas/build.ts` and `schemas/protocol.schema.json`, which build the protocol's JSON Schema bundle from `schemas/protocol.ts`; `harness/harness.test.ts` and `harness/fixtures/`, the harness's own tests; and `conformance/plugins/`, the plugins group 10 loads.

The harness imports `@sinclair/typebox`, which is a dev dependency of `examples/hyper` pinned to 0.34.52, the version the specification's lockfile resolved.

## Adding a case

A pull request that makes a case pass:

1. Copies the case from the source commit into the file of the same name under `cases/`, unedited. When that file is not here yet, it starts from the source file's header comment and imports, and keeps only the imports its cases use.
2. Copies any harness, schema or fixture file the case needs that is not here yet.
3. Adds the case's name to `cases.txt` as the run prints it, the describe block and the test joined by ` > `.
4. Updates the table and the lists above.

`bun run conformance` fails unless the cases under `cases/` are exactly the ones `cases.txt` lists and every one passes, so a copied case that is not listed fails the run too.
