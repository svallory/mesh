// M8a at build time: what a policy may read, what `actions=` may name, which checks run where (ACT-28, POL-08), the M10
// refusal of a read or load policy that reads the record, a policy with no check (POL-16), `&x` on a create (S2 of the
// review), `Mesh.isSystem(context)`, and what `mesh explain` says. The run-time side is
// `packages/data-sqlite/test/policies.test.ts`.
import { describe, expect, test } from "bun:test";
import type { Diagnostic, Entity } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { policiesCovering, policyExpressions, readsRecord, recordReason } from "../src/model/policies.ts";
import { generateFiles } from "../src/typescript/emit.ts";
import { explainAction } from "../src/typescript/explain.ts";
import { configOf } from "./generated.ts";

/** An entity with one action of each kind and the given policies section. */
const post = (policies: string) => `entity :Post
  attributes
    uuid :id primary-key
    string :authorId
    string :title nullable
  actions auto=[:read]
    create :draft
      input
        &authorId
        &title
    update :publish
    destroy :remove
${policies}`;

/** The import an entity file needs to call Mesh's own functions (PRJ-22). */
const MESH = 'import { Mesh } from "meshfw"\n';

function build(source: string) {
  return buildModel({ root: "/project", files: [{ file: "blog/post.mesh.mx", source }] });
}
const codes = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => `${d.severity}:${d.code}`);
function entityOf(source: string): Entity {
  const built = build(source);
  expect(built.diagnostics).toEqual([]);
  return built.document!.entities[0]!;
}

