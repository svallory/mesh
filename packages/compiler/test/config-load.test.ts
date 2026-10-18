// What `loadConfig` says when mesh.config.ts cannot be loaded, and the `events` key's checks (spec, Events and commands,
// "Configuration and the events module"). A config that loads `#mesh` while it loads is refused with `MESH_CONFIG_LOAD`
// in all three forms it takes: no output folder yet, an output folder without the module the config names, and a stale
// output folder that loads without an error. The last is found by listing `require.cache` before and after the import,
// which relies on Bun listing ES modules there; the first test pins that.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../src/index.ts";
import { keyed } from "./v4.ts";

const data = { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: "app.db" } } as const;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const IMPORTS = { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" };
const FIX = "Import it inside the function that uses it: `const { tables } = await import(\"#mesh\")`. A type-only import (`import type`) is fine.";
const message = (specifier: string) =>
  `mesh.config.ts imports \`${specifier}\` (directly or through a file it imports). \`#mesh\` is the code Mesh generates from this config, so the build cannot load it first.`;

/** A project with one entity, a package.json mapping `#mesh`, the given files and a config made of `head` and the default export. */
async function project(head: string, files: Record<string, string> = {}, config = `{ domain: "src/domain", output: ".mesh", data: ${JSON.stringify(data)} }`) {
  const root = await mkdtemp(resolve(tmpdir(), "mesh-config-load-"));
  roots.push(root);
  const all: Record<string, string> = {
    "package.json": JSON.stringify({ name: "config-load", type: "module", imports: IMPORTS }),
    "src/domain/todo.mesh.mx": keyed,
    ...files,
    "mesh.config.ts": `${head}\nexport default ${config};\n`,
  };
  for (const [path, source] of Object.entries(all)) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), source);
  }
  return root;
}
const GENERATED = {
  ".mesh/index.ts": "export const tables = { stale: true };\n",
  ".mesh/domain/index.ts": "export const domain = 1;\n",
  ".mesh/domain/billing/index.ts": "export const Invoice = { stale: true };\n",
};
const brief = (result: Awaited<ReturnType<typeof loadConfig>>) =>
  result.diagnostics.map(({ code, message, fix, position }) => ({ code, message, fix, line: position?.line, column: position?.column }));

describe("Bun lists the ES modules import() loads in require.cache", () => {
  test("a module loaded by import(), and the module it imports, are keys of require.cache after the import and not before", async () => {
    const root = await project("");
    await writeFile(resolve(root, "leaf.ts"), "export const leaf = 1;\n");
    await writeFile(resolve(root, "entry.ts"), "import { leaf } from \"./leaf.ts\";\nexport const entry = leaf + 1;\n");
    const before = new Set(Object.keys(require.cache));
    expect(before.has(resolve(root, "entry.ts"))).toBe(false);
    const loaded = await import(resolve(root, "entry.ts"));
    expect(loaded.entry).toBe(2);
    const added = Object.keys(require.cache).filter((key) => !before.has(key));
    expect(added).toContain(resolve(root, "entry.ts"));
    expect(added).toContain(resolve(root, "leaf.ts"));
  });
});

