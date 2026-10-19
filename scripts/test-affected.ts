// `bun run test:affected`: run only the tests a change affects.
//
// Selects the workspace packages touched by the files changed against a base
// (default origin/main; uncommitted and untracked files count too) plus every
// workspace package that depends on them, transitively, and runs each selected
// package's own `test` script one at a time. A package whose changed files are
// all test files runs only those files, through the package's own script when
// its form makes that safe. Slow test files (scripts/slow-tests.json) are
// skipped unless --slow is passed or the file itself changed. A root/config
// change (and --all) also runs the repository's own script tests.
//
// Flags: --base <ref>, --dry-run, --slow, --no-slow, --all.
import { Glob } from "bun";
import { dirname, join } from "node:path";
import {
  buildWorkspaceGraph,
  commandFor,
  parseNameStatus,
  selectAffected,
  type FileChange,
  type Manifest,
} from "./affected/select.ts";

const root = join(import.meta.dir, "..");
const DEFAULT_BASE = "origin/main";

function usage(code: number): never {
  console.log(`usage: bun run test:affected [--base <ref>] [--dry-run] [--slow|--no-slow] [--all]`);
  process.exit(code);
}

const args = process.argv.slice(2);
let base = DEFAULT_BASE;
let dryRun = false;
let slow = false;
let all = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--base") base = args[++i] ?? usage(2);
  else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--slow") slow = true;
  else if (arg === "--no-slow") slow = false;
  else if (arg === "--all") all = true;
  else if (arg === "--help" || arg === "-h") usage(0);
  else {
    console.error(`test-affected: unknown argument: ${arg}`);
    usage(2);
  }
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    console.error(`test-affected: git ${args.join(" ")} failed:\n${proc.stderr.toString().trim()}`);
    process.exit(1);
  }
  return proc.stdout.toString();
}

// Changed files: everything tracked that differs from the base (committed on this
// branch, staged or unstaged), plus untracked files. --no-renames turns a rename
// into a delete of the old path plus an add of the new one.
const changes: FileChange[] = [
  ...parseNameStatus(git(["diff", "--no-renames", "--name-status", base])),
  ...git(["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((path) => ({ path, kind: "add" as const })),
];

// Workspace manifests: raw dependency fields plus each `test` script, resolved
// into the workspace graph after every manifest is known (order and version
// specs do not matter; see buildWorkspaceGraph).
const rootPackage = await Bun.file(join(root, "package.json")).json();
const manifests: Manifest[] = [];
const testScripts = new Map<string, string>();
for (const pattern of rootPackage.workspaces as string[]) {
  for await (const manifestPath of new Glob(`${pattern}/package.json`).scan({ cwd: root })) {
    const pkg = await Bun.file(join(root, manifestPath)).json();
    const dir = dirname(manifestPath);
    manifests.push({
      dir,
      name: pkg.name,
      deps: {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      },
    });
    if (typeof pkg.scripts?.test === "string") testScripts.set(dir, pkg.scripts.test);
  }
}
const workspaces = buildWorkspaceGraph(manifests);

const slowManifest = await Bun.file(join(root, "scripts", "slow-tests.json")).json();
const slowFiles: string[] = slowManifest.files;

const selection = selectAffected(changes, workspaces, slowFiles, { slow, all });

console.log(`test-affected: base ${base}, ${changes.length} changed file(s)`);
if (selection.mode === "none") {
  console.log(`test-affected: ${selection.note}`);
  process.exit(0);
}
if (selection.mode === "all") console.log(`test-affected: ${selection.note}`);

const failed: string[] = [];
for (const run of selection.runs) {
  const skip = run.skipSlow.length > 0 ? ` (skipping ${run.skipSlow.length} slow file(s): ${run.skipSlow.join(", ")})` : "";
  console.log(`\n=== ${run.name} (${run.dir}) — ${run.reason}${skip}`);
  if (run.skipSlow.length > 0) {
    console.log(`  skipped slow test file(s), run with --slow: ${run.skipSlow.map((f) => `${run.dir}/${f}`).join(", ")}`);
  }
  if (dryRun) continue;
  const argv = commandFor(run, testScripts.get(run.dir));
  const proc = Bun.spawn(["bun", ...argv], { cwd: join(root, run.dir), stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) failed.push(run.dir);
}

if (selection.rootTests) {
  console.log(`\n=== scripts (repository root) — root or config change: the scripts' own tests`);
  if (!dryRun) {
    const proc = Bun.spawn(["bun", "test", "scripts/"], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if ((await proc.exited) !== 0) failed.push("scripts (repository root)");
  }
}

if (dryRun) {
  console.log(`\ntest-affected --dry-run: ${selection.runs.length} package(s)${selection.rootTests ? " plus the root script tests" : ""}, nothing run`);
  process.exit(0);
}
if (failed.length > 0) {
  console.error(`\ntest-affected: FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\ntest-affected: ${selection.runs.length} package(s)${selection.rootTests ? " plus the root script tests" : ""} passed`);
