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

// Each package's whole `test` script, run sequentially with its slow files included: wall seconds measured on
// forge at main b5e58ba for the test-speed design (2026-11-17); data-drizzle, model and create-meshfw are their
// junit `time` totals. Weights only order already-selected work; they never select or skip tests.
// Unknown packages weigh 0 and keep their original order; the coverage test catches new workspaces.
export const PACKAGE_WEIGHTS: Readonly<Record<string, number>> = {
  "packages/compiler": 43.71,
  "packages/cli": 40.70,
  "packages/data-sqlite": 26.50,
  "examples/hyper": 17.60,
  "packages/bus-local": 9.70,
  "packages/jsonrpc": 5.50,
  "apps/docs": 5.30,
  "examples/blog": 3.70,
  "packages/runtime": 0.30,
  "packages/data-drizzle": 0.04,
  "packages/model": 0.02,
  "packages/create-meshfw": 0.01,
  // Not measured: without MESH_TEST_POSTGRES_URL its server tests skip and it takes about a second; with a server
  // (CI's data group) the whole file set took 127 to 163 s on a shared Mac. Set between the two, so a local run with
  // a server starts it early.
  "packages/data-postgres": 8,
  // Not measured on forge: its whole test script took about 1.2 s on the Mac (2026-11-17), one `mesh build` included.
  "packages/event-sourcing": 1.2,
};
// Measured on forge on 2026-11-17 (each run under a 4 GiB cgroup scope, cgroup memory.peak): a model or a compiler
// edit at four jobs peaked at 2.14 GiB at most (two jobs: 1.31 GiB), under the 3 GiB this budget allows inside
// Forge's 4 GiB command cap, and the median wall fell from 73 s to 59 s for both edits; `--all` peaked at
// 2.12 GiB. bus-local's worker runs in its own 1 GiB scope, outside these figures. `--jobs` overrides per run.
export const DEFAULT_JOBS = 4;

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
