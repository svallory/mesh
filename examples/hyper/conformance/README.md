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
| `cases/01-bootstrap-transport.test.ts` | `conformance/01-bootstrap-transport.test.ts` | edited |
| `cases/02-permissions.test.ts` | `conformance/02-permissions.test.ts` | edited |
| `cases/03-tasks.test.ts` | `conformance/03-tasks.test.ts` | edited |
| `cases/04-dependencies-blocking.test.ts` | `conformance/04-dependencies-blocking.test.ts` | edited |
| `cases/05-claims.test.ts` | `conformance/05-claims.test.ts` | edited |
| `cases/06-review-completion.test.ts` | `conformance/06-review-completion.test.ts` | edited |
| `cases/07-idempotency-versions.test.ts` | `conformance/07-idempotency-versions.test.ts` | edited |
| `tsconfig.json` | `tsconfig.json` | edited |

The source's `conformance/` folder is `cases/` here, and `harness/` and `schemas/` keep their places beside it, so every relative import is the source's. A whole copy is the source file byte for byte. The edited test files remove cases and what only the removed cases use, and narrow their imports to the names the kept cases use; every other line they keep is the source's:

- `cases/01-bootstrap-transport.test.ts` keeps one case of `01.1 bootstrap` (`workspace.create` on a daemon that has its workspace) and all eight cases of `01.3 transport`. It removes the other three cases of `01.1` (what `workspace.get` returns after bootstrap, the three bootstrap events, `workspace.rename`) and the `01.2 restart keeps state` suite, and drops `types` and `World` from the `_setup.ts` import, which only the removed cases used.
- `cases/02-permissions.test.ts` keeps four cases of `02.1 guests` and ten of `02.2 only owners manage memberships and collaborators`. It removes one case of `02.1` (a guest can read, which reads the event log), two cases of `02.2` (an owner grants, changes a role and revokes, with events; `collaborator.update` by the collaborator itself or an owner) and the `02.3` suite (two cases), and drops `types` from the `_setup.ts` import.
- `cases/03-tasks.test.ts` keeps six cases of `03.1 create, update, cancel, reopen`, three of `03.2 hierarchy` and two of `03.3 parent rule and no cascades`. It removes three cases of `03.1` (what `task.create` returns and records; `task.update`'s old and new values; `task.cancel` and `task.reopen`), one of `03.2` (`task.move` and `task.no-cycle`), one of `03.3` (case 6, no cascades) and the `03.4 priority and task.next` suite (one case), and drops `types` from the `_setup.ts` import.
- `cases/04-dependencies-blocking.test.ts` keeps three cases of `04.1 dependency commands` and four of `04.2 readiness and blocked reasons`. It removes two cases of `04.1` (`dependency.add` blocks the dependent; `dependency.remove` unblocks it) and one of `04.2` (reopening a prerequisite blocks an unstarted dependent again), and drops `types` from the `_setup.ts` import.
- `cases/05-claims.test.ts` keeps one case of `05.2 claim race — case 4`, the race between an assignee's two connections, and three cases of `05.3 lease expiry and stale workers — case 5` (renewing just after `expiresAt`; renewing an expired claim with a wrong fence; a result under a revoked fence), with the constant `LEASE_MS`, the lease their world starts the daemon with. It removes the `05.1 acquire, renew, release, revoke` suite (eight cases), the other case of `05.2` (eight agents claim one Task), six cases of `05.3` (`--lease-ms` and the `claim.expired` the engine emits; the stale worker; the stale completion with no replacement claim, two cases made by a loop; expiry without traffic; renewing before expiry) and what only they use (the constants `EXPIRY_CONTRACT_MS` and `DELIVERY_ALLOWANCE_MS` and the `waitExpired` helper), and drops the `Event` type import and `types`, `until` and `World` from the `_setup.ts` import.
- `cases/06-review-completion.test.ts` keeps three cases of `06.1 submit, return, resubmit, accept` and six of `06.2 the reviewer rule and the waiver`. It removes seven cases of `06.1` (submitting; return, resubmit and accept; withdrawing; `task.complete` with evidence and no summary; completing with one's own pending submission; `task.cancel` withdrawing a pending submission; evidence references) and two of `06.2` (the performer is the reviewer; the delegator's waiver), and drops `types` from the `_setup.ts` import.
- `cases/07-idempotency-versions.test.ts` keeps two cases of `07.2 versions and expected-version conflicts`. It removes the `07.1 idempotent command IDs — case 9` suite (six cases; the daemon does not remember command ids yet) and three cases of `07.2` (the version increments once per changing command; a matching or a stale `expectedVersion`; rejections are not events), and drops `newCommandId` and `types` from the `_setup.ts` import.

- `tsconfig.json` drops the `paths` entry for `@hyper/plugin-sdk`, which no copied file imports. `bun run typecheck` checks this folder with it (`tsc --noEmit -p conformance`), under the specification's own compiler options.

Each case removed from groups 02 to 07, except where a reason is given above, reads the events a command returns or the event log, which this daemon does not have yet: every command answers `events: []`, and `events.read` answers `-32010` until the outbox (Mesh's M6).

Not copied, because no copied case uses them: the specification's prose; the other cases and the test files of groups 08 to 10; `schemas/bundle.ts`, `schemas/build.ts` and `schemas/protocol.schema.json`, which build the protocol's JSON Schema bundle from `schemas/protocol.ts`; `harness/harness.test.ts` and `harness/fixtures/`, the harness's own tests; and `conformance/plugins/`, the plugins group 10 loads.

The harness imports `@sinclair/typebox`, which is a dev dependency of `examples/hyper` pinned to 0.34.52, the version the specification's lockfile resolved.

## Adding a case

A pull request that makes a case pass:

1. Copies the case from the source commit into the file of the same name under `cases/`, unedited. When that file is not here yet, it starts from the source file's header comment and imports, and keeps only the imports its cases use.
2. Copies any harness, schema or fixture file the case needs that is not here yet.
3. Adds the case's name to `cases.txt` as the run prints it, the describe block and the test joined by ` > `.
4. Updates the table and the lists above.

`bun run conformance` fails unless the cases under `cases/` are exactly the ones `cases.txt` lists and every one passes, so a copied case that is not listed fails the run too.
