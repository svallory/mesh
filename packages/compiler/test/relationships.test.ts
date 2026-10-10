import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildModel } from "../src/front-end/build.ts";

/** M7: relationships resolve across files; the build records the key each follows and the type of each key. */
const build = (files: Record<string, string>) =>
  buildModel({ root: "/project", files: Object.entries(files).map(([file, source]) => ({ file: `app/${file}`, source })) });
const codes = (result: ReturnType<typeof build>) => result.diagnostics.map((d) => d.code);
const entityOf = (result: ReturnType<typeof build>, name: string) => result.document!.entities.find((e) => e.name === name)!;

const task = `entity :Task
  attributes
    uuid :id primary-key
  relationships
    belongs-to :parent entity=Task nullable
    has-many :children entity=Task
`;
const collaborator = (via = "") => `import { Membership } from "./membership.mesh.mx"
entity :Collaborator
  attributes
    uuid :id primary-key
  relationships
    has-many :memberships entity=Membership${via}
`;
const membership = (extra = "") => `import { Collaborator } from "./collaborator.mesh.mx"
entity :Membership
  attributes
    uuid :id primary-key
  relationships
    belongs-to :collaborator entity=Collaborator
    belongs-to :grantedBy entity=Collaborator
    belongs-to :revokedBy entity=Collaborator nullable${extra}
`;

describe("self-reference (acceptance 1)", () => {
  test("an entity relates to its own type with no import, and has-many follows the only belongs-to back", () => {
    const result = build({ "task.mesh.mx": task });
    expect(result.diagnostics).toEqual([]);
    const [parent, children] = entityOf(result, "Task").relationships;
    expect(parent).toMatchObject({ kind: "belongs-to", entity: { identifier: "Task", from: "./task.mesh.mx" }, keyColumn: "parentId", keyType: "uuid" });
    expect(children).toMatchObject({ kind: "has-many", entity: { identifier: "Task", from: "./task.mesh.mx" }, via: "parent" });
    expect(entityOf(result, "Task").imports).toEqual([]);
  });

  test("a self-import is still accepted and means the same", () => {
    const result = build({ "task.mesh.mx": `import { Task } from "./task.mesh.mx"\n${task}` });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Task").relationships[1]).toMatchObject({ via: "parent" });
  });

  test("a self-cycle (a record that is its own parent) is data, not a build error", () => {
    const result = build({ "task.mesh.mx": task });
    expect(result.document).not.toBeNull();
  });

  test("a misspelt own name is an unknown entity at the entity option, with a suggestion", () => {
    const result = build({ "task.mesh.mx": task.replace("belongs-to :parent entity=Task", "belongs-to :parent entity=Tsak") });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_UNKNOWN_ENTITY", message: "Tsak is not an imported entity. Did you mean Task?", position: expect.objectContaining({ line: 5 }) })]);
  });

  test("two belongs-to to the same type make a has-many ask for via", () => {
    const source = task.replace("    has-many", "    belongs-to :corrects entity=Task nullable\n    has-many");
    const result = build({ "task.mesh.mx": source });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_VIA_REQUIRED", message: expect.stringContaining(":parent, :corrects") })]);
    const fixed = build({ "task.mesh.mx": source.replace("has-many :children entity=Task", "has-many :children entity=Task via=:parent") });
    expect(fixed.diagnostics).toEqual([]);
    expect(entityOf(fixed, "Task").relationships[2]).toMatchObject({ via: "parent" });
  });
});

describe("a relationship to an unknown entity (acceptance 6)", () => {
  test("fails at the tag's entity option, and the rest of the build still runs", () => {
    const source = `entity :Post
  attributes
    uuid :id primary-key
  relationships
    belongs-to :author entity=User
`;
    const result = build({ "post.mesh.mx": source });
    expect(result.document).toBeNull();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_UNKNOWN_ENTITY", message: "User is not an imported entity.", position: expect.objectContaining({ file: "app/post.mesh.mx", line: 5, column: 30 }) })]);
  });

  test("an import of a file that is not an entity file is not an entity", () => {
    const result = build({ "post.mesh.mx": `import { User } from "./user"\nentity :Post\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :author entity=User\n` });
    expect(codes(result)).toContain("MESH_UNKNOWN_ENTITY");
  });
});

