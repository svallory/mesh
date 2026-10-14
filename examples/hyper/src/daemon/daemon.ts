// The engine daemon (PROTOCOL.md:24-38): one SQLite database in WAL mode, the domain bound to it, bootstrap, the
// method table served on a Unix socket, and the lease sweeper. `main.ts` parses the flags and calls `startDaemon`; the
// tests start it the same way, with an extra method when they need one.
import { Database } from "bun:sqlite";
import { serve, type MethodTable, type Server } from "@meshfw/jsonrpc";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import type { ActionContext } from "@meshfw/runtime";
import { bind, tables } from "#mesh";
import { contextFactory, ENGINE } from "../rpc/context";
import { messages, wireError } from "../rpc/errors";
import { actorless as hyperActorless, methods as hyperMethods, unserved } from "../rpc/methods";
import { bootstrap } from "./bootstrap";
import { startSweeper } from "./sweeper";

export interface DaemonOptions {
  /** The socket's path (`--socket`). */
  readonly socket: string;
  /** The database file (`--db`), created when it is missing. */
  readonly db: string;
  /** The method table; Hyper's unless a test passes its own. */
  readonly methods?: MethodTable<ActionContext>;
  /** The methods that run with the engine's context (`actorless` in `src/rpc/methods.ts`). */
  readonly actorless?: ReadonlySet<string>;
  /** The claim lease in milliseconds (`--lease-ms`), which every call's context carries; the default lease when left out. */
  readonly leaseMs?: number;
}

export interface Daemon {
  readonly server: Server;
  /**
   * Stops the lease sweeper and serving, waits for the calls in flight and the sweep in progress, then closes the
   * database. Calling it again returns the same promise.
   */
  close(): Promise<void>;
}

/**
 * Sets WAL mode on the database file, creating the file when it is missing. `SQLiteOptions` takes only the file, and WAL
 * mode persists in the file once set (https://www.sqlite.org/wal.html, "Persistence of WAL mode"), so the data layer's
 * own connections open it in WAL mode.
 */
function useWal(file: string): void {
  const database = new Database(file, { create: true });
  try {
    database.exec("PRAGMA journal_mode=WAL");
  } finally {
    database.close();
  }
}

/**
 * Opens the database, prepares its schema, runs bootstrap, starts serving and starts the lease sweeper. Resolves once
 * the socket accepts connections.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  useWal(options.db);
  const layer = sqlite({ file: options.db });
  // `createSchema` plans a diff against what the file already holds and refuses statements that would lose data, so a
  // restart on the same database keeps its rows (the lead's ruling on Q7 of the HA plan).
  await createSchema(layer, tables);
  const hyper = bind(layer);
  await bootstrap(hyper);
  const methods = options.methods ?? hyperMethods;
  const server = await serve({
    socket: options.socket,
    methods,
    context: contextFactory(options.actorless ?? hyperActorless, unserved(methods), options.leaseMs),
    binding: hyper,
    error: wireError,
    messages,
  });
  const sweeper = startSweeper(hyper, { context: ENGINE });
  let closing: Promise<void> | undefined;
  return {
    server,
    // The sweeper stops first, so no new sweep starts while the calls drain; `stop` never rejects. The database is
    // closed even when `server.close()` rejects; that rejection is still what `close()` rejects with.
    close: () => (closing ??= (async () => {
      const sweeping = sweeper.stop();
      try {
        await server.close();
      } finally {
        await sweeping;
        await layer.close();
      }
    })()),
  };
}

/**
 * Stops the daemon on `SIGTERM` or `SIGINT` (PROTOCOL.md:38): it stops serving, waits for the calls in flight and
 * closes the database, then exits 0. A call that never settles would hold that up, so the process exits 0 anyway
 * `graceMs` after the signal, within the spec's 5 seconds; each method is one transaction, so the database stays
 * consistent. A second signal while stopping changes nothing.
 *
 * `daemon` may be the promise `startDaemon` returned, so the handlers are in place while the daemon starts: a signal
 * then waits for start-up to finish and closes the daemon as above. When start-up fails, the handler leaves the report
 * and the exit to whoever awaits the promise (`runDaemon` exits 1).
 */
export function exitOnSignal(daemon: Daemon | Promise<Daemon>, graceMs = 4_000): void {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => {
      console.error(`calls still running ${graceMs} ms after ${signal}; exiting without waiting for them`);
      process.exit(0);
    }, graceMs);
    Promise.resolve(daemon).then(
      (started) =>
        started.close().then(
          () => process.exit(0),
          (error: unknown) => {
            console.error("the daemon did not close cleanly", error);
            process.exit(1);
          },
        ),
      () => {}, // start-up failed: `runDaemon` reports it and exits 1
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

/**
 * What `main.ts` does once it has read the flags, and what the tests' daemon does too: it calls `start`, with the
 * signal handlers in place before start-up finishes (so a signal during schema creation or bootstrap still waits for it,
 * closes the database and exits 0), prints `READY` on standard output once the daemon serves, and exits 1 with the
 * reason on standard error when it cannot start.
 */
export async function runDaemon(start: () => Promise<Daemon>): Promise<void> {
  const started = start();
  exitOnSignal(started);
  try {
    await started;
  } catch (error) {
    console.error("the engine could not start", error);
    process.exit(1);
  }
  process.stdout.write("READY\n");
}
