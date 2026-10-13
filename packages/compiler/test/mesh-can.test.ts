// CMP-21 at build time: `Mesh.checkPolicies` and `Mesh.can` in an entity file. They run another action's policies, so
// they follow `Mesh.privileged`'s rules: allowed wherever a function runs inside an action (a step, a check, a set value,
// a helper those call), refused in a computed field (MESH_COMPUTED_COMPOSES), and refused in every policy, read or write
// (MESH_POLICY_ASKS: a policy that asks can be asked back, and nothing bounds that). The run-time side, and the real
// project built and run, is `packages/cli/test/can-in-entities.test.ts`.
import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/front-end/build.ts";

const ASK = "async ({ input, context }) => await Mesh.can(Task.go, input, context)";

/** An entity file with one update action `go`; `extra` is the section(s) between the relationships and the actions. */
const entity = (steps: string, extra = "", imports = 'import { Mesh } from "meshfw"') => `import { Task } from "./task.mesh.mx"
${imports}
entity :Task
  attributes
    uuid :id primary-key
    integer :n
  relationships
    has-many :children entity=Task
${extra}  actions auto=[:read]
    update :go
${steps}`;
const run = (body: string) => `      do\n        run async ({ input, context }) { ${body} }\n`;
const check = (that: string) => `      validate\n        check :c that=${that} code="c" message="m"\n`;
const policies = (...lines: string[]) => `  policies\n${lines.map((line) => `    ${line}\n`).join("")}`;

const build = (source: string) => buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source }] });
const errors = (source: string) =>
  build(source).diagnostics.filter((d) => d.severity === "error").map((d) => ({ code: d.code, message: d.message, fix: d.fix, offset: d.position.offset }));
const codes = (source: string) => build(source).diagnostics.map((d) => `${d.severity}:${d.code}`);
const go = (source: string) => build(source).document!.entities[0]!.actions.find((a) => a.name === "go")!;

describe("where they may be called: a step, a check, a set value and a helper's caller", () => {
  test("a run step, a plain check and a set value build, are plain code that asks, and warn of nothing", () => {
    const source = entity(
      check(ASK) + "      do\n        set\n          &n=async ({ input, context }) => (await Mesh.can(Task.go, input, context)) ? 1 : 0\n" +
      "        run [after=:write] async ({ input, context }) { console.log(await Mesh.checkPolicies(Task.go, input, context)) }\n" +
      "        run async ({ input, context }) { if (await Mesh.can(Task.go, input, context)) console.log(1) }\n",
    );
    expect(build(source).diagnostics).toEqual([]);
    const action = go(source);
    expect(action.validate[0]!.that.plain).toMatchObject({ why: "asks-policies", asks: true, mesh: ["Mesh"], entities: ["Task"] });
    const [set, after, before] = action.do;
    expect(set!.kind === "set" ? (set!.assignments[0]!.value as { plain?: unknown }).plain : undefined).toMatchObject({ why: "asks-policies", asks: true });
    for (const step of [after, before]) expect(step!.kind === "run" ? step!.fn.plain : undefined).toMatchObject({ why: "run-step", asks: true, mesh: ["Mesh"] });
    // A function that does not ask is not marked.
    expect(go(entity(check("() => true"))).validate[0]!.that.plain).toBeUndefined();
    const reading = go(entity(run("await Mesh.privileged(Task).read({})"))).do[0]!;
    expect(reading.kind === "run" ? reading.fn.plain : undefined).toMatchObject({ privileged: true });
    expect(reading.kind === "run" ? reading.fn.plain?.asks : "x").toBeUndefined();
  });

  test("a function that asks and calls a privileged read is both", () => {
    const source = entity(run("await Mesh.can(Task.go, input, context); await Mesh.privileged(Task).read({})"));
    expect(build(source).diagnostics).toEqual([]);
    const step = go(source).do[0]!;
    expect(step.kind === "run" ? step.fn.plain : undefined).toMatchObject({ privileged: true, asks: true });
  });

  test("each takes three arguments: any other number is MESH_EXPR_ARITY, naming the call as written, with a fix that shows the call", () => {
    expect(errors(entity(run("await Mesh.can(Task.go, input)")))).toMatchObject([{
      code: "MESH_EXPR_ARITY", message: "`Mesh.can()` takes 3 arguments, and this call passes 2", fix: "write `Mesh.can(Task.complete, input, context)`",
    }]);
    expect(errors(entity(run("await Mesh.checkPolicies()"))).map((e) => [e.code, e.message])).toEqual([["MESH_EXPR_ARITY", "`Mesh.checkPolicies()` takes 3 arguments, and this call passes 0"]]);
    expect(errors(entity(run("await Mesh.can(Task.go, input, context, 1)"))).map((e) => e.code)).toEqual(["MESH_EXPR_ARITY"]);
  });

  test("a bare call is a free variable whose fix writes it through Mesh, keeping its own arguments", () => {
    expect(errors(entity(run("await can(Task.go, input, context)")))).toMatchObject([{
      code: "MESH_EXPR_FREE_VARIABLE", fix: "write `Mesh.can(Task.go, input, context)`",
    }]);
    const unimported = entity(run("await checkPolicies(Task.go, { id: input.id }, context)"), "", "");
    expect(errors(unimported)[0]).toMatchObject({
      code: "MESH_EXPR_FREE_VARIABLE",
      fix: 'write `Mesh.checkPolicies(Task.go, { id: input.id }, context)` and import `Mesh` from "meshfw": `import { Mesh } from "meshfw"`',
    });
  });
});

