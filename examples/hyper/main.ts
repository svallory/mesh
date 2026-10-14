// The Hyper engine daemon (PROTOCOL.md:24-38):
//
//   bun examples/hyper/main.ts --socket <path> --db <path>
//
// It serves the engine protocol on the Unix socket, keeps everything in the SQLite file, and prints `READY` on standard
// output once the socket accepts connections and the workspace exists; everything else goes to standard error. Every
// setting comes from the flags: there are no environment variables and no configuration file. Exit codes: 0 after
// `SIGTERM` or `SIGINT`, 1 when it cannot start, 2 for a usage error.
import { parseArgs } from "node:util";
import { exitOnSignal, startDaemon } from "./src/daemon/daemon";

const USAGE = "usage: bun examples/hyper/main.ts --socket <path> --db <path>";

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function flags(): { socket: string; db: string } {
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
  // Refused rather than accepted and ignored: a client that sets them would otherwise get behaviour it did not ask for.
  if (values["lease-ms"] !== undefined) usage("--lease-ms is not supported yet: every claim gets the default lease of 600000 ms");
  if (values.plugins !== undefined) usage("--plugins is not supported yet: the plugin host is not built (ADR-0073)");
  if (!values.socket) usage("--socket is required");
  if (!values.db) usage("--db is required");
  return { socket: values.socket, db: values.db };
}

const { socket, db } = flags();
try {
  const daemon = await startDaemon({ socket, db });
  exitOnSignal(daemon);
  process.stdout.write("READY\n");
} catch (error) {
  console.error("the engine could not start", error);
  process.exit(1);
}
