import { afterAll, describe, expect, test } from "bun:test";
import type { Diagnostic, ModelDocument } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { explainAction } from "../src/typescript/explain.ts";
import { loadView } from "../src/typescript/views/load.ts";
import { configOf } from "./generated.ts";
import { closeTypeServer } from "./type-server.ts";

afterAll(closeTypeServer);

/**
 * `has-many :name entity=Far through=Link` (D14, D26): a many-to-many read through a link entity. The owner declares the
 * line, the far entity is what it lists, the link joins the two; the entry is the link's belongs-to to the owner, the
 * exit its belongs-to to the far entity. Every link and far entity declares an auto read, except where a test removes it.
 */
const build = (files: Record<string, string>) =>
  buildModel({ root: "/project", files: Object.entries(files).map(([file, source]) => ({ file: `app/${file}`, source })) });
const entityOf = (result: ReturnType<typeof build>, name: string) => result.document!.entities.find((e) => e.name === name)!;
const brief = (d: Diagnostic) => ({ code: d.code, severity: d.severity, message: d.message, at: `${d.position.file}:${d.position.line}:${d.position.column}`, fix: d.fix });

/** `school`: Student lists Course through Enrollment. The relationship is on line 7 of student.mesh.mx. */
const student = (line = "has-many :courses entity=Course through=Enrollment", extra = "") => `import { Course } from "./course.mesh.mx"
import { Enrollment } from "./enrollment.mesh.mx"
entity :Student
  attributes
    uuid :id primary-key
  relationships
    ${line}${extra}
  actions auto=[:read]
`;
const course = (extra = "", actions = "  actions auto=[:read]\n") => `entity :Course
  attributes
    uuid :id primary-key
    integer :credits
${actions}${extra}`;
const enrollment = (keys = "    belongs-to :student entity=Student\n    belongs-to :course entity=Course\n", tail = "  actions auto=[:read]\n") => `import { Student } from "./student.mesh.mx"
import { Course } from "./course.mesh.mx"
entity :Enrollment
  attributes
    uuid :id primary-key
  relationships
${keys}${tail}`;
const school = (files: { student?: string; course?: string; enrollment?: string } = {}) => build({
  "student.mesh.mx": files.student ?? student(),
  "course.mesh.mx": files.course ?? course(),
  "enrollment.mesh.mx": files.enrollment ?? enrollment(),
});

/** `work`: Task lists Task through Dependency (the spec's own example). The relationship is on line 6 of task.mesh.mx. */
const task = (lines = "has-many :blockers entity=Task through=Dependency inverse=:dependent", extra = "") => `import { Dependency } from "./dependency.mesh.mx"
entity :Task
  attributes
    uuid :id primary-key
  relationships
    ${lines}
  actions auto=[:read]
${extra}`;
const dependency = (keys = "    belongs-to :dependent entity=Task\n    belongs-to :prerequisite entity=Task\n") => `import { Task } from "./task.mesh.mx"
entity :Dependency
  attributes
    uuid :id primary-key
  relationships
${keys}  actions auto=[:read]
`;
const work = (taskSource = task(), dependencySource = dependency()) => build({ "task.mesh.mx": taskSource, "dependency.mesh.mx": dependencySource });

