// Runs the Hyper engine spec's conformance suite against this example's daemon (`main.ts`).
//
//   bun run conformance          the cases in conformance.txt; fails unless every one of them passes
//   bun run conformance --all    every case, then lists the ones that pass and are not in conformance.txt yet
//
// The suite comes from the spec repository at the commit `conformance.json` pins: the checkout at `$HYPER_SPEC_DIR`
// when it is set, else a clone in `.spec/` (git-ignored), made with `gh` and moved to the pinned commit. Either way the
// checkout must be at that commit with no local changes, so the run tests the pinned suite and nothing else.
//
// The suite starts the engine through `sh -c "exec $ENGINE_CMD --socket <path> --db <path>"`. `ENGINE_CMD` names the
// Bun running this script and the absolute path of `main.ts`, and that Bun's folder goes first on `PATH`, so a shell
// that finds an older Bun first still runs the engine on this one. `SCHEMA_STRICT` is removed, so the suite validates
// every result strictly.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HYPER = join(import.meta.dir, "..");
const MAIN = join(HYPER, "main.ts");
const BUN = process.execPath;

interface Pin {
  readonly repository: string;
  readonly commit: string;
}

interface Case {
  /** As the suite prints it: the describe blocks and the test, joined by ` > `. */
  readonly name: string;
  readonly status: "pass" | "fail" | "skip";
}

function fail(message: string): never {
  console.error(`conformance: ${message}`);
  process.exit(1);
}

