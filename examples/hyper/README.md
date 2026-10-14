# Hyper on Mesh

Hyper's 18 entities as `.mesh.mx` files, in four modules under `src/domain/`: `identity`, `work`, `execution` and `audit`. They hold what Mesh builds today: the data, the actions with Hyper's rules, and each command's effects inside its own aggregate. The commands whose effects reach another aggregate, or whose result adds `warnings` or a late result, are plain functions in `src/domain/<module>/<module>.commands.ts` (`taskComplete`, `taskCancel`, `submissionSubmit`, `reviewAccept`, `membershipRevoke`, `collaboratorRetire`, `attemptStart`, `sessionRecord`); call those, not the generated action of the same command, which skips that part. [PORTING.md](./PORTING.md) lists each construct left out, with the milestone that delivers it, and where each of Hyper's 13 effects lives.

```sh
bun install
mesh build        # writes .mesh/
mesh db push      # creates the 18 tables in hyper.db
bun test          # the rules, the effects, the relationships and a round-trip of every entity
```

Code here imports `bind`, `connect`, `disconnect`, `transaction` and `tables` from `#mesh`, `Mesh` (for `Mesh.privileged`) from `meshfw`, and a module's entity values, record and input types and load functions from that module's specifier: `#mesh/domain/identity`, `#mesh/domain/work`, `#mesh/domain/execution` or `#mesh/domain/audit`. `package.json` maps the three specifiers (`#mesh`, `#mesh/domain` and `#mesh/domain/*`) to `.mesh/`.

## The engine daemon

`main.ts` is Hyper's engine as a process: it serves the Hyper engine protocol (newline-delimited JSON-RPC 2.0 over a Unix socket, the specification's v0) through `@meshfw/jsonrpc`.

```sh
bun main.ts --socket /tmp/hyper.sock --db hyper.db
```

- It opens the database file, creating it when it is missing, in WAL mode, and creates the tables it lacks; a restart on the same `--db` keeps every row.
- On a database with no workspace it bootstraps one, in one transaction: a collaborator named `owner`, the local workspace, and the owner membership that collaborator holds. On a database that has its workspace it does nothing.
- It prints `READY` on standard output once the socket accepts connections, and nothing else there; its logs go to standard error.
- It exits 0 on `SIGTERM` or `SIGINT`, even one that arrives while it is starting: it stops serving and removes the socket file, lets the calls in flight finish, each committing or rolling back whole, closes the database and exits, or exits after 4 seconds when a call is still running; 1 when it cannot start; 2 on a usage error. `--lease-ms` and `--plugins` are usage errors for now: the lease is the default ten minutes, and the plugin host is not built.

Each call runs as its actor, read from the database: the collaborator the request names and the role of its active membership. An unknown or retired collaborator, or one with no active membership, is refused before the method runs. Only `workspace.get` and `events.unsubscribe`, which the protocol defines without an actor, run as the engine itself. A command runs in one transaction and calls the command function where there is one. An error reaches the client in the protocol's shape: the code, the short name, the phase that refused the call and the checks that failed.

It serves `workspace.get`, `workspace.create`, `workspace.rename`, the collaborator and membership methods, and `task.create`. Every other method of the protocol answers `-32010 not_implemented`, naming why, before the actor is read. Until the event log lands (M6), a command's result carries `events: []` and `workspace.get`'s `head` is 0.

- `src/rpc/`: the method table (`methods.ts`), the params schemas (`params.ts`), the context factory (`context.ts`), the record views (`views.ts`), the lookups that turn the protocol's ids into records (`resolve.ts`) and the error mapping (`errors.ts`).
- `src/daemon/`: `startDaemon`, `exitOnSignal` and `runDaemon`, the start sequence `main.ts` runs (`daemon.ts`), and bootstrap (`bootstrap.ts`).

## Conformance

```sh
bun run conformance         # the cases listed in conformance.txt; fails unless every one passes
bun run conformance --all   # every case; lists those that pass and are not listed yet
```

The runner takes the specification's conformance suite at the commit `conformance.json` pins: from the checkout at `$HYPER_SPEC_DIR`, or from a clone it makes in `.spec/` (git-ignored) with `gh`. It refuses a checkout at another commit or with local changes. It runs the suite against `main.ts` on the Bun that runs the script, with strict result validation. The specification repository is private for now, so the clone needs a `gh` login that can read it, and the step is not part of `bun run verify` yet.