describe("resolution", () => {
  test("the happy path records the link, the exit and the entry", () => {
    const result = school();
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Student").relationships[0]).toEqual({
      kind: "has-many",
      name: "courses",
      entity: { identifier: "Course", from: "./course.mesh.mx" },
      nullable: false,
      inverse: "student",
      through: { entity: { identifier: "Enrollment", from: "./enrollment.mesh.mx" }, exit: "course" },
      position: expect.objectContaining({ line: 7, column: 4 }),
    });
    // The relationship adds no column and changes nothing on the link or the far entity.
    expect(entityOf(result, "Enrollment").relationships.map((r) => r.keyColumn)).toEqual(["studentId", "courseId"]);
  });

  test("through= may be a member of a namespace import", () => {
    const result = school({ student: student("has-many :courses entity=Course through=links.Enrollment").replace('import { Enrollment } from "./enrollment.mesh.mx"', 'import * as links from "./enrollment.mesh.mx"') });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Student").relationships[0]!.through).toEqual({ entity: { identifier: "links.Enrollment", from: "./enrollment.mesh.mx" }, exit: "course" });
  });

  test("of two belongs-to to the owner, the one named after it is the entry", () => {
    const result = school({ enrollment: enrollment("    belongs-to :payer entity=Student\n    belongs-to :student entity=Student\n    belongs-to :course entity=Course\n") });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Student").relationships[0]).toMatchObject({ inverse: "student", through: { exit: "course" } });
  });

  test("an authored inverse= equal to the ladder's pick is accepted", () => {
    const result = school({ student: student("has-many :courses entity=Course through=Enrollment inverse=:student") });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Student").relationships[0]).toMatchObject({ inverse: "student", through: { exit: "course" } });
  });

  test("an authored inverse= names the entry and the exit is still resolved (self-reference)", () => {
    const result = work();
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Task").relationships[0]).toMatchObject({ inverse: "dependent", through: { entity: { identifier: "Dependency" }, exit: "prerequisite" } });
  });

  test("both directions over one link, beside the plain has-many to the link", () => {
    const result = work(task([
      "has-many :blockers entity=Task through=Dependency inverse=:dependent",
      "has-many :blocking entity=Task through=Dependency inverse=:prerequisite",
      "has-many :dependencies entity=Dependency inverse=:dependent",
    ].join("\n    ")));
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Task").relationships.map((r) => [r.name, r.inverse, r.through?.exit])).toEqual([
      ["blockers", "dependent", "prerequisite"],
      ["blocking", "prerequisite", "dependent"],
      ["dependencies", "dependent", undefined],
    ]);
  });

  describe("legal neighbours", () => {
    test("a nullable exit", () => {
      expect(school({ enrollment: enrollment("    belongs-to :student entity=Student\n    belongs-to :course entity=Course nullable\n") }).diagnostics).toEqual([]);
    });
    test("a nullable entry", () => {
      expect(school({ enrollment: enrollment("    belongs-to :student entity=Student nullable\n    belongs-to :course entity=Course\n") }).diagnostics).toEqual([]);
    });
    test("a link with a belongs-to to a third entity", () => {
      const result = build({
        "student.mesh.mx": student(),
        "course.mesh.mx": course(),
        "teacher.mesh.mx": "entity :Teacher\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n",
        "enrollment.mesh.mx": enrollment("    belongs-to :student entity=Student\n    belongs-to :course entity=Course\n    belongs-to :approvedBy entity=Teacher nullable\n")
          .replace("entity :Enrollment", 'import { Teacher } from "./teacher.mesh.mx"\nentity :Enrollment'),
      });
      expect(result.diagnostics).toEqual([]);
    });
    test("the plain has-many to the link by the same entry, beside the through", () => {
      const result = school({ student: student("has-many :courses entity=Course through=Enrollment", "\n    has-many :enrollments entity=Enrollment") });
      expect(result.diagnostics).toEqual([]);
      expect(entityOf(result, "Student").relationships.map((r) => r.inverse)).toEqual(["student", "student"]);
    });
  });
});