describe("a config that loads #mesh while it loads is MESH_CONFIG_LOAD, at 1:1, with the import moved inside a function as its fix", () => {
  test("no output folder yet: the specifier does not resolve", async () => {
    const result = await loadConfig(await project("import { tables } from \"#mesh\";\nvoid tables;"));
    expect(result.config).toBeNull();
    expect(brief(result)).toEqual([{ code: "MESH_CONFIG_LOAD", message: message("#mesh"), fix: FIX, line: 1, column: 0 }]);
  });

  test("an output folder without the module the config names, as when an entity file has only just added it", async () => {
    const root = await project("import { Invoice } from \"#mesh/domain/billing\";\nvoid Invoice;", { ".mesh/index.ts": GENERATED[".mesh/index.ts"] });
    const result = await loadConfig(root);
    expect(result.config).toBeNull();
    expect(brief(result)).toEqual([{ code: "MESH_CONFIG_LOAD", message: message("#mesh/domain/billing"), fix: FIX, line: 1, column: 0 }]);
  });

  test("through a file the config imports, the specifier that file names", async () => {
    const root = await project("import { seam } from \"./src/seams.ts\";\nvoid seam;", { "src/seams.ts": "import { tables } from \"#mesh\";\nexport const seam = () => tables;\n" });
    expect(brief(await loadConfig(root))).toEqual([{ code: "MESH_CONFIG_LOAD", message: message("#mesh"), fix: FIX, line: 1, column: 0 }]);
  });

  test("a stale output folder that loads without an error: the generated module the config loaded, named by its specifier", async () => {
    const root = await project("import { tables } from \"#mesh\";\nvoid tables;", GENERATED);
    const result = await loadConfig(root);
    expect(result.config).toBeNull();
    expect(brief(result)).toEqual([{ code: "MESH_CONFIG_LOAD", message: message("#mesh"), fix: FIX, line: 1, column: 0 }]);
  });

  test("a stale module of a domain folder, loaded through a file the config imports, is named #mesh/domain/<folder>", async () => {
    const root = await project("import { seam } from \"./src/seams.ts\";\nvoid seam;", {
      ...GENERATED,
      "src/seams.ts": "import { Invoice } from \"#mesh/domain/billing\";\nexport const seam = () => Invoice;\n",
    });
    expect(brief(await loadConfig(root))).toEqual([{ code: "MESH_CONFIG_LOAD", message: message("#mesh/domain/billing"), fix: FIX, line: 1, column: 0 }]);
  });

  test("a stale module under a nested output folder", async () => {
    const root = await project("import { tables } from \"./src/generated/index.ts\";\nvoid tables;", { "src/generated/index.ts": "export const tables = {};\n" },
      `{ domain: "src/domain", output: "src/generated", data: ${JSON.stringify(data)} }`);
    expect(brief(await loadConfig(root))).toEqual([{ code: "MESH_CONFIG_LOAD", message: message("#mesh"), fix: FIX, line: 1, column: 0 }]);
  });

  test("an import inside a function and a type-only import load nothing generated, so the config loads", async () => {
    const root = await project([
      "import type { tables as Tables } from \"#mesh\";",
      "export const seam = async (): Promise<typeof Tables> => (await import(\"#mesh\")).tables;",
    ].join("\n"), GENERATED);
    const result = await loadConfig(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.config).not.toBeNull();
  });

  test("a generated module the process loaded before the build is not reported again (the check sees only what the config's import adds)", async () => {
    const root = await project("import { tables } from \"#mesh\";\nvoid tables;", GENERATED);
    await import(resolve(root, ".mesh/index.ts"));
    expect((await loadConfig(root)).diagnostics).toEqual([]);
  });

  test("any other load error keeps its own text, with a fix that points at the file that threw", async () => {
    const root = await project("throw new TypeError(\"broken seam\");");
    expect(brief(await loadConfig(root))).toEqual([{
      code: "MESH_CONFIG_LOAD", message: "Cannot load mesh.config.ts: TypeError: broken seam",
      fix: "Fix the error in mesh.config.ts, or in the file it imports that threw it", line: 1, column: 0,
    }]);
  });

  test("a missing package that is not #mesh is reported as the load error it is", async () => {
    const result = await loadConfig(await project("import { x } from \"no-such-package-mesh-test\";\nvoid x;"));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: "MESH_CONFIG_LOAD", fix: "Fix the error in mesh.config.ts, or in the file it imports that threw it" });
    expect(result.diagnostics[0]!.message).toStartWith("Cannot load mesh.config.ts: ");
    expect(result.diagnostics[0]!.message).toContain("no-such-package-mesh-test");
  });
});

