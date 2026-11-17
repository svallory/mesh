// Start a worker script of the multi-process group as a second OS process (a copy of data-sqlite's), and resolve once it prints READY: what the
// `multiProcess.spawn` member of a bus conformance fixture does.
import type { MultiProcessWorker } from "@meshfw/runtime/testing";

export async function spawnWorker(script: string, file: string, scenario: string, args: readonly string[]): Promise<MultiProcessWorker> {
  const child = Bun.spawn([process.execPath, script, file, scenario, ...args], { stdout: "pipe", stderr: "inherit", env: { ...process.env } });
  let text = "";
  let ready!: () => void;
  let failed!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      text += decoder.decode(chunk, { stream: true });
      if (text.includes("READY ")) ready();
    }
  })();
  const done = (async () => { await child.exited; await reading; return text; })();
  void done.then(() => failed(new Error(`the worker ${scenario} exited before READY:\n${text}`)));
  await started;
  return {
    pid: child.pid,
    // process.kill, not child.kill: Bun's subprocess.kill maps SIGSTOP and SIGCONT to Linux's numbers on macOS (1.4.2).
    kill: (signal) => { try { process.kill(child.pid, signal); } catch { /* exited already */ } },
    output: () => text,
    done,
  };
}
