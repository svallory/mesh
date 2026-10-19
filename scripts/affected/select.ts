// Pure selection logic for `bun run test:affected`: changed files + the workspace
// dependency graph + the slow-test manifest -> the packages (and files) to test.
// No git, no filesystem, no spawned tests; the CLI in `scripts/test-affected.ts`
// owns those, and `select.test.ts` exercises this module with fixtures.

/** The workspace directories a package can live in. */
const PKG_ROOTS = ["packages/", "apps/", "examples/"] as const;

export type ChangeKind = "add" | "modify" | "delete";

export interface FileChange {
  /** Repository-relative path, POSIX separators. */
  path: string;
  kind: ChangeKind;
}

export interface Workspace {
  /** Workspace-relative package directory, e.g. `packages/compiler`. */
  dir: string;
  /** Package name from its manifest, e.g. `@meshfw/compiler`. */
  name: string;
  /** Names of workspace packages this package directly depends on. */
  dependsOn: string[];
}

export interface SelectOptions {
  /** Run slow test files too (default: skipped unless the file itself changed). */
  slow: boolean;
  /** Select every workspace package, whatever changed (`test:fast`). */
  all: boolean;
}

export interface PackageRun {
  dir: string;
  name: string;
  /** Why this package was selected. */
  reason: string;
  /**
   * Package-relative test files to run directly (`bun test <files>`) instead of
   * the package's own `test` script; null means run the `test` script.
   */
  files: string[] | null;
  /** Package-relative slow files this run skips (empty under `--slow`). */
  skipSlow: string[];
}

export interface Selection {
  mode: "all" | "none" | "packages";
  /** One-line explanation for mode "all" or "none". */
  note: string | null;
  runs: PackageRun[];
  /** Repository-relative slow files skipped, for the CLI to print. */
  skippedSlow: string[];
  /** Run the repository's own script tests (`bun test scripts/`): a root/config change or `--all`. */
  rootTests: boolean;
}

/**
 * Bun's default test-file names: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`
 * over the JavaScript/TypeScript extensions (bun 1.4.2 discovers these anywhere
 * under the package except node_modules; `apps/docs` also has `.test.js` files).
 */
const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/** A documentation-only change: under `notes/`, or a `*.md` outside `apps/docs`. */
export function isDocChange(path: string): boolean {
  if (path.startsWith("notes/")) return true;
  if (!path.endsWith(".md")) return false;
  return !path.startsWith("apps/docs/");
}

