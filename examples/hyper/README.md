# Hyper on Mesh

Hyper's 18 entities as `.mesh.mx` files, in four modules under `src/domain/`: `identity`, `work`, `execution` and `audit`. They hold what Mesh builds today: the data, the actions with Hyper's rules, and each command's effects inside its own aggregate. The commands whose effects reach another aggregate, or whose result adds `warnings` or a late result, are plain functions in `src/domain/<module>/<module>.commands.ts` (`taskComplete`, `taskCancel`, `submissionSubmit`, `reviewAccept`, `membershipRevoke`, `collaboratorRetire`, `attemptStart`, `sessionRecord`); call those, not the generated action of the same command, which skips that part. [PORTING.md](./PORTING.md) lists each construct left out, with the milestone that delivers it, and where each of Hyper's 13 effects lives.

```sh
bun install
mesh build        # writes .mesh/
mesh db push      # creates the 18 entity tables and Mesh's event tables in hyper.db
bun test ./test   # the rules, the effects, the relationships and a round-trip of every entity
```

Code here imports `bind`, `connect`, `disconnect`, `transaction` and `tables` from `#mesh`, `Mesh` (for `Mesh.privileged`) from `meshfw`, and a module's entity values, record and input types and load functions from that module's specifier: `#mesh/domain/identity`, `#mesh/domain/work`, `#mesh/domain/execution` or `#mesh/domain/audit`. `package.json` maps the three specifiers (`#mesh`, `#mesh/domain` and `#mesh/domain/*`) to `.mesh/`.

## The engine daemon

`main.ts` is Hyper's engine as a process: it serves the Hyper engine protocol (newline-delimited JSON-RPC 2.0 over a Unix socket, the specification's v0) through `@meshfw/jsonrpc`.

```sh
bun main.ts --socket /tmp/hyper.sock --db hyper.db [--lease-ms 600000]
```

- It opens the database file, creating it when it is missing, in WAL mode, and creates the tables it lacks; a restart on the same `--db` keeps every row.
- On a database with no workspace it bootstraps one, in one transaction: a collaborator named `owner`, the local workspace, and the owner membership that collaborator holds. On a database that has its workspace it does nothing.
- It starts event delivery, which claims the database for this process. A second engine on a file whose engine is alive on this host exits 1 at once with `MESH_DELIVERER_TAKEN`; a claim left by an engine that died, or that runs on another host, is waited out once (it lapses 15 s after its last renewal). The subscription rows of an earlier run are then dropped, since a subscription lives as long as its connection. On stop it closes every subscription before delivery stops. Connection close hooks immediately end its subscriptions and drop their rows, without polling. A subscription Mesh ends on its own (a callback error, an overflowing queue or a lost delivery claim) is logged and closes its connection: every other subscription on that connection ends too, and pending requests lose their responses (their work is not cancelled). PROTOCOL.md §1 and §8 define no per-subscription end notification, so none is invented; the client reconnects and subscribes again from each last processed cursor.
- It prints `READY` on standard output once the socket accepts connections, and nothing else there; its logs go to standard error.
- `--lease-ms <n>` sets the claim lease in milliseconds: a positive integer, 600000 (ten minutes) when the flag is left out. The context of every call carries it (`leaseMs`), and Claim `acquire` and `renew` read it there to set `expiresAt`.
- Every 250 ms the lease sweeper (`src/daemon/sweeper.ts`) expires each active claim whose `expiresAt` has passed, through Claim `expire` with the engine's context, one transaction per claim, which bumps the Task's version as the protocol's `claim.expired` does, well within the 1000 ms the protocol allows. A claim is expired the moment its lease runs out, whether or not the sweeper has reached it (PROTOCOL.md:312): `task.get` shows no active claim, `claim.renew` and `claim.release` answer `claim.expired` (also for a claim marked expired, should the clock step back before its `expiresAt`), `claim.revoke` answers `claim.active`, and `task.cancel`, `task.assign`, `task.unassign`, `membership.revoke` and `collaborator.retire` revoke only the claims whose lease is still running and leave a lapsed one to the sweeper.
- It exits 0 on `SIGTERM` or `SIGINT`, even one that arrives while it is starting: it stops serving and removes the socket file, lets the calls in flight finish, each committing or rolling back whole, stops the sweeper once the expiry it is running commits, closes the database and exits, or exits after 4 seconds when a call is still running; 1 when it cannot start; 2 on a usage error, a `--lease-ms` that is not a positive integer included. `--plugins` is a usage error for now: the plugin host is not built.

Each call runs as its actor, read from the database: the collaborator the request names and the role of its active membership. An unknown or retired collaborator, or one with no active membership, is refused before the method runs. Only `workspace.get` and `events.unsubscribe`, which the protocol defines without an actor, run as the engine itself. A command runs in one transaction and calls the command function where there is one. An error reaches the client in the protocol's shape: the code, the short name, the phase that refused the call and the checks that failed.

It serves 35 of the protocol's 37 methods: `workspace.get`, `workspace.create`, `workspace.rename`, the collaborator and membership methods, the work methods (the `task.*`, `dependency.*`, `claim.*`, `submission.*` and `review.*` commands, `evidence-reference.record`, and the queries `task.get`, `task.list` and `task.next`) and the event methods `events.read`, `events.subscribe` and `events.unsubscribe`. The other two, `workspace.export` and `workspace.move`, which are outside the v0 slice, answer `-32010 not_implemented`, naming why, before the actor is read.

Every change publishes its domain event in the change's transaction (Mesh's outbox, `localBus` delivering), so a command's result carries the events it caused, `workspace.get`'s `head` is the log's highest `seq`, and `events.read` and `events.subscribe` page and stream the log from a cursor. A command sent again with the same `commandId` and the same params returns the stored result and changes nothing; with other params it is `-32006 idempotency_conflict`. PORTING.md's Event and Idempotency lines say where each part lives.

- `src/rpc/`: the method table (`methods.ts`), the params schemas (`params.ts`), the context factory (`context.ts`), the record views (`views.ts`), the lookups that turn the protocol's ids into records (`resolve.ts`), the error mapping (`errors.ts`), the stored command ids (`idempotency.ts`), the event log's data layer and binding (`event-log.ts`) and the event methods (`subscriptions.ts`).
- `src/daemon/`: `startDaemon`, `exitOnSignal` and `runDaemon`, the start sequence `main.ts` runs (`daemon.ts`), bootstrap (`bootstrap.ts`) and the lease sweeper (`sweeper.ts`).

## Conformance

```sh
bun run conformance   # the cases in conformance/cases; fails unless they are exactly the ones conformance/cases.txt lists and each one passes
```

`conformance/` holds copies of the Hyper engine specification's conformance suite: its harness, its protocol schemas and the cases this daemon passes. [conformance/README.md](./conformance/README.md) names the source commit and lists every file copied and how. Those copies are the gate for Mesh 1.0: the specification repository will be deleted, so they are never synced back to it. The runner starts `main.ts` on the Bun that runs the script, with strict result validation, and `bun run verify` runs it as a step that never skips. A pull request that makes a case pass copies the case in and adds its name to `conformance/cases.txt`.
