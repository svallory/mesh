// The Hyper engine daemon (PROTOCOL.md:24-38):
//
//   bun examples/hyper/main.ts --socket <path> --db <path> [--lease-ms <n>]
//
// It serves the engine protocol on the Unix socket, keeps everything in the SQLite file, and prints `READY` on standard
// output once the socket accepts connections and the workspace exists; everything else goes to standard error.
// `--lease-ms` is the claim lease in milliseconds, 600000 when left out. Every setting comes from the flags: there are
// no environment variables and no configuration file. Exit codes: 0 after `SIGTERM` or `SIGINT`, 1 when it cannot
// start, 2 for a usage error.
import { parseArgs } from "node:util";
import type { DaemonOptions } from "./src/daemon/daemon";

const USAGE = "usage: bun examples/hyper/main.ts --socket <path> --db <path> [--lease-ms <n>]";

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

/**
 * The lease `--lease-ms` gives: a positive integer written in decimal digits, small enough that a lease taken now ends
 * at a time a `Date` can hold. Anything else is a usage error rather than a lease the client did not ask for.
 */
function leaseMs(raw: string): number {
  const lease = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(lease)) usage(`--lease-ms must be a positive integer of milliseconds, got ${JSON.stringify(raw)}`);
  if (Number.isNaN(new Date(Date.now() + lease).getTime())) usage(`--lease-ms ${raw} is too long: a lease taken now would end after the last time a Date can hold`);
  return lease;
}

function flags(): DaemonOptions {
  let values: { socket?: string; db?: string; "lease-ms"?: string; plugins?: string };
  try {
    ({ values } = parseArgs({
      options: { socket: { type: "string" }, db: { type: "string" }, "lease-ms": { type: "string" }, plugins: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  // Refused rather than accepted and ignored: a client that sets it would otherwise get behaviour it did not ask for.
  if (values.plugins !== undefined) usage("--plugins is not supported yet: the plugin host is not built (ADR-0073)");
  if (!values.socket) usage("--socket is required");
  if (!values.db) usage("--db is required");
  return values["lease-ms"] === undefined
    ? { socket: values.socket, db: values.db }
    : { socket: values.socket, db: values.db, leaseMs: leaseMs(values["lease-ms"]) };
}

// Parse the flags before loading the daemon and the domain, so a bad flag exits 2 at once without loading them.
const options = flags();
const { runDaemon, startDaemon } = await import("./src/daemon/daemon");
await runDaemon(() => startDaemon(options));
