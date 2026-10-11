// M8a at build time: what a policy may read, what `actions=` may name, which checks run where (ACT-28, POL-08), the M10
// refusal of a read policy that reads the record, `isSystem(context)`, and what `mesh explain` says. The run-time side is
// `packages/data-sqlite/test/policies.test.ts`.
import { describe, expect, test } from "bun:test";
import type { Diagnostic, Entity } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { policiesCovering, policyExpressions, readsRecord } from "../src/model/policies.ts";
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
    expect(built.diagnostics[0]!.message).toBe("&publsh is not an action of :Post: `actions=` names the entity's own actions (&draft, &publish, &remove, &read). Did you mean &publish?");
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

  test("a policy that reads `actions` fails the build: a policy decides, it does not act", () => {
    const built = build(post("  policies\n    policy :p types=[:update]\n      forbid-if=async ({ actions }) => (await actions.readPost({})).length > 1\n"));
    expect(codes(built.diagnostics)).toContain("error:MESH_POLICY_ACTS");
    // Reading through `tx` is how a policy reads other rows.
    expect(build(post("  policies\n    policy :p types=[:update]\n      forbid-if=async ({ tx }) => (await tx.readPost({})).length > 1\n    policy :r types=[:create, :read, :destroy]\n      authorize-if=() => true\n")).diagnostics).toEqual([]);
  });
});

describe("a read policy that reads the record is refused until M10", () => {
  test("covering a read with a record-reading check is MESH_NOT_IMPLEMENTED, once per policy, naming each read", () => {
    const built = build(post("  policies\n    policy :mine\n      authorize-if=({ actor }) => &authorId === actor.id\n"));
    expect(codes(built.diagnostics)).toEqual(["error:MESH_NOT_IMPLEMENTED"]);
    expect(built.diagnostics[0]!.message).toBe("policy :mine authorize-if reads the record, and the policy covers read :read of :Post: a read policy that reads the record is a filter on the query, which the SQL evaluator folds in M10");
    // The same through tx, and through a `when`.
    expect(codes(build(post("  policies\n    policy :q types=[:read]\n      forbid-if=async ({ tx }) => (await tx.readPost({})).length > 9\n")).diagnostics)).toEqual(["error:MESH_NOT_IMPLEMENTED"]);
    expect(codes(build(post("  policies\n    policy :w types=[:read] when=() => &title !== null\n      authorize-if=() => true\n")).diagnostics)).toEqual(["error:MESH_NOT_IMPLEMENTED"]);
  });

  test("scoped to the writes, the same policy builds; an actor-only read policy builds", () => {
    expect(build(post("  policies\n    policy :mine types=[:update, :destroy]\n      authorize-if=({ actor }) => &authorId === actor.id\n    policy :signedIn types=[:create, :read]\n      authorize-if=({ actor }) => actor.id !== null\n")).diagnostics).toEqual([]);
  });
});

describe("which checks read the record (ACT-28, POL-08)", () => {
  const checks = (policy: string) => {
    const entity = entityOf(post(`  policies\n    policy :p types=[:update]\n      authorize-if=${policy}\n    policy :rest types=[:create, :read, :destroy]\n      authorize-if=() => true\n`));
    return readsRecord(policyExpressions(entity.policies[0]!)[0]!.expression);
  };
  test("actor, context and input only: before the transaction", () => {
    expect(checks("({ actor }) => actor.id !== null")).toBe(false);
    expect(checks("({ context, input }) => isSystem(context) || input.title !== null")).toBe(false);
    expect(checks("() => true")).toBe(false);
    expect(checks("({ actor }) => { return typeof actor === \"object\" }")).toBe(false);
  });
  test("self, a member, tx, or plain code the build cannot read: inside the transaction", () => {
    expect(checks("() => &title !== null")).toBe(true);
    expect(checks("({ self }) => self.title !== null")).toBe(true);
    expect(checks("async ({ tx }) => (await tx.readPost({})).length > 0")).toBe(true);
    expect(checks("({ actor }) => { return actor.id === &authorId }")).toBe(true);
    expect(checks("(scope) => scope.actor !== null")).toBe(true);
    expect(checks("({ ...scope }) => scope.actor !== null")).toBe(true);
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

describe("isSystem(context)", () => {
  const source = (check: string) => post(`  policies\n    policy :internal types=[:create, :update, :destroy]\n      authorize-if=${check}\n    policy :readers types=[:read]\n      authorize-if=() => true\n`);
  test("translated, it is a registered function; in plain code it is in scope; its expressions file calls the runtime's", async () => {
    const translated = build(source("({ context }) => isSystem(context)"));
    expect(translated.diagnostics).toEqual([]);
    expect(translated.document!.entities[0]!.policies[0]!.authorizeIf[0]!.tree).toMatchObject({ kind: "call", fn: "isSystem" });
    const plain = build(source("({ context }) => { return isSystem(context) }"));
    expect(plain.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    for (const document of [translated.document!, plain.document!]) {
      const files = await generateFiles({ document, config: configOf("/project") });
      const expressions = files.find((file) => file.path.endsWith("post.expressions.ts"))!.contents;
      expect(expressions).toMatch(/\$\.isSystem\(|const isSystem = \$\.isSystem;/);
      expect(expressions).toContain('"policy.internal.authorize-if.0"');
    }
  });
  test("it takes one argument: with two, the function is not translated, and is kept as plain code", () => {
    const built = build(source("({ context }) => isSystem(context, context)"));
    expect(built.document!.entities[0]!.policies[0]!.authorizeIf[0]!.plain).toMatchObject({ detail: "`isSystem()` takes 1 argument" });
  });
});

describe("mesh explain lists each policy and where its checks run", () => {
  const entity = () => entityOf(post(`  policies
    policy :signedIn types=[:create, :read]
      authorize-if=({ actor }) => actor.id !== null
    policy :owner types=[:create, :update]
      authorize-if=({ actor }) => &authorId === actor.id
      forbid-if=({ context }) => isSystem(context)
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
      "                 authorize-if ({ actor }) => &authorId === actor.id: inside the transaction, on the locked row, before validate",
      "                 forbid-if ({ context }) => isSystem(context): before the transaction, once",
      "               every policy above must pass; in one, any forbid-if that holds or is unknown forbids, and of its authorize-ifs one must hold",
    ]);
  });
  test("a create: record-reading on the new instance, before the input", () => {
    const lines = section(explainAction(entity(), "draft")!);
    expect(lines).toContain("                 authorize-if ({ actor }) => &authorId === actor.id: inside the transaction, on the new instance before the input, before validate");
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
});