describe("the through= value", () => {
  test("an unknown link is MESH_UNKNOWN_ENTITY at the value, and nothing else", () => {
    const result = school({ student: student("has-many :courses entity=Course through=Enrolment") });
    expect(result.diagnostics.map(brief)).toEqual([{ code: "MESH_UNKNOWN_ENTITY", severity: "error", message: "Enrolment is not an imported entity. Did you mean Enrollment?", at: "app/student.mesh.mx:7:44", fix: null }]);
  });

  test("an unknown far entity with a known link is one MESH_UNKNOWN_ENTITY", () => {
    const result = school({ student: student("has-many :courses entity=Corse through=Enrollment") });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MESH_UNKNOWN_ENTITY"]);
  });

  test("a link that is the owner is refused at the value (D26), with no entry or exit error", () => {
    const result = work(task("belongs-to :parent entity=Task nullable\n    has-many :grand entity=Task through=Task inverse=:parent"));
    expect(result.diagnostics.map(brief)).toEqual([{
      code: "MESH_ENTITY_REFERENCE",
      severity: "error",
      message: "has-many :grand of app.Task goes through app.Task itself; the link entity must be a third entity, neither app.Task nor the one it lists",
      at: "app/task.mesh.mx:7:40",
      fix: "Declare a link entity with a belongs-to to each side and name it in through=",
    }]);
  });

  test("a link that is the far entity is refused at the value (D26), with no entry or exit error", () => {
    const result = school({ student: student("has-many :courses entity=Course through=Course") });
    expect(result.diagnostics.map(brief)).toEqual([{
      code: "MESH_ENTITY_REFERENCE",
      severity: "error",
      message: "has-many :courses of app.Student goes through app.Course, the entity it lists; the link entity must be a third entity, neither app.Student nor the one it lists",
      at: "app/student.mesh.mx:7:44",
      fix: "Declare a link entity with a belongs-to to each side and name it in through=",
    }]);
  });
});

describe("the entry", () => {
  test("no belongs-to to the owner is MESH_NO_INVERSE at the relationship, naming the link", () => {
    const result = school({ enrollment: enrollment("    belongs-to :course entity=Course\n") });
    expect(result.diagnostics.map(brief)).toEqual([{
      code: "MESH_NO_INVERSE",
      severity: "error",
      message: "has-many :courses of app.Student goes through app.Enrollment, which has no belongs-to to app.Student: add `belongs-to :student entity=Student` to app.Enrollment",
      at: "app/student.mesh.mx:7:4",
      fix: "Add `belongs-to :student entity=Student` to app.Enrollment",
    }]);
  });

  test("two belongs-to to the owner and none chosen is MESH_INVERSE_REQUIRED; inverse= resolves it", () => {
    const keys = "    belongs-to :learner entity=Student\n    belongs-to :payer entity=Student\n    belongs-to :course entity=Course\n";
    const result = school({ enrollment: enrollment(keys) });
    expect(result.diagnostics.map(brief)).toEqual([{
      code: "MESH_INVERSE_REQUIRED",
      severity: "error",
      message: "has-many :courses of app.Student could enter app.Enrollment by any of its 2 belongs-to to app.Student (:learner, :payer)",
      at: "app/student.mesh.mx:7:4",
      fix: "Choose one: `inverse=:learner`",
    }]);
    const fixed = school({ enrollment: enrollment(keys), student: student("has-many :courses entity=Course through=Enrollment inverse=:learner") });
    expect(fixed.diagnostics).toEqual([]);
    expect(entityOf(fixed, "Student").relationships[0]).toMatchObject({ inverse: "learner", through: { exit: "course" } });
  });

  test("an inverse= that names no belongs-to of the link is MESH_INVERSE_UNKNOWN, and the one exit adds nothing", () => {
    for (const written of ["studnt", "students"]) {
      const result = school({ student: student(`has-many :courses entity=Course through=Enrollment inverse=:${written}`) });
      expect(result.diagnostics.map(brief)).toEqual([{
        code: "MESH_INVERSE_UNKNOWN",
        severity: "error",
        message: `inverse=:${written} names no belongs-to of the link entity app.Enrollment. Did you mean inverse=:student?`,
        at: "app/student.mesh.mx:7:63",
        fix: null,
      }]);
    }
    const listed = school({ student: student("has-many :courses entity=Course through=Enrollment inverse=:zzz") });
    expect(listed.diagnostics.map((d) => d.message)).toEqual(["inverse=:zzz names no belongs-to of the link entity app.Enrollment. The belongs-to from app.Enrollment to app.Student: :student."]);
  });

  test("an inverse= that names the exit is MESH_INVERSE_ENTITY, and the exit is still found", () => {
    const result = school({ student: student("has-many :courses entity=Course through=Enrollment inverse=:course") });
    expect(result.diagnostics.map(brief)).toEqual([{
      code: "MESH_INVERSE_ENTITY",
      severity: "error",
      message: "inverse=:course is a belongs-to of the link entity app.Enrollment that points at app.Course, not at app.Student. The belongs-to from app.Enrollment to app.Student: :student.",
      at: "app/student.mesh.mx:7:63",
      fix: null,
    }]);
  });

  test("an inverse= that names a member of the far entity is a member of no link belongs-to", () => {
    const result = school({ student: student("has-many :courses entity=Course through=Enrollment inverse=:credits") });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MESH_INVERSE_UNKNOWN"]);
  });
});

