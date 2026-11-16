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
  actions auto=[:read]
`;
const collaborator = (inverse = "") => `import { Membership } from "./membership.mesh.mx"
entity :Collaborator
  attributes
    uuid :id primary-key
  relationships
    has-many :memberships entity=Membership${inverse}
  actions auto=[:read]
`;
const membership = (extra = "") => `import { Collaborator } from "./collaborator.mesh.mx"
entity :Membership
  attributes
    uuid :id primary-key
  relationships
    belongs-to :collaborator entity=Collaborator
    belongs-to :grantedBy entity=Collaborator
    belongs-to :revokedBy entity=Collaborator nullable${extra}
  actions auto=[:read]
`;

describe("self-reference (acceptance 1)", () => {
  test("an entity relates to its own type with no import, and has-many follows the only belongs-to back", () => {
    const result = build({ "task.mesh.mx": task });
    expect(result.diagnostics).toEqual([]);
    const [parent, children] = entityOf(result, "Task").relationships;
    expect(parent).toMatchObject({ kind: "belongs-to", entity: { identifier: "Task", from: "./task.mesh.mx" }, keyColumn: "parentId", keyType: "uuid" });
    expect(children).toMatchObject({ kind: "has-many", entity: { identifier: "Task", from: "./task.mesh.mx" }, inverse: "parent" });
    expect(entityOf(result, "Task").imports).toEqual([]);
  });

  test("a self-import is still accepted and means the same", () => {
    const result = build({ "task.mesh.mx": `import { Task } from "./task.mesh.mx"\n${task}` });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Task").relationships[1]).toMatchObject({ inverse: "parent" });
  });

  test("a self-cycle (a record that is its own parent) is data, not a build error", () => {
    const result = build({ "task.mesh.mx": task });
    expect(result.document).not.toBeNull();
  });

  test("a misspelt own name is an unknown entity at the entity option, with a suggestion", () => {
    const result = build({ "task.mesh.mx": task.replace("belongs-to :parent entity=Task", "belongs-to :parent entity=Tsak") });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_UNKNOWN_ENTITY", message: "Tsak is not an imported entity. Did you mean Task?", position: expect.objectContaining({ line: 5 }) })]);
  });

  test("two belongs-to to the same type make a has-many ask for inverse", () => {
    const source = task.replace("    has-many", "    belongs-to :corrects entity=Task nullable\n    has-many");
    const result = build({ "task.mesh.mx": source });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_INVERSE_REQUIRED", message: expect.stringContaining(":parent, :corrects") })]);
    const fixed = build({ "task.mesh.mx": source.replace("has-many :children entity=Task", "has-many :children entity=Task inverse=:parent") });
    expect(fixed.diagnostics).toEqual([]);
    expect(entityOf(fixed, "Task").relationships[2]).toMatchObject({ inverse: "parent" });
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

// Membership with three belongs-to back to Collaborator, none named `collaborator`: the ladder cannot guess.
const unnamed = () => membership().replace("belongs-to :collaborator", "belongs-to :holder");

describe("inverse (acceptance 2, ADR-0070)", () => {
  test("several candidates, one named after the entity: it is followed with no option", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(), "membership.mesh.mx": membership() });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Collaborator").relationships[0]).toMatchObject({ inverse: "collaborator" });
  });

  test("several candidates, none named after the entity: the build lists all of them", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(), "membership.mesh.mx": unnamed() });
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "MESH_INVERSE_REQUIRED",
      message: "has-many :memberships of app.Collaborator could follow any of 3 belongs-to of app.Membership back to app.Collaborator (:holder, :grantedBy, :revokedBy)",
      fix: "Choose one: `inverse=:holder`",
    })]);
  });

  test("an authored inverse wins over the ladder", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(" inverse=:grantedBy"), "membership.mesh.mx": membership() });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Collaborator").relationships[0]).toMatchObject({ inverse: "grantedBy" });
    const other = build({ "collaborator.mesh.mx": collaborator(" inverse=:revokedBy"), "membership.mesh.mx": unnamed() });
    expect(entityOf(other, "Collaborator").relationships[0]).toMatchObject({ inverse: "revokedBy" });
  });

  test("an authored inverse equal to the ladder's pick is legal and silent", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(" inverse=:collaborator"), "membership.mesh.mx": membership() });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Collaborator").relationships[0]).toMatchObject({ inverse: "collaborator" });
  });

  test("the entity's name is matched in lower camel case", () => {
    const worker = `import { Shift } from "./shift.mesh.mx"\nentity :WorkItem\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :shifts entity=Shift\n  actions auto=[:read]\n`;
    const shift = `import { WorkItem } from "./work-item.mesh.mx"\nentity :Shift\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :workItem entity=WorkItem\n    belongs-to :swappedFor entity=WorkItem\n  actions auto=[:read]\n`;
    const result = build({ "work-item.mesh.mx": worker, "shift.mesh.mx": shift });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "WorkItem").relationships[0]).toMatchObject({ inverse: "workItem" });
  });

  test("with exactly one belongs-to back, inverse may be left out", () => {
    const one = membership().replace(/    belongs-to :grantedBy.*\n/, "").replace(/    belongs-to :revokedBy.*/, "").replace("belongs-to :collaborator", "belongs-to :holder");
    const result = build({ "collaborator.mesh.mx": collaborator(), "membership.mesh.mx": one });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Collaborator").relationships[0]).toMatchObject({ inverse: "holder" });
  });

  test("via is not a Mesh word: it is an unknown option", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(` ${"vi"}a=:collaborator`), "membership.mesh.mx": membership() });
    expect(result.document).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toContain("via");
  });

  test("an inverse that names no belongs-to of the other entity is an error at the option, with a suggestion", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(" inverse=:collaborater"), "membership.mesh.mx": membership() });
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "MESH_INVERSE_UNKNOWN",
      message: "inverse=:collaborater names no belongs-to of app.Membership. Did you mean inverse=:collaborator?",
      position: expect.objectContaining({ file: "app/collaborator.mesh.mx", line: 6 }),
    })]);
    expect(result.document).toBeNull();
  });

  test("an inverse that names an attribute is not a belongs-to", () => {
    const source = membership().replace("uuid :id primary-key", "uuid :id primary-key\n    string :role");
    const result = build({ "collaborator.mesh.mx": collaborator(" inverse=:role"), "membership.mesh.mx": source });
    expect(codes(result)).toEqual(["MESH_INVERSE_UNKNOWN"]);
  });

  test("an inverse that names a belongs-to to a different entity says where it points", () => {
    const source = `import { Collaborator } from "./collaborator.mesh.mx"\nimport { Workspace } from "./workspace.mesh.mx"
