// TypeScript 7 exposes its compiler through an API server, not ts.createProgram. Keep one server per test file;
// serve fixture sources and the synthetic config from memory, with lib and node_modules falling back to disk.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parsers } from "prettier/plugins/typescript";
import { API, DiagnosticCategory, type Diagnostic } from "typescript/unstable/async";

/** The flags used by the real-tsc smoke tests in generated.ts. */
const STRICT_OPTIONS = {
  noEmit: true,
  strict: true,
  noUncheckedIndexedAccess: true,
  module: "esnext",
  moduleResolution: "bundler",
  target: "es2022",
  skipLibCheck: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  exactOptionalPropertyTypes: true,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  allowImportingTsExtensions: true,
} as const;

const contents = new Map<string, string>();
const directories = new Set<string>();
let server: API | undefined;
let openConfig: string | undefined;
let lastSnapshot: Awaited<ReturnType<API["updateSnapshot"]>> | undefined;
const batchConfig = resolve(import.meta.dir, "__mesh_typecheck__/tsconfig.json");

function virtualFile(file: string, text: string): void {
  contents.set(file, text);
  for (let dir = dirname(file); !directories.has(dir); dir = dirname(dir)) {
    directories.add(dir);
    if (dir === dirname(dir)) break;
  }
}

/** Capture the whole fixture, including imported helpers and package imports, before afterEach removes it. */
function capture(root: string, files = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const file = resolve(root, entry.name);
    if (entry.isDirectory()) capture(file, files);
    else if (entry.isFile() && /\.(?:[cm]?tsx?|json)$/.test(entry.name)) files.set(file, readFileSync(file, "utf8"));
  }
  return files;
}

/** Scripts and ambient augmentations change every fixture's global types, even when their diagnostics are filtered. */
function assertBatchModules(files: ReadonlyMap<string, string>): void {
  const hasAugmentation = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(hasAugmentation);
    const node = value as { type?: string; kind?: string; global?: boolean; id?: { type?: string; name?: string; value?: unknown } };
    if (node.type === "TSNamespaceExportDeclaration") return true;
    if (node.type === "TSModuleDeclaration" && (node.kind === "global" || node.kind === "module" || node.global ||
      node.id?.name === "global" || typeof node.id?.value === "string")) return true;
    return Object.entries(value).some(([key, child]) =>
      !["loc", "range", "parent", "tokens", "comments"].includes(key) && hasAugmentation(child));
  };
  for (const [file, text] of files) {
    if (!/\.[cm]?tsx?$/.test(file)) continue;
    let program: { body: { type: string; moduleReference?: { type: string } }[] };
    try { program = parsers.typescript.parse(text, {} as never) as typeof program; }
    catch { throw new Error(`Cannot batch ${file}: TypeScript syntax could not be parsed; use checkTypes for an isolated project`); }
    if (hasAugmentation(program)) {
      throw new Error(`Cannot batch ${file}: declare global / declare module can leak types into other fixtures; use checkTypes for an isolated project`);
    }
    if (!program.body.some((node) => node.type === "ImportDeclaration" || node.type.startsWith("Export") ||
      (node.type === "TSImportEqualsDeclaration" && node.moduleReference?.type === "TSExternalModuleReference") || node.type === "TSExportAssignment")) {
      throw new Error(`Cannot batch ${file}: no top-level import/export; script globals can leak into other fixtures; use checkTypes for an isolated project`);
    }
  }
}

/** Undefined delegates to the real filesystem. In particular, never hide lib or installed package files. */
export function typeServer(): API {
  server ??= new API({
    cwd: resolve(import.meta.dir, "../../.."),
    fs: {
      readFile: (file) => contents.get(file),
      fileExists: (file) => contents.has(file) ? true : undefined,
      directoryExists: (dir) => directories.has(dir) ? true : undefined,
    },
  });
  return server;
}

/** Bun test does not run process exit hooks; each consumer registers this in afterAll. */
export async function closeTypeServer(): Promise<void> {
  try {
    await lastSnapshot?.dispose();
    lastSnapshot = undefined;
    if (server) await server.close();
  } finally {
    server = undefined;
    openConfig = undefined;
    contents.clear();
    directories.clear();
  }
}