describe("what a policy may name and read", () => {
  test("`actions=` naming an action the entity does not have fails the build, and suggests the nearest", () => {
    const built = build(post("  policies\n    policy :owner actions=[&publsh]\n      authorize-if=() => true\n"));
    expect(codes(built.diagnostics)).toEqual(["error:MESH_UNKNOWN_ACTION"]);
    expect(built.diagnostics[0]!.message).toBe("&publsh is not an action of blog.Post: `actions=` names the entity's own actions (&draft, &publish, &remove, &read). Did you mean &publish?");
    expect(built.document).toBeNull();
    // An auto action is named too.
    expect(build(post("  policies\n    policy :owner actions=[&read]\n      authorize-if=() => true\n")).diagnostics).toEqual([]);
  });

  test("a policy that reads `before` fails the build, translated or plain", () => {
    for (const check of ["({ before }) => before.title === null", "({ before }) => { return String(before) === \"x\" }"]) {
      const built = build(post(`  policies\n    policy :p types=[:update]\n      authorize-if=${check}\n`));
      expect(codes(built.diagnostics)).toContain("error:MESH_POLICY_BEFORE");
      expect(built.diagnostics.filter((d) => d.code === "MESH_POLICY_BEFORE")).toHaveLength(1);
    }
  });

  test("a policy with no check fails the build (POL-16): it would pass every call it covers", () => {
    for (const line of ["policy :open", "policy :open types=[:update]", "policy :open when=({ actor }) => actor.id !== null"]) {
      const built = build(post(`  policies\n    ${line}\n    policy :rest\n      authorize-if=() => true\n`));
      expect(codes(built.diagnostics)).toEqual(["error:MESH_POLICY_NO_CHECKS"]);
      expect(built.diagnostics[0]!.message).toBe("policy :open of blog.Post has no `authorize-if` and no `forbid-if`, so it would pass every call it covers");
      expect(built.diagnostics[0]!.fix).toContain("`authorize-if=() => true`");
      expect(built.diagnostics[0]!.position.line).toBe(14);
    }
    // One check, of either kind, is enough; written out, an open policy builds.
    expect(build(post("  policies\n    policy :open\n      authorize-if=() => true\n")).diagnostics).toEqual([]);
    expect(build(post("  policies\n    policy :open forbid-if=() => false\n")).diagnostics).toEqual([]);
  });

  test("`actions=[]` fails the build, as `types=[]` does: an empty list covers no action", () => {
    const built = build(post("  policies\n    policy :none actions=[]\n      authorize-if=() => true\n"));
    expect(codes(built.diagnostics)).toEqual(["error:MESH_MEMBER_REFERENCE"]);
    expect(built.diagnostics[0]!.message).toBe("`policy`: `actions` must name at least one action: an empty list covers none");
    expect(codes(build(post("  policies\n    policy :none types=[]\n      authorize-if=() => true\n")).diagnostics)).toEqual(["error:MESH_ATOM_LIST"]);
    // The same for an `always` block.
    const always = build(post("  policies\n    policy :all\n      authorize-if=() => true\n").replace("  actions auto=[:read]\n", "  actions auto=[:read]\n    always actions=[]\n      validate\n        check :fresh that=() => true code=\"stale\" message=\"stale\"\n"));
    expect(codes(always.diagnostics)).toContain("error:MESH_MEMBER_REFERENCE");
  });

  test("on a create, `&x` of a member the create takes is the new instance's value, not the caller's: a warning, as in validate", () => {
    const warned = (check: string, scope = "types=[:create]") => {
      const built = build(post(`  policies\n    policy :p ${scope}\n      authorize-if=${check}\n    policy :rest types=[:read, :update, :destroy]\n      authorize-if=() => true\n`));
      expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      return built.diagnostics.filter((d) => d.code === "MESH_POLICY_NOT_APPLIED");
    };
    const [warning] = warned("({ actor }) => &authorId === actor.id");
    expect(warning!.message).toBe("on a create, `&authorId` here is the new instance's value before the input is applied (its default, or null), not the caller's: policy :p sees `self` as `validate` does, before the input");
    expect(warning!.fix).toContain("`input.authorId`");
    expect(warning!.position).toMatchObject({ line: 15, column: 34 });
    // Plain code, a `when`, and every member the create takes.
    expect(warned("({ actor }) => { return &authorId === actor.id }")).toHaveLength(1);
    expect(warned("() => &title !== null && &authorId !== null")).toHaveLength(2);
    // The caller's value, the value the action will store, and a policy that covers no create: no warning.
    expect(warned("({ actor, input }) => input.authorId === actor.id")).toEqual([]);
    expect(warned("({ actor, input }) => (input.authorId ?? &authorId) === actor.id")).toEqual([]);
    expect(warned("({ actor }) => &authorId === actor.id", "types=[:update]")).toEqual([]);
    // `id` is not an input of the create: a warning would be noise.
    expect(warned("() => &id !== null")).toEqual([]);
  });

  test("a policy that calls an entity's action fails the build: a policy decides, it does not act", () => {
    const source = post("  policies\n    policy :p types=[:update]\n      forbid-if=async ({ context }) => (await Post.read({}, context)).length > 1\n    policy :r types=[:create, :read, :destroy]\n      authorize-if=() => true\n");
    const built = build(source);
    expect(codes(built.diagnostics)).toEqual(["error:MESH_POLICY_ACTS"]);
    expect(built.diagnostics[0]).toMatchObject({
      message: "policy :p forbid-if calls an entity's action: a policy decides whether the call may run, and must not run actions itself",
      fix: "read what the decision needs through `Mesh.privileged(Entity)`, which runs reads only",
    });
    // Reading through `Mesh.privileged` is how a policy reads other rows.
    expect(build(MESH + post("  policies\n    policy :p types=[:update]\n      forbid-if=async () => (await Mesh.privileged(Post).read({})).length > 1\n    policy :r types=[:create, :read, :destroy]\n      authorize-if=() => true\n")).diagnostics).toEqual([]);
  });
});