/** The workspace package directory a path belongs to, or null when outside all. */
export function packageDirOf(path: string): string | null {
  for (const root of PKG_ROOTS) {
    if (!path.startsWith(root)) continue;
    const rest = path.slice(root.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null; // the package's own manifest, or a stray file
    return root + rest.slice(0, slash);
  }
  return null;
}

/** Parse `git diff --no-renames --name-status` output into file changes. */
export function parseNameStatus(text: string): FileChange[] {
  const out: FileChange[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const status = line.slice(0, tab)[0]!;
    const path = line.slice(tab + 1).trim();
    if (!path) continue;
    out.push({ path, kind: status === "A" ? "add" : status === "D" ? "delete" : "modify" });
  }
  return out;
}

/** A manifest as read from disk, before its workspace edges are resolved. */
export interface Manifest {
  dir: string;
  name: string;
  /** Every dependency field merged: name -> spec as written. */
  deps: Record<string, string>;
}

/**
 * Resolve the workspace graph from manifests. A workspace dependency is a
 * `workspace:` spec or any dependency name that is itself a workspace package,
 * whatever order the manifests come in (forward references included) and
 * whatever the version spec says.
 */
export function buildWorkspaceGraph(manifests: Manifest[]): Workspace[] {
  const names = new Set(manifests.map((m) => m.name));
  return manifests.map((m) => ({
    dir: m.dir,
    name: m.name,
    dependsOn: Object.keys(m.deps).filter((name) => name !== m.name && names.has(name)),
  }));
}

function relativeTo(dir: string, path: string): string {
  return path.slice(dir.length + 1);
}

/**
 * Select what to test.
 *
 * - A change outside every package that is not documentation (root `package.json`,
 *   `bun.lock`, `tsconfig*.json`, `scripts/`, `.github/`), or inside a package-shaped
 *   directory no manifest covers (an unregistered directory, or a package deleted or
 *   renamed away), selects every package and the repository's own script tests.
 * - A package with a non-test change selects itself and every workspace package
 *   that depends on it, transitively.
 * - A package whose changed files are all test files runs only those files; a package
 *   whose changed test files are all deletions runs its full `test` script (the
 *   remaining tests) instead, since a deleted path cannot run. No dependents either way.
 * - Slow files are skipped in script runs unless `slow` or the file changed.
 * - A change that is documentation only selects nothing.
 */
export function selectAffected(
  changes: FileChange[],
  workspaces: Workspace[],
  slowFiles: string[],
  options: SelectOptions,
): Selection {
  const byDir = new Map(workspaces.map((w) => [w.dir, w]));
  const byName = new Map(workspaces.map((w) => [w.name, w]));

  // A package with only live test-file changes runs only those files; a package
  // whose test-file changes are all deletions runs its full `test` script.
  const fileChanges = new Map<string, { live: FileChange[]; deleted: FileChange[] }>();
  // A package with any other change runs its full `test` script, and pulls in dependents.
  const fullReasons = new Map<string, string[]>();

  if (options.all) {
    for (const w of workspaces) fullReasons.set(w.dir, ["run everything"]);
  } else {
    for (const change of changes) {
      if (isDocChange(change.path)) continue;
      const dir = packageDirOf(change.path);
      if (dir === null) {
        // Outside every package (root config, scripts, CI, anything at the root):
        // run everything.
        return allRuns(workspaces, changes, slowFiles, options, `changed file outside every package: ${change.path}`);
      }
      const w = byDir.get(dir);
      if (!w) {
        // A package-shaped directory no manifest covers: an unregistered directory,
        // or a package that was deleted or renamed away. Never silent: run everything.
        return allRuns(workspaces, changes, slowFiles, options, `changed file in a directory no workspace package covers: ${change.path}`);
      }
      if (isTestFile(change.path)) {
        const entry = fileChanges.get(dir) ?? { live: [], deleted: [] };
        (change.kind === "delete" ? entry.deleted : entry.live).push(change);
        fileChanges.set(dir, entry);
      } else {
        const reasons = fullReasons.get(dir) ?? [];
        reasons.push(change.kind === "delete" ? `deleted ${change.path}` : `changed ${change.path}`);
        fullReasons.set(dir, reasons);
      }
    }
  }

  // Transitive dependents of the fully-selected packages.
  const selected = new Map(fullReasons);
  const dependentsOf = new Map<string, string[]>();
  for (const w of workspaces) {
    for (const dep of w.dependsOn) {
      if (!byName.has(dep)) continue;
      const list = dependentsOf.get(dep) ?? [];
      list.push(w.name);
      dependentsOf.set(dep, list);
    }
  }
  const queue = [...fullReasons.keys()].map((dir) => byDir.get(dir)!.name);
  while (queue.length > 0) {
    const name = queue.shift()!;
    for (const dependent of dependentsOf.get(name) ?? []) {
      const dir = byName.get(dependent)!.dir;
      if (selected.has(dir)) continue;
      selected.set(dir, [`depends on ${name}`]);
      queue.push(dependent);
    }
  }

  const changedSlow = new Set(changes.map((c) => c.path));
  const runs: PackageRun[] = [];
  const skippedSlow: string[] = [];

  for (const w of workspaces) {
    const reason = selected.get(w.dir);
    if (reason) {
      const skipSlow = slowFiles
        .filter((f) => f.startsWith(`${w.dir}/`) && !options.slow && !changedSlow.has(f))
        .map((f) => relativeTo(w.dir, f));
      skippedSlow.push(...skipSlow.map((f) => `${w.dir}/${f}`));
      runs.push({ dir: w.dir, name: w.name, reason: reason.join(", "), files: null, skipSlow });
    } else if (fileChanges.has(w.dir)) {
      const entry = fileChanges.get(w.dir)!;
      // A live-file run names its files, but a package whose script cannot be
      // narrowed (a directory filter) falls back to the full script, and a
      // deletion-only run always does; both then skip the package's unchanged
      // slow files, like any other full-script run.
      const skipSlow = slowFiles
        .filter((f) => f.startsWith(`${w.dir}/`) && !options.slow && !changedSlow.has(f))
        .map((f) => relativeTo(w.dir, f));
      skippedSlow.push(...skipSlow.map((f) => `${w.dir}/${f}`));
      if (entry.live.length > 0) {
        // Only live test files changed here: run exactly those, and no dependents.
        const files = entry.live.map((c) => relativeTo(w.dir, c.path));
        runs.push({ dir: w.dir, name: w.name, reason: `changed test files only: ${files.join(", ")}`, files, skipSlow });
      } else {
        // Every test-file change here is a deletion: a deleted path cannot run, so
        // the package's full `test` script (its remaining tests) runs instead.
        const deleted = entry.deleted.map((c) => relativeTo(w.dir, c.path));
        runs.push({ dir: w.dir, name: w.name, reason: `deleted test files: ${deleted.join(", ")}`, files: null, skipSlow });
      }
    }
  }

  if (runs.length === 0) {
    return {
      mode: "none",
      note: changes.length === 0 ? "no changes against the base" : "documentation-only change (notes/ or *.md outside apps/docs): no tests to run",
      runs: [],
      skippedSlow: [],
      rootTests: false,
    };
  }
  return { mode: options.all ? "all" : "packages", note: null, runs, skippedSlow, rootTests: options.all };
}

function allRuns(
  workspaces: Workspace[],
  changes: FileChange[],
  slowFiles: string[],
  options: SelectOptions,
  note: string,
): Selection {
  const changedSlow = new Set(changes.map((c) => c.path));
  const runs: PackageRun[] = [];
  const skippedSlow: string[] = [];
  for (const w of workspaces) {
    const skipSlow = slowFiles
      .filter((f) => f.startsWith(`${w.dir}/`) && !options.slow && !changedSlow.has(f))
      .map((f) => relativeTo(w.dir, f));
    skippedSlow.push(...skipSlow.map((f) => `${w.dir}/${f}`));
    runs.push({ dir: w.dir, name: w.name, reason: "run everything", files: null, skipSlow });
  }
  return { mode: "all", note, runs, skippedSlow, rootTests: true };
}

/**
 * A `test` script whose final command is a bare `bun test` (flags allowed, no
 * positional path filter), so arguments appended after `--` become the only
 * test-file filters.
 */
function endsInBareBunTest(script: string): boolean {
  const last = script.split(/&&|;/).pop()!.trim();
  return /^bun\s+test(\s+-\S+)*$/.test(last);
}

/**
 * The `bun` argv (run with the package directory as cwd) for one package's
 * selection. File-only runs append the files to the package's own `test` script
 * when that is safe — its final command is a bare `bun test`, so prerequisites
 * like `mesh build --check` still run; anything else (a directory filter such
 * as `bun test test/`, a form we do not recognise) runs the full `test` script,
 * because appending a file to a directory filter broadens bun's selection.
 */
export function commandFor(run: PackageRun, testScript: string | undefined): string[] {
  const skipArgs =
    run.skipSlow.length > 0
      ? // --pass-with-no-tests: a package whose every test file is slow (blog)
        // would otherwise fail on the empty run.
        ["--", "--pass-with-no-tests", ...run.skipSlow.flatMap((f) => ["--path-ignore-patterns", f])]
      : [];
  if (run.files !== null && testScript !== undefined && endsInBareBunTest(testScript)) {
    return ["run", "test", "--", ...run.files];
  }
  return ["run", "test", ...skipArgs];
}
