import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_JOBS, executeTask, orderedTasks, parseJobs, runPool, type TestResult, type TestTask } from "./pool.ts";

const task = (id: string): TestTask => ({ id, header: `\n=== ${id}\n`, cwd: process.cwd(), argv: [] });
const result = (text: string, code = 0): TestResult => ({ code, output: Buffer.from(text) });

function controlled() {
  const started: string[] = [];
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<TestResult>>>();
  const execute = (item: TestTask) => {
    started.push(item.id);
    const deferred = Promise.withResolvers<TestResult>();
    pending.set(item.id, deferred);
    return deferred.promise;
  };
  const finish = (id: string, code = 0) => pending.get(id)!.resolve(result(`${id} stdout\n${id} stderr\n`, code));
  return { started, execute, finish };
}

describe("package pool", () => {
  test("jobs is a positive safe integer, with a conservative default", () => {
    expect(DEFAULT_JOBS).toBe(2);
    expect(parseJobs("1")).toBe(1);
    expect(parseJobs("8")).toBe(8);
    for (const value of [undefined, "", "0", "-1", "1.5", "2x", "Infinity", "NaN", "9007199254740992"]) {
      expect(() => parseJobs(value)).toThrow("positive whole number");
    }
  });

  test("starts the longest packages first with stable ties and leaves input untouched", () => {
    const tasks = [task("unknown-a"), task("packages/model"), task("packages/cli"), task("unknown-b"), task("packages/compiler")];
    expect(orderedTasks(tasks, 2).map((t) => t.id)).toEqual([
      "packages/compiler", "packages/cli", "packages/model", "unknown-a", "unknown-b",
    ]);
    expect(tasks.map((t) => t.id)).toEqual(["unknown-a", "packages/model", "packages/cli", "unknown-b", "packages/compiler"]);
  });

  test("bounds active work and immediately fills a freed slot", async () => {
    const control = controlled();
    const outputs: string[] = [];
    const done = runPool([task("a"), task("b"), task("c"), task("d")], 2, control.execute, (text) => outputs.push(Buffer.from(text).toString()));
    expect(control.started).toEqual(["a", "b"]);
    expect(outputs).toEqual([]);
    control.finish("b");
    await Promise.resolve();
    expect(control.started).toEqual(["a", "b", "c"]);
    control.finish("c");
    await Promise.resolve();
    expect(control.started).toEqual(["a", "b", "c", "d"]);
    control.finish("a");
    control.finish("d");
    expect(await done).toEqual([]);
  });

  test("keeps each header and both output streams in one completion block", async () => {
    const control = controlled();
    const outputs: string[] = [];
    const done = runPool([task("a"), task("b")], 2, control.execute, (text) => outputs.push(Buffer.from(text).toString()));
    control.finish("b");
    await Promise.resolve();
    expect(outputs).toEqual(["\n=== b\nb stdout\nb stderr\n"]);
    control.finish("a");
    await done;
    expect(outputs).toEqual(["\n=== b\nb stdout\nb stderr\n", "\n=== a\na stdout\na stderr\n"]);
  });

  test("reports every failure in selection order and still runs remaining tasks including root scripts", async () => {
    const ran: string[] = [];
    const printed: string[] = [];
    const failed = await runPool([task("packages/model"), task("packages/compiler"), task("scripts (repository root)")], 2, async (item) => {
      ran.push(item.id);
      return result(`failure of ${item.id}\n`, 1);
    }, (output) => printed.push(Buffer.from(output).toString()));
    expect(ran).toEqual(["packages/compiler", "packages/model", "scripts (repository root)"]);
    expect(failed).toEqual(["packages/model", "packages/compiler", "scripts (repository root)"]);
    expect(printed).toHaveLength(3);
    expect(printed.join("")).toContain("failure of scripts (repository root)");
  });

  test("a spawn exception is a reported failure, not an early pool rejection", async () => {
    const printed: string[] = [];
    const ran: string[] = [];
    expect(await runPool([task("bad"), task("good")], 2, async (item) => {
      ran.push(item.id);
      if (item.id === "bad") throw new Error("cannot spawn");
      return result("good\n");
    }, (text) => printed.push(Buffer.from(text).toString()))).toEqual(["bad"]);
    expect(ran).toEqual(["bad", "good"]);
    expect(printed.join("")).toContain("bad: Error: cannot spawn");
    expect(printed.join("")).toContain("=== good\ngood");
  });

  test("jobs 1 preserves original order, streams, and prints the header before starting", async () => {
    const events: string[] = [];
    const ids = ["packages/model", "packages/cli", "packages/compiler", "scripts (repository root)"];
    expect(await runPool(ids.map(task), 1, async (item, streaming) => {
      expect(streaming).toBe(true);
      events.push(`start ${item.id}`);
      return result("", item.id === "packages/cli" ? 1 : 0);
    }, (text) => events.push(Buffer.from(text).toString()))).toEqual(["packages/cli"]);
    expect(events).toEqual(ids.flatMap((id) => [`\n=== ${id}\n`, `start ${id}`]));
  });

  test("empty and oversized pools run each task exactly once", async () => {
    const ran: string[] = [];
    const execute = async (item: TestTask) => { ran.push(item.id); return result(""); };
    expect(await runPool([], 2, execute, () => {})).toEqual([]);
    expect(await runPool([task("only")], 50, execute, () => {})).toEqual([]);
    expect(ran).toEqual(["only"]);
    await expect(runPool([task("no")], 0, execute)).rejects.toThrow("positive whole number");
  });

  test("real child pipes are drained beyond capacity and a non-zero exit is retained", async () => {
    const actual = await executeTask({ ...task("child"), argv: [process.execPath, "--eval", 'process.stdout.write("A".repeat(200000)); process.stderr.write("B".repeat(200000)); process.exitCode = 7;'] }, false);
    expect(actual.code).toBe(7);
    expect(actual.output.length).toBe(400000);
    const text = Buffer.from(actual.output).toString();
    expect([...text].filter((c) => c === "A")).toHaveLength(200000);
    expect([...text].filter((c) => c === "B")).toHaveLength(200000);
  });
});

describe("jobs CLI", () => {
  const cli = join(import.meta.dir, "../test-affected.ts");
  test.each(["--jobs", "-j"])("%s accepts a number and dry-run never starts package tests", (flag) => {
    const proc = Bun.spawnSync([process.execPath, cli, flag, "1", "--dry-run", "--all", "--slow", "--no-slow", "--base", "HEAD"], { stdout: "pipe", stderr: "pipe" });
    const output = proc.stdout.toString();
    expect(proc.exitCode).toBe(0);
    expect(output).toContain("=== scripts (repository root)");
    expect(output).toContain("skipped slow test file(s)");
    expect(output).toContain("nothing run");
    expect(proc.stderr.toString()).not.toContain("bun test v");
  });
  test.each([{ args: ["--jobs"] }, { args: ["-j", "0"] }, { args: ["--jobs", "1.5"] }, { args: ["--jobs", "--dry-run"] }])("rejects malformed jobs arguments %j with usage exit 2", ({ args }) => {
    const proc = Bun.spawnSync([process.execPath, cli, ...args]);
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("positive whole number");
    expect(proc.stdout.toString()).toContain("usage:");
  });
});