entity :Membership
  attributes
    uuid :id primary-key
  relationships
    belongs-to :collaborator entity=Collaborator
    belongs-to :workspace entity=Workspace
  actions auto=[:read]
`;
    const workspace = "entity :Workspace\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n";
    const result = build({ "collaborator.mesh.mx": collaborator(" inverse=:workspace"), "membership.mesh.mx": source, "workspace.mesh.mx": workspace });
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "MESH_INVERSE_ENTITY",
      message: "inverse=:workspace is a belongs-to of app.Membership that points at app.Workspace, not at app.Collaborator. The belongs-to from app.Membership to app.Collaborator: :collaborator.",
    })]);
  });

  test("inverse names a belongs-to, not a member of this entity: &name is not accepted", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(" inverse=&collaborator"), "membership.mesh.mx": membership() });
    expect(result.document).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test("has-one takes no inverse", () => {
    const result = build({ "collaborator.mesh.mx": collaborator(" inverse=:collaborator").replace("has-many", "has-one"), "membership.mesh.mx": membership() });
    expect(result.document).toBeNull();
    expect(result.diagnostics[0]!.message).toContain("inverse");
  });

  test("a has-one follows the belongs-to named after the entity, like a has-many", () => {
    const result = build({ "collaborator.mesh.mx": collaborator().replace("has-many", "has-one"), "membership.mesh.mx": membership() });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Collaborator").relationships[0]).toMatchObject({ kind: "has-one", inverse: "collaborator" });
  });

  test("a has-one with several belongs-to back and none named after the entity cannot choose, and says so", () => {
    const result = build({ "collaborator.mesh.mx": collaborator().replace("has-many", "has-one"), "membership.mesh.mx": unnamed() });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_INVERSE_REQUIRED", message: expect.stringContaining("a has-one takes no inverse") })]);
  });

  describe("a has-many or has-one needs a belongs-to back", () => {
    const bare = "entity :Membership\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n";
    const expected = (kind: string) => [expect.objectContaining({
      code: "MESH_NO_INVERSE",
      message: `${kind} :memberships of app.Collaborator needs a belongs-to back, and app.Membership has none to app.Collaborator: add \`belongs-to :collaborator entity=Collaborator\` to app.Membership`,
      fix: "Add `belongs-to :collaborator entity=Collaborator` to app.Membership",
      position: expect.objectContaining({ file: "app/collaborator.mesh.mx", line: 6 }),
    })];

    test("a has-many with no belongs-to back in the other file is an error that names the line to add", () => {
      expect(build({ "collaborator.mesh.mx": collaborator(), "membership.mesh.mx": bare }).diagnostics).toEqual(expected("has-many"));
    });

    test("so is a has-one", () => {
      const result = build({ "collaborator.mesh.mx": collaborator().replace("has-many", "has-one"), "membership.mesh.mx": bare });
      expect(result.diagnostics).toEqual(expected("has-one"));
    });

    test("a belongs-to to some other entity is not a belongs-to back", () => {
      const other = `import { Other } from "./other.mesh.mx"\n${bare}  relationships\n    belongs-to :other entity=Other\n`;
      const result = build({ "collaborator.mesh.mx": collaborator(), "membership.mesh.mx": other, "other.mesh.mx": "entity :Other\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n" });
      expect(codes(result)).toEqual(["MESH_NO_INVERSE"]);
    });

    test("with a module path, the entity is named by it and the file is still the one to change", () => {
      const result = buildModel({ root: "/project", files: [
        { file: "crm/people/collaborator.mesh.mx", source: collaborator() },
        { file: "crm/people/membership.mesh.mx", source: bare },
      ] });
      expect(result.diagnostics).toEqual([expect.objectContaining({
        code: "MESH_NO_INVERSE",
        message: expect.stringContaining("add `belongs-to :collaborator entity=Collaborator` to crm.people.Membership"),
      })]);
    });

    test("the pair builds, and the has-many follows the belongs-to", () => {
      const result = build({ "collaborator.mesh.mx": collaborator(), "membership.mesh.mx": "import { Collaborator } from \"./collaborator.mesh.mx\"\n" + bare + "  relationships\n    belongs-to :collaborator entity=Collaborator\n" });
      expect(result.diagnostics).toEqual([]);
      expect(entityOf(result, "Collaborator").relationships[0]!.inverse).toBe("collaborator");
    });

    test("a belongs-to alone still builds: it declares the key and needs nothing back", () => {
      const result = build({ "collaborator.mesh.mx": "entity :Collaborator\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n", "membership.mesh.mx": membership().replace("belongs-to :grantedBy entity=Collaborator\n    belongs-to :revokedBy entity=Collaborator nullable", "") });
      expect(result.diagnostics).toEqual([]);
    });

    test("in one file, a self-referencing entity builds with its belongs-to, and the has-many alone is an error", () => {
      expect(build({ "task.mesh.mx": task }).diagnostics).toEqual([]);
      const alone = build({ "task.mesh.mx": task.replace("    belongs-to :parent entity=Task nullable\n", "") });
      expect(alone.diagnostics).toEqual([expect.objectContaining({ code: "MESH_NO_INVERSE", message: expect.stringContaining("add `belongs-to :task entity=Task` to app.Task") })]);
    });

    test("an inverse= that names no belongs-to stays MESH_INVERSE_UNKNOWN, and adds no second error", () => {
      const result = build({ "collaborator.mesh.mx": collaborator(" inverse=:nope"), "membership.mesh.mx": bare });
      expect(codes(result)).toEqual(["MESH_INVERSE_UNKNOWN"]);
    });
  });

  test("several has-many to the same entity, each with its own inverse", () => {
    const dependency = (extra: string) => `import { Task } from "./task.mesh.mx"
entity :Dependency
  attributes
    uuid :id primary-key
  relationships
    belongs-to :dependent entity=Task
    belongs-to :prerequisite entity=Task${extra}
  actions auto=[:read]
`;
    const owner = `import { Dependency } from "./dependency.mesh.mx"
entity :Task
  attributes
    uuid :id primary-key
  relationships
    has-many :dependencies entity=Dependency inverse=:dependent
    has-many :dependents entity=Dependency inverse=:prerequisite
  actions auto=[:read]
`;
    const result = build({ "task.mesh.mx": owner, "dependency.mesh.mx": dependency("") });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Task").relationships.map((r) => r.inverse)).toEqual(["dependent", "prerequisite"]);
  });
});