describe("name resolution: every rule `Mesh` already follows holds", () => {
  const asks = (source: string) => {
    const step = go(source).do[0]!;
    return step.kind === "run" ? step.fn.plain?.asks === true : undefined;
  };
  const inPolicy = (call: string, imports?: string) =>
    entity(check("() => true"), policies(`policy :p types=[:update]`, `  authorize-if=async ({ input, context }) => ${call}`, "policy :r types=[:read]", "  authorize-if=() => true"), imports);

  test("an alias of Mesh, Mesh?.can and Mesh[\"can\"] are the function", () => {
    const aliased = (body: string) => entity(run(body), "", 'import { Mesh as M } from "meshfw"');
    expect(asks(aliased("await M.can(Task.go, input, context)"))).toBe(true);
    expect(asks(aliased("await M.checkPolicies(Task.go, input, context)"))).toBe(true);
    expect(asks(entity(run("await Mesh?.can(Task.go, input, context)")))).toBe(true);
    expect(asks(entity(run('await Mesh["can"](Task.go, input, context)')))).toBe(true);
    expect(asks(entity(run('await Mesh?.["checkPolicies"](Task.go, input, context)')))).toBe(true);
    // The fix and the arity message name the alias.
    expect(errors(aliased("await M.can(Task.go)"))).toMatchObject([{ message: "`M.can()` takes 3 arguments, and this call passes 1", fix: "write `M.can(Task.complete, input, context)`" }]);
    // The refusals follow the alias and the computed key.
    expect(errors(inPolicy("await M.can(Task.go, input, context)", 'import { Mesh as M } from "meshfw"')).map((e) => e.code)).toEqual(["MESH_POLICY_ASKS"]);
    expect(errors(inPolicy('await Mesh["can"](Task.go, input, context)')).map((e) => e.code)).toEqual(["MESH_POLICY_ASKS"]);
  });

  test("a template literal with no substitution is a fixed key, as a string is", () => {
    for (const call of ["Mesh[`can`](Task.go, input, context)", "Mesh?.[`checkPolicies`](Task.go, input, context)"])
      expect(errors(inPolicy(`await ${call}`)).map((e) => e.code), call).toEqual(["MESH_POLICY_ASKS"]);
    // `privileged` was missed the same way: in a computed field it is refused.
    const computed = entity(check("() => true"), "  computed\n    boolean :c() { return Mesh[`privileged`](Task) !== null }\n");
    expect(errors(computed).map((e) => e.code)).toEqual(["MESH_COMPUTED_COMPOSES"]);
    expect(asks(entity(run("await Mesh[`can`](Task.go, input, context)")))).toBe(true);
    expect(errors(inPolicy("await Mesh[`can`](Task.go, input, context)")).map((e) => e.code)).toEqual(["MESH_POLICY_ASKS"]);
    for (const body of ["const { [`can`]: ask } = Mesh; await ask(Task.go, input, context)", "let ask; ({ [`checkPolicies`]: ask } = Mesh); await ask(Task.go, input, context)"]) {
      expect(errors(entity(run(body))), body).toEqual([]);
      expect(asks(entity(run(body))), body).toBe(true);
    }
    // An unknown function written that way is unknown, and one with a substitution names no member.
    expect(errors(entity(run("await Mesh[`nope`](input)"))).map((e) => e.code)).toEqual(["MESH_UNKNOWN_MESH_FUNCTION"]);
    expect(errors(entity(run("const k = 'can'; await Mesh[`${k}`](input)")))).toEqual([]);
  });

  test("a member destructured from Mesh counts as a read of it", () => {
    for (const body of [
      "const { can } = Mesh; await can(Task.go, input, context)",
      "const { can: ask } = Mesh; await ask(Task.go, input, context)",
      'const { "checkPolicies": ask } = Mesh; await ask(Task.go, input, context)',
      "let ask; ({ checkPolicies: ask } = Mesh); await ask(Task.go, input, context)",
    ]) {
      expect(errors(entity(run(body))), body).toEqual([]);
      expect(asks(entity(run(body))), body).toBe(true);
    }
    const computed = entity(check("() => true"), "  computed\n    boolean :c() { const { can } = Mesh; return can !== null }\n");
    expect(errors(computed).map((e) => e.code)).toEqual(["MESH_COMPUTED_COMPOSES"]);
    const at = inPolicy("await (async () => { const { can } = Mesh; return can(Task.go, input, context) })()");
    expect(errors(at).map((e) => [e.code, e.offset])).toEqual([["MESH_POLICY_ASKS", at.indexOf("can }")]]);
    // A key Mesh does not have, next to one it has, is named at the key.
    const later = entity(run("const { can, later } = Mesh; await can(Task.go, input, context); later()"));
    expect(errors(later)).toMatchObject([{ code: "MESH_UNKNOWN_MESH_FUNCTION", offset: later.indexOf("later }") }]);
  });

  test("a parameter or a local named Mesh hides the import where it is in scope", () => {
    // `Mesh` here is the function's own parameter or local: its `can` is not Mesh's.
    for (const source of [
      entity(`      do\n        run async ({ input }, Mesh) { await Mesh.can(Task.go, input, {}) }\n`),
      entity(run("const Mesh = { can: async (...rest) => rest }; await Mesh.can(Task.go, input, context)")),
      entity(run("await [1].map(async (Mesh) => Mesh.can(Task.go, input, context))[0]")),
    ]) {
      const built = build(source).diagnostics.filter((d) => d.severity === "error");
      expect(built.filter((d) => d.code === "MESH_POLICY_ASKS" || d.code === "MESH_UNKNOWN_MESH_FUNCTION" || d.code === "MESH_EXPR_ARITY"), source).toEqual([]);
      const step = go(source).do[0]!;
      expect(step.kind === "run" ? step.fn.plain?.asks : "x", source).toBeUndefined();
    }
    // In a policy and a computed field a hidden `Mesh` is no refusal either; where the import is not hidden, it is.
    expect(errors(inPolicy("await [context].map(async (Mesh) => Mesh.can)[0]"))).toEqual([]);
    const shadowed = entity(check("() => true"), "  computed\n    boolean :c() { return [{ can: 1 }].some((Mesh) => Mesh.can === 1) }\n");
    expect(errors(shadowed)).toEqual([]);
    // Hidden only where the binding is in scope: a read outside it is the import.
    expect(errors(entity(run("await [1].map((Mesh) => Mesh); await Mesh.can(Task.go, input, context)")))).toEqual([]);
    expect(asks(entity(run("await [1].map((Mesh) => Mesh); await Mesh.can(Task.go, input, context)")))).toBe(true);
  });

  test("Mesh not imported, or imported under a scope name, is not the function", () => {
    expect(errors(entity(run("await Mesh.can(Task.go, input, context)"), "", "")).map((e) => e.code)).toEqual(["MESH_EXPR_FREE_VARIABLE"]);
    expect(errors(entity(run("await Mesh.can(Task.go, input, context)"), "", 'import { Mesh as input } from "meshfw"')).map((e) => e.code)).toContain("MESH_HELPER_NAME");
  });
});

