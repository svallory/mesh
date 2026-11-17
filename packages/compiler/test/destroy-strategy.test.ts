// How a destroy writes (ADR-0054, ADR-0046 option B): `destroyStrategy` is shared by the actions view and `mesh explain`.
// A destroy whose only reason to read the row is record-reading policy checks that lower to SQL in write mode is one
// guarded delete when the data adapter declares `policy-guards`; every neighbour keeps today's read-first or plain delete,
// and a project whose adapter does not declare the capability gets byte-identical output (R8).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Entity, ModelDocument } from "@meshfw/model";
import type { ResolvedConfig } from "../src/config.ts";
import { buildModel } from "../src/front-end/build.ts";
import { generateFiles } from "../src/typescript/emit.ts";
import { explainAction } from "../src/typescript/explain.ts";
import { destroyStrategy, type DestroyStrategy } from "../src/typescript/strategy.ts";
import { configOf } from "./generated.ts";

const GUARDS = ["policy-guards", "joins", "conditions", "aggregates"] as const;
const NO_JOINS = ["policy-guards", "conditions", "aggregates"] as const;

const helpers = "export const isStaff = (actor: unknown): boolean => actor === null;\n";
const folder = `import { Note } from "./note.mesh.mx"
entity :Folder
  attributes
    uuid :id primary-key
    uuid :ownerId
  relationships
    has-many :notes entity=Note
  computed
    count :noteCount of=&notes
  actions auto=[:read]
    destroy :empty
  policies
    policy :open types=[:read]
      authorize-if=() => true
    policy :noNotes actions=[&empty]
      forbid-if=() => &noteCount > 0
`;
const command = `command :RemoveNote
  uuid :id
`;
// One destroy per case, each covered by a policy of its own (`actions=[&x]`), so each answers one question.
const note = `import { Folder } from "./folder.mesh.mx"
import { RemoveNote } from "./remove-note.mesh.mx"
import { isStaff } from "./helpers"
import { Mesh } from "meshfw"
entity :Note
  attributes
    uuid :id primary-key
    uuid :ownerId
    boolean :locked default=false
    string :title
  relationships
    belongs-to :folder entity=Folder
  actions auto=[:read]
    always actions=[&alwaysChecked]
      validate
        check :titled that=({ self }) => self.title.length > 0 code="t" message="t"
    destroy :open
    destroy :actorOnly
    destroy :byOwner
    destroy :byFolder
    destroy :bySystem
    destroy :byWhen
    destroy :byBlock
    destroy :byHelper
    destroy :byPrivileged
    destroy :withCheck
      validate
        check :unlocked that=({ self }) => self.locked === false code="l" message="l"
    destroy :alwaysChecked
    destroy :withRun
      do
        run () { }
    destroy :withRunAfter
      do
        run [after=:write] () { }
    destroy on=RemoveNote
  policies
    policy :public types=[:read]
      authorize-if=() => true
    policy :anyone actions=[&open]
      authorize-if=() => true
    policy :signedIn actions=[&actorOnly]
      authorize-if=({ actor }) => actor.id !== null
    policy :owner actions=[&byOwner, &withCheck, &alwaysChecked, &withRun, &withRunAfter, &removeNote]
      authorize-if=({ actor }) => &ownerId === actor.id
      forbid-if=() => &locked
    policy :folderOwner actions=[&byFolder]
      authorize-if=({ actor }) => &folder.ownerId === actor.id
    policy :system actions=[&bySystem]
      authorize-if=({ context, actor }) => Mesh.isSystem(context) || &ownerId === actor.id
    policy :unlockedOnly actions=[&byWhen] when=() => &locked === false
      authorize-if=({ actor }) => actor.id !== null
    policy :block actions=[&byBlock]
      authorize-if=({ actor }) => { return &ownerId === actor.id }
    policy :helper actions=[&byHelper]
      authorize-if=({ actor }) => &ownerId === actor.id || isStaff(actor)
    policy :privileged actions=[&byPrivileged]
      authorize-if=({ actor }) => Mesh.privileged(Folder) !== null && &ownerId === actor.id
`;

let root: string;
let document: ModelDocument;
const entity = (name: string): Entity => document.entities.find((candidate) => candidate.name === name)!;
const strategyOf = (name: string, capabilities: readonly string[], owner = "Note") => {
  const found = entity(owner);
  const action = [...found.actions, ...found.auto.map((kind) => ({ kind, name: kind }))].find((candidate) => candidate.name === name);
  return destroyStrategy(document, found, action as never, capabilities);
};

