// The pure parts of `bun run verify` (scripts/verify.ts): which steps run, in which
// order, and which of them one CI group runs (scripts/verify-groups.json).
import { Glob } from "bun";
import { dirname, join } from "node:path";

export const STEPS = ["test", "typecheck", "build", "validate", "conformance"] as const;

export const GROUPS_FILE = "scripts/verify-groups.json";

export interface Step {
  /** As printed in the run, e.g. "@meshfw/compiler (packages/compiler): test". */
  label: string;
  /** Repository-relative; "." for the root steps. */
  cwd: string;
  argv: string[];
}

export interface VerifyGroups {
  groups: Record<string, { packages: string[]; root?: boolean }>;
}

/** The fields of a workspace package's `package.json` that the plan reads. */
export interface Manifest {
  name?: string;
  scripts?: Record<string, string>;
}

/** The repository's own steps, run before every package's. */
export const ROOT_STEPS: readonly Step[] = [
  { label: "mesh (.): typecheck scripts", cwd: ".", argv: ["bunx", "tsc", "--noEmit"] },
  { label: "mesh (.): test scripts", cwd: ".", argv: ["bun", "test", "scripts/"] },
];

/** Every workspace package directory (repository-relative, sorted) and its manifest. */
export async function readWorkspace(root: string): Promise<{ dirs: string[]; manifests: Map<string, Manifest> }> {
  const rootPackage = await Bun.file(join(root, "package.json")).json();
  const dirs: string[] = [];
  for (const pattern of rootPackage.workspaces as string[]) {
    for await (const manifest of new Glob(`${pattern}/package.json`).scan({ cwd: root })) {
      dirs.push(dirname(manifest));
    }
  }
  dirs.sort();
  const manifests = new Map<string, Manifest>();
  for (const dir of dirs) manifests.set(dir, await Bun.file(join(root, dir, "package.json")).json());
  return { dirs, manifests };
}

/** Every step `verify` runs with no arguments: the root steps, then each package in `dirs` order with each of
 *  `STEPS` its manifest defines, in `STEPS` order. */
export function planAll(dirs: string[], manifests: Map<string, Manifest>): Step[] {
  const steps: Step[] = ROOT_STEPS.map((step) => ({ ...step, argv: [...step.argv] }));
  for (const dir of dirs) {
    const pkg = manifests.get(dir) ?? {};
    for (const step of STEPS) {
      if (!pkg.scripts?.[step]) continue;
      steps.push({ label: `${pkg.name} (${dir}): ${step}`, cwd: dir, argv: ["bun", "run", step] });
    }
  }
  return steps;
}

/** The steps of one group: `all` filtered to the group's packages (plus the root steps when `root: true`), order
 *  kept. Throws on a name the groups file does not define. */
export function planGroup(all: Step[], groups: VerifyGroups, name: string): Step[] {
  const group = Object.hasOwn(groups.groups, name) ? groups.groups[name] : undefined;
  if (!group) throw new Error(`unknown group ${name}`);
  const packages = new Set(group.packages);
  return all.filter((step) => (step.cwd === "." ? group.root === true : packages.has(step.cwd)));
}

function list(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Problems with the groups file's shape, before it is read as `VerifyGroups`: `groups` must be an object, each
 *  group an object with `packages`, a list of strings, and `root`, when present, true or false. Other top-level
 *  keys (`$comment`) are allowed. Empty when the shape is valid. */
export function checkGroupsShape(file: unknown): string[] {
  if (!isObject(file) || !isObject(file.groups)) return [`verify: ${GROUPS_FILE} must have "groups", an object of groups`];
  const problems: string[] = [];
  for (const [name, group] of Object.entries(file.groups)) {
    if (!isObject(group)) {
      problems.push(`verify: group ${name} in ${GROUPS_FILE} must be an object`);
      continue;
    }
    if (!Array.isArray(group.packages) || !group.packages.every((dir) => typeof dir === "string")) {
      problems.push(`verify: group ${name} in ${GROUPS_FILE} must have "packages", a list of directories`);
    }
    if (group.root !== undefined && typeof group.root !== "boolean") {
      problems.push(`verify: group ${name} in ${GROUPS_FILE} has "root" ${JSON.stringify(group.root)}; use true or false`);
    }
  }
  return problems;
}

/** The groups file of the repository at `root`, or the problems that stop it being read: not readable, not JSON,
 *  or the wrong shape (`checkGroupsShape`). */
export async function readGroups(root: string): Promise<{ groups: VerifyGroups } | { problems: string[] }> {
  let file: unknown;
  try {
    file = await Bun.file(join(root, GROUPS_FILE)).json();
  } catch (error) {
    return { problems: [`verify: cannot read ${GROUPS_FILE}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const problems = checkGroupsShape(file);
  return problems.length > 0 ? { problems } : { groups: file as VerifyGroups };
}

/** Problems with the groups file against the workspace: a package in no group, in several groups, a group naming
 *  a directory that is not a workspace package, zero or several groups with `root: true`. Empty when valid. */
export function checkGroups(dirs: string[], groups: VerifyGroups): string[] {
  const problems: string[] = [];
  const workspace = new Set(dirs);
  const owners = new Map<string, string[]>();
  let roots = 0;
  for (const [name, group] of Object.entries(groups.groups)) {
    if (group.root === true) roots++;
    for (const dir of group.packages) {
      if (!workspace.has(dir)) {
        problems.push(`verify: group ${name} lists ${dir}, which is not a workspace package`);
        continue;
      }
      const seen = owners.get(dir) ?? [];
      if (!seen.includes(name)) seen.push(name);
      owners.set(dir, seen);
    }
  }
  for (const dir of dirs) {
    const seen = owners.get(dir) ?? [];
    if (seen.length === 0) problems.push(`verify: ${dir} is in no group in ${GROUPS_FILE}; add it to one`);
    else if (seen.length > 1) problems.push(`verify: ${dir} is in groups ${list(seen)} in ${GROUPS_FILE}; keep it in one`);
  }
  if (roots !== 1) problems.push(`verify: exactly one group must have "root": true; found ${roots}`);
  return problems;
}

/** Parsed `verify` arguments: `group` is undefined when every step runs. */
export type VerifyArgs = { group?: string } | { error: string };

export function parseVerifyArgs(args: string[]): VerifyArgs {
  let group: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--group") {
      const value = args[++i];
      if (value === undefined || value === "" || value.startsWith("-")) return { error: "verify: --group requires a group name" };
      group = value;
    } else return { error: `verify: unknown argument: ${arg}` };
  }
  return { group };
}