describe("a computed field may not ask (MESH_COMPUTED_COMPOSES)", () => {
  const computed = (body: string) => entity(check("() => true"), `  computed\n    boolean :c() { ${body} }\n`);

  test("the message names Mesh.can and Mesh.checkPolicies, at the body", () => {
    for (const body of ["return Mesh.can(Task.go, {}, {}) !== null", "return Mesh.checkPolicies(Task.go, {}, {}) !== null", 'return Mesh["can"](Task.go, {}, {}) !== null']) {
      const source = computed(body);
      expect(errors(source), body).toEqual([{
        code: "MESH_COMPUTED_COMPOSES",
        message: "computed :c of Task calls `Mesh.can` or `Mesh.checkPolicies`, which only a function that runs inside an action may: a computed field is worked out whenever a record is loaded, outside any action",
        fix: "Compute it from the record, its relationships and other computed fields; a read through `Mesh.privileged`, a question to `Mesh.can` or a call to another action belongs in a step or a check",
        offset: expect.any(Number),
      }]);
    }
  });

  test("one that also reads through privileged or calls an action says each; the existing messages are unchanged", () => {
    expect(errors(computed("return Mesh.can(Task.go, {}, {}) !== null && Mesh.privileged(Task) !== null"))[0]!.message)
      .toStartWith("computed :c of Task calls `Mesh.privileged` and calls `Mesh.can` or `Mesh.checkPolicies`, which");
    expect(errors(computed("return Mesh.privileged(Task) !== null"))[0]!.message)
      .toStartWith("computed :c of Task calls `Mesh.privileged`, which only a function that runs inside an action may");
    expect(errors(computed("return Task.go({}, {}) !== null"))[0]!.message)
      .toStartWith("computed :c of Task calls an entity's action, which only");
  });

  test("a computed field that does not ask builds, and so does one whose own Mesh is a local", () => {
    expect(errors(computed("return 1 > 0"))).toEqual([]);
    expect(errors(computed("const Mesh = { can: 1 }; return Mesh.can > 0"))).toEqual([]);
  });
});