describe("the exit", () => {
  test("no belongs-to to the far entity is MESH_NO_INVERSE at the through= value", () => {
    const result = school({ enrollment: enrollment("    belongs-to :student entity=Student\n") });
    expect(result.diagnostics.map(brief)).toEqual([{
      code: "MESH_NO_INVERSE",
      severity: "error",
      message: "has-many :courses of app.Student goes through app.Enrollment, which has no belongs-to to app.Course: add `belongs-to :course entity=Course` to app.Enrollment",
      at: "app/student.mesh.mx:7:44",
      fix: "Add `belongs-to :course entity=Course` to app.Enrollment",
    }]);
  });

  test("a link with neither key gives exactly two errors, the entry's and the exit's", () => {
    const result = school({ enrollment: enrollment("") });
    expect(result.diagnostics.map((d) => [d.code, `${d.position.line}:${d.position.column}`])).toEqual([["MESH_NO_INVERSE", "7:4"], ["MESH_NO_INVERSE", "7:44"]]);
  });

  test("two belongs-to to the far entity is MESH_INVERSE_REQUIRED at the through= value, which no option resolves", () => {
    const result = school({ enrollment: enrollment("    belongs-to :student entity=Student\n    belongs-to :course entity=Course\n    belongs-to :audited entity=Course nullable\n") });
    expect(result.diagnostics.map(brief)).toEqual([{
      code: "MESH_INVERSE_REQUIRED",
      severity: "error",
      message: "has-many :courses of app.Student leaves app.Enrollment by its one belongs-to to app.Course, and app.Enrollment has 2 (:course, :audited); the exit must be the only one",
      at: "app/student.mesh.mx:7:44",
      fix: "Keep one belongs-to from app.Enrollment to app.Course, or give the second its own link entity",
    }]);
  });

  test("a link belongs-to whose entity is unknown gives only that line's error", () => {
    const result = school({ enrollment: enrollment("    belongs-to :student entity=Student\n    belongs-to :course entity=Corse\n") });
    expect(result.diagnostics.map((d) => [d.code, d.position.file])).toEqual([["MESH_UNKNOWN_ENTITY", "app/enrollment.mesh.mx"]]);
  });

  describe("self-reference", () => {
    test("no inverse= gives only the entry's MESH_INVERSE_REQUIRED", () => {
      const result = work(task("has-many :blockers entity=Task through=Dependency"));
      expect(result.diagnostics.map(brief)).toEqual([{
        code: "MESH_INVERSE_REQUIRED",
        severity: "error",
        message: "has-many :blockers of app.Task could enter app.Dependency by any of its 2 belongs-to to app.Task (:dependent, :prerequisite)",
        at: "app/task.mesh.mx:6:4",
        fix: "Choose one: `inverse=:dependent`",
      }]);
    });

    test("an inverse= naming no belongs-to gives only the entry's error", () => {
      const result = work(task("has-many :blockers entity=Task through=Dependency inverse=:dependant"));
      expect(result.diagnostics.map((d) => d.code)).toEqual(["MESH_INVERSE_UNKNOWN"]);
    });

    test("three belongs-to to Task: the exit is ambiguous, other than the entry", () => {
      const result = work(task(), dependency("    belongs-to :dependent entity=Task\n    belongs-to :prerequisite entity=Task\n    belongs-to :duplicateOf entity=Task nullable\n"));
      expect(result.diagnostics.map(brief)).toEqual([{
        code: "MESH_INVERSE_REQUIRED",
        severity: "error",
        message: "has-many :blockers of app.Task leaves app.Dependency by its one belongs-to to app.Task other than :dependent, and app.Dependency has 2 (:prerequisite, :duplicateOf); the exit must be the only one",
        at: "app/task.mesh.mx:6:43",
        fix: "Keep one belongs-to from app.Dependency to app.Task, or give the second its own link entity",
      }]);
    });

    test("one belongs-to to Task, the entry: no exit, and the line to add is not a second :task", () => {
      const result = work(task("has-many :blockers entity=Task through=Dependency inverse=:task"), dependency("    belongs-to :task entity=Task\n"));
      expect(result.diagnostics.map(brief)).toEqual([{
        code: "MESH_NO_INVERSE",
        severity: "error",
        message: "has-many :blockers of app.Task goes through app.Dependency, which has no belongs-to to app.Task other than :task: add `belongs-to :task2 entity=Task` to app.Dependency",
        at: "app/task.mesh.mx:6:43",
        fix: "Add `belongs-to :task2 entity=Task` to app.Dependency",
      }]);
    });

    test("one belongs-to to Task, named otherwise: the suggestion is :task", () => {
      const result = work(task(), dependency("    belongs-to :dependent entity=Task\n"));
      expect(result.diagnostics.map((d) => d.fix)).toEqual(["Add `belongs-to :task entity=Task` to app.Dependency"]);
    });
  });
});

