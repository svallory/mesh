// Builds the dialect module MX loads (`mx.dialect.module`): `src/dialect.ts` bundled to
// `dist/dialect.js`, plain JavaScript with every Mesh import inlined, so Node loads it with no install
// beside it. Mesh's syntax files import only types from MX's core package, so nothing of MX is inlined.
// Also keeps `mx.dialect` honest: its `extensions` must be Mesh's one extension list
// (`MESH_EXTENSIONS`), its `id` must stay `mesh` (the `Atom` node says `dialect: "mesh"`), and
// the module must be the file this script writes. Any mismatch fails the build.
//
// Tests run repository scans that read `dist/dialect.js` while this build may run (another test builds the CLI), so
// the file is finished in a `.scratch-build-XXXXXX/` directory beside `dist/` (a name every scan skips) and renamed
// onto `dist/dialect.js`: a rename on one filesystem replaces the file at once, so a reader sees the old file or the
// new one, never a missing or half-written one. `dist/` is never removed; it holds only `dialect.js`.
import { MESH_EXTENSIONS } from "@meshfw/compiler/extensions";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = (await Bun.file(join(root, "package.json")).json()) as {
  mx?: { dialect?: { id?: string; name?: string; extensions?: string[]; module?: string } };
};
const dialect = manifest.mx?.dialect;
const problems: string[] = [];
if (!dialect) problems.push("package.json has no mx.dialect");
else {
  if (dialect.id !== "mesh") problems.push(`mx.dialect.id must be "mesh", not ${JSON.stringify(dialect.id)}`);
  if (JSON.stringify(dialect.extensions) !== JSON.stringify(MESH_EXTENSIONS))
    problems.push(`mx.dialect.extensions ${JSON.stringify(dialect.extensions)} must equal MESH_EXTENSIONS ${JSON.stringify(MESH_EXTENSIONS)}`);
  if (dialect.module !== "./dist/dialect.js") problems.push(`mx.dialect.module must be "./dist/dialect.js", not ${JSON.stringify(dialect.module)}`);
}
if (problems.length > 0) {
  console.error(problems.map((problem) => `meshfw: ${problem}`).join("\n"));
  process.exit(1);
}

const scratch = await mkdtemp(join(root, ".scratch-build-"));
/** `process.exit` skips `finally`, so a failure removes the scratch directory itself. */
const fail = async (message: string): Promise<never> => {
  console.error(message);
  await rm(scratch, { recursive: true, force: true });
  process.exit(1);
};
try {
  const result = await Bun.build({
    entrypoints: [join(root, "src/dialect.ts")],
    outdir: scratch,
    target: "node",
    format: "esm",
    naming: "dialect.js",
  });
  if (!result.success) await fail(result.logs.map(String).join("\n"));
  // The bundler marks each inlined module with a path comment (`// ../../packages/compiler/...`). Drop
  // them: they are noise. Then check that no mention of MX's package is left in the bundle (nothing of MX
  // is inlined today, and the repository check keeps MX's package name out of the workspace outside
  // `packages/compiler`); the check guards against a value import of MX creeping in.
  const file = join(scratch, "dialect.js");
  const text = (await Bun.file(file).text()).replace(/^\/\/ \.\.?\/.*\.[cm]?[jt]s\n/gm, "");
  if (text.includes("mxlang")) await fail("meshfw: dist/dialect.js still mentions MX's package after the path comments were dropped");
  await Bun.write(file, text);
  await mkdir(join(root, "dist"), { recursive: true });
  await rename(file, join(root, "dist/dialect.js"));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log(`meshfw: wrote dist/dialect.js for extensions ${MESH_EXTENSIONS.join(", ")}`);
