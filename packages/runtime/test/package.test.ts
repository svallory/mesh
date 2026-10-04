import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`Package archive check failed (${command[0]}): ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

test("package archive excludes the Map fake and tests, and both exports load from the archive", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-runtime-pack-"));
  try {
    // Pack the actual workspace, not a prefiltered copy that could hide a packaging regression.
    run([process.execPath, "pm", "pack", "--ignore-scripts", "--destination", dir, "--quiet"], root);
    const archives = readdirSync(dir).filter((name) => name.endsWith(".tgz"));
    expect(archives).toHaveLength(1);
    const archive = join(dir, archives[0]!);
    const entries = run(["tar", "-tzf", archive], dir).trim().split("\n");
    expect(entries.some((name) => name.includes("/test/") || name.endsWith(".test.ts"))).toBe(false);
    expect(entries).toContain("package/package.json");
    run(["tar", "-xzf", archive], dir);
    const manifest = JSON.parse(readFileSync(join(dir, "package/package.json"), "utf8")) as {
      private: boolean; files: string[]; exports: Record<string, string>;
    };
    expect(manifest.private).toBe(true);
    expect(manifest.files).toEqual(["src"]);
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./testing"]);
    for (const target of Object.values(manifest.exports)) {
      expect(entries).toContain(`package/${target.replace(/^\.\//, "")}`);
    }
    const main = pathToFileURL(join(dir, "package", manifest.exports["."]!)).href;
    const testing = pathToFileURL(join(dir, "package", manifest.exports["./testing"]!)).href;
    run([process.execPath, "--eval", `
      const main = await import(${JSON.stringify(main)});
      const testing = await import(${JSON.stringify(testing)});
      if (typeof main.parseInput !== "function" || typeof main.MeshError !== "function") throw new Error("Main export failed");
      if (typeof testing.dataLayerConformance !== "function") throw new Error("Testing export failed");
      if ("dataLayerConformance" in main || "fake" in main || "fake" in testing) throw new Error("Unexpected exported implementation");
    `], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