describe("via (acceptance 2, ADR-0070)", () => {
  test("without via, the build lists the candidates", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(), "membership.mesh.mx": membership() });
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "MESH_VIA_REQUIRED",
      message: "has-many :memberships of :Collaborator could follow any of 3 belongs-to of :Membership back to :Collaborator (:collaborator, :grantedBy, :revokedBy)",
      fix: "Choose one: `via=:collaborator`",
    })]);
  });

  test("with via, the model records the key that has-many follows", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(" via=:collaborator"), "membership.mesh.mx": membership() });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Collaborator").relationships[0]).toMatchObject({ via: "collaborator" });
    const other = build({ "collaborator.mesh.mx": collaborator(" via=:grantedBy"), "membership.mesh.mx": membership() });
    expect(entityOf(other, "Collaborator").relationships[0]).toMatchObject({ via: "grantedBy" });
  });

  test("with exactly one belongs-to back, via may be left out", () => {
    const one = membership().replace(/    belongs-to :grantedBy.*\n/, "").replace(/    belongs-to :revokedBy.*/, "");
    const result = build({ "collaborator.mesh.mx": collaborator(), "membership.mesh.mx": one });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Collaborator").relationships[0]).toMatchObject({ via: "collaborator" });
  });

  test("a via that names no belongs-to of the other entity is an error at the option, with a suggestion", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(" via=:collaborater"), "membership.mesh.mx": membership() });
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "MESH_VIA_UNKNOWN",
      message: "via=:collaborater names no belongs-to of :Membership. Did you mean via=:collaborator?",
      position: expect.objectContaining({ file: "app/collaborator.mesh.mx", line: 6 }),
    })]);
    expect(result.document).toBeNull();
  });

  test("a via that names an attribute is not a belongs-to", () => {
    const source = membership().replace("uuid :id primary-key", "uuid :id primary-key\n    string :role");
    const result = build({ "collaborator.mesh.mx": collaborator(" via=:role"), "membership.mesh.mx": source });
    expect(codes(result)).toEqual(["MESH_VIA_UNKNOWN"]);
  });

  test("a via that names a belongs-to to a different entity says where it points", () => {
    const source = `import { Collaborator } from "./collaborator.mesh.mx"\nimport { Workspace } from "./workspace.mesh.mx"
entity :Membership
  attributes
    uuid :id primary-key
  relationships
    belongs-to :collaborator entity=Collaborator
    belongs-to :workspace entity=Workspace
`;
    const workspace = "entity :Workspace\n  attributes\n    uuid :id primary-key\n";
    const result = build({ "collaborator.mesh.mx": collaborator(" via=:workspace"), "membership.mesh.mx": source, "workspace.mesh.mx": workspace });
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "MESH_VIA_ENTITY",
      message: "via=:workspace is a belongs-to of :Membership that points at :Workspace, not at :Collaborator. The belongs-to from :Membership to :Collaborator: :collaborator.",
    })]);
  });

  test("via names a belongs-to, not a member of this entity: &name is not accepted", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(" via=&collaborator"), "membership.mesh.mx": membership() });
    expect(result.document).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test("has-one takes no via", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(" via=:collaborator").replace("has-many", "has-one"), "membership.mesh.mx": membership() });
    expect(result.document).toBeNull();
    expect(result.diagnostics[0]!.message).toContain("via");
  });

  test("a has-one with several belongs-to back cannot choose, and says so", () => {
    const result = build({ "collaborator.mesh.mx": collaborator().replace("has-many", "has-one"), "membership.mesh.mx": membership() });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_VIA_REQUIRED", message: expect.stringContaining("a has-one takes no via") })]);
  });

  test("no belongs-to back is not a build error: cross-file inverse checks come after 1.0, and loading it fails at run time", () => {
    const result = build({
      "collaborator.mesh.mx": collaborator(),
      "membership.mesh.mx": "entity :Membership\n  attributes\n    uuid :id primary-key\n",
    });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Collaborator").relationships[0]!.via).toBeUndefined();
  });

  test("several has-many to the same entity, each with its own via", () => {
    const dependency = (extra: string) => `import { Task } from "./task.mesh.mx"
entity :Dependency
  attributes
    uuid :id primary-key
  relationships
    belongs-to :dependent entity=Task
    belongs-to :prerequisite entity=Task${extra}
`;
    const owner = `import { Dependency } from "./dependency.mesh.mx"
entity :Task
  attributes
    uuid :id primary-key
  relationships
    has-many :dependencies entity=Dependency via=:dependent
    has-many :dependents entity=Dependency via=:prerequisite
`;
    const result = build({ "task.mesh.mx": owner, "dependency.mesh.mx": dependency("") });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Task").relationships.map((r) => r.via)).toEqual(["dependent", "prerequisite"]);
  });
});

