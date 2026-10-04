/// <reference types="bun" />
// Fails when the docs dependency versions pinned for Docker (docker/bun.lock) differ from
// package.json, so the image cannot silently build with other versions than the workspace.
import { join } from "node:path";

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

if (problems.length > 0) {
  console.error(`docker lockfile out of step:\n- ${problems.join("\n- ")}`);
  console.error("Regenerate: copy package.json deps into docker/package.json, then run `bun install` in a copy of docker/ outside the workspace and copy bun.lock back.");
  process.exit(1);
}
console.log(`docker lockfile matches package.json (${names.map((n) => `${n}@${pkg.devDependencies[n]}`).join(", ")})`);