describe("the events key", () => {
  const withEvents = (events: string) => project("", {}, `{ domain: "src/domain", output: ".mesh", data: ${JSON.stringify(data)}, events: ${events} }`);
  const codes = async (events: string) => brief(await loadConfig(await withEvents(events))).map(({ code, message, fix }) => ({ code, message, fix }));

  test("load and keep, each optional, are kept on the resolved config", async () => {
    const all = await loadConfig(await withEvents("{ load: () => import(\"./src/events.ts\"), keep: \"all\" }"));
    expect(all.diagnostics).toEqual([]);
    expect(all.config!.events!.keep).toBe("all");
    expect(typeof all.config!.events!.load).toBe("function");
    const empty = await loadConfig(await withEvents("{}"));
    expect(empty.diagnostics).toEqual([]);
    expect(empty.config!.events).toEqual({});
    expect((await loadConfig(await withEvents("{ keep: \"until-delivered\" }"))).config!.events).toEqual({ keep: "until-delivered" });
    const none = await loadConfig(await project(""));
    expect(none.config).not.toBeNull();
    expect(Object.hasOwn(none.config!, "events")).toBe(false);
  });

  test("not an object", async () => {
    for (const value of ["null", "\"all\"", "[]", "() => ({})"]) {
      expect(await codes(value), value).toEqual([{ code: "MESH_EVENTS_CONFIG", message: "Configuration field `events` must be an object", fix: "Set events: { bus, load, keep, requires }; bus is needed once an event is declared" }]);
    }
  });

  test("a keep that is not one of its values", async () => {
    const fix = "Set keep: \"until-delivered\" (the default: a row is deleted once delivered) or keep: \"all\" (every row is kept)";
    expect(await codes("{ keep: \"forever\" }")).toEqual([{ code: "MESH_EVENTS_CONFIG", message: "`events.keep` must be \"until-delivered\" or \"all\", and is \"forever\"", fix }]);
    expect(await codes("{ keep: undefined }")).toEqual([{ code: "MESH_EVENTS_CONFIG", message: "`events.keep` must be \"until-delivered\" or \"all\", and is undefined", fix }]);
    expect(await codes("{ keep: 30 }")).toEqual([{ code: "MESH_EVENTS_CONFIG", message: "`events.keep` must be \"until-delivered\" or \"all\", and is 30", fix }]);
  });

  test("a load that is not a function", async () => {
    for (const value of ["\"./src/events.ts\"", "{}", "null"]) {
      expect(await codes(`{ load: ${value} }`), value).toEqual([{ code: "MESH_EVENTS_CONFIG", message: "`events.load` must be a function that imports the events module", fix: "Set load: () => import(\"./src/events.ts\")" }]);
    }
  });

  const bus = (capabilities: string) => `{ manifest: { adapter: "fake", capabilities: ${capabilities} }, create() { return {}; } }`;

  test("a bus and requires are kept on the resolved config", async () => {
    const loaded = await loadConfig(await withEvents(`{ bus: ${bus('["ordered-delivery", "replay"]')}, requires: ["replay", "gapless-positions"] }`));
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.config!.events!.bus!.manifest).toEqual({ adapter: "fake", capabilities: ["ordered-delivery", "replay"] });
    expect(loaded.config!.events!.requires).toEqual(["replay", "gapless-positions"]);
  });

  test("a bus that is not an event-bus descriptor", async () => {
    const fix = "Set bus: localBus() (from @meshfw/bus-local), or another event-bus adapter's descriptor";
    const cases: [string, string][] = [
      ["{}", "it has no create function: an event-bus descriptor has { manifest, create(core, options) }"],
      ["\"local\"", "it must be an event-bus descriptor, such as localBus()"],
      ["{ create() {} }", "it has no manifest: an event-bus descriptor declares { adapter, capabilities }"],
      [bus('["ordered-delivery", "prune"]'), "its manifest lists the unknown capability \"prune\"; the closed set is ordered-delivery, replay, subscribe, dead-letters, multi-process"],
      [bus('["replay", "replay"]'), "its manifest lists the capability \"replay\" twice"],
      [`{ manifest: { adapter: "", capabilities: [] }, create() {} }`, "its manifest's adapter must be a non-empty string"],
    ];
    for (const [value, problem] of cases)
      expect(await codes(`{ bus: ${value} }`), value).toEqual([{ code: "MESH_EVENTS_CONFIG", message: `\`events.bus\` is not a valid event bus: ${problem}`, fix }]);
  });

  test("requires that is not a list of capability names, and any other field is unknown; every problem is reported", async () => {
    expect(await codes("{ requires: \"replay\" }")).toEqual([{ code: "MESH_EVENTS_CONFIG", message: "`events.requires` must be an array of capability names", fix: expect.stringContaining("Set requires:") }]);
    expect(await codes("{ requires: [\"replay\", \"prune\", \"replay\", 3], retain: 3, keep: \"no\" }")).toEqual([
      { code: "MESH_EVENTS_CONFIG", message: "`events.requires` lists \"prune\", which is no capability: the bus's are ordered-delivery, replay, subscribe, dead-letters, multi-process, and the data adapter's aggregates, integer-key-fill, joins, upserts, atomic-expressions, gapless-positions", fix: "Remove it, or correct the name" },
      { code: "MESH_EVENTS_CONFIG", message: "`events.requires` lists \"replay\" twice", fix: "Remove the second one" },
      { code: "MESH_EVENTS_CONFIG", message: expect.stringContaining("`events.requires` lists 3, which is no capability"), fix: "Remove it, or correct the name" },
      { code: "MESH_EVENTS_CONFIG", message: "Unknown field \"retain\" in configuration field `events`; its fields are bus, load, keep and requires", fix: "Remove the unknown field" },
      { code: "MESH_EVENTS_CONFIG", message: "`events.keep` must be \"until-delivered\" or \"all\", and is \"no\"", fix: expect.any(String) },
    ]);
  });
});