function renderDiagnostic(diagnostic: Diagnostic, root: string): string {
  let position = "";
  if (diagnostic.fileName !== undefined) {
    const text = contents.get(diagnostic.fileName) ?? readFileSync(diagnostic.fileName, "utf8");
    const before = text.slice(0, diagnostic.pos);
    const line = before.split("\n").length;
    const column = diagnostic.pos - before.lastIndexOf("\n");
    position = `${relative(root, diagnostic.fileName)}(${line},${column}): `;
  }
  const message = (item: Diagnostic, indent: string): string => [
    `${indent}${item.text}`,
    ...(item.messageChain ?? []).map((child) => message(child, `${indent}  `)),
  ].join("\n");
  return `${position}error TS${diagnostic.code}: ${message(diagnostic, "")}`;
}

/**
 * Normal checks use an isolated project, so one fixture's ActionContext/EventBusCapabilities augmentation cannot
 * change another's result. The expressions file reuses one project for its independent module fixtures, replacing
 * the root list on each call so dependencies stay cached without accumulating every earlier fixture's program.
 */
export async function checkTypesInMemory(root: string, files: readonly string[], batch = false): Promise<{ code: number; output: string }> {
  const absolute = files.map((file) => resolve(root, file));
  const captured = capture(root);
  // Validate before changing shared state: a refused fixture must not contaminate a later snapshot either.
  if (batch) assertBatchModules(captured);
  // Drop old copies when a test rewrites a fixture, rather than serving stale or deleted helper files.
  const deleted = [...contents.keys()].filter((file) => file.startsWith(`${root}${sep}`) && !captured.has(file));
  for (const file of contents.keys()) if (file.startsWith(`${root}${sep}`)) contents.delete(file);
  for (const [file, text] of captured) virtualFile(file, text);
  const config = batch ? batchConfig : resolve(root, "tsconfig.check.json");
  virtualFile(config, JSON.stringify({ compilerOptions: STRICT_OPTIONS, files: absolute }));
  const next = await typeServer().updateSnapshot({
    ...(openConfig === config ? {} : { openProjects: [config], ...(openConfig ? { closeProjects: [openConfig] } : {}) }),
    // invalidateAll refreshes source contents but does not reload the virtual config's replacement root list.
    // Explicit config/file events ensure this fixture replaces, rather than accumulates, previous roots.
    fileChanges: { changed: [config, ...captured.keys()], created: [...captured.keys()], deleted: deleted.filter((file) => file !== config) },
  });
  openConfig = config;
  const previous = lastSnapshot;
  lastSnapshot = next;
  try {
    const project = next.getProject(config);
    if (!project) throw new Error(`TypeScript did not open ${config}`);
    for (const file of absolute) {
      if (!project.rootFiles.includes(file)) throw new Error(`TypeScript did not include ${file} in ${config}`);
    }
    for (const file of project.rootFiles) {
      if (!absolute.includes(file)) throw new Error(`TypeScript retained a previous fixture root ${file} in ${config}`);
    }
    // Check the entire current program, including imported implementations. No diagnostic filtering is needed:
    // earlier fixture roots have left the project, while shared dependency sources remain cached by the server.
    const diagnostics = [
      ...await project.program.getConfigFileParsingDiagnostics(),
      ...await project.program.getProgramDiagnostics(),
      ...await project.program.getGlobalDiagnostics(),
      ...await project.program.getSyntacticDiagnostics(),
      ...await project.program.getSemanticDiagnostics(),
    ];
    const unique = [...new Map(diagnostics.map((diagnostic) => [
      `${diagnostic.fileName}:${diagnostic.pos}:${diagnostic.code}:${diagnostic.text}`, diagnostic,
    ])).values()];
    return {
      code: unique.some((diagnostic) => diagnostic.category === DiagnosticCategory.Error) ? 1 : 0,
      output: unique.map((diagnostic) => renderDiagnostic(diagnostic, root)).join("\n"),
    };
  } finally {
    await previous?.dispose();
  }
}