beforeAll(async () => {
  root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-destroy-strategy-"));
  await mkdir(resolve(root, "notes"));
  await writeFile(resolve(root, "notes/helpers.ts"), helpers);
  const built = buildModel({ root, files: Object.entries({ folder, note, "remove-note": command }).map(([name, source]) => ({ file: `notes/${name}.mesh.mx`, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  document = built.document!;
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const READ = "read-then-write: the body can see the stored record, so the row is read under the lock before it is deleted";

describe("destroyStrategy", () => {
  const cases: [action: string, withGuards: DestroyStrategy, withoutGuards: DestroyStrategy][] = [
    // no policy function reads the record: one delete by key, as today
    ["open", "delete", "delete"],
    ["actorOnly", "delete", "delete"],
    // record-reading checks that translate: guarded with the capability, read first without it
    ["byOwner", "guarded", "read"],
    ["byFolder", "guarded", "read"],
    ["bySystem", "guarded", "read"],
    ["removeNote", "guarded", "read"],
    // the legal neighbours keep the read path whatever the adapter declares
    ["byWhen", "read", "read"],
    ["byBlock", "read", "read"],
    ["byHelper", "read", "read"],
    ["byPrivileged", "read", "read"],
    ["withCheck", "read", "read"],
    ["alwaysChecked", "read", "read"],
    ["withRun", "read", "read"],
    ["withRunAfter", "read", "read"],
  ];
  for (const [action, withGuards, withoutGuards] of cases)
    test(`${action}: ${withGuards} with policy-guards, ${withoutGuards} without`, () => {
      expect(strategyOf(action, GUARDS).strategy).toBe(withGuards);
      expect(strategyOf(action, []).strategy).toBe(withoutGuards);
      expect(strategyOf(action, ["joins", "conditions", "aggregates"]).strategy).toBe(withoutGuards);
    });

  test("the guarded checks are every record-reading check of the covering policies, in declaration order", () => {
    expect(strategyOf("byOwner", GUARDS).guarded.map(({ id }) => id)).toEqual(["policy.owner.authorize-if.0", "policy.owner.forbid-if.0"]);
    expect(strategyOf("byOwner", []).guarded).toEqual([]);
  });

  test("a check that crosses a relationship reads first when the adapter does not declare joins", () => {
    const plan = strategyOf("byFolder", NO_JOINS);
    expect(plan.strategy).toBe("read");
    expect(plan.reason).toBe(`${READ} (policy :folderOwner authorize-if reads the record, and the delete statement cannot check it: it reads &folder.ownerId through a relationship, and the data adapter does not declare joins)`);
  });

  test("a check that reads a rollup lowers (m10-rollups) and is guarded", () => {
    expect(strategyOf("empty", GUARDS, "Folder").strategy).toBe("guarded");
    expect(strategyOf("empty", [], "Folder").strategy).toBe("read");
  });

  test("the read reason names the check that does not translate, only when the adapter declares policy-guards", () => {
    expect(strategyOf("byHelper", GUARDS).reason).toBe(`${READ} (policy :helper authorize-if reads the record, and the delete statement cannot check it: it calls isStaff, which in a write policy counts as reading the record)`);
    expect(strategyOf("byBlock", GUARDS).reason).toMatch(/^read-then-write: .* \(policy :block authorize-if reads the record, and the delete statement cannot check it: Mesh does not translate it \(.+\)\)$/);
    expect(strategyOf("byPrivileged", GUARDS).reason).toMatch(/\(policy :privileged authorize-if reads the record, and the delete statement cannot check it: Mesh does not translate it/);
    for (const action of ["byHelper", "byBlock", "byWhen", "withCheck"]) expect(strategyOf(action, []).reason).toBe(READ);
    // A record-reading `when=` or a check reads first before the capability is looked at: today's reason.
    expect(strategyOf("byWhen", GUARDS).reason).toBe(READ);
    expect(strategyOf("withCheck", GUARDS).reason).toBe(READ);
  });
});

describe("mesh explain", () => {
  const section = (lines: readonly string[], name: string) => {
    const at = lines.findIndex((line) => line.startsWith(`  ${name.padEnd(12)} `));
    const end = lines.findIndex((line, i) => i > at && /^ {2}\S/.test(line));
    return lines.slice(at, end < 0 ? undefined : end).map((line) => line.slice(15));
  };

  test("a guarded destroy says the delete checks the policies, and where each check runs", () => {
    const lines = explainAction(entity("Note"), "byOwner", document, GUARDS)!;
    expect(section(lines, "strategy")).toEqual(["one delete by key with the policies in the statement: the checks that read the record (:owner) run inside the delete, which fails as forbidden when they deny (ADR-0046, option B); with an afterWrite or afterCommit seam registered, or under Mesh.checkPolicies or Mesh.can, the row is read under the lock first and the policies run in memory"]);
    expect(section(lines, "policies").slice(0, 3)).toEqual([
      ":owner",
      "  authorize-if ({ actor }) => &ownerId === actor.id: in the delete statement: a denial raises forbidden (ADR-0046 B); read under the lock first when a seam wants before or under Mesh.checkPolicies",
      "  forbid-if () => &locked: in the delete statement: a denial raises forbidden (ADR-0046 B); read under the lock first when a seam wants before or under Mesh.checkPolicies",
    ]);
  });

  test("without the capability, or without the model, the plan is today's", () => {
    const today = explainAction(entity("Note"), "byOwner", document)!;
    expect(section(today, "strategy")).toEqual([READ]);
    expect(section(today, "policies")[1]).toBe("  authorize-if ({ actor }) => &ownerId === actor.id: inside the transaction, on the locked row, before validate");
    expect(explainAction(entity("Note"), "byOwner")).toEqual(today);
    expect(explainAction(entity("Note"), "byOwner", undefined, GUARDS)).toEqual(today);
    for (const action of ["open", "byHelper", "withRun", "byWhen"])
      expect(explainAction(entity("Note"), action, document, [])).toEqual(explainAction(entity("Note"), action)!);
  });

  test("a destroy that reads first on an adapter with policy-guards says which check stops the guard", () => {
    expect(section(explainAction(entity("Note"), "byHelper", document, GUARDS)!, "strategy")[0]).toContain("(policy :helper authorize-if reads the record, and the delete statement cannot check it: it calls isStaff");
    expect(section(explainAction(entity("Note"), "byHelper", document, GUARDS)!, "policies")[1]).toContain("inside the transaction, on the locked row, before validate");
  });
});

describe("the generated files", () => {
  const configWith = (capabilities: readonly string[]): ResolvedConfig => {
    const config = configOf(root);
    return { ...config, data: { ...config.data, capabilities: { adapter: "sqlite", capabilities: [...capabilities] as never } } };
  };
  /** Each method of an actions file, by name: from `async <name>(` to the next method. */
  const methods = (contents: string) => {
    const out = new Map<string, string>();
    const parts = contents.split(/^(?= {4}async [\w$]+\()/m);
    for (const part of parts.slice(1)) out.set(/^ {4}async ([\w$]+)\(/.exec(part)![1]!, part);
    return out;
  };
  let without: Map<string, string>;
  let withGuards: Map<string, string>;
  beforeAll(async () => {
    without = new Map((await generateFiles({ document, config: configOf(root) })).map((file) => [file.path, file.contents]));
    withGuards = new Map((await generateFiles({ document, config: configWith(GUARDS) })).map((file) => [file.path, file.contents]));
  });
  const fileOf = (files: Map<string, string>, suffix: string) => [...files].find(([path]) => path.endsWith(suffix))![1];

  test("an empty capability list and one without policy-guards give byte-identical files (R8)", async () => {
    const other = new Map((await generateFiles({ document, config: configWith(["joins", "conditions", "aggregates"]) })).map((file) => [file.path, file.contents]));
    expect(other).toEqual(without);
  });

  test("with policy-guards, only the guarded destroys and their literals change; every other action is byte-identical", () => {
    expect([...withGuards.keys()].sort()).toEqual([...without.keys()].sort());
    const changed = [...withGuards].filter(([path, contents]) => without.get(path) !== contents).map(([path]) => path.replace(/^.*generated\//, "")).sort();
    expect(changed).toEqual(["domain/notes/folder.actions.ts", "domain/notes/folder.expressions.ts", "domain/notes/note.actions.ts", "domain/notes/note.expressions.ts"]);
    const before = methods(fileOf(without, "note.actions.ts"));
    const after = methods(fileOf(withGuards, "note.actions.ts"));
    expect([...after.keys()]).toEqual([...before.keys()]);
    const differ = [...after.keys()].filter((name) => after.get(name) !== before.get(name)).sort();
    expect(differ).toEqual(["byFolder", "byOwner", "bySystem", "removeNote"]);
  });

  test("a guarded destroy keeps the read path for seams, questions and a layer without the method, and deletes in one statement otherwise", () => {
    const body = methods(fileOf(withGuards, "note.actions.ts")).get("byOwner")!;
    expect(body).toContain('sql: () => $conditions["policy.owner.authorize-if.0"]');
    expect(body).toContain('sql: () => $conditions["policy.owner.forbid-if.0"]');
    expect(body).toContain("await $policies.before(layer, $preScope);");
    expect(body).toContain("if ($wantsChanges(options.seams) || $policies.answering || !tx.deleteByKeyGuarded) {");
    expect(body).toContain("await $policies.inside($checkScope($s));");
    expect(body).toContain("const $guard = $policies.guard($preScope, $tableOf);");
    expect(body).toContain("tx.deleteByKeyGuarded!(tables.note, $key, $guard)");
    expect(body).toContain("$seen ?? null");
    // A check that is not guarded carries no literal: the actor-only one of another destroy.
    expect(methods(fileOf(withGuards, "note.actions.ts")).get("actorOnly")).not.toContain("sql:");
  });

  test("the expressions file holds one write-mode literal per guarded check, and the actions file maps the tables a hop reaches", () => {
    const expressions = fileOf(withGuards, "note.expressions.ts");
    for (const id of ["policy.owner.authorize-if.0", "policy.owner.forbid-if.0", "policy.folderOwner.authorize-if.0", "policy.system.authorize-if.0"])
      expect(expressions).toContain(`"${id}": {`);
    // Not guarded, so no literal: a helper call and plain code.
    expect(expressions).not.toContain('"policy.helper.authorize-if.0": {');
    expect(fileOf(without, "note.expressions.ts")).not.toContain('"policy.owner.authorize-if.0": {');
    expect(fileOf(withGuards, "note.actions.ts")).toMatch(/const \$tableOf: \$TableOf = \(fqn\) =>\s+\(\(\{ "notes\.Folder": tables\.folder \}\)/);
  });
});