describe("a read policy that reads the record is refused until M10", () => {
  test("covering a read with a record-reading check is MESH_NOT_IMPLEMENTED, once per policy, naming each read", () => {
    const built = build(post("  policies\n    policy :mine types=[:read, :update]\n      authorize-if=({ actor }) => &authorId === actor.id\n"));
    expect(codes(built.diagnostics)).toEqual(["error:MESH_NOT_IMPLEMENTED"]);
    expect(built.diagnostics[0]!.message).toBe("policy :mine authorize-if reads the record, and the policy covers read :read of blog.Post: a read policy that reads the record is a filter on the query, which the SQL evaluator folds in M10");
    // The same through a `when`.
    expect(codes(build(post("  policies\n    policy :w types=[:read] when=() => &title !== null\n      authorize-if=() => true\n")).diagnostics)).toEqual(["error:MESH_NOT_IMPLEMENTED"]);
  });

  test("a read policy that calls `Mesh.privileged` is MESH_READ_POLICY_PRIVILEGED at each call: a filter reads no other entity", () => {
    const fix = "Move the condition into a write policy (scope this one to the writes with `types=` or `actions=`) or a check, or into a computed field that the filter compares";
    const that = "async () => (await Mesh.privileged(Post).read({})).length > 9";
    const source = MESH + post(`  policies\n    policy :q types=[:read]\n      forbid-if=${that}\n    policy :rest types=[:create, :update, :destroy]\n      authorize-if=() => true\n`);
    const built = build(source);
    expect(codes(built.diagnostics)).toEqual(["error:MESH_READ_POLICY_PRIVILEGED"]);
    expect(built.diagnostics[0]).toMatchObject({
      message: "policy :q forbid-if calls `Mesh.privileged`, and the policy covers read :read of blog.Post: a read policy is a filter on the query, and reads no other entity",
      fix,
    });
    expect(built.diagnostics[0]!.position.offset).toBe(source.indexOf("Mesh.privileged(Post)"));
    expect(built.document).toBeNull();
    // A policy with no scope covers the read too; each call is reported, in a `when` as in a check.
    const twice = MESH + post("  policies\n    policy :all when=async () => (await Mesh.privileged(Post).read({})).length > 0\n      authorize-if=async () => (await Mesh.privileged(Post).read({})).length + (await Mesh.privileged(Post).read({})).length > 1\n");
    const all = build(twice).diagnostics;
    expect(codes(all)).toEqual(Array(3).fill("error:MESH_READ_POLICY_PRIVILEGED"));
    expect(all.map((d) => d.position.offset).sort((a, b) => a - b)).toEqual([...twice.matchAll(/Mesh\.privileged\(Post\)/g)].map((m) => m.index));
    expect(all.map((d) => d.message.split(" calls ")[0])).toEqual(["policy :all when", "policy :all authorize-if", "policy :all authorize-if"]);
    // A write policy reads through `Mesh.privileged` (POL-21), and `Mesh` shadowed by a parameter is not Mesh's.
    expect(build(MESH + post(`  policies\n    policy :p types=[:update]\n      forbid-if=${that}\n    policy :rest types=[:create, :read, :destroy]\n      authorize-if=() => true\n`)).diagnostics).toEqual([]);
    expect(codes(build(MESH + post("  policies\n    policy :q types=[:read]\n      authorize-if=({ context: Mesh }) => Mesh.privileged !== null\n")).diagnostics)).toEqual([]);
    // A read policy that calls an entity's action stays MESH_POLICY_ACTS.
    expect(codes(build(post("  policies\n    policy :q types=[:read]\n      authorize-if=async ({ context }) => (await Post.draft({ authorId: \"a\" }, context)) !== null\n")).diagnostics)).toEqual(["error:MESH_POLICY_ACTS"]);
  });

  test("a read policy that calls a helper which calls `Mesh.privileged` builds: the run time refuses the call (TXN-18)", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-policy-helper-"));
    try {
      await mkdir(resolve(root, "blog"));
      await writeFile(resolve(root, "blog/helpers.ts"), 'import { Mesh } from "meshfw";\nimport { Post } from "#mesh/domain/blog";\nexport const big = () => Mesh.privileged(Post) !== null;\n');
      const source = `import { big } from "./helpers"\n${post("  policies\n    policy :q types=[:read]\n      authorize-if=() => big()\n    policy :rest types=[:create, :update, :destroy]\n      authorize-if=() => true\n")}`;
      expect(buildModel({ root, files: [{ file: "blog/post.mesh.mx", source }] }).diagnostics).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a policy a caller's load runs (POL-17) that reads the record is refused too, with no read action to cover", () => {
    const comment = (policies: string) => ({ file: "blog/comment.mesh.mx", source: `entity :Comment
  attributes
    uuid :id primary-key
    string :authorId
  actions
    create :add
${policies}` });
    const blog = (policies: string, from = "belongs-to :comment entity=Comment") => buildModel({ root: "/project", files: [comment(policies), { file: "blog/post.mesh.mx", source: `import { Comment } from "./comment.mesh.mx"
entity :Post
  attributes
    uuid :id primary-key
  relationships
    ${from}
  actions auto=[:read]
  policies
    policy :all
      authorize-if=() => true
` }] });
    const built = blog("  policies\n    policy :mine\n      authorize-if=({ actor }) => &authorId === actor.id\n");
    expect(codes(built.diagnostics)).toEqual(["error:MESH_NOT_IMPLEMENTED"]);
    expect(built.diagnostics[0]!.message).toBe("policy :mine authorize-if reads the record, and the policy covers the loads of it (a relationship or a rollup that reaches it) of blog.Comment: a read policy that reads the record is a filter on the query, which the SQL evaluator folds in M10");
    // Scoped to reads by type, it covers the loads too.
    expect(codes(blog("  policies\n    policy :mine types=[:read]\n      authorize-if=() => &authorId !== null\n").diagnostics)).toEqual(["error:MESH_NOT_IMPLEMENTED"]);
    // Scoped to the writes, it builds, with the warning that no caller then loads a Comment (R2-N2); so does an entity no
    // relationship reaches, with no warning.
    expect(codes(blog("  policies\n    policy :mine types=[:create]\n      authorize-if=({ input, actor }) => input.authorId === actor.id\n").diagnostics)).toEqual(["warning:MESH_LOAD_NO_POLICY"]);
    expect(codes(buildModel({ root: "/project", files: [comment("  policies\n    policy :mine\n      authorize-if=({ actor, input }) => (input.authorId ?? &authorId) === actor.id\n")] }).diagnostics)).toEqual([]);
  });

  test("a relationship to an entity whose policies leave out the read a load runs warns: every caller's load of it is empty (R2-N2)", () => {
    const tag = (policies: string) => ({ file: "blog/tag.mesh.mx", source: `import { Shelf } from "./shelf.mesh.mx"
entity :Tag
  attributes
    uuid :id primary-key
  relationships
    belongs-to :shelf entity=Shelf
  actions auto=[:read]
    read :list
${policies}` });
    const covered = "  actions auto=[:read]\n  policies\n    policy :all\n      authorize-if=() => true\n";
    const blog = (policies: string) => buildModel({ root: "/project", files: [tag(policies), { file: "blog/post.mesh.mx", source: `import { Tag } from "./tag.mesh.mx"
entity :Post
  attributes
    uuid :id primary-key
  relationships
    belongs-to :tag entity=Tag nullable
${covered}` }, { file: "blog/shelf.mesh.mx", source: `import { Tag } from "./tag.mesh.mx"
entity :Shelf
  attributes
    uuid :id primary-key
  relationships
    has-many :tags entity=Tag
${covered}` }] });
    // Only a custom read is covered: a load runs the policies of `read`, so it gets nothing; each relationship says so, where it is.
    const custom = blog("  policies\n    policy :lists actions=[&list]\n      authorize-if=() => true\n");
    expect(codes(custom.diagnostics)).toEqual(["warning:MESH_LOAD_NO_POLICY", "warning:MESH_LOAD_NO_POLICY"]);
    expect(custom.diagnostics.map((d) => [d.message, d.position.line])).toEqual([
      ["belongs-to :tag of blog.Post reaches blog.Tag, and no policy of blog.Tag covers the read a load runs, so every caller's load of it is null, a count over it 0 and any other rollup null (through `Mesh.privileged` and in a computed field's body it is loaded)", 6],
      ["has-many :tags of blog.Shelf reaches blog.Tag, and no policy of blog.Tag covers the read a load runs, so every caller's load of it is [], a count over it 0 and any other rollup null (through `Mesh.privileged` and in a computed field's body it is loaded)", 6],
    ]);
    expect(custom.diagnostics[0]!.fix).toBe("If callers may load it, give blog.Tag a policy that covers its read: `types=[:read]`, `actions=[&read]` or no scope");
    // Covered by type, with no scope, or by name: no warning. Neither for an entity with no policy at all, which denies
    // every caller everything (deny by default), nor for Tag's relationship to Shelf, whose policy covers its read.
    for (const covering of ["policy :reads types=[:read]", "policy :any", "policy :named actions=[&read, &list]"])
      expect(blog(`  policies\n    ${covering}\n      authorize-if=() => true\n`).diagnostics).toEqual([]);
    expect(blog("").diagnostics).toEqual([]);
  });

  test("scoped to the writes, the same policy builds; an actor-only read policy builds", () => {
    expect(build(post("  policies\n    policy :mine types=[:update, :destroy]\n      authorize-if=({ actor }) => &authorId === actor.id\n    policy :signedIn types=[:create, :read]\n      authorize-if=({ actor }) => actor.id !== null\n")).diagnostics).toEqual([]);
  });
});

