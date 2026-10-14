// The daemon as a process (`main.ts`, PROTOCOL.md:24-48): it prints `READY` and nothing else on standard output,
// bootstraps once per database, keeps what it stored across a restart on the same `--db`, and refuses bad flags with
// exit code 2. On `SIGTERM` or `SIGINT`, even one that arrives during start-up, it lets the calls inside a transaction
// commit whole, closes the database, removes the socket file and exits 0, within 5 seconds even when a call never
// settles. Over the wire, a non-member is `-32001` and a method it does not serve `-32010`, before the actor is read.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { ENGINE_ID } from "../src/rpc/context";
import { methods, unserved } from "../src/rpc/methods";

const HYPER = join(import.meta.dir, "..");
const MAIN = join(HYPER, "main.ts");
const TEST_DAEMON = join(import.meta.dir, "fixtures", "test-daemon.ts");
/** How long the spec gives an engine to exit after `SIGTERM` before it is killed (PROTOCOL.md:38). */
const STOP_MS = 5_000;
/** How long the daemon waits for the calls in flight before it exits anyway (`exitOnSignal` in `src/daemon/daemon.ts`). */
const GRACE_MS = 4_000;
/** What the daemon logs when it exits through the grace timer instead of after closing. */
const GRACE_EXIT = "calls still running";
const TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A temporary directory for the socket and the database. Short on macOS, where a socket path is limited to 104 bytes. */
function scratch(): { socket: string; db: string; dir: string } {
  const dir = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "hyd-"));
  dirs.push(dir);
  return { dir, socket: join(dir, "e.sock"), db: join(dir, "engine.db") };
}

const dirs: string[] = [];
const running: Subprocess[] = [];

afterEach(() => {
  for (const proc of running.splice(0)) if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Engine {
  readonly proc: Subprocess<"ignore", "pipe", "pipe">;
  out(): string;
  err(): string;
  /** Resolves once `text` has been written to standard error. */
  logged(text: string): Promise<void>;
  /** Resolves once `READY` is on standard output; rejects if the process exits first. */
  ready(): Promise<void>;
  /** Sends `signal` (`SIGTERM` unless given) and resolves with the exit code and how long the process took to exit. */
  stop(signal?: "SIGTERM" | "SIGINT"): Promise<{ code: number | null; ms: number }>;
}

/** Runs `bun <args>` from the example's folder, collecting both outputs. */
function launch(args: readonly string[]): Engine {
  const proc = Bun.spawn([process.execPath, ...args], { cwd: HYPER, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  running.push(proc);
  let out = "";
  let err = "";
  const listeners = new Set<() => void>();
  const pump = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      append(decoder.decode(chunk, { stream: true }));
      for (const listener of listeners) listener();
    }
  };
  void pump(proc.stdout, (text) => (out += text));
  void pump(proc.stderr, (text) => (err += text));
  const until = (holds: () => boolean, what: string) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!holds()) return;
        listeners.delete(check);
        resolve();
      };
      listeners.add(check);
      check();
      void proc.exited.then(() => {
        listeners.delete(check);
        if (holds()) resolve();
        else reject(new Error(`the process exited (${proc.exitCode}) before ${what}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`));
      });
    });
  return {
    proc,
    out: () => out,
    err: () => err,
    logged: (text) => until(() => err.includes(text), `it logged ${JSON.stringify(text)}`),
    ready: () => until(() => out.includes("READY\n"), "it printed READY"),
    async stop(signal = "SIGTERM") {
      const started = performance.now();
      proc.kill(signal);
      const code = await proc.exited;
      return { code, ms: performance.now() - started };
    },
  };
}

interface Response {
  readonly id: number;
  readonly result?: Record<string, any>;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: any };
}

/** A client that sends one request per line and matches each response to its request by id. */
async function connect(socket: string) {
  const pending = new Map<number, (response: Response) => void>();
  const decoder = new TextDecoder();
  let buffer = "";
  const connection = await Bun.connect({
    unix: socket,
    socket: {
      data(_socket, chunk) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const response = JSON.parse(buffer.slice(0, end)) as Response;
          buffer = buffer.slice(end + 1);
          pending.get(response.id)?.(response);
          pending.delete(response.id);
        }
      },
    },
  });
  let next = 1;
  return {
    call(method: string, params: unknown): Promise<Response> {
      const id = next++;
      const answered = new Promise<Response>((resolve) => pending.set(id, resolve));
      connection.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return answered;
    },
    close: () => connection.end(),
  };
}

const command = (actor: string, payload: Record<string, unknown>) => ({ commandId: crypto.randomUUID(), actor, caller: "test", payload });

/** The names of the collaborators stored in `db`, read straight from the file once the daemon has exited. */
function storedNames(db: string): string[] {
  const database = new Database(db);
  try {
    return database.query<{ name: string }, []>("SELECT name FROM collaborators ORDER BY name").all().map((row) => row.name);
  } finally {
    database.close();
  }
}

