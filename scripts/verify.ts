// Runs test, typecheck, build, validate and conformance for every workspace package that
// defines them, plus a type check and the tests of scripts/. Keeps going after a failure so
// one run lists every broken step; exits 1 if any failed or if nothing ran.
//
// `--group <name>` runs only that group's steps (scripts/verify-groups.json; CI runs one
// job per group). It refuses to run when the groups file and the workspace disagree, so a
// package in no group fails every group job instead of running nowhere. A groups file that cannot be read or has
// the wrong shape also fails --group; without --group it is only reported, and every step runs.
import { join } from "node:path";
import { checkGroups, parseVerifyArgs, planAll, planGroup, readGroups, readWorkspace } from "./verify/plan.ts";

const root = join(import.meta.dir, "..");

const args = parseVerifyArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(args.error);
  process.exit(2);
}

const { dirs, manifests } = await readWorkspace(root);
const loaded = await readGroups(root);
if (args.group !== undefined && "groups" in loaded && !Object.hasOwn(loaded.groups.groups, args.group)) {
  console.error(`verify: unknown group ${args.group}; groups: ${Object.keys(loaded.groups.groups).join(", ")}`);
  process.exit(2);
}

const problems = "groups" in loaded ? checkGroups(dirs, loaded.groups) : loaded.problems;
if (args.group !== undefined && problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
// Without --group every step runs anyway, so a problem is only reported.
for (const problem of problems) console.error(`${problem} (warning: CI runs groups)`);

const all = planAll(dirs, manifests);
// `loaded` has groups here: with --group, a problem has already exited.
const steps = args.group === undefined || !("groups" in loaded) ? all : planGroup(all, loaded.groups, args.group);

const failed: string[] = [];
let ran = 0;

for (const step of steps) {
  console.log(`\n=== ${step.label} ===`);
  ran++;
  const proc = Bun.spawn(step.argv, { cwd: join(root, step.cwd), stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) failed.push(step.label);
}

if (ran === 0) {
  console.error("verify: no steps found");
  process.exit(1);
}

console.log(`\n=== verify: ${ran - failed.length}/${ran} steps passed ===`);
// data-postgres's server tests skip without a server, so a run that skipped them says so in its summary.
if (steps.some((step) => step.cwd === "packages/data-postgres" && step.label.endsWith(": test")) && !process.env.MESH_TEST_POSTGRES_URL?.trim()) {
  console.log("data-postgres server tests: skipped (MESH_TEST_POSTGRES_URL not set)");
}
if (failed.length > 0) {
  for (const label of failed) console.error(`FAILED: ${label}`);
  process.exit(1);
}