describe("the type of a belongs-to key follows the target's key", () => {
  const target = (type: string) => `entity :Customer\n  attributes\n    ${type} :id primary-key\n`;
  const invoice = `import { Customer } from "./customer.mesh.mx"\nentity :Invoice\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :customer entity=Customer\n`;
  for (const type of ["uuid", "string", "integer"])
    test(`a ${type} key gives a ${type} key column`, () => {
      const result = build({ "customer.mesh.mx": target(type), "invoice.mesh.mx": invoice });
      expect(result.diagnostics).toEqual([]);
      expect(entityOf(result, "Invoice").relationships[0]).toMatchObject({ keyColumn: "customerId", keyType: type });
    });
});

describe("helper names that collide with generated internals", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  async function withHelpers(names: string[]) {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-helper-names-"));
    roots.push(root);
    await writeFile(resolve(root, "helpers.ts"), names.map((name) => `export const ${name} = (n: number) => n > 1;`).join("\n"));
    const source = `import { ${names.join(", ")} } from "./helpers"\nentity :Task\n  attributes\n    uuid :id primary-key\n    integer :size\n  actions auto=[:read]\n    update :resize\n      validate\n        check :big that=({ input }) => ${names[0]}(input.size) code="small" message="too small"\n`;
    return buildModel({ root, files: [{ file: "task.mesh.mx", source }] });
  }
  for (const name of ["$", "$s", "$helper", "l$x", "l$"])
    test(`${name} is a build error that says why`, async () => {
      const result = await withHelpers([name]);
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([expect.objectContaining({
        code: "MESH_HELPER_NAME",
        message: `The helper name ${name} cannot start with $ or l$: generated code uses those prefixes for its own names`,
        position: expect.objectContaining({ line: 1, column: 9 }),
      })]);
      expect(result.document).toBeNull();
    });
  test("each offending name in one import is reported, and names that only contain $ or l are fine", async () => {
    const result = await withHelpers(["$a", "fine", "l", "lx", "a$", "l$b"]);
    expect(result.diagnostics.filter((d) => d.code === "MESH_HELPER_NAME").map((d) => d.message.split(" ")[3])).toEqual(["$a", "l$b"]);
  });
  test("a name that merely contains them builds", async () => {
    const result = await withHelpers(["isBig", "a$b", "lx"]);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
  test("an alias is the name that counts: the local binding is what generated code prints", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-helper-names-"));
    roots.push(root);
    await writeFile(resolve(root, "helpers.ts"), "export const big = (n: number) => n > 1;");
    const source = `import { big as $big } from "./helpers"\nentity :Task\n  attributes\n    uuid :id primary-key\n`;
    const result = buildModel({ root, files: [{ file: "task.mesh.mx", source }] });
    expect(codes(result as never)).toEqual(["MESH_HELPER_NAME"]);
  });
});

