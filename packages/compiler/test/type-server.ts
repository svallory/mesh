// TypeScript 7 exposes its compiler through an API server, not ts.createProgram. Keep one server per test file;
// serve fixture sources and the synthetic config from memory, with lib and node_modules falling back to disk.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
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
const batchFiles = new Set<string>();
const batchRoots = new Set<string>();
const batchConfig = resolve(import.meta.dir, "__mesh_typecheck__/tsconfig.json");

function virtualFile(file: string, text: string): void {
  contents.set(file, text);
  for (let dir = dirname(file); !directories.has(dir); dir = dirname(dir)) {
    directories.add(dir);
    if (dir === dirname(dir)) break;
  }
}

/** Capture the whole fixture, including imported helpers and package imports, before afterEach removes it. */
function capture(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const file = resolve(root, entry.name);
    if (entry.isDirectory()) capture(file);
    else if (entry.isFile() && /\.(?:[cm]?tsx?|json)$/.test(entry.name)) virtualFile(file, readFileSync(file, "utf8"));
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
    batchFiles.clear();
    batchRoots.clear();
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
 * change another's result. The expressions file explicitly opts into batching its independent module fixtures:
 * their unique absolute roots coexist in one program, with captured sources surviving the disk fixture's cleanup.
 */
export async function checkTypesInMemory(root: string, files: readonly string[], batch = false): Promise<{ code: number; output: string }> {
  const absolute = files.map((file) => resolve(root, file));
  // Drop old copies when a test rewrites a fixture, rather than serving stale or deleted helper files.
  for (const file of contents.keys()) if (file.startsWith(`${root}${sep}`)) contents.delete(file);
  capture(root);
  const config = batch ? batchConfig : resolve(root, "tsconfig.check.json");
  if (batch) {
    batchRoots.add(root);
    for (const file of absolute) batchFiles.add(file);
  }
  virtualFile(config, JSON.stringify({ compilerOptions: STRICT_OPTIONS, files: batch ? [...batchFiles] : absolute }));
  const next = await typeServer().updateSnapshot({
    ...(openConfig === config ? {} : { openProjects: [config], ...(openConfig ? { closeProjects: [openConfig] } : {}) }),
    fileChanges: { invalidateAll: true },
  });
  openConfig = config;
  const previous = lastSnapshot;
  lastSnapshot = next;
  try {
    const project = next.getProject(config);
    if (!project) throw new Error(`TypeScript did not open ${config}`);
    // Like tsc, check imported implementation files too, not merely the explicit root files.
    const diagnostics = [
      ...await project.program.getConfigFileParsingDiagnostics(),
      ...await project.program.getProgramDiagnostics(),
      ...await project.program.getGlobalDiagnostics(),
      ...await project.program.getSyntacticDiagnostics(),
      ...await project.program.getSemanticDiagnostics(),
    ].filter((diagnostic) => !batch || !diagnostic.fileName || ![...batchRoots].some((other) =>
      other !== root && diagnostic.fileName!.startsWith(`${other}${sep}`)));
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