// A has-one is at most one row for the key it follows, so a has-many of the same entity cannot follow that key too.
describe("a has-one and a has-many over one key (MESH_HAS_ONE_SHARED_KEY)", () => {
  const user = (relationships: string, imports = 'import { Profile } from "./profile.mesh.mx"') => `${imports}
entity :User
  attributes
    uuid :id primary-key
  relationships
${relationships.split("\n").map((line) => `    ${line}`).join("\n")}
  actions auto=[:read]
`;
  const profile = (relationships = "belongs-to :user entity=User") => `import { User } from "./user.mesh.mx"
entity :Profile
  attributes
    uuid :id primary-key
  relationships
${relationships.split("\n").map((line) => `    ${line}`).join("\n")}
  actions auto=[:read]
`;
  const one = "has-one :profile entity=Profile";
  const many = "has-many :profiles entity=Profile";
  const twoKeys = "belongs-to :user entity=User\nbelongs-to :invitedBy entity=User nullable";
  const fix = "Keep the has-many and take the one row from its list, or give the has-many its own belongs-to with `inverse=`";
  const shared = "has-one :profile of app.User follows belongs-to :user of app.Profile, and has-many :profiles follows it too: a has-one is at most one row for that key, so the two cannot share it";
  const inverses = (result: ReturnType<typeof build>) => entityOf(result, "User").relationships.map((r) => [r.kind, r.name, r.inverse]);

  test("both follow the only belongs-to back: one error at the has-one, naming both and the key", () => {
    const result = build({ "user.mesh.mx": user(`${one}\n${many}`), "profile.mesh.mx": profile() });
    expect(result.diagnostics).toEqual([{
      severity: "error",
      code: "MESH_HAS_ONE_SHARED_KEY",
      message: shared,
      fix,
      position: expect.objectContaining({ file: "app/user.mesh.mx", line: 6, column: 4 }),
    }]);
    expect(result.document).toBeNull();
  });

  test("the error is the has-one's, whichever line comes first", () => {
    const result = build({ "user.mesh.mx": user(`${many}\n${one}`), "profile.mesh.mx": profile() });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_HAS_ONE_SHARED_KEY", message: shared, position: expect.objectContaining({ line: 7 }) })]);
  });

  test("a has-many that names the has-one's key with inverse= shares it too", () => {
    const result = build({ "user.mesh.mx": user(`${one}\n${many} inverse=:user`), "profile.mesh.mx": profile() });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_HAS_ONE_SHARED_KEY", message: shared, fix })]);
  });

  test("of several belongs-to back, both follow the one named after the entity", () => {
    const result = build({ "user.mesh.mx": user(`${one}\n${many}`), "profile.mesh.mx": profile(twoKeys) });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "MESH_HAS_ONE_SHARED_KEY", message: shared })]);
  });

  test("the fix: a has-many with its own belongs-to, named by inverse=, builds beside the has-one", () => {
    const result = build({ "user.mesh.mx": user(`${one}\n${many} inverse=:invitedBy`), "profile.mesh.mx": profile(twoKeys) });
    expect(result.diagnostics).toEqual([]);
    expect(inverses(result)).toEqual([["has-one", "profile", "user"], ["has-many", "profiles", "invitedBy"]]);
  });

  test("two has-one over one key are accepted", () => {
    const result = build({ "user.mesh.mx": user(`${one}\nhas-one :card entity=Profile`), "profile.mesh.mx": profile() });
    expect(result.diagnostics).toEqual([]);
    expect(inverses(result)).toEqual([["has-one", "profile", "user"], ["has-one", "card", "user"]]);
  });

  test("two has-many over one key are accepted", () => {
    const result = build({ "user.mesh.mx": user(`${many}\nhas-many :cards entity=Profile`), "profile.mesh.mx": profile() });
    expect(result.diagnostics).toEqual([]);
    expect(inverses(result)).toEqual([["has-many", "profiles", "user"], ["has-many", "cards", "user"]]);
  });

  test("a has-one and a has-many to different entities share nothing, though both keys are named alike", () => {
    const badge = `import { User } from "../user.mesh.mx"\nentity :Profile\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :user entity=User\n  actions auto=[:read]\n`;
    const result = build({
      "user.mesh.mx": user(`${one}\nhas-many :profiles entity=Public`, 'import { Profile } from "./profile.mesh.mx"\nimport { Profile as Public } from "./public/profile.mesh.mx"'),
      "profile.mesh.mx": profile(),
      "public/profile.mesh.mx": badge,
    });
    expect(result.diagnostics).toEqual([]);
    expect(inverses(result)).toEqual([["has-one", "profile", "user"], ["has-many", "profiles", "user"]]);
  });

  test("every has-many on the key is named once, and each has-one on it gets its own error", () => {
    const result = build({ "user.mesh.mx": user(`${one}\n${many}\nhas-many :drafts entity=Profile\nhas-many :cards entity=Profile inverse=:user\nhas-one :card entity=Profile`), "profile.mesh.mx": profile() });
    const tail = "and has-many :profiles, has-many :drafts and has-many :cards follow it too: a has-one is at most one row for that key, so they cannot share it";
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "MESH_HAS_ONE_SHARED_KEY", message: `has-one :profile of app.User follows belongs-to :user of app.Profile, ${tail}`, fix, position: expect.objectContaining({ line: 6 }) }),
      expect.objectContaining({ code: "MESH_HAS_ONE_SHARED_KEY", message: `has-one :card of app.User follows belongs-to :user of app.Profile, ${tail}`, fix, position: expect.objectContaining({ line: 10 }) }),
    ]);
  });

  test("an entity that relates to its own type shares a key the same way", () => {
    const source = task.replace("    has-many", "    has-one :firstChild entity=Task\n    has-many");
    const result = build({ "task.mesh.mx": source });
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "MESH_HAS_ONE_SHARED_KEY",
      message: "has-one :firstChild of app.Task follows belongs-to :parent of app.Task, and has-many :children follows it too: a has-one is at most one row for that key, so the two cannot share it",
      position: expect.objectContaining({ line: 6 }),
    })]);
  });

  test("a relationship whose key was not found keeps its own error and shares nothing", () => {
    // A bad inverse= on the has-many: its error alone.
    expect(codes(build({ "user.mesh.mx": user(`${one}\n${many} inverse=:nope`), "profile.mesh.mx": profile() }))).toEqual(["MESH_INVERSE_UNKNOWN"]);
    // Several belongs-to back and none named after the entity: neither relationship knows its key.
    const unnamedKeys = "belongs-to :holder entity=User\nbelongs-to :invitedBy entity=User nullable";
    expect(codes(build({ "user.mesh.mx": user(`${one}\n${many}`), "profile.mesh.mx": profile(unnamedKeys) }))).toEqual(["MESH_INVERSE_REQUIRED", "MESH_INVERSE_REQUIRED"]);
    // No belongs-to back at all.
    const bare = "entity :Profile\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n";
    expect(codes(build({ "user.mesh.mx": user(`${one}\n${many}`), "profile.mesh.mx": bare }))).toEqual(["MESH_NO_INVERSE", "MESH_NO_INVERSE"]);
  });

  test("a rollup or a computed field that reads either relationship adds no second error", () => {
    const source = `${user(`${one}\n${many}`)}  computed\n    count :profileCount of=&profiles\n    boolean :hasProfile() { return &profile !== null }\n`;
    expect(codes(build({ "user.mesh.mx": source, "profile.mesh.mx": profile() }))).toEqual(["MESH_HAS_ONE_SHARED_KEY"]);
  });
});

