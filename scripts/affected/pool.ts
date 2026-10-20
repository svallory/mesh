import { writeSync } from "node:fs";

export interface TestTask {
  id: string;
  header: string;
  cwd: string;
  argv: string[];
}

export interface TestResult {
  code: number;
  output: Uint8Array;
}

export function parseJobs(value: string | undefined): number {
  if (value === undefined || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error("--jobs requires a positive whole number");
  }
  return Number(value);
}

// Full-package wall seconds from the sequential model-edit baseline, 2026-10-19.
// Other workspace weights below use test-file counts as estimates (not timings).
// Unknown packages retain their original order; the coverage test catches new workspaces.
export const PACKAGE_WEIGHTS: Readonly<Record<string, number>> = {
  "packages/compiler": 44.97,
  "packages/cli": 38.40,
  "packages/data-sqlite": 19.99,
  "examples/hyper": 15.80,
  "packages/bus-local": 11.99,
  "examples/blog": 4.28,
  "packages/model": 0.02,
  // Estimated from test-file counts, not seconds; no extra full-suite benchmark.
  "packages/runtime": 16,
  "apps/docs": 12,
  "packages/jsonrpc": 3,
  "packages/data-drizzle": 2,
  "packages/create-meshfw": 1,
};
// The sequential selection peaked at 0.94 GiB (cgroup memory.peak). Two
// simultaneous packages leave ample headroom under Forge's 4 GiB command cap.
export const DEFAULT_JOBS = 2;

export function orderedTasks(tasks: readonly TestTask[], jobs: number): TestTask[] {
  if (jobs === 1) return [...tasks];
  return [...tasks].sort((a, b) => (PACKAGE_WEIGHTS[b.id] ?? 0) - (PACKAGE_WEIGHTS[a.id] ?? 0));
}

export interface LiveExecution {
  pid?: number;
  onOutput: (chunk: Uint8Array) => void;
  stop?: () => void;
}

/** Drain both pipes while the child runs, exposing partial output for interruption. */
export async function executeTask(task: TestTask, streaming: boolean, live?: LiveExecution): Promise<TestResult> {
  if (streaming) {
    const proc = Bun.spawn(task.argv, { cwd: task.cwd, stdout: "inherit", stderr: "inherit" });
    return { code: await proc.exited, output: new Uint8Array() };
  }
  // A separate process group lets interruption stop the package script's children too.
  const proc = Bun.spawn(task.argv, { cwd: task.cwd, stdout: "pipe", stderr: "pipe", detached: true });
  if (live) {
    live.pid = proc.pid;
    live.stop = () => {
      try { process.kill(-proc.pid, "SIGKILL"); }
      catch { proc.kill("SIGKILL"); } // Hosts without POSIX process groups.
    };
  }
  const chunks: Uint8Array[] = [];
  async function drain(stream: ReadableStream<Uint8Array>) {
    for await (const chunk of stream) {
      chunks.push(chunk);
      live?.onOutput(chunk);
    }
  }
  const [code] = await Promise.all([proc.exited, drain(proc.stdout), drain(proc.stderr)]);
  return { code, output: Buffer.concat(chunks) };
}

// Synchronous writes also preserve buffered diagnostics immediately before signal exit.
function writeOutput(output: Uint8Array, fd = 1): void {
  let offset = 0;
  while (offset < output.length) offset += writeSync(fd, output, offset, output.length - offset);
}

/** Bounded, work-conserving pool. A failed/spawn-rejected task never skips the rest. */
export async function runPool(
  tasks: readonly TestTask[],
  jobs: number,
  execute: (task: TestTask, streaming: boolean, live: LiveExecution) => Promise<TestResult> = executeTask,
  print: (output: Uint8Array) => void = writeOutput,
): Promise<string[]> {
  parseJobs(String(jobs));
  const queue = orderedTasks(tasks, jobs);
  const failed = new Set<string>();
  const completed = new Set<string>();
  const running = new Map<TestTask, { chunks: Uint8Array[]; live: LiveExecution }>();
  const concurrency = Math.min(jobs, queue.length);
  const streaming = concurrency === 1;
  function interrupt(signal: "SIGINT" | "SIGTERM" | "SIGHUP"): never {
    // A hung-up terminal can reject every write. Stop all groups before any I/O.
    for (const state of running.values()) {
      try { state.live.stop?.(); } catch { /* The child may already have exited. */ }
    }
    for (const [task, state] of running) {
      try {
        print(Buffer.concat([Buffer.from(task.header), ...state.chunks, Buffer.from(`\ntest-affected: interrupted ${task.id} (${signal})\n`)]));
      } catch { /* Best effort: the terminal or redirected stream may be gone. */ }
    }
    // Include pending work as failed too: interruption must never imply it passed.
    for (const task of tasks) if (!completed.has(task.id)) failed.add(task.id);
    try {
      writeOutput(Buffer.from(`\ntest-affected: FAILED: ${tasks.filter((task) => failed.has(task.id)).map((task) => task.id).join(", ")}\n`), 2);
    } catch { /* Best effort on stderr too; cleanup and the signal exit still hold. */ }
    process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
  }
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  const onHup = () => interrupt("SIGHUP");
  if (!streaming && concurrency > 0) {
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    process.on("SIGHUP", onHup);
  }
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const task = queue[next++]!;
      if (streaming) print(Buffer.from(task.header));
      else writeOutput(Buffer.from(`test-affected: started ${task.id}\n`), 2);
      const chunks: Uint8Array[] = [];
      const live: LiveExecution = { onOutput: (chunk) => { chunks.push(chunk); } };
      running.set(task, { chunks, live });
      let result: TestResult;
      try {
        result = await execute(task, streaming, live);
      } catch (error) {
        result = { code: 1, output: Buffer.from(`test-affected: ${task.id}: ${String(error)}\n`) };
      }
      if (!streaming) print(Buffer.concat([Buffer.from(task.header), result.output]));
      else if (result.output.length > 0) print(result.output);
      running.delete(task);
      completed.add(task.id);
      if (result.code !== 0) failed.add(task.id);
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
    return tasks.filter((task) => failed.has(task.id)).map((task) => task.id);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);
  }
}
