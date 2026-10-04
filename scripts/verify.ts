// Runs test, typecheck, build and validate for every workspace package that defines them,
// plus a type check of this script. Keeps going after a failure so one run lists every
// broken step; exits 1 if any failed or if nothing ran.
import { Glob } from "bun";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const STEPS = ["test", "typecheck", "build", "validate"] as const;

const rootPackage = await Bun.file(join(root, "package.json")).json();
const dirs: string[] = [];
for (const pattern of rootPackage.workspaces as string[]) {
  for await (const manifest of new Glob(`${pattern}/package.json`).scan({ cwd: root })) {
    dirs.push(dirname(manifest));
  }
}
dirs.sort();

const failed: string[] = [];
let ran = 0;

async function run(label: string, cmd: string[], cwd: string) {
  console.log(`\n=== ${label} ===`);
  ran++;
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) failed.push(label);
}

await run("mesh (.): typecheck scripts", ["bunx", "tsc", "--noEmit"], root);

for (const dir of dirs) {
  const pkg = await Bun.file(join(root, dir, "package.json")).json();
  for (const step of STEPS) {
    if (!pkg.scripts?.[step]) continue;
    await run(`${pkg.name} (${dir}): ${step}`, ["bun", "run", step], join(root, dir));
  }
}

if (ran === 0) {
  console.error("verify: no steps found");
  process.exit(1);
}

console.log(`\n=== verify: ${ran - failed.length}/${ran} steps passed ===`);
if (failed.length > 0) {
  for (const label of failed) console.error(`FAILED: ${label}`);
  process.exit(1);
}