describe("the type of a belongs-to key follows the target's key", () => {
  const target = (type: string) => `entity :Customer\n  attributes\n    ${type} :id primary-key\n  actions auto=[:read]\n`;
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
  // The refusal of a `$` at the start of an import binding holds for an entity's alias too: `$b$List$value` is the local generated code imports b.List's value under,
  // so `import { List as $b$List$value }` would make the function bind the name to itself.
  test.each(["$b$List$value", "$List", "l$List"])("an entity import aliased %s is a build error at the alias", (alias) => {
    const list = "entity :List\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n";
    const board = `import { List as ${alias} } from "./b/list.mesh.mx"\nentity :Board\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :list entity=${alias}\n`;
    const result = buildModel({ root: "/project", files: [{ file: "b/list.mesh.mx", source: list }, { file: "board.mesh.mx", source: board }] });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([expect.objectContaining({
      code: "MESH_HELPER_NAME",
      message: `The entity import name ${alias} cannot start with $ or l$: generated code uses those prefixes for its own names`,
      position: expect.objectContaining({ file: "board.mesh.mx", line: 1, column: 17 }),
    })]);
    expect(result.document).toBeNull();
  });
});

describe("what loading a computed field needs", () => {
  const user = `import { Doc } from "./doc.mesh.mx"
entity :User
  attributes
    uuid :id primary-key
    string :name
  relationships
    has-many :docs entity=Doc inverse=:owner
  computed
    count :docCount of=&docs
  actions auto=[:read]
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
  actions auto=[:read]
`;
  const note = `import { Doc } from "./doc.mesh.mx"
entity :Note
  attributes
    uuid :id primary-key
    boolean :pinned
  relationships
    belongs-to :doc entity=Doc
    belongs-to :author entity=User
  actions auto=[:read]
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

  test("a body that reads a has-many nothing points back at is the one MESH_NO_INVERSE, at the has-many line, not one per reader", () => {
    const orphan = "entity :Orphan\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n";
    const owner = `import { Orphan } from "./orphan.mesh.mx"\nentity :Doc\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :orphans entity=Orphan\n  computed\n    boolean :hasOrphans() { return &orphans.length > 0 }\n`;
    const result = build({ "doc.mesh.mx": owner, "orphan.mesh.mx": orphan });
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "MESH_NO_INVERSE",
      message: "has-many :orphans of app.Doc needs a belongs-to back, and app.Orphan has none to app.Doc: add `belongs-to :doc entity=Doc` to app.Orphan",
      position: expect.objectContaining({ line: 6 }),
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
    const { result } = needs('count :noteCount of=&notes');
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
    expect(codes(build({ "doc.mesh.mx": source("string :label values=[:a] value=() => &state") }))).toEqual(["MESH_UNKNOWN_OPTION"]);
    expect(codes(build({ "doc.mesh.mx": source("string :label nullable value=() => &state") }))).toContain("MESH_COMPUTED_OPTIONS");
    expect(codes(build({ "doc.mesh.mx": source("enum :phase nullable value=() => :a") }))).toContain("MESH_COMPUTED_OPTIONS");
  });
  test("repeated values are the same error an enum attribute gives", () => {
    expect(codes(build({ "doc.mesh.mx": source("enum :phase values=[:a, :a] value=() => :a") }))).toContain("MESH_ATOM_LIST");
  });
});

describe("a used has-many with several candidates and no inverse lists them", () => {
  const withUse = (use: string) => collaborator().replace("    has-many :memberships entity=Membership\n", `    has-many :memberships entity=Membership\n  computed\n${use}\n`);

  test("a body that reads it names the candidates, not a missing belongs-to", () => {
    const result = build({ "collaborator.mesh.mx": withUse("    boolean :member() { return &memberships.length > 0 }"), "membership.mesh.mx": unnamed() });
    const read = result.diagnostics.filter((d) => d.message.startsWith("&member "));
    expect(read).toEqual([expect.objectContaining({
      code: "MESH_INVERSE_REQUIRED",
      message: "&member reads has-many :memberships, which cannot be loaded: app.Membership has 3 belongs-to back to app.Collaborator (:holder, :grantedBy, :revokedBy) and has-many :memberships does not say which it follows",
      fix: "Choose one: `inverse=:holder`",
    })]);
    expect(result.diagnostics.some((d) => d.code === "MESH_NO_INVERSE")).toBe(false);
  });

  test("a rollup that reads it names them too", () => {
    const result = build({ "collaborator.mesh.mx": withUse('    count :membershipCount of=&memberships'), "membership.mesh.mx": unnamed() });
    expect(result.diagnostics.filter((d) => d.message.startsWith("count :membershipCount"))).toEqual([expect.objectContaining({
      code: "MESH_INVERSE_REQUIRED",
      message: expect.stringContaining("(:holder, :grantedBy, :revokedBy)"),
    })]);
    expect(result.diagnostics.some((d) => d.code === "MESH_NO_INVERSE")).toBe(false);
  });

  test("choosing one with inverse clears both", () => {
    const result = build({ "collaborator.mesh.mx": withUse("    boolean :member() { return &memberships.length > 0 }").replace("entity=Membership", "entity=Membership inverse=:holder"), "membership.mesh.mx": unnamed() });
    expect(result.diagnostics).toEqual([]);
  });
});

describe("an entity reached through a relationship needs a read to load it with (ACT-20)", () => {
  // A load through a relationship runs the read `on:load=` names, or else the auto read. A target with neither is an
  // error at each relationship that reaches it.
  const order = (actions = "  actions auto=[:read]\n") => `import { Line } from "./line.mesh.mx"
entity :Order
  attributes
    uuid :id primary-key
  relationships
    has-many :lines entity=Line
${actions}`;
  const line = (actions = "  actions auto=[:read]\n") => `import { Order } from "./order.mesh.mx"
entity :Line
  attributes
    uuid :id primary-key
  relationships
    belongs-to :order entity=Order
${actions}`;
  const missing = (relation: string, from: string, target: string) => ({
    severity: "error" as const,
    code: "MESH_ON_LOAD",
    message: `${relation} of app.${from} reaches app.${target}, which has neither \`on:load=\` nor an auto read, so Mesh has no read to load it with`,
    fix: `List \`:read\` in \`auto=\` on the \`actions\` line of app.${target} (\`actions auto=[:read]\`), or name one of its reads there with \`on:load=&name\``,
  });

  test("a target with no actions at all is refused at the relationship that reaches it, and only there", () => {
    const result = build({ "order.mesh.mx": order(), "line.mesh.mx": line("") });
    expect(result.diagnostics).toEqual([{ ...missing("has-many :lines", "Order", "Line"), position: expect.objectContaining({ file: "app/order.mesh.mx", line: 6, column: 4 }) }]);
    expect(result.document).toBeNull();
    // The other way round, the belongs-to is the relationship that reaches the entity with no read.
    expect(build({ "order.mesh.mx": order(""), "line.mesh.mx": line() }).diagnostics)
      .toEqual([{ ...missing("belongs-to :order", "Line", "Order"), position: expect.objectContaining({ file: "app/line.mesh.mx", line: 6, column: 4 }) }]);
  });

  test("a written read, or another auto action, is not the read a load runs", () => {
    for (const actions of ["  actions\n    read :visible\n", "  actions auto=[:destroy]\n", "  actions\n    create :add\n", "  actions auto=[:destroy]\n    read :read\n"])
      expect(build({ "order.mesh.mx": order(), "line.mesh.mx": line(actions) }).diagnostics, actions).toEqual([expect.objectContaining(missing("has-many :lines", "Order", "Line"))]);
  });

  test("legal neighbours: an auto read, `on:load=` naming a written read, and both", () => {
    for (const actions of [
      "  actions auto=[:read]\n",
      "  actions auto=[:read, :destroy]\n    create :add\n",
      "  actions on:load=&visible\n    read :visible\n",
      "  actions auto=[:destroy] on:load=&visible\n    read :visible\n",
      "  actions auto=[:read] on:load=&read\n",
      "  actions auto=[:read] on:load=&visible\n    read :visible\n",
    ]) {
      const result = build({ "order.mesh.mx": order(), "line.mesh.mx": line(actions) });
      expect(result.diagnostics, actions).toEqual([]);
      expect(result.document, actions).not.toBeNull();
    }
  });

  test("an entity no relationship reaches needs no read", () => {
    // A belongs-to alone: Line reaches Order, which has its read, and nothing reaches Line.
    const target = "entity :Order\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n";
    for (const actions of ["", "  actions\n    create :add\n", "  actions auto=[:destroy]\n", "  actions\n    read :visible\n"])
      expect(build({ "order.mesh.mx": target, "line.mesh.mx": line(actions) }).diagnostics, actions).toEqual([]);
    expect(build({ "solo.mesh.mx": "entity :Solo\n  attributes\n    uuid :id primary-key\n" }).diagnostics).toEqual([]);
  });

  test("each relationship that reaches the entity is reported, in every file, a has-one included", () => {
    const shelf = `import { Line } from "./line.mesh.mx"
entity :Shelf
  attributes
    uuid :id primary-key
  relationships
    belongs-to :first entity=Line
    belongs-to :last entity=Line nullable
  actions auto=[:read]
`;
    const result = build({ "order.mesh.mx": order().replace("has-many :lines", "has-one :line"), "line.mesh.mx": line(""), "shelf.mesh.mx": shelf });
    expect(result.diagnostics.map((d) => [d.code, d.position.file, d.position.line, d.message.split(" reaches ")[0]])).toEqual([
      ["MESH_ON_LOAD", "app/order.mesh.mx", 6, "has-one :line of app.Order"],
      ["MESH_ON_LOAD", "app/shelf.mesh.mx", 6, "belongs-to :first of app.Shelf"],
      ["MESH_ON_LOAD", "app/shelf.mesh.mx", 7, "belongs-to :last of app.Shelf"],
    ]);
  });

  test("an entity that relates to itself is its own target", () => {
    const result = build({ "task.mesh.mx": task.replace("  actions auto=[:read]\n", "") });
    expect(result.diagnostics.map((d) => [d.code, d.position.line, d.message])).toEqual([
      ["MESH_ON_LOAD", 5, missing("belongs-to :parent", "Task", "Task").message],
      ["MESH_ON_LOAD", 6, missing("has-many :children", "Task", "Task").message],
    ]);
    expect(build({ "task.mesh.mx": task }).diagnostics).toEqual([]);
  });

  test("`on:load=` that names something other than a read stays its own error, with no second one at the relationship", () => {
    const result = build({ "order.mesh.mx": order(), "line.mesh.mx": line("  actions on:load=&add\n    create :add\n") });
    expect(result.diagnostics.map((d) => [d.code, d.position.file, d.message])).toEqual([["MESH_ON_LOAD", "app/line.mesh.mx", "on:load must name a read action"]]);
  });

  test("a target whose policies leave out the read keeps its warning beside the error", () => {
    const guarded = line("  actions\n    create :add\n  policies\n    policy :adding types=[:create]\n      authorize-if=() => true\n");
    expect(build({ "order.mesh.mx": order(), "line.mesh.mx": guarded }).diagnostics.map((d) => `${d.severity}:${d.code}`).sort()).toEqual(["error:MESH_ON_LOAD", "warning:MESH_LOAD_NO_POLICY"]);
  });
});