describe("what loading a computed field needs", () => {
  const user = `import { Doc } from "./doc.mesh.mx"
entity :User
  attributes
    uuid :id primary-key
    string :name
  relationships
    has-many :docs entity=Doc via=:owner
  computed
    count :docCount of="docs"
`;
  const doc = (computed: string) => `import { User } from "./user.mesh.mx"
import { Note } from "./note.mesh.mx"
entity :Doc
  attributes
    uuid :id primary-key
    string :title
    string :body nullable
    enum :state values=[:open, :done]
  relationships
    belongs-to :owner entity=User
    belongs-to :editor entity=User nullable
    has-many :notes entity=Note
  computed
${computed.split("\n").map((line) => `    ${line}`).join("\n")}
`;
  const note = `import { Doc } from "./doc.mesh.mx"
entity :Note
  attributes
    uuid :id primary-key
    boolean :pinned
  relationships
    belongs-to :doc entity=Doc
    belongs-to :author entity=User
`.replace("import { Doc }", 'import { User } from "./user.mesh.mx"\nimport { Doc }');
  const needs = (computed: string) => {
    const result = build({ "user.mesh.mx": user, "doc.mesh.mx": doc(computed), "note.mesh.mx": note });
    return { result, of: (name: string) => entityOf(result, "Doc").computed.find((c) => c.name === name)?.needs };
  };

  test("a list quantifier names the list; a read through its parameter names the path", () => {
    const { result, of } = needs(`boolean :anyPinned() { return &notes.some((n) => n.pinned) }
boolean :anyoneNamed() { return &notes.some((n) => n.author.name === "Ada") }
boolean :none() { return &notes.length === 0 }`);
    expect(result.diagnostics).toEqual([]);
    expect(of("anyPinned")).toEqual(["notes"]);
    expect(of("anyoneNamed")).toEqual(["notes", "notes.author"]);
    expect(of("none")).toEqual(["notes"]);
  });

  test("a read through a belongs-to, and a rollup or computed field of the related row", () => {
    const { result, of } = needs(`string :ownerName() { return &owner.name }
boolean :busyOwner() { return &owner.docCount > 3 }
boolean :editedBy() { return &editor?.name === &owner.name }`);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(of("ownerName")).toEqual(["owner"]);
    expect(of("busyOwner")).toEqual(["owner", "owner.docCount"]);
    expect(of("editedBy")).toEqual(["editor", "owner"]);
  });

  test("the row find returns, and the rows filter keeps, are rows of the list", () => {
    const { result, of } = needs(`string :pinnedAuthor() { return &notes.find((n) => n.pinned)?.author.name ?? "" }
integer :pinnedCount() { return &notes.filter((n) => n.pinned).length }`);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(of("pinnedAuthor")).toEqual(["notes", "notes.author"]);
    expect(of("pinnedCount")).toEqual(["notes"]);
  });

  test("another computed field of the same entity is a need, whatever the order they are written in", () => {
    const { result, of } = needs(`boolean :ready() { return &anyPinned && &state === :open }
boolean :anyPinned() { return &notes.some((n) => n.pinned) }`);
    expect(result.diagnostics).toEqual([]);
    expect(of("ready")).toEqual(["anyPinned"]);
    expect(of("anyPinned")).toEqual(["notes"]);
  });

  test("an attribute is not a need, and neither is a field the body does not read", () => {
    const { of } = needs(`boolean :untitled() { return &title === "" }
boolean :untouched() { return &state === :done }`);
    expect(of("untitled")).toEqual([]);
    expect(of("untouched")).toEqual([]);
  });

  test("a body that runs as plain code needs the &names it reads on the record", () => {
    const { result, of } = needs(`string :summary() { return \`\${&title}: \${&notes.length} notes by \${&owner.name}\` }`);
    expect(entityOf(result, "Doc").computed[0]!.body!.plain).toBeDefined();
    expect(of("summary")).toEqual(["notes", "owner"]);
  });

  test("a plain body's chain is followed to its end: one, two and three relationships deep", () => {
    const { of } = needs(`string :one() { return JSON.stringify(&owner?.docCount) }
string :two() { return JSON.stringify(&notes?.length) + JSON.stringify(&owner?.docs) }
string :three() { return JSON.stringify(&notes?.at(0)?.doc?.owner?.docCount) }`);
    expect(of("one")).toEqual(["owner", "owner.docCount"]);
    expect(of("two")).toEqual(["notes", "owner", "owner.docs"]);
    // `.at(0)` is a call, so the chain the text shows ends at notes; the loader's guard covers the rest at run time.
    expect(of("three")).toEqual(["notes"]);
  });

  test("a body that reads a has-many nothing points back at cannot be loaded, and the build says so", () => {
    const orphan = "entity :Orphan\n  attributes\n    uuid :id primary-key\n";
    const owner = `import { Orphan } from "./orphan.mesh.mx"\nentity :Doc\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :orphans entity=Orphan\n  computed\n    boolean :hasOrphans() { return &orphans.length > 0 }\n`;
    const result = build({ "doc.mesh.mx": owner, "orphan.mesh.mx": orphan });
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "MESH_NO_INVERSE",
      message: "&hasOrphans reads has-many :orphans, which cannot be loaded: :Orphan has no belongs-to back to :Doc",
    })]);
  });

  test("a computed field needs nothing of a related entity that the body only names in a local", () => {
    const { of } = needs("boolean :shadow() { return &notes.some((owner) => owner.pinned) }");
    expect(of("shadow")).toEqual(["notes"]);
  });

  test("computed fields that read each other are a build error that names the cycle", () => {
    const { result } = needs(`boolean :a() { return &b }
boolean :b() { return &c }
boolean :c() { return &a }`);
    expect(result.diagnostics.filter((d) => d.code === "MESH_COMPUTED_CYCLE")).toEqual([
      expect.objectContaining({ message: "Computed fields read each other: &a reads &b reads &c reads &a" }),
    ]);
  });

  test("a computed field that reads itself is a cycle of one", () => {
    const { result } = needs("boolean :loop() { return &loop }");
    expect(result.diagnostics.filter((d) => d.code === "MESH_COMPUTED_CYCLE")).toEqual([
      expect.objectContaining({ message: "Computed fields read each other: &loop reads &loop" }),
    ]);
  });

  test("a rollup has no needs: it calls the data layer", () => {
    const { result } = needs('count :noteCount of="notes"');
    expect(entityOf(result, "Doc").computed[0]!.needs).toBeUndefined();
  });
});