describe("MESH_HAS_ONE_SHARED_KEY", () => {
  test("a has-one to the link by the entry is refused at the has-one, with the through form", () => {
    const result = school({ student: student("has-many :courses entity=Course through=Enrollment", "\n    has-one :enrollment entity=Enrollment") });
    expect(result.diagnostics.map(brief)).toEqual([{
      code: "MESH_HAS_ONE_SHARED_KEY",
      severity: "error",
      message: "has-one :enrollment of app.Student follows belongs-to :student of app.Enrollment, and has-many :courses enters app.Enrollment by it too: a has-one is at most one row for that key, so the two cannot share it",
      at: "app/student.mesh.mx:8:4",
      fix: "Replace the has-one with `has-many :enrollments entity=Enrollment` and take the one row from its list, or give has-many :courses its own belongs-to on app.Enrollment with `inverse=`",
    }]);
  });

  test("a has-one to the far entity follows a different key and is not compared with the entry", () => {
    const result = school({
      student: student("has-many :courses entity=Course through=Enrollment", "\n    has-one :favourite entity=Course"),
      course: course("  relationships\n    belongs-to :student entity=Student nullable\n").replace("entity :Course", 'import { Student } from "./student.mesh.mx"\nentity :Course'),
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("the plain form keeps its text and its fix", () => {
    const result = school({ student: student("has-many :enrollments entity=Enrollment", "\n    has-one :enrollment entity=Enrollment") });
    expect(result.diagnostics.map((d) => [d.code, d.fix])).toEqual([["MESH_HAS_ONE_SHARED_KEY", "Keep the has-many and take the one row from its list, or give the has-many its own belongs-to with `inverse=`"]]);
    expect(result.diagnostics[0]!.message).toContain("and has-many :enrollments follows it too");
  });
});

describe("rollups and bodies", () => {
  const computed = (lines: string) => student("has-many :courses entity=Course through=Enrollment", "").replace("  actions", `  computed\n    ${lines}\n  actions`);
  test("a count or max over a through relationship waits for M10", () => {
    for (const [line, fn, name] of [["count :courseCount of=&courses", "count", "courseCount"], ["max :most of=&courses.credits", "max", "most"]] as const) {
      const result = school({ student: computed(line) });
      expect(result.diagnostics.map(brief)).toEqual([{
        code: "MESH_NOT_IMPLEMENTED",
        severity: "error",
        message: `${fn} :${name} goes through a link entity (has-many :courses through=Enrollment), which needs a join; joins arrive with the SQL evaluator (M10). Only a ${fn} over one has-many or has-one runs before then`,
        at: "app/student.mesh.mx:9:4",
        fix: null,
      }]);
    }
  });

  test("sum keeps its own message", () => {
    const result = school({ student: computed("sum :total of=&courses.credits") });
    expect(result.diagnostics.map((d) => d.message)).toEqual(["sum rollups are not implemented yet: only count and max run before Mesh 1.0; sum, avg and min come after it"]);
  });

  test("a body reads the list of far records, and needs the relationship alone", () => {
    const result = school({ student: computed("integer :courseCount() { return &courses.length }\n    integer :heavy() { return &courses.filter((c) => c.credits > 5).length }") });
    expect(result.diagnostics).toEqual([]);
    expect(entityOf(result, "Student").computed.map((c) => c.needs)).toEqual([["courses"], ["courses"]]);
  });

  test("a body that reads a through with no entry chosen adds the use error, naming the link", () => {
    const result = work(task("has-many :blockers entity=Task through=Dependency", "  computed\n    integer :blockerCount() { return &blockers.length }\n"));
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MESH_INVERSE_REQUIRED", "MESH_INVERSE_REQUIRED"]);
    expect(result.diagnostics[1]!.message).toContain("app.Dependency has 2 belongs-to back to app.Task (:dependent, :prerequisite) and has-many :blockers does not say which it follows");
  });
});

describe("policies and on:load", () => {
  const writers = "  policies\n    policy :writers types=[:create]\n      authorize-if=() => true\n";
  test("a link whose policies cover no read warns at the relationship", () => {
    const result = school({ enrollment: enrollment(undefined, `  actions auto=[:read, :create]\n${writers}`) });
    expect(result.diagnostics.map(brief)).toEqual([{
      code: "MESH_LOAD_NO_POLICY",
      severity: "warning",
      message: "has-many :courses of app.Student goes through app.Enrollment, and no policy of app.Enrollment covers the read a load runs, so every caller's load of it is [] (through `Mesh.privileged` and in a computed field's body it is loaded)",
      at: "app/student.mesh.mx:7:4",
      fix: "If callers may load it, give app.Enrollment a policy that covers its read: `types=[:read]`, `actions=[&read]` or no scope",
    }]);
  });

  test("a far entity whose policies cover no read warns with no word of rollups", () => {
    const result = school({ course: course(writers, "  actions auto=[:read, :create]\n") });
    // Enrollment's own belongs-to :course draws its own (plain) warning at its line.
    expect(result.diagnostics.filter((d) => d.position.file === "app/student.mesh.mx").map((d) => [d.code, d.message])).toEqual([["MESH_LOAD_NO_POLICY",
      "has-many :courses of app.Student reaches app.Course, and no policy of app.Course covers the read a load runs, so every caller's load of it is [] (through `Mesh.privileged` and in a computed field's body it is loaded)"]]);
  });

  test("a link or far entity with no policy at all draws no warning (deny by default)", () => {
    expect(school().diagnostics).toEqual([]);
  });

  test("a plain relationship keeps its warning text", () => {
    const result = school({ student: student("has-many :enrollments entity=Enrollment"), enrollment: enrollment(undefined, `  actions auto=[:read, :create]\n${writers}`) });
    expect(result.diagnostics.map((d) => d.message)).toEqual([expect.stringContaining("is [], a count over it 0 and any other rollup null")]);
  });

  test("a link read policy that reads the record waits for M10, as for any entity a relationship reaches", () => {
    const result = school({ enrollment: enrollment(undefined, "  actions auto=[:read]\n  policies\n    policy :own types=[:read]\n      authorize-if=({ actor }) => &student.id === actor.id\n") });
    expect(result.diagnostics.map((d) => [d.code, d.position.file])).toEqual([["MESH_NOT_IMPLEMENTED", "app/enrollment.mesh.mx"]]);
    expect(result.diagnostics[0]!.message).toContain("policy :own authorize-if reads the record");
  });

  test("a link with no read is MESH_ON_LOAD at the through= value", () => {
    const result = school({ enrollment: enrollment(undefined, "  actions auto=[:create]\n") });
    expect(result.diagnostics.map(brief)).toEqual([
      // Its own belongs-to reach Student and Course, which have reads; the link is reached by the through alone.
      {
        code: "MESH_ON_LOAD",
        severity: "error",
        message: "has-many :courses of app.Student goes through app.Enrollment, which has neither `on:load=` nor an auto read, so Mesh has no read to load it with",
        at: "app/student.mesh.mx:7:44",
        fix: "List `:read` in `auto=` on the `actions` line of app.Enrollment (`actions auto=[:read]`), or name one of its reads there with `on:load=&name`",
      },
    ]);
  });

  test("a far entity with no read is MESH_ON_LOAD at the relationship; both missing give both", () => {
    // Enrollment's own belongs-to :course reaches Course too, and is refused at its own line.
    const atStudent = (result: ReturnType<typeof school>) =>
      result.diagnostics.filter((d) => d.position.file === "app/student.mesh.mx").map((d) => [d.code, `${d.position.line}:${d.position.column}`]);
    const far = school({ course: course("", "  actions auto=[:create]\n") });
    expect(atStudent(far)).toEqual([["MESH_ON_LOAD", "7:4"]]);
    const both = school({ course: course("", "  actions auto=[:create]\n"), enrollment: enrollment(undefined, "  actions auto=[:create]\n") });
    expect(atStudent(both).sort()).toEqual([["MESH_ON_LOAD", "7:4"], ["MESH_ON_LOAD", "7:44"]]);
  });

  test("a link with on:load= naming a read and no auto read is clean", () => {
    const result = school({ enrollment: enrollment(undefined, "  actions on:load=&listed\n    read :listed\n") });
    expect(result.diagnostics).toEqual([]);
  });

  test("explain says the link's read policies run, only where the entity has a through", () => {
    const anyone = "  policies\n    policy :anyone\n      authorize-if=() => true\n";
    const result = school({
      student: student("has-many :courses entity=Course through=Enrollment", "\n    has-many :enrollments entity=Enrollment") + anyone,
      enrollment: enrollment(undefined, `  actions auto=[:read]\n${anyone}`),
    });
    expect(result.diagnostics).toEqual([]);
    const policyLine = (name: string) => explainAction(entityOf(result, name), "read")!.find((line) => line.includes("what the caller loads"));
    expect(policyLine("Student")).toContain("runs the read policies of the entity it reaches, and of the link entity of a `through=`: ");
    expect(policyLine("Enrollment")).toContain("runs the read policies of the entity it reaches: ");
  });
});

describe("the load plan", () => {
  const config = configOf("/project", "generated");
  const relations = (document: ModelDocument, name: string) =>
    loadView({ document, config }, "generated/load.ts").entities.find((entity) => entity.nameLiteral === JSON.stringify(`app.${name}`))!.relations;

  test("column is the entry's key on the link, and through names the link and the exit's key column", () => {
    const result = school({ student: student("has-many :courses entity=Course through=Enrollment", "\n    has-many :enrollments entity=Enrollment") });
    expect(relations(result.document!, "Student")).toEqual([
      { key: "courses", plan: '{ kind: "has-many", target: "app.Course", column: "studentId", through: { target: "app.Enrollment", exit: "courseId" } }' },
      { key: "enrollments", plan: '{ kind: "has-many", target: "app.Enrollment", column: "studentId" }' },
    ]);
  });

  test("both directions of a self-reference", () => {
    const result = work(task("has-many :blockers entity=Task through=Dependency inverse=:dependent\n    has-many :blocking entity=Task through=Dependency inverse=:prerequisite"));
    expect(relations(result.document!, "Task")).toEqual([
      { key: "blockers", plan: '{ kind: "has-many", target: "app.Task", column: "dependentId", through: { target: "app.Dependency", exit: "prerequisiteId" } }' },
      { key: "blocking", plan: '{ kind: "has-many", target: "app.Task", column: "prerequisiteId", through: { target: "app.Dependency", exit: "dependentId" } }' },
    ]);
  });

  test("a model whose exit is absent prints exit: null, which the loader refuses", () => {
    const document = structuredClone(school().document!);
    delete document.entities.find((e) => e.name === "Student")!.relationships[0]!.through!.exit;
    expect(relations(document, "Student")[0]!.plan).toBe('{ kind: "has-many", target: "app.Course", column: "studentId", through: { target: "app.Enrollment", exit: null } }');
  });
});

describe("the contract", () => {
  const withLine = (line: string) => school({ student: student(line) });
  const only = (result: ReturnType<typeof school>) => result.diagnostics.map((d) => [d.code, `${d.position.line}:${d.position.column}`, d.message]);
  test("a value that is no reference is MESH_ENTITY_REFERENCE at the option", () => {
    for (const value of [":Enrollment", "getLink()", "[Enrollment]"])
      expect(only(withLine(`has-many :courses entity=Course through=${value}`))).toEqual([["MESH_ENTITY_REFERENCE", "7:36",
        "`has-many`: through must be an imported identifier (`List`) or a member of a namespace import (`billing.Invoice`)"]]);
  });
  test("a wrapped reference is MESH_ENTITY_REFERENCE at the value", () => {
    for (const value of ["(Enrollment)", "Enrollment!", "Enrollment as X"])
      expect(only(withLine(`has-many :courses entity=Course through=${value}`))).toEqual([["MESH_ENTITY_REFERENCE", "7:44",
        "`has-many`: through must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`through=List`, `through=billing.Invoice`)"]]);
  });
  test("a string or a bare through is MX's MESH_OPTION_VALUE", () => {
    for (const value of ['through="Enrollment"', "through"])
      expect(withLine(`has-many :courses entity=Course ${value}`).diagnostics.map((d) => d.code)).toEqual(["MESH_OPTION_VALUE"]);
  });
  test("through= on a has-one or a belongs-to stays an unknown option", () => {
    expect(withLine("has-one :course entity=Course through=Enrollment").diagnostics.map((d) => d.code)).toEqual(["MESH_UNKNOWN_OPTION"]);
    expect(withLine("belongs-to :course entity=Course through=Enrollment").diagnostics.map((d) => d.code)).toEqual(["MESH_UNKNOWN_OPTION"]);
  });
  test("the entity= messages keep their exact text", () => {
    expect(only(withLine("has-many :courses entity=getCourse()"))).toEqual([["MESH_ENTITY_REFERENCE", "7:22",
      "`has-many`: entity must be an imported identifier (`List`) or a member of a namespace import (`billing.Invoice`)"]]);
    expect(only(withLine("has-many :courses entity=(Course)"))).toEqual([["MESH_ENTITY_REFERENCE", "7:29",
      "`has-many`: entity must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`entity=List`, `entity=billing.Invoice`)"]]);
  });
});