describe("a policy may not ask (MESH_POLICY_ASKS)", () => {
  const policy = (header: string, ...lines: string[]) =>
    entity(check("() => true"), policies(header, ...lines.map((line) => `  ${line}`), "policy :rest types=[:read, :create, :destroy]", "  authorize-if=() => true"));
  const FIX = "decide in the policy from what it can read through `Mesh.privileged(Entity)`, and ask in a step or a `validate` check";
  // A read policy may not read through `Mesh.privileged` (MESH_READ_POLICY_PRIVILEGED), so its fix does not offer it.
  const READ_FIX = "decide in the policy from the record and what it loads, and ask in a step or a `validate` check of a write action";

  test("a write policy's check is refused at the call, naming the policy and the check", () => {
    const source = policy("policy :p types=[:update]", `forbid-if=${ASK}`);
    expect(errors(source)).toEqual([{
      code: "MESH_POLICY_ASKS",
      message: "policy :p forbid-if asks another action's policies (`Mesh.can` or `Mesh.checkPolicies`): a policy may not ask, since the policy it asks could ask back and nothing bounds that",
      fix: FIX,
      offset: source.indexOf("Mesh.can"),
    }]);
    expect(build(source).document).toBeNull();
  });

  test("a read policy is refused too, and so is a `when=` and an authorize-if", () => {
    expect(codes(policy("policy :p types=[:read]", `authorize-if=${ASK}`))).toEqual(["error:MESH_POLICY_ASKS"]);
    expect(errors(policy("policy :p types=[:read]", `authorize-if=${ASK}`)).map((e) => e.fix)).toEqual([READ_FIX]);
    // A policy that covers a read and a write is a read policy too.
    expect(errors(policy("policy :p", `authorize-if=${ASK}`)).map((e) => e.fix)).toEqual([READ_FIX]);
    const when = policy(`policy :p types=[:update] when=${ASK}`, "authorize-if=() => true");
    expect(errors(when).map((e) => [e.code, e.message.split(" asks ")[0]])).toEqual([["MESH_POLICY_ASKS", "policy :p when"]]);
    // A policy that covers every action.
    expect(codes(policy("policy :p", `authorize-if=${ASK}`))).toEqual(["error:MESH_POLICY_ASKS"]);
  });

  test("each call is reported at its own position, `checkPolicies` as `can`", () => {
    const that = "async ({ input, context }) => (await Mesh.can(Task.go, input, context)) && (await Mesh.checkPolicies(Task.go, input, context)).allowed && (await Mesh.can(Task.go, input, context))";
    const source = policy("policy :p types=[:update]", `authorize-if=${that}`);
    expect(errors(source).map((e) => e.code)).toEqual(Array(3).fill("MESH_POLICY_ASKS"));
    expect(errors(source).map((e) => e.offset).sort((a, b) => a - b)).toEqual([...source.matchAll(/Mesh\.(?:can|checkPolicies)\(/g)].map((m) => m.index));
  });

  test("a call inside a step or a check of the same entity is no policy's: it builds", () => {
    expect(build(entity(check(ASK), policies("policy :p", "  authorize-if=() => true"))).diagnostics).toEqual([]);
  });

  test("asking is not acting or reading: MESH_POLICY_ACTS and a privileged read stay their own", () => {
    const acts = policy("policy :p types=[:update]", "forbid-if=async ({ context }) => (await Task.go({ id: \"x\" }, context)) !== null");
    expect(codes(acts)).toEqual(["error:MESH_POLICY_ACTS"]);
    expect(codes(policy("policy :p types=[:update]", "forbid-if=async () => (await Mesh.privileged(Task).read({})).length > 1"))).toEqual([]);
    // Reading privileged in a read policy keeps its own code; asking in the same check adds this one.
    const both = policy("policy :p types=[:read]", "authorize-if=async ({ input, context }) => (await Mesh.privileged(Task).read({})).length > 0 && (await Mesh.can(Task.go, input, context))");
    expect(codes(both).sort()).toEqual(["error:MESH_POLICY_ASKS", "error:MESH_READ_POLICY_PRIVILEGED"]);
  });

  test("Mesh read whole is no call the build sees: it adds no error (the run time refuses it where a hidden call is refused)", () => {
    for (const call of ["(0, Mesh).can(Task.go, input, context)", "Mesh[input.k](Task.go, input, context)"])
      expect(errors(policy("policy :p types=[:update]", `authorize-if=async ({ input, context }) => await ${call}`)), call).toEqual([]);
    expect(errors(policy("policy :p types=[:update]", "authorize-if=({ context }) => { const M = Mesh; return M.isSystem(context) }"))).toEqual([]);
  });

  test("a policy whose Mesh is a parameter is not asking", () => {
    expect(errors(policy("policy :p types=[:update]", "authorize-if=({ context: Mesh }) => Mesh.can !== undefined"))).toEqual([]);
  });
});