describe("the daemon", () => {
  test("bootstraps a workspace with one owner, prints only READY, and exits 0 on SIGTERM", async () => {
    const { socket, db } = scratch();
    const engine = launch([MAIN, "--socket", socket, "--db", db]);
    await engine.ready();
    expect(engine.out()).toBe("READY\n");
    expect(engine.err()).toBe("");

    const client = await connect(socket);
    const { result } = await client.call("workspace.get", {});
    expect(result).toEqual({
      workspace: { id: expect.any(String), name: null, location: "local", state: "active", version: expect.any(Number) },
      owners: [{ id: expect.any(String), kind: "human", name: "owner", state: "active", version: expect.any(Number) }],
      head: 0,
    });

    // The connection stays open: stopping must not wait for an idle client.
    expect(existsSync(socket)).toBe(true);
    const { code, ms } = await engine.stop();
    expect(code).toBe(0);
    expect(ms).toBeLessThan(STOP_MS);
    expect(engine.out()).toBe("READY\n");
    expect(engine.err()).toBe("");
    expect(existsSync(socket)).toBe(false);
    client.close();
  }, TIMEOUT_MS);

  test("a restart on the same --db keeps the workspace, its owner and what was stored, and does not bootstrap again", async () => {
    const { socket, db } = scratch();
    const first = launch([MAIN, "--socket", socket, "--db", db]);
    await first.ready();
    const before = await connect(socket);
    const { result: was } = await before.call("workspace.get", {});
    const owner: string = was!.owners[0].id;
    const registered = await before.call("collaborator.register", command(owner, { kind: "agent", name: "Ann" }));
    expect(registered.result?.collaborator).toMatchObject({ kind: "agent", name: "Ann", state: "active" });
    before.close();
    expect((await first.stop()).code).toBe(0);

    const second = launch([MAIN, "--socket", socket, "--db", db]);
    await second.ready();
    expect(second.out()).toBe("READY\n");
    const after = await connect(socket);
    const { result: is } = await after.call("workspace.get", {});
    expect(is!.workspace.id).toBe(was!.workspace.id);
    expect(is!.owners).toEqual(was!.owners);
    // Ann is still there: registering the name again is the name rule's refusal.
    const again = await after.call("collaborator.register", command(owner, { kind: "agent", name: "Ann" }));
    expect(again.error).toMatchObject({ code: -32003, message: "rule_violation", data: { phase: "content", failures: [{ check: "collaborator.name-unique" }] } });
    // And the owner bootstrap would have made is the one there is.
    const owners = await after.call("collaborator.register", command(owner, { kind: "human", name: "owner" }));
    expect(owners.error?.data.failures[0].check).toBe("collaborator.name-unique");
    after.close();
    expect((await second.stop()).code).toBe(0);
  }, TIMEOUT_MS);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`on ${signal}, the calls inside a transaction commit whole, then it exits 0 well before the grace timer and removes the socket`, async () => {
      const { socket, db } = scratch();
      const engine = launch([TEST_DAEMON, socket, db]);
      await engine.ready();
      const client = await connect(socket);
      const names = ["w0", "w1", "w2"];
      // Each call takes the write lock in turn and holds it across its pause, so they finish one after another.
      for (const name of names) void client.call("test.write-twice", { name, pauseMs: 300 });
      await engine.logged("test.write-twice w0 wrote w0-1");

      const { code, ms } = await engine.stop(signal);
      expect(code).toBe(0);
      expect(ms).toBeLessThan(GRACE_MS / 2);
      expect(engine.err()).not.toContain(GRACE_EXIT);
      expect(existsSync(socket)).toBe(false);
      // A call answered after the connection closed is not sent, so the database is what shows each call finished.
      for (const name of names) expect(engine.err()).toContain(`test.write-twice ${name} committed`);
      expect(storedNames(db).filter((name) => /^w\d-/.test(name))).toEqual(["w0-1", "w0-2", "w1-1", "w1-2", "w2-1", "w2-2"]);
      expect(engine.out()).toBe("READY\n");
      client.close();
    }, TIMEOUT_MS);
  }

  test("SIGINT, like SIGTERM, closes an idle daemon, exits 0 and removes the socket", async () => {
    const { socket, db } = scratch();
    const engine = launch([MAIN, "--socket", socket, "--db", db]);
    await engine.ready();
    const { code, ms } = await engine.stop("SIGINT");
    expect(code).toBe(0);
    expect(ms).toBeLessThan(STOP_MS);
    expect(engine.err()).toBe("");
    expect(existsSync(socket)).toBe(false);
  }, TIMEOUT_MS);

  test("SIGTERM exits 0 within 5 seconds even with a call in flight that never settles", async () => {
    const { socket, db } = scratch();
    const engine = launch([TEST_DAEMON, socket, db]);
    await engine.ready();
    const client = await connect(socket);
    void client.call("test.hang", {});
    await engine.logged("test.hang is running");

    const { code, ms } = await engine.stop();
    expect(code).toBe(0);
    expect(ms).toBeLessThan(STOP_MS);
    expect(engine.err()).toContain(GRACE_EXIT);
    expect(engine.out()).toBe("READY\n");
    expect(existsSync(socket)).toBe(false);
    client.close();
  }, TIMEOUT_MS);

  test("a signal while it is still starting waits for start-up to finish, then closes, exits 0 and removes the socket", async () => {
    const { socket, db } = scratch();
    const engine = launch([TEST_DAEMON, socket, db, "500"]);
    await engine.logged("starting");
    expect(existsSync(socket)).toBe(false);

    const { code, ms } = await engine.stop();
    expect(code).toBe(0);
    expect(ms).toBeLessThan(STOP_MS);
    expect(engine.err()).not.toContain(GRACE_EXIT);
    expect(existsSync(socket)).toBe(false);
    // Start-up ran to the end: the workspace and its owner were stored.
    expect(storedNames(db)).toEqual(["owner"]);
  }, TIMEOUT_MS);

  test("over the wire, a caller with no membership is -32001 membership, and every method not served is -32010 before the actor is read", async () => {
    const { socket, db } = scratch();
    const engine = launch([MAIN, "--socket", socket, "--db", db]);
    await engine.ready();
    const client = await connect(socket);

    for (const actor of [crypto.randomUUID(), "nope", ENGINE_ID]) {
      const { error } = await client.call("collaborator.register", command(actor, { kind: "agent", name: "Eve" }));
      expect(error).toEqual({
        code: -32001,
        message: "permission_denied",
        data: { phase: "permission", failures: [{ check: "membership", reason: `no collaborator with id ${actor}; register it, and have an owner grant it a membership` }] },
      });
    }

    const reasons = unserved(methods);
    expect([...reasons.keys()]).toContain("events.read");
    for (const [method, why] of reasons) {
      // An unknown actor would be -32001 had its context been built.
      const { error } = await client.call(method, { ...command(crypto.randomUUID(), {}), taskId: crypto.randomUUID() });
      expect(error).toEqual({
        code: -32010,
        message: "not_implemented",
        data: { phase: "shape", failures: [{ check: "method", reason: `${method} is not implemented by this engine: ${why}` }] },
      });
    }
    client.close();
    expect((await engine.stop()).code).toBe(0);
  }, TIMEOUT_MS);

  test("task.create over the wire returns the new Task's view, with no events until the event log exists", async () => {
    const { socket, db } = scratch();
    const engine = launch([MAIN, "--socket", socket, "--db", db]);
    await engine.ready();
    const client = await connect(socket);
    const { result: workspace } = await client.call("workspace.get", {});
    const owner: string = workspace!.owners[0].id;

    const { result, error } = await client.call("task.create", command(owner, { title: "Write the report", intent: "for the board", priority: 3 }));
    expect(error).toBeUndefined();
    expect(result).toEqual({
      events: [],
      task: {
        id: expect.stringMatching(UUID),
        title: "Write the report",
        intent: "for the board",
        state: "open",
        parentId: null,
        priority: 3,
        creatorId: owner,
        version: 1,
        createdAt: expect.any(String),
        derived: { state: "ready", reasons: [] },
        dependsOn: [],
        assignment: null,
        activeClaim: null,
        pendingSubmission: null,
        reviewer: { collaboratorId: owner, rule: "task-creator" },
      },
    });
    expect(new Date(result!.task.createdAt).toISOString()).toBe(result!.task.createdAt);

    const child = await client.call("task.create", command(owner, { title: "Draft it", parentId: result!.task.id }));
    expect(child.result?.task).toMatchObject({ title: "Draft it", intent: null, parentId: result!.task.id, priority: null, version: 1 });
    const orphan = await client.call("task.create", command(owner, { title: "Lost", parentId: crypto.randomUUID() }));
    expect(orphan.error).toMatchObject({ code: -32005, message: "not_found", data: { phase: "permission", failures: [{ check: "exists" }] } });
    client.close();
    expect((await engine.stop()).code).toBe(0);
  }, TIMEOUT_MS);

  test("each usage error exits 2 with the usage on standard error and nothing on standard output", async () => {
    const { socket, db } = scratch();
    const cases: readonly [readonly string[], string][] = [
      [["--db", db], "--socket is required"],
      [["--socket", socket], "--db is required"],
      [["--socket", socket, "--db", db, "--plugins", "plugins.ts"], "--plugins is not supported yet"],
      [["--socket", socket, "--db", db, "--lease-ms", "1000"], "--lease-ms is not supported yet"],
      [["--socket", socket, "--db", db, "--verbose"], "--verbose"],
      [["--socket", socket, "--db", db, "extra"], "extra"],
      [["--socket"], "--socket"],
    ];
    for (const [args, message] of cases) {
      const engine = launch([MAIN, ...args]);
      expect(await engine.proc.exited).toBe(2);
      expect(engine.out()).toBe("");
      expect(engine.err()).toContain(message);
      expect(engine.err()).toContain("usage: bun examples/hyper/main.ts --socket <path> --db <path>");
    }
  }, TIMEOUT_MS);

  test("a database it cannot open exits 1, with the reason on standard error", async () => {
    const { socket, dir } = scratch();
    const engine = launch([MAIN, "--socket", socket, "--db", dir]);
    expect(await engine.proc.exited).toBe(1);
    expect(engine.out()).toBe("");
    expect(engine.err()).toContain("the engine could not start");
  }, TIMEOUT_MS);
});
