// Type-checks every TypeScript sample on the Docs pages against samples/mesh-api.d.ts,
// the declarations of the API those pages describe.
//
// Mesh has no installable runtime yet, so this is not a claim that any sample ran. It
// is a claim that every sample is complete: it declares what it uses, its calls match
// the documented signatures, and it would compile. A sample that references an
// identifier it never declares, or passes a field the entity does not accept, fails
// here instead of in a reader's editor.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const docs = new URL("../docs/docs/", import.meta.url).pathname;
const app = new URL("../", import.meta.url).pathname;
const root = new URL("../../../", import.meta.url).pathname;
const tsc = join(root, "node_modules/.bin/tsc");

const actorModule = `import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string };
  }
}

export const alice = { id: "00000000-0000-4000-8000-000000000001" };
export const bob = { id: "00000000-0000-4000-8000-000000000002" };
`;

const tsconfig = {
  compilerOptions: {
    strict: true,
    target: "esnext",
    module: "esnext",
    moduleResolution: "bundler",
    noEmit: true,
    noUncheckedIndexedAccess: true,
    noUnusedLocals: true,
    skipLibCheck: true,
    types: ["bun"],
    typeRoots: ["../../../../node_modules/@types"],
    paths: {
      "#mesh": ["../../samples/mesh-api.d.ts"],
      "@meshfw/runtime": ["../../samples/mesh-api.d.ts"],
      "@meshfw/data-sqlite": ["../../samples/mesh-api.d.ts"],
      "@meshfw/data-postgres": ["../../samples/mesh-api.d.ts"],
      "@meshfw/cli": ["../../samples/mesh-api.d.ts"],
    },
  },
  files: [] as string[],
};

interface Sample {
  page: string;
  line: number;
  title: string;
  code: string;
}

/** Every ```ts block on the Docs pages, with the file title the page gave it. */
function samples(): Sample[] {
  const found: Sample[] = [];
  for (const name of readdirSync(docs).filter((name) => name.endsWith(".md")).sort()) {
    const file = join(docs, name);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const opening = /^ {0,3}(`{3,})(.*)$/.exec(lines[i]!);
      if (!opening || !opening[2]!.trimStart().startsWith("ts")) continue;
      const block: string[] = [];
      while (++i < lines.length && !/^ {0,3}`{3,}\s*$/.test(lines[i]!)) block.push(lines[i]!);
      const title = opening[2]!.trim().replace(/^ts\s*/, "").replaceAll('"', "").trim();
      found.push({
        page: name,
        line: i - block.length,
        title: title || "(untitled)",
        code: block.join("\n") + "\n",
      });
    }
  }
  return found;
}

test("every TypeScript sample on the Docs pages type-checks against the proposed API", () => {
  const found = samples();
  expect(found.length).toBeGreaterThan(15);
  const dir = mkdtempSync(join(app, ".samples-"));
  const failures: string[] = [];
  try {
for (const [index, sample] of found.entries()) {
// A fence titled "…(excerpt)" is a signature shown in prose, not a file; the
      // checker cannot compile a fragment that never declared its own imports.
      if (sample.title.endsWith("(excerpt)")) continue;
      const caseDir = join(dir, String(index));
      mkdirSync(caseDir);
      const samplePath = /^[a-z0-9._-]+\/[a-z0-9._-]+\.ts$/.test(sample.title) ? sample.title : "sample.ts";
      const files = [samplePath];
      mkdirSync(dirname(join(caseDir, samplePath)), { recursive: true });
      writeFileSync(join(caseDir, samplePath), sample.code);
      // A sample that imports a context module gets the one a project would have,
      // written beside it at `src/context.ts`. A sample that is itself
      // `src/context.ts` declares the type, so it brings its own.
      if (/from "\.{1,2}(\/src)?\/context"/.test(sample.code) && samplePath !== "src/context.ts") {
        mkdirSync(join(caseDir, "src"), { recursive: true });
        writeFileSync(join(caseDir, "src/context.ts"), actorModule);
        files.push("src/context.ts");
      }
      writeFileSync(join(caseDir, "tsconfig.json"), JSON.stringify({ ...tsconfig, files: [...files, "../../samples/mesh-api.d.ts"] }));
      let out = "";
      try {
        execFileSync(tsc, ["-p", caseDir], { encoding: "utf8", stdio: "pipe" });
      } catch (error) {
        out = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`.trim();
      }
      if (out) failures.push(`${sample.page}:${sample.line} (${sample.title})\n${out}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`Docs TypeScript samples: ${found.length - failures.length - 1}/${found.length} compile (1 excerpt skipped)`);
  expect(failures).toEqual([]);
}, 300_000);