describe("a computed enum names its values", () => {
  const source = (line: string) => `entity :Doc\n  attributes\n    uuid :id primary-key\n    enum :state values=[:open, :done]\n  computed\n    ${line}\n`;
  test("with values, the field has them", () => {
    const result = build({ "doc.mesh.mx": source("enum :phase values=[:early, :late] value=() => &state === :open ? :early : :late") });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Doc").computed[0]).toMatchObject({ type: "enum", values: [{ value: "early" }, { value: "late" }] });
  });
  test("without values it still builds (its TypeScript type is string)", () => {
    const result = build({ "doc.mesh.mx": source("enum :phase() { return :early }") });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(entityOf(result, "Doc").computed[0]!.values).toBeUndefined();
  });
  test("a non-enum computed field takes no values, and no other option", () => {
    expect(codes(build({ "doc.mesh.mx": source("string :label values=[:a] value=() => &state") }))).toEqual(["MESH_SYNTAX"]);
    expect(codes(build({ "doc.mesh.mx": source("string :label nullable value=() => &state") }))).toContain("MESH_COMPUTED_OPTIONS");
    expect(codes(build({ "doc.mesh.mx": source("enum :phase nullable value=() => :a") }))).toContain("MESH_COMPUTED_OPTIONS");
  });
  test("repeated values are the same error an enum attribute gives", () => {
    expect(codes(build({ "doc.mesh.mx": source("enum :phase values=[:a, :a] value=() => :a") }))).toContain("MESH_ATOM_LIST");
  });
});
