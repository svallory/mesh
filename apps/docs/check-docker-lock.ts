/// <reference types="bun" />
// Fails when the docs dependency versions pinned for Docker (docker/bun.lock) differ from
// package.json, so the image cannot silently build with other versions than the workspace.
import { join } from "node:path";
import { sharedLockProblems } from "./shared-lock-check.js";

const dir = import.meta.dir;
const pkg = await Bun.file(join(dir, "package.json")).json();
const imagePkg = await Bun.file(join(dir, "docker/package.json")).json();
// bun.lock is JSONC (trailing commas), which Bun.JSONC.parse reads.
const lock = Bun.JSONC.parse(await Bun.file(join(dir, "docker/bun.lock")).text()) as {
  workspaces: Record<string, { devDependencies?: Record<string, string> }>;
  packages: Record<string, [string, ...unknown[]]>;
};

const problems: string[] = [];
const names = Object.keys(pkg.devDependencies ?? {});
if (names.length === 0) problems.push("no @docmd/* dependencies found in package.json");

for (const name of names) {
  const want = pkg.devDependencies[name];
  const declared = imagePkg.devDependencies?.[name];
  const locked = lock.packages[name]?.[0]?.slice(name.length + 1);
  const lockedSpec = lock.workspaces[""]?.devDependencies?.[name];
  if (declared !== want) problems.push(`docker/package.json pins ${name}@${declared}, package.json has ${want}`);
  if (lockedSpec !== want) problems.push(`docker/bun.lock declares ${name}@${lockedSpec}, package.json has ${want}`);
  if (locked !== want) problems.push(`docker/bun.lock resolves ${name}@${locked}, package.json has ${want}`);
}

const rootLockFile = Bun.file(join(dir, "../../bun.lock"));
if (await rootLockFile.exists()) {
  const rootLock = Bun.JSONC.parse(await rootLockFile.text()) as typeof lock;
  problems.push(...sharedLockProblems(lock.packages, rootLock.packages));
} else {
  console.log("Root bun.lock unavailable in standalone docs copy; shared-package comparison not applicable.");
}

if (problems.length > 0) {
  console.error(`docker lockfile out of step:\n- ${problems.join("\n- ")}`);
  console.error("Regenerate incrementally: copy docker/package.json AND docker/bun.lock outside the workspace, sync manifest deps, run `bun install`, check shared versions against root bun.lock, then copy bun.lock back.");
  process.exit(1);
}
console.log(`docker lockfile matches package.json (${names.map((n) => `${n}@${pkg.devDependencies[n]}`).join(", ")})`);
