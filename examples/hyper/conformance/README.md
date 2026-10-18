# Conformance cases

This folder holds copies of the Hyper engine specification's conformance suite: its harness, its protocol schemas and the cases this daemon passes. They were copied from the specification at commit `ccc00f9` (`ccc00f9abf6f330877f393193a09c457b97056e7`, 2026-09-29).

These copies are the gate for Mesh 1.0 (ruled on 2026-10-14). `bun run conformance` runs them against `main.ts`, and `bun run verify` runs that step on every pull request; it never skips. The specification repository is internal and will be deleted, so nothing here is ever synced back to it: a change to a copied file is a change to the gate, made and reviewed in this repository.

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
| `cases/01-bootstrap-transport.test.ts` | `conformance/01-bootstrap-transport.test.ts` | whole |
| `cases/02-permissions.test.ts` | `conformance/02-permissions.test.ts` | whole |
| `cases/03-tasks.test.ts` | `conformance/03-tasks.test.ts` | whole |
| `cases/04-dependencies-blocking.test.ts` | `conformance/04-dependencies-blocking.test.ts` | whole |
| `cases/05-claims.test.ts` | `conformance/05-claims.test.ts` | whole |
| `cases/06-review-completion.test.ts` | `conformance/06-review-completion.test.ts` | whole |
| `cases/07-idempotency-versions.test.ts` | `conformance/07-idempotency-versions.test.ts` | whole |
| `cases/08-events-subscriptions.test.ts` | `conformance/08-events-subscriptions.test.ts` | whole |
| `cases/09-scenarios.test.ts` | `conformance/09-scenarios.test.ts` | whole |
| `tsconfig.json` | `tsconfig.json` | edited |

The source's `conformance/` folder is `cases/` here, and `harness/` and `schemas/` keep their places beside it, so every relative import is the source's. A whole copy is the source file byte for byte: every case of groups 01 to 09 is here, 119 in all, and every one passes.

- `tsconfig.json` drops the `paths` entry for `@hyper/plugin-sdk`, which no copied file imports. `bun run typecheck` checks this folder with it (`tsc --noEmit -p conformance`), under the specification's own compiler options.

Until the event log (Mesh's M6) the files of groups 01 to 07 were edited copies that removed the cases reading the events a command returns or the event log, and the cases of command-id idempotency (`07.1`); groups 08 and 09 were not copied. The Hyper port on domain events (M6 PR 6) copied all nine files whole.

Not copied: the specification's prose; group 10 (`conformance/10-plugins.test.ts`) and `conformance/plugins/`, the plugins it loads, which wait for the extension host; `schemas/bundle.ts`, `schemas/build.ts` and `schemas/protocol.schema.json`, which build the protocol's JSON Schema bundle from `schemas/protocol.ts`; and `harness/harness.test.ts` and `harness/fixtures/`, the harness's own tests.

The harness imports `@sinclair/typebox`, which is a dev dependency of `examples/hyper` pinned to 0.34.52, the version the specification's lockfile resolved.

## Adding a case

A pull request that makes a case pass:

1. Copies the case from the source commit into the file of the same name under `cases/`, unedited. When that file is not here yet, it starts from the source file's header comment and imports, and keeps only the imports its cases use.
2. Copies any harness, schema or fixture file the case needs that is not here yet.
3. Adds the case's name to `cases.txt` as the run prints it, the describe block and the test joined by ` > `.
4. Updates the table and the lists above.

`bun run conformance` fails unless the cases under `cases/` are exactly the ones `cases.txt` lists and every one passes, so a copied case that is not listed fails the run too.