/** Runs `command`, its output shown; throws when it exits non-zero. */
function run(command: readonly string[], cwd: string, env: Record<string, string | undefined> = process.env): number {
  const { exitCode } = Bun.spawnSync([...command], { cwd, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return exitCode;
}

/** Runs `command` and returns its standard output, trimmed; `undefined` when it exits non-zero. */
function output(command: readonly string[], cwd: string): string | undefined {
  const result = Bun.spawnSync([...command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

/** The checkout to run: `$HYPER_SPEC_DIR` as it is, or `.spec/`, cloned and moved to the pinned commit. */
function checkout(pin: Pin): string {
  const given = process.env.HYPER_SPEC_DIR;
  if (given) {
    const dir = resolve(given);
    if (!existsSync(join(dir, "conformance"))) fail(`HYPER_SPEC_DIR is ${dir}, which holds no conformance suite`);
    return dir;
  }
  const dir = join(HYPER, ".spec");
  if (!existsSync(join(dir, ".git"))) {
    console.log(`conformance: cloning ${pin.repository} into ${dir}`);
    if (run(["gh", "repo", "clone", pin.repository, dir, "--", "--filter=blob:none", "--quiet"], HYPER) !== 0) {
      fail(`could not clone ${pin.repository}; it is private for now, so \`gh\` must be signed in to an account that can read it (\`gh auth status\`)`);
    }
  }
  if (output(["git", "cat-file", "-e", `${pin.commit}^{commit}`], dir) === undefined && run(["git", "fetch", "--quiet", "origin"], dir) !== 0) {
    fail(`could not fetch ${pin.repository} into ${dir}`);
  }
  if (run(["git", "checkout", "--quiet", "--detach", pin.commit], dir) !== 0) fail(`could not check out ${pin.commit} in ${dir}`);
  return dir;
}

/** Fails unless `dir` is at the pinned commit with no local changes. */
function checkPinned(dir: string, pin: Pin): void {
  const head = output(["git", "rev-parse", "HEAD"], dir);
  if (head === undefined) fail(`${dir} is not a git checkout`);
  if (head !== pin.commit) fail(`${dir} is at ${head}, not at the pinned commit ${pin.commit}; check it out, or move the pin in conformance.json`);
  const changes = output(["git", "status", "--porcelain", "--untracked-files=no"], dir);
  if (changes !== "") fail(`${dir} has local changes, so it is not the pinned suite:\n${changes}`);
}

/** The names in `conformance.txt`: one per line; blank lines and lines starting with `#` are skipped. */
function allowList(): string[] {
  const names = readFileSync(join(HYPER, "conformance.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) fail(`conformance.txt lists ${JSON.stringify(name)} twice`);
    seen.add(name);
  }
  return names;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The `-t` pattern that selects exactly the listed cases. Bun matches it against a case's describe blocks and test
 * joined by spaces, where the suite prints them joined by ` > `.
 */
function namePattern(names: readonly string[]): string {
  return `^(?:${names.map((name) => escapeRegExp(name.split(" > ").join(" "))).join("|")})$`;
}

const entities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function attribute(attributes: string, name: string): string {
  const value = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? "";
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return entities[entity] ?? whole;
  });
}

/**
 * Every case of the run, from Bun's JUnit report, which lists the cases `-t` left out as skipped. A file is the outer
 * `testsuite`, each describe block a `testsuite` inside it, and a `testcase` with no `skipped`, `failure` or `error`
 * child passed.
 */
function casesOf(report: string): Case[] {
  const cases: Case[] = [];
  const suites: string[] = [];
  let open: { name: string; status: Case["status"] } | undefined;
  for (const [, closing, tag, attributes, selfClosing] of report.matchAll(/<(\/?)(testsuites|testsuite|testcase|skipped|failure|error)\b([^>]*?)(\/?)>/g)) {
    if (tag === "testsuites") continue;
    if (tag === "testsuite") {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attribute(attributes!, "name"));
    } else if (tag === "testcase") {
      if (closing) {
        if (open) cases.push(open);
        open = undefined;
      } else {
        // The outer suite is the file, which the suite's own output leaves out of a case's name.
        const name = [...suites.slice(1), attribute(attributes!, "name")].join(" > ");
        if (selfClosing) cases.push({ name, status: "pass" });
        else open = { name, status: "pass" };
      }
    } else if (open && !closing) {
      open.status = tag === "skipped" ? "skip" : "fail";
    }
  }
  return cases;
}

const { values: flags } = parseArgs({ options: { all: { type: "boolean", default: false } }, strict: true, allowPositionals: false });

const pin = JSON.parse(readFileSync(join(HYPER, "conformance.json"), "utf8")) as Pin;
const allowed = allowList();
if (!flags.all && allowed.length === 0) fail("conformance.txt lists no case");

const spec = checkout(pin);
checkPinned(spec, pin);
if (run([BUN, "install", "--frozen-lockfile"], spec) !== 0) fail(`bun install failed in ${spec}`);

const reports = mkdtempSync(join(tmpdir(), "hyper-conformance-"));
const report = join(reports, "junit.xml");
const env: Record<string, string | undefined> = {
  ...process.env,
  ENGINE_CMD: [BUN, MAIN].map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" "),
  PATH: [dirname(BUN), process.env.PATH].filter(Boolean).join(":"),
};
delete env.SCHEMA_STRICT;

let cases: Case[];
let exitCode: number;
try {
  const select = flags.all ? [] : ["-t", namePattern(allowed)];
  exitCode = run([BUN, "test", "conformance", ...select, "--reporter=junit", `--reporter-outfile=${report}`], spec, env);
  if (!existsSync(report)) fail(`bun test wrote no report (exit code ${exitCode})`);
  cases = casesOf(readFileSync(report, "utf8"));
} finally {
  rmSync(reports, { recursive: true, force: true });
}

const byName = new Map<string, Case[]>();
for (const one of cases) byName.set(one.name, [...(byName.get(one.name) ?? []), one]);

const unknown = allowed.filter((name) => !byName.has(name));
const notPassing = allowed.filter((name) => byName.get(name)?.some((one) => one.status !== "pass"));
const passing = cases.filter((one) => one.status === "pass");

console.log(`\nconformance: suite ${pin.repository} at ${pin.commit}, ${cases.length} cases`);
for (const name of unknown) console.error(`  not in the suite: ${name}`);
for (const name of notPassing) console.error(`  listed, does not pass: ${name}`);
if (flags.all) {
  const listed = new Set(allowed);
  for (const one of passing) if (!listed.has(one.name)) console.log(`  passes, not listed: ${one.name}`);
  console.log(`conformance: ${passing.length} of ${cases.length} cases pass; ${allowed.length - notPassing.length - unknown.length} of the ${allowed.length} listed pass`);
} else {
  console.log(`conformance: ${allowed.length - notPassing.length - unknown.length} of the ${allowed.length} listed cases pass`);
}
if (unknown.length > 0 || notPassing.length > 0) process.exit(1);
if (!flags.all && exitCode !== 0) fail(`bun test exited ${exitCode}`);
