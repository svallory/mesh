// The engine daemon (PROTOCOL.md:24-38): one SQLite database in WAL mode, the domain bound to it, bootstrap, and the
// method table served on a Unix socket. `main.ts` parses the flags and calls `startDaemon`; the tests start it the same
// way, with an extra method when they need one.
import { Database } from "bun:sqlite";
import { serve, type MethodTable, type Server } from "@meshfw/jsonrpc";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import type { ActionContext } from "@meshfw/runtime";
import { bind, tables } from "#mesh";
import { contextFactory } from "../rpc/context";
import { messages, wireError } from "../rpc/errors";
import { actorless as hyperActorless, methods as hyperMethods } from "../rpc/methods";
import { bootstrap } from "./bootstrap";

export interface DaemonOptions {
  /** The socket's path (`--socket`). */
  readonly socket: string;
  /** The database file (`--db`), created when it is missing. */
  readonly db: string;
  /** The method table; Hyper's unless a test passes its own. */
  readonly methods?: MethodTable<ActionContext>;
  /** The methods that run with the engine's context (`actorless` in `src/rpc/methods.ts`). */
  readonly actorless?: ReadonlySet<string>;
}

export interface Daemon {
  readonly server: Server;
  /** Stops serving, waits for the calls in flight, then closes the database. Calling it again returns the same promise. */
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

/** Opens the database, prepares its schema, runs bootstrap and starts serving. Resolves once the socket accepts connections. */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  useWal(options.db);
  const layer = sqlite({ file: options.db });
  // `createSchema` plans a diff against what the file already holds and refuses statements that would lose data, so a
  // restart on the same database keeps its rows (the lead's ruling on Q7 of the HA plan).
  await createSchema(layer, tables);
  const hyper = bind(layer);
  await bootstrap(hyper);
  const server = await serve({
    socket: options.socket,
    methods: options.methods ?? hyperMethods,
    context: contextFactory(options.actorless ?? hyperActorless),
    binding: hyper,
    error: wireError,
    messages,
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    close: () => (closing ??= server.close().then(() => layer.close())),
  };
}

/**
 * Stops the daemon on `SIGTERM` or `SIGINT` (PROTOCOL.md:38): it stops serving, waits for the calls in flight and
 * closes the database, then exits 0. A call that never settles would hold that up, so the process exits 0 anyway
 * `graceMs` after the signal, within the spec's 5 seconds; each method is one transaction, so the database stays
 * consistent. A second signal while stopping changes nothing.
 */
export function exitOnSignal(daemon: Daemon, graceMs = 4_000): void {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => {
      console.error(`calls still running ${graceMs} ms after ${signal}; exiting without waiting for them`);
      process.exit(0);
    }, graceMs);
    daemon.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("the daemon did not close cleanly", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
