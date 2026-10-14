/**
 * Starts an engine daemon from ENGINE_CMD with a temporary socket and database,
 * and waits for its READY line (PROTOCOL.md#daemon).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import { RpcClient } from "./rpc.ts";

export const ENGINE_CMD = process.env.ENGINE_CMD?.trim() || undefined;
export const READY_TIMEOUT_MS = Number(process.env.ENGINE_READY_TIMEOUT_MS ?? 30_000);

export interface EngineOptions {
  /** Defaults to ENGINE_CMD. */
  cmd?: string;
  leaseMs?: number;
  plugins?: string;
  /** Reuse an existing temp dir (and so its database) — for restart tests. Never deleted on a failed start. */
  dir?: string;
  /** Defaults to ENGINE_READY_TIMEOUT_MS or 30 s. */
  readyTimeoutMs?: number;
  /** How long the engine gets to exit after SIGTERM (PROTOCOL.md#daemon: 5 s). */
  stopTimeoutMs?: number;
}

/** Thrown by stop() when the engine had to be SIGKILLed: the daemon broke the shutdown requirement. */
export class ForcedShutdownError extends Error {}
/** Thrown by stop() when the engine exited on its own, or exited non-zero after SIGTERM. */
export class UnexpectedExitError extends Error {}

/** Tracks a process's descendants (polling `ps`), so they can be killed even after being reparented. */
export class ProcessTree {
  readonly seen = new Set<number>();
  private timer: Timer;
  constructor(readonly root: number) {
    this.timer = setInterval(() => this.scan(), 200);
    this.timer.unref?.();
  }
  scan() {
    const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="]);
    const children = new Map<number, number[]>();
    for (const line of r.stdout.toString().trim().split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!pid || ppid === undefined) continue;
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
    const queue = [this.root, ...this.seen];
    while (queue.length) {
      for (const c of children.get(queue.pop()!) ?? []) {
        if (!this.seen.has(c)) {
          this.seen.add(c);
          queue.push(c);
        }
      }
    }
  }
  stopWatching() {
    clearInterval(this.timer);
  }
  /** Gives descendants 1 s to exit on their own, then SIGKILLs the rest. */
  async killRemaining() {
    this.stopWatching();
    const alive = () => [...this.seen].filter((p) => isAlive(p));
    const end = Date.now() + 1000;
    while (alive().length && Date.now() < end) await Bun.sleep(50);
    for (const p of alive()) {
      try {
        process.kill(p, "SIGKILL");
      } catch {}
    }
  }
}

export function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface EngineHandle {
  dir: string;
  socket: string;
  db: string;
  proc: Subprocess<"ignore", "pipe", "pipe">;
  /** stdout + stderr captured so far, for failure messages. */
  output(): string;
  connect(): Promise<RpcClient>;
  /** SIGTERM, wait for exit (SIGKILL after 5 s). Keeps the dir. */
  stop(): Promise<void>;
  /** stop() and delete the temp dir. */
  dispose(): Promise<void>;
}

export async function startEngine(opts: EngineOptions = {}): Promise<EngineHandle> {
  const cmd = opts.cmd ?? ENGINE_CMD;
  if (!cmd) throw new Error("ENGINE_CMD is not set: export ENGINE_CMD=\"<command that starts the engine>\"");
  // Unix socket paths are limited to ~104 bytes on macOS: keep the dir short.
  const ownsDir = opts.dir === undefined;
  const dir = opts.dir ?? mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "hyp-"));
  const socket = join(dir, "e.sock");
  const db = join(dir, "engine.db");
  const flags = [`--socket ${q(socket)}`, `--db ${q(db)}`];
  if (opts.leaseMs !== undefined) flags.push(`--lease-ms ${opts.leaseMs}`);
  if (opts.plugins) flags.push(`--plugins ${q(opts.plugins)}`);

  const proc = spawn(["sh", "-c", `exec ${cmd} ${flags.join(" ")}`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Every process the engine starts (e.g. the Bun plugin host and its workers), tracked while it runs, so that
  // cleanup can reach them even after they are reparented when the engine exits.
  const tree = new ProcessTree(proc.pid);
  let exitStatus: { code: number | null; signal: string | null } | undefined;
  let stopping = false;
  void proc.exited.then(() => {
    exitStatus = { code: proc.exitCode, signal: proc.signalCode };
  });
  let out = "";
  let ready = false;
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 5000;
  const readyPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`engine did not print READY within ${readyTimeoutMs} ms\n--- output ---\n${out}`)),
      readyTimeoutMs,
    );
    const pump = async (stream: ReadableStream<Uint8Array>, isStdout: boolean) => {
      const dec = new TextDecoder();
      let line = "";
      for await (const chunk of stream) {
        const text = dec.decode(chunk, { stream: true });
        out += text;
        if (out.length > 200_000) out = out.slice(-100_000);
        if (!isStdout || ready) continue;
        line += text;
        const lines = line.split("\n");
        line = lines.pop() ?? "";
        if (lines.some((l) => l.trim() === "READY")) {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
      }
    };
    const pumps = Promise.all([pump(proc.stdout, true), pump(proc.stderr, false)]);
    void proc.exited.then(async (code) => {
      // Drain what the process wrote before exiting, so the error carries its output.
      await Promise.race([pumps, Bun.sleep(1000)]);
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`engine exited with code ${code} before READY\n--- output ---\n${out}`));
      }
    });
  });
  try {
    await readyPromise;
  } catch (e) {
    // Never leak the child, its descendants or a directory this call created.
    tree.scan();
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await proc.exited;
    await tree.killRemaining();
    if (ownsDir) rmSync(dir, { recursive: true, force: true });
    throw Object.assign(e as Error, { dir, pid: proc.pid });
  }

  const clients: RpcClient[] = [];
  const doStop = async () => {
    // An exit before we asked for one is a crash, even if every response was already sent.
    const crashed = exitStatus !== undefined && !stopping ? exitStatus : undefined;
    stopping = true;
    await Promise.all(clients.map((c) => c.close()));
    tree.scan();
    let forced = false;
    if (!crashed) {
      proc.kill("SIGTERM");
      const t = setTimeout(() => {
        forced = true;
        tree.scan();
        proc.kill("SIGKILL");
      }, stopTimeoutMs);
      await proc.exited;
      clearTimeout(t);
    }
    tree.stopWatching();
    await tree.killRemaining();
    if (crashed) {
      throw new UnexpectedExitError(
        `engine exited on its own (code ${crashed.code}, signal ${crashed.signal}) before the suite stopped it\n--- output ---\n${out}`,
      );
    }
    if (forced) {
      throw new ForcedShutdownError(
        `engine did not exit within ${stopTimeoutMs} ms of SIGTERM and was killed (PROTOCOL.md#daemon requires a clean exit within 5 s)`,
      );
    }
    if (proc.exitCode !== 0) {
      throw new UnexpectedExitError(
        `engine exited with code ${proc.exitCode}, signal ${proc.signalCode} after SIGTERM; PROTOCOL.md#daemon requires exit code 0\n--- output ---\n${out}`,
      );
    }
  };
  let stopped: Promise<void> | undefined;
  /** Idempotent: repeated calls share one shutdown and its outcome. */
  const stop = () => (stopped ??= doStop());
  return {
    dir,
    socket,
    db,
    proc,
    output: () => out,
    async connect() {
      const c = await RpcClient.connect(socket);
      clients.push(c);
      return c;
    },
    stop,
    async dispose() {
      try {
        await stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function q(s: string) {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
