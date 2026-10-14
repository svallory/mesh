// Runs the conformance cases in `conformance/cases/` against this example's daemon (`main.ts`).
//
//   bun run conformance
//
// The cases, their harness and the protocol schemas they validate against are copies of the Hyper engine
// specification's conformance suite (`conformance/README.md` lists them). Those copies are the gate: the run fails
// unless the cases it finds are exactly the ones `conformance/cases.txt` lists and every one of them passes, so a
// listed case that is missing, skipped or failing fails it, and so does a copied case the list leaves out.
//
// The cases start the engine through `sh -c "exec $ENGINE_CMD --socket <path> --db <path>"`. `ENGINE_CMD` names the
// Bun running this script and the absolute path of `main.ts`, and that Bun's folder goes first on `PATH`, so a shell
// that finds an older Bun first still runs the engine on this one. `SCHEMA_STRICT` is removed, so the harness validates
// every result strictly.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const HYPER = join(import.meta.dir, "..");
const MAIN = join(HYPER, "main.ts");
const CASES = join(HYPER, "conformance", "cases");
const LIST = join(HYPER, "conformance", "cases.txt");
const BUN = process.execPath;

interface Case {
  /** As the suite prints it: the describe blocks and the test, joined by ` > `. */
  readonly name: string;
  readonly status: "pass" | "fail" | "skip";
}

function fail(message: string): never {
  console.error(`conformance: ${message}`);
  process.exit(1);
}

/** Runs `command`, its output shown, and returns its exit code. */
function run(command: readonly string[], cwd: string, env: Record<string, string | undefined> = process.env): number {
  const { exitCode } = Bun.spawnSync([...command], { cwd, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return exitCode;
}

/** The names in `conformance/cases.txt`: one per line; blank lines and lines starting with `#` are skipped. */
function allowList(): string[] {
  const names = readFileSync(LIST, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) fail(`cases.txt lists ${JSON.stringify(name)} twice`);
    seen.add(name);
  }
  return names;
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
 * Every case of the run, from Bun's JUnit report. A file is the outer `testsuite`, each describe block a `testsuite`
 * inside it, and a `testcase` with no `skipped`, `failure` or `error` child passed.
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

if (process.argv.length > 2) fail(`takes no arguments, got ${process.argv.slice(2).join(" ")}`);

const allowed = allowList();
if (allowed.length === 0) fail("conformance/cases.txt lists no case");

const reports = mkdtempSync(join(tmpdir(), "hyper-conformance-"));
const report = join(reports, "junit.xml");
const env: Record<string, string | undefined> = {
  ...process.env,
  ENGINE_CMD: [BUN, MAIN].map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" "),
  PATH: [dirname(BUN), process.env.PATH].filter(Boolean).join(":"),
};
delete env.SCHEMA_STRICT;

// Nothing inside the `try` may call `fail`: `process.exit` skips the `finally`, which would leave the directory behind.
let junit: string | undefined;
let exitCode: number;
try {
  exitCode = run([BUN, "test", CASES, "--reporter=junit", `--reporter-outfile=${report}`], HYPER, env);
  junit = existsSync(report) ? readFileSync(report, "utf8") : undefined;
} finally {
  rmSync(reports, { recursive: true, force: true });
}
if (junit === undefined) fail(`bun test wrote no report (exit code ${exitCode})`);
const cases = casesOf(junit);

const byName = new Map<string, Case[]>();
for (const one of cases) byName.set(one.name, [...(byName.get(one.name) ?? []), one]);
const listed = new Set(allowed);

const missing = allowed.filter((name) => !byName.has(name));
const notPassing = allowed.filter((name) => byName.get(name)?.some((one) => one.status !== "pass"));
const unlisted = [...byName.keys()].filter((name) => !listed.has(name));
const twice = [...byName].filter(([, runs]) => runs.length > 1).map(([name]) => name);

console.log(`\nconformance: ${cases.length} cases in conformance/cases, ${allowed.length} listed`);
for (const name of missing) console.error(`  listed, not in conformance/cases: ${name}`);
for (const name of notPassing) console.error(`  listed, does not pass: ${name}`);
for (const name of unlisted) console.error(`  in conformance/cases, not listed: ${name}`);
for (const name of twice) console.error(`  reported more than once: ${name}`);
console.log(`conformance: ${allowed.length - notPassing.length - missing.length} of the ${allowed.length} listed cases pass`);
if (missing.length > 0 || notPassing.length > 0 || unlisted.length > 0 || twice.length > 0) process.exit(1);
if (exitCode !== 0) fail(`bun test exited ${exitCode}`);
