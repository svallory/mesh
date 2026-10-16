import { describe, expect, test } from "bun:test";
import type { Entity } from "@meshfw/model";
import { resolveName } from "../src/index.ts";

/** A model fixture built by hand: the build refuses two same-named entities until per-barrel name checks exist. */
const at = { file: "x.mesh.mx", line: 1, column: 1, offset: 0 };
const entity = (fqn: string): Entity => {
  const segments = fqn.split(".");
  const name = segments.pop()!;
  return {
    name, fqn, table: name.toLowerCase(), file: `${segments.join("/")}/${name.toLowerCase()}.mesh.mx`, module: segments.join("/"),
    imports: [], attributes: [], relationships: [], computed: [], auto: [], actions: [], always: [], policies: [], position: at,
  };
};
const model = (...fqns: string[]) => ({ entities: fqns.map(entity) });
const found = (result: ReturnType<typeof resolveName>) => (result.kind === "found" ? result.entity.fqn : result);

describe("resolveName", () => {
  const unique = model("work.project.Task", "work.Review", "identity.Membership", "Root");

  test("a bare name picks the one declaration while only one exists", () => {
    expect(found(resolveName(unique, "Task"))).toBe("work.project.Task");
    expect(found(resolveName(unique, "Membership"))).toBe("identity.Membership");
  });
  test("the full FQN and any trailing run of qualifiers pick it too", () => {
    for (const input of ["work.project.Task", "project.Task", "Task"]) expect(found(resolveName(unique, input))).toBe("work.project.Task");
    expect(found(resolveName(unique, "work.Review"))).toBe("work.Review");
  });
  test("a root entity is its bare name", () => {
    expect(found(resolveName(unique, "Root"))).toBe("Root");
  });
  test("qualifiers must be trailing and whole segments: a leading run, a middle run and a part of a segment pick nothing", () => {
    for (const input of ["work.project", "work.Task", "proj.Task", "ask", "roject.Task", "work..Task", ".Task", "Task.", ""])
      expect(resolveName(unique, input).kind, input).toBe("unknown");
  });
  test("a hyphenated module is matched as written: a prefix of its segment picks nothing", () => {
    const m = model("order-management.Invoice");
    expect(found(resolveName(m, "order-management.Invoice"))).toBe("order-management.Invoice");
    expect(resolveName(m, "management.Invoice").kind).toBe("unknown");
    expect(resolveName(m, "order.Invoice").kind).toBe("unknown");
  });
  test("it is case-sensitive", () => {
    for (const input of ["task", "TASK", "Project.Task", "Work.project.Task"]) expect(resolveName(unique, input).kind, input).toBe("unknown");
  });

  const clash = model("work.project.Task", "school.homework.Task", "other.Task", "work.Review");
  test("an ambiguous name is an error that lists every candidate and picks none", () => {
    const result = resolveName(clash, "Task");
    expect(result).toEqual({
      kind: "ambiguous",
      candidates: ["other.Task", "school.homework.Task", "work.project.Task"],
      message: 'Entity name "Task" is ambiguous. Did you mean other.Task, school.homework.Task or work.project.Task?',
    });
  });
  test("two candidates read 'a or b'", () => {
    const result = resolveName(model("a.Task", "b.Task"), "Task");
    expect(result.kind === "ambiguous" && result.message).toBe('Entity name "Task" is ambiguous. Did you mean a.Task or b.Task?');
  });
  test("a shortened name that picks one of two same-named entities resolves", () => {
    expect(found(resolveName(clash, "project.Task"))).toBe("work.project.Task");
    expect(found(resolveName(clash, "homework.Task"))).toBe("school.homework.Task");
    expect(found(resolveName(clash, "other.Task"))).toBe("other.Task");
  });
  test("a still-ambiguous shortened name lists only the entities it matches", () => {
    const result = resolveName(model("a.x.Task", "b.x.Task", "c.y.Task"), "x.Task");
    expect(result.kind === "ambiguous" && result.candidates).toEqual(["a.x.Task", "b.x.Task"]);
  });
  test("an exact FQN wins over a longer FQN that ends in it", () => {
    expect(found(resolveName(model("Task", "work.Task"), "Task"))).toBe("Task");
    expect(found(resolveName(model("Task", "work.Task"), "work.Task"))).toBe("work.Task");
  });
  test("an unknown name lists the known FQNs, sorted", () => {
    expect(resolveName(clash, "Nope")).toEqual({
      kind: "unknown",
      known: ["other.Task", "school.homework.Task", "work.Review", "work.project.Task"],
      message: 'Unknown entity "Nope"; known entities: other.Task, school.homework.Task, work.Review, work.project.Task',
    });
  });
  test("an empty model has nothing to pick", () => {
    expect(resolveName(model(), "Task")).toMatchObject({ kind: "unknown", known: [] });
  });
});
