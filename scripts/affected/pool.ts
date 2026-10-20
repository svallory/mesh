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
// These are scheduling hints only: unknown packages retain their original order.
export const PACKAGE_WEIGHTS: Readonly<Record<string, number>> = {
  "packages/compiler": 44.97,
  "packages/cli": 38.40,
  "packages/data-sqlite": 19.99,
  "examples/hyper": 15.80,
  "packages/bus-local": 11.99,
  "examples/blog": 4.28,
  "packages/model": 0.02,
};
// The sequential selection peaked at 0.94 GiB (cgroup memory.peak). Two
// simultaneous packages leave ample headroom under Forge's 4 GiB command cap.
export const DEFAULT_JOBS = 2;

export function orderedTasks(tasks: readonly TestTask[], jobs: number): TestTask[] {
  if (jobs === 1) return [...tasks];
  return [...tasks].sort((a, b) => (PACKAGE_WEIGHTS[b.id] ?? 0) - (PACKAGE_WEIGHTS[a.id] ?? 0));
}

/** Drain both pipes while the child runs, including output larger than a pipe's capacity. */
export async function executeTask(task: TestTask, streaming: boolean): Promise<TestResult> {
  if (streaming) {
    const proc = Bun.spawn(task.argv, { cwd: task.cwd, stdout: "inherit", stderr: "inherit" });
    return { code: await proc.exited, output: new Uint8Array() };
  }
  const proc = Bun.spawn(task.argv, { cwd: task.cwd, stdout: "pipe", stderr: "pipe" });
  const chunks: Uint8Array[] = [];
  async function drain(stream: ReadableStream<Uint8Array>) {
    for await (const chunk of stream) chunks.push(chunk);
  }
  const [code] = await Promise.all([proc.exited, drain(proc.stdout), drain(proc.stderr)]);
  return { code, output: Buffer.concat(chunks) };
}

/** Bounded, work-conserving pool. A failed/spawn-rejected task never skips the rest. */
export async function runPool(
  tasks: readonly TestTask[],
  jobs: number,
  execute: (task: TestTask, streaming: boolean) => Promise<TestResult> = executeTask,
  print: (output: Uint8Array) => void = (output) => { process.stdout.write(output); },
): Promise<string[]> {
  parseJobs(String(jobs));
  const queue = orderedTasks(tasks, jobs);
  const failed = new Set<string>();
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const task = queue[next++]!;
      if (jobs === 1) print(Buffer.from(task.header));
      let result: TestResult;
      try {
        result = await execute(task, jobs === 1);
      } catch (error) {
        result = { code: 1, output: Buffer.from(`test-affected: ${task.id}: ${String(error)}\n`) };
      }
      if (jobs > 1) print(Buffer.concat([Buffer.from(task.header), result.output]));
      else if (result.output.length > 0) print(result.output);
      if (result.code !== 0) failed.add(task.id);
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
  return tasks.filter((task) => failed.has(task.id)).map((task) => task.id);
}
