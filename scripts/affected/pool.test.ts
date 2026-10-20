import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { Glob } from "bun";
import { DEFAULT_JOBS, PACKAGE_WEIGHTS, executeTask, orderedTasks, parseJobs, runPool, type TestResult, type TestTask } from "./pool.ts";

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

  test("every workspace has a scheduling weight, including test-count estimates", async () => {
    const root = join(import.meta.dir, "../..");
    const pkg = await Bun.file(join(root, "package.json")).json();
    for (const pattern of pkg.workspaces as string[]) {
      for await (const path of new Glob(`${pattern}/package.json`).scan({ cwd: root })) {
        expect(PACKAGE_WEIGHTS[dirname(path)]).toBeGreaterThan(0);
      }
    }
  });

  test("a single selected task streams live even with a larger jobs limit", async () => {
    const events: string[] = [];
    expect(await runPool([task("single")], 4, async (item, streaming) => {
      expect(streaming).toBe(true);
      events.push(`start ${item.id}`);
      return result("");
    }, (output) => events.push(Buffer.from(output).toString()))).toEqual([]);
    expect(events).toEqual(["\n=== single\n", "start single"]);
  });

  test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("%s flushes real hung children, names interrupted and pending work, and exits non-zero", async (signal) => {
    const pool = join(import.meta.dir, "pool.ts");
    const childCode = 'const grandchild = Bun.spawn([process.execPath, "--eval", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" }); process.stdout.write("partial stdout PID=" + process.pid + " GRANDCHILD=" + grandchild.pid + "\\n"); process.stderr.write("partial stderr\\n"); setInterval(() => {}, 1000);';
    const source = `
      import { runPool, executeTask } from ${JSON.stringify(pool)};
      const ready = new Set();
      const pids = new Set();
      const tasks = ["hung-a", "hung-b", "pending"].map(id => ({
        id, header: "\\n=== " + id + "\\n", cwd: process.cwd(),
        argv: [process.execPath, "--eval", ${JSON.stringify(childCode)}]
      }));
      await runPool(tasks, 2, (task, streaming, live) => {
        let seen = "";
        const capture = live.onOutput;
        live.onOutput = chunk => {
          capture(chunk);
          seen += Buffer.from(chunk).toString();
          if (!ready.has(task.id) && seen.includes("partial stdout") && seen.includes("partial stderr")) {
            pids.add(seen.match(/PID=(\\d+)/)[1]);
            process.stderr.write("GRANDCHILD " + seen.match(/GRANDCHILD=(\\d+)/)[1] + "\\n");
            ready.add(task.id);
            if (ready.size === 2) process.stderr.write("READY " + [...pids].join(" ") + "\\n");
          }
        };
        const result = executeTask(task, streaming, live);
        process.stderr.write("CHILD " + live.pid + "\\n");
        return result;
      });
    `;
    const proc = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe", detached: true });
    const output = new Response(proc.stdout).text();
    const reader = proc.stderr.getReader();
    let diagnostics = "";
    let children: number[] = [];
    let grandchildren: number[] = [];
    const deadline = setTimeout(() => { proc.kill("SIGKILL"); }, 10_000);
    try {
      while (!diagnostics.includes("READY ")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`fixture ended before readiness: ${diagnostics}`);
        diagnostics += Buffer.from(chunk.value).toString();
        children = [...diagnostics.matchAll(/^CHILD (\d+)/gm)].map((match) => Number(match[1]));
        grandchildren = [...diagnostics.matchAll(/^GRANDCHILD (\d+)/gm)].map((match) => Number(match[1]));
      }
      expect(children).toHaveLength(2);
      expect(grandchildren).toHaveLength(2);
      expect(diagnostics).toContain("test-affected: started hung-a");
      expect(diagnostics).toContain("test-affected: started hung-b");
      expect(diagnostics).not.toContain("test-affected: started pending");
      process.kill(-proc.pid, signal);
      expect(await proc.exited).toBe(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
      const stdout = await output;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        diagnostics += Buffer.from(chunk.value).toString();
      }
      expect(diagnostics).toContain("FAILED: hung-a, hung-b, pending");
      expect(stdout).not.toContain("FAILED:");
      const text = stdout + diagnostics;
      expect(text).toContain("=== hung-a\n");
      expect(text).toContain("=== hung-b\n");
      expect(text.match(/partial stdout/g)).toHaveLength(2);
      expect(text.match(/partial stderr/g)).toHaveLength(2);
      expect(text).toContain(`interrupted hung-a (${signal})`);
      expect(text).toContain(`interrupted hung-b (${signal})`);
      expect(text).toContain("FAILED: hung-a, hung-b, pending");
      // Assert before fallback cleanup: removing the pool's stop() must fail this test.
      for (const pid of [...children, ...grandchildren]) {
        let code: string | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
          try { process.kill(pid, 0); }
          catch (error) { code = (error as NodeJS.ErrnoException).code; break; }
          await Bun.sleep(10);
        }
        expect(code, `process ${pid} must be gone after ${signal}`).toBe("ESRCH");
      }
    } finally {
      clearTimeout(deadline);
      for (const pid of children) { try { process.kill(-pid, "SIGKILL"); } catch { /* Already stopped by the pool. */ } }
      for (const pid of grandchildren) { try { process.kill(pid, "SIGKILL"); } catch { /* Already stopped with its group. */ } }
      try { process.kill(-proc.pid, "SIGKILL"); } catch { /* The parent already exited. */ }
      reader.releaseLock();
      await proc.exited;
    }
  }, 15_000);

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