describe("which checks read the record (ACT-28, POL-08)", () => {
  const checks = (policy: string) => {
    const entity = entityOf(MESH + post(`  policies\n    policy :p types=[:update]\n      authorize-if=${policy}\n    policy :rest types=[:create, :read, :destroy]\n      authorize-if=() => true\n`));
    return readsRecord(policyExpressions(entity.policies[0]!)[0]!.expression);
  };
  test("actor, context and input only: before the transaction", () => {
    expect(checks("({ actor }) => actor.id !== null")).toBe(false);
    expect(checks("({ context, input }) => Mesh.isSystem(context) || input.title !== null")).toBe(false);
    expect(checks("() => true")).toBe(false);
    expect(checks("({ actor }) => { return typeof actor === \"object\" }")).toBe(false);
  });
  test("self, a member, Mesh.privileged, an entity, or plain code the build cannot read: inside the transaction (POL-11, POL-21)", () => {
    expect(checks("() => &title !== null")).toBe(true);
    expect(checks("({ self }) => self.title !== null")).toBe(true);
    expect(checks("async () => (await Mesh.privileged(Post).read({})).length > 0")).toBe(true);
    expect(checks("() => Post !== undefined")).toBe(true);
    expect(checks("({ actor }) => { return actor.id === &authorId }")).toBe(true);
    expect(checks("(scope) => scope.actor !== null")).toBe(true);
    expect(checks("({ ...scope }) => scope.actor !== null")).toBe(true);
  });
  test("a write's check that calls an imported function runs inside the transaction, even when the build translates it (POL-21); a read policy's builds", async () => {
    // The function may read anything through `Mesh.privileged`, which reads in the running transaction.
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-policy-helper-"));
    try {
      await mkdir(resolve(root, "blog"));
      await writeFile(resolve(root, "blog/helpers.ts"), "export const isStaff = (actor: { staff?: boolean }) => actor.staff === true;\n");
      const source = `import { isStaff } from "./helpers"\n${post("  policies\n    policy :p types=[:update]\n      authorize-if=({ actor }) => isStaff(actor)\n    policy :rest types=[:create, :read, :destroy]\n      authorize-if=() => true\n")}`;
      const built = buildModel({ root, files: [{ file: "blog/post.mesh.mx", source }] });
      expect(built.diagnostics).toEqual([]);
      const expression = policyExpressions(built.document!.entities[0]!.policies[0]!)[0]!.expression;
      expect(expression.tree).toBeDefined();
      expect(readsRecord(expression)).toBe(true);
      expect(recordReason(expression)).toBe("calls an imported function");
      // In a read policy it is a pure call (EXP-03), not a read of the record: the policy builds, and runs before the query.
      const reader = `import { isStaff } from "./helpers"\n${post("  policies\n    policy :staff types=[:read]\n      authorize-if=({ actor }) => isStaff(actor)\n    policy :rest types=[:create, :update, :destroy]\n      authorize-if=() => true\n")}`;
      const read = buildModel({ root, files: [{ file: "blog/post.mesh.mx", source: reader }] });
      expect(read.diagnostics).toEqual([]);
      const readCheck = policyExpressions(read.document!.entities[0]!.policies[0]!)[0]!.expression;
      expect(recordReason(readCheck, "read")).toBeUndefined();
      expect(recordReason(readCheck, "write")).toBe("calls an imported function");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("types= and actions= cover by kind and by name; a policy with neither covers every action", () => {
    const entity = entityOf(post("  policies\n    policy :all\n      authorize-if=() => true\n    policy :writes types=[:create, :update]\n      authorize-if=() => true\n    policy :one actions=[&remove]\n      authorize-if=() => true\n"));
    const names = (action: string) => policiesCovering(entity, [...entity.actions, { kind: "read" as const, name: "read" }].find((a) => a.name === action)!).map((p) => p.name);
    expect(names("draft")).toEqual(["all", "writes"]);
    expect(names("publish")).toEqual(["all", "writes"]);
    expect(names("remove")).toEqual(["all", "one"]);
    expect(names("read")).toEqual(["all"]);
  });
});

describe("Mesh.isSystem(context)", () => {
  const source = (check: string) => MESH + post(`  policies\n    policy :internal types=[:create, :update, :destroy]\n      authorize-if=${check}\n    policy :readers types=[:read]\n      authorize-if=() => true\n`);
  test("translated, it is Mesh's function; in plain code it is a member of the imported Mesh; its expressions file calls the runtime's", async () => {
    const translated = build(source("({ context }) => Mesh.isSystem(context)"));
    expect(translated.diagnostics).toEqual([]);
    expect(translated.document!.entities[0]!.policies[0]!.authorizeIf[0]!.tree).toMatchObject({ kind: "call", fn: "isSystem" });
    const plain = build(source("({ context }) => { return Mesh.isSystem(context) }"));
    expect(plain.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    for (const document of [translated.document!, plain.document!]) {
      const files = await generateFiles({ document, config: configOf("/project") });
      const expressions = files.find((file) => file.path.endsWith("post.expressions.ts"))!.contents;
      expect(expressions).toMatch(/\$\.isSystem\(|return Mesh\.isSystem\(context\)/);
      // The file's `Mesh` is the runtime's, imported as a helper is: no per-evaluation `Mesh` is bound (SYN-29 removed it).
      expect(expressions).not.toMatch(/\$mesh|meshIn/);
      expect(expressions).toContain('"policy.internal.authorize-if.0"');
    }
  });
  test("called with the wrong number of arguments, a Mesh function fails the build, translated or plain (N3)", () => {
    const built = build(source("({ context }) => Mesh.isSystem(context, context)"));
    expect(codes(built.diagnostics)).toEqual(["error:MESH_EXPR_ARITY"]);
    expect(built.diagnostics[0]!.message).toBe("`Mesh.isSystem()` takes 1 argument, and this call passes 2");
    expect(built.diagnostics[0]!.position).toMatchObject({ line: 16, column: 36 });
    expect(codes(build(source("() => Mesh.isSystem()")).diagnostics)).toEqual(["error:MESH_EXPR_ARITY"]);
    expect(codes(build(source("({ context }) => { return Mesh.isSystem(context, 1) }")).diagnostics)).toEqual(["error:MESH_EXPR_ARITY"]);
    // `%.now` is a value of the transaction, never a call: `%.now(1)` is refused as a call, not counted (SYN-29).
    expect(codes(build(source("() => %.now(1) !== null")).diagnostics)).toEqual(["error:MESH_TRANSACTION_CALL"]);
    // A parameter named `Mesh` is the author's own, with its own arity.
    expect(build(source("() => [1].some((Mesh) => Mesh.isSystem(1, 2) === 1)")).diagnostics.filter((d) => d.code === "MESH_EXPR_ARITY")).toEqual([]);
  });
});

describe("mesh explain lists each policy and where its checks run", () => {
  const entity = () => entityOf(MESH + post(`  policies
    policy :signedIn types=[:create, :read]
      authorize-if=({ actor }) => actor.id !== null
    policy :owner types=[:create, :update]
      authorize-if=({ actor, input }) => (input.authorId ?? &authorId) === actor.id
      forbid-if=({ context }) => Mesh.isSystem(context)
`));
  /** The policies section: its heading line and the indented lines under it. */
  const section = (lines: string[]) => {
    const start = lines.findIndex((line) => line.startsWith("  policies"));
    const end = lines.findIndex((line, i) => i > start && !line.startsWith("               "));
    return lines.slice(start, end < 0 ? undefined : end);
  };
  test("an update: actor-only before the transaction, record-reading on the locked row", () => {
    expect(section(explainAction(entity(), "publish")!)).toEqual([
      "  policies     :owner",
      "                 authorize-if ({ actor, input }) => (input.authorId ?? &authorId) === actor.id: inside the transaction, on the locked row, before validate",
      "                 forbid-if ({ context }) => Mesh.isSystem(context): before the transaction, once",
      "               every policy above must pass; in one, any forbid-if that holds or is unknown forbids, and of its authorize-ifs one must hold",
    ]);
  });
  test("a create: record-reading on the new instance, before the input", () => {
    const lines = section(explainAction(entity(), "draft")!);
    expect(lines).toContain("                 authorize-if ({ actor, input }) => (input.authorId ?? &authorId) === actor.id: inside the transaction, on the new instance before the input, before validate");
    expect(lines.filter((line) => line.startsWith("  policies") || /^ {15}:/.test(line))).toEqual(["  policies     :signedIn", "               :owner"]);
  });
  test("a read: before the query; an action no policy covers: every call is forbidden", () => {
    expect(section(explainAction(entity(), "read")!)).toEqual([
      "  policies     :signedIn",
      "                 authorize-if ({ actor }) => actor.id !== null: before the query, once: a caller it does not admit gets no rows",
      "               every policy above must pass; in one, any forbid-if that holds or is unknown forbids, and of its authorize-ifs one must hold",
    ]);
    expect(explainAction(entity(), "remove")!).toContain("  policies     none covers it: every call is forbidden (an action no policy covers is denied)");
  });
  test("a read that fails with M10 runs no policy; a `when` and a load say what they do", () => {
    const filtered = entityOf(post("  policies\n    policy :all\n      authorize-if=() => true\n").replace("  actions auto=[:read]\n", "  actions auto=[:read]\n    read :titled\n      filter=() => &title !== null\n"));
    expect(section(explainAction(filtered, "titled")!)).toEqual(["  policies     none run: the read's filter is the SQL evaluator's (M10), so every call fails before its policies are evaluated"]);
    const when = entityOf(MESH + post("  policies\n    policy :staff when=({ context }) => Mesh.isSystem(context)\n      authorize-if=() => true\n"));
    expect(section(explainAction(when, "publish")!)).toContain("               a policy whose when is false does not apply; with none applying, the call is forbidden");
    expect(section(explainAction(when, "read")!)).toContain("               a policy whose when is false does not apply; with none applying, the caller gets no rows");
  });
});
