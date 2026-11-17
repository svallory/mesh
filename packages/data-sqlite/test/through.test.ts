// A has-many through a link entity (D14, D26), end to end: the domain is built, generated, pushed to SQLite, type-checked
// under the strictest flags and loaded through the generated functions, the entity values and `Mesh.privileged`.
// `Student` lists `Course` through `Enrollment`; `Task` lists `Task` through `Dependency`, with integer keys.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { FrameworkError, InvalidInputError, Mesh, type DataOperations } from "@meshfw/runtime";
import build from "../src/build.ts";
import { callsOf } from "./calls.ts";
import { createSchema, sqlite } from "../src/index.ts";

const open = "  policies\n    policy :anyone\n      authorize-if=() => true\n";
const student = `import { Course } from "./course.mesh.mx"
import { Enrollment } from "./enrollment.mesh.mx"
entity :Student table="students"
  attributes
    uuid :id primary-key
    string :name
  relationships
    has-many :courses entity=Course through=Enrollment
    has-many :enrollments entity=Enrollment
  computed
    integer :courseCount() { return &courses.length }
  actions auto=[:read]
    always types=[:create, :update]
      validate
        check :noBanned that=() => !&courses.some((c) => c.title === "banned") code="banned" message="a banned course"
    create :enrol
      input
        &name
    update :rename
      input
        &name
      validate
        check :fewCourses that=() => &courses.length < 3 code="too_many" message="too many courses"
    update :show
      do
        load=[&courses]
${open}`;
// Each of the link and the far entity admits an actor whose id names it: "L" the link, "C" the course.
const course = `entity :Course table="courses"
  attributes
    uuid :id primary-key
    string :title
  actions auto=[:read]
  policies
    policy :courses types=[:read]
      authorize-if=({ actor }) => actor.id === "LC" || actor.id === "C"
`;
const enrollment = `import { Student } from "./student.mesh.mx"
import { Course } from "./course.mesh.mx"
entity :Enrollment table="enrollments"
  attributes
    uuid :id primary-key
  relationships
    belongs-to :student entity=Student
    belongs-to :course entity=Course nullable
  actions auto=[:read]
  policies
    policy :links types=[:read]
      authorize-if=({ actor }) => actor.id === "LC" || actor.id === "L"
`;
const task = `import { Dependency } from "./dependency.mesh.mx"
entity :Task table="tasks"
  attributes
    integer :id primary-key
    boolean :done default=false
  relationships
    has-many :blockers entity=Task through=Dependency inverse=:dependent
    has-many :blocking entity=Task through=Dependency inverse=:prerequisite
  computed
    boolean :blocked() { return &blockers.some((t) => !t.done) }
    boolean :deeplyBlocked() { return &blockers.some((t) => t.blockers.some((u) => !u.done)) }
  actions auto=[:read]
${open}`;
const dependency = `import { Task } from "./task.mesh.mx"
entity :Dependency table="dependencies"
  attributes
    integer :id primary-key
  relationships
    belongs-to :dependent entity=Task
    belongs-to :prerequisite entity=Task
  actions auto=[:read]
${open}`;

const SQLITE: ResolvedConfig["data"] = {
  kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build",
  capabilities: { adapter: "sqlite", capabilities: ["aggregates", "integer-key-fill"] }, options: { file: ":memory:" },
};

let dir: string;
let app: any;
let domain: any;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".scratch-through-"));
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data: SQLITE };
  const sources = { student, course, enrollment, task, dependency };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: Object.entries(sources).map(([name, source]) => ({ file: `src/domain/${name}.mesh.mx`, source })) });
  expect(built.diagnostics).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  await Bun.write(join(dir, "context.ts"), 'import "@meshfw/runtime";\ndeclare module "@meshfw/runtime" {\n  interface ActionContext {\n    actor: { id: string };\n  }\n}\nexport {};\n');
  app = await import(join(dir, ".mesh/index.ts"));
  domain = await import(join(dir, ".mesh/domain/index.ts"));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const as = (actor: string) => ({ actor: { id: actor } });

async function fresh() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  return { db, mesh: callsOf(app.bind(db), domain) };
}

/** s1 is enrolled in c13, c11, c13 again, nothing and c12, in that order of insertion; s2 in c12; s3 in nothing. */
async function school(tx: DataOperations) {
  const t = app.tables;
  for (const n of [1, 2, 3]) await tx.insert(t.students, { id: id(n), name: `s${n}` });
  for (const n of [13, 11, 12, 14]) await tx.insert(t.courses, { id: id(n), title: `c${n}` });
  const links: [number, number | null][] = [[1, 13], [1, 11], [1, 13], [1, null], [1, 12], [2, 12]];
  for (const [index, [s, c]] of links.entries()) await tx.insert(t.enrollments, { id: id(100 + index), studentId: id(s), courseId: c === null ? null : id(c) });
}

/** Counts the reads a transaction makes, by table name. */
function counted(tx: DataOperations) {
  const calls: string[] = [];
  const names = new Map(Object.entries(app.tables).map(([name, table]) => [table, name]));
  return {
    calls,
    tx: { ...tx, select: (async (table: object, query?: object) => { calls.push(String(names.get(table))); return tx.select(table as never, query as never); }) as never } as DataOperations,
  };
}

const titles = (list: unknown) => (list as { title: string }[]).map((course) => course.title);

describe("loading", () => {
  test("each course once, in key order, a null exit left out, with two queries", async () => {
    const { db } = await fresh();
    try {
      await db.transaction(async (tx) => {
        await school(tx);
        const { tx: watched, calls } = counted(tx);
        const students = await tx.select(app.tables.students, { sort: ["id"] });
        const loaded = await domain.loadStudentFields(watched, students, ["courses", "enrollments", "courseCount"]);
        expect(loaded.map((s: any) => [s.name, titles(s.courses), s.enrollments.length, s.courseCount])).toEqual([
          ["s1", ["c11", "c12", "c13"], 5, 3],
          ["s2", ["c12"], 1, 1],
          ["s3", [], 0, 0],
        ]);
        // A course two students take is one row, the same object in both lists.
        expect(loaded[0].courses[1]).toBe(loaded[1].courses[0]);
        // The link rows and then the courses for `courses`; the link rows again for `enrollments`.
        expect(calls).toEqual(["enrollments", "courses", "enrollments"]);
      });
    } finally { await db.close(); }
  });

  test("integer keys load in numeric order, in both directions; nested needs load level by level", async () => {
    const { db } = await fresh();
    try {
      await db.transaction(async (tx) => {
        for (const [n, done] of [[2, true], [7, false], [10, true], [100, false]] as const) await tx.insert(app.tables.tasks, { id: n, done });
        // 100 waits on 10 and 2; 10 waits on 7 and 2; 2 waits on itself.
        for (const [index, [dependentId, prerequisiteId]] of [[100, 10], [100, 2], [10, 7], [10, 2], [2, 2]].entries())
          await tx.insert(app.tables.dependencies, { id: index + 1, dependentId, prerequisiteId });
        const tasks = await tx.select(app.tables.tasks, { sort: ["id"] });
        const loaded = await domain.loadTaskFields(tx, tasks, ["blockers", "blocking", "blocked", "deeplyBlocked"]);
        const ids = (list: { id: number }[]) => list.map((row) => row.id);
        expect(loaded.map((t: any) => [t.id, ids(t.blockers), ids(t.blocking), t.blocked, t.deeplyBlocked])).toEqual([
          [2, [2], [2, 10, 100], false, false],
          [7, [], [10], false, false],
          [10, [2, 7], [100], true, false],
          [100, [2, 10], [], false, true],
        ]);
      });
    } finally { await db.close(); }
  });

  test("a link row whose course does not exist is an error naming the row", async () => {
    const { db } = await fresh();
    try {
      await db.transaction(async (tx) => {
        await tx.insert(app.tables.students, { id: id(1), name: "s1" });
        await tx.insert(app.tables.enrollments, { id: id(100), studentId: id(1), courseId: id(99) });
        const students = await tx.select(app.tables.students);
        const failed = await domain.loadStudentFields(tx, students, ["courses"]).catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(FrameworkError);
        expect((failed as Error).message).toBe(`has-many :courses of Student goes through a row of Enrollment that points at Course "${id(99)}", which does not exist`);
      });
    } finally { await db.close(); }
  });
});

describe("checks read the list", () => {
  test("on update a check sees the student's courses; on create it sees []", async () => {
    const { db, mesh } = await fresh();
    try {
      await db.transaction(school);
      await db.transaction(async (tx) => { await tx.insert(app.tables.courses, { id: id(20), title: "banned" }); });
      // s1 has three courses: the action's own check refuses; s2 has one and passes.
      const tooMany = await mesh.renameStudent({ id: id(1), name: "x" }, as("LC")).catch((error: unknown) => error);
      expect(tooMany).toBeInstanceOf(InvalidInputError);
      expect(JSON.stringify(tooMany)).toContain("too_many");
      expect(await mesh.renameStudent({ id: id(2), name: "y" }, as("LC"))).toMatchObject({ name: "y" });
      // The always block's check, on update: s2 now takes the banned course.
      await db.transaction(async (tx) => { await tx.insert(app.tables.enrollments, { id: id(120), studentId: id(2), courseId: id(20) }); });
      const banned = await mesh.renameStudent({ id: id(2), name: "z" }, as("LC")).catch((error: unknown) => error);
      expect(JSON.stringify(banned)).toContain("banned");
      // On create the new student has no key in any link row: the list is [] and the checks pass.
      expect(await mesh.enrolStudent({ name: "new" }, as("LC"))).toMatchObject({ name: "new" });
    } finally { await db.close(); }
  });
});

describe("read policies", () => {
  test("a caller's load needs the link's and the course's read policies both; privileged loads everything", async () => {
    const { db, mesh } = await fresh();
    try {
      await db.transaction(school);
      for (const [actor, expected] of [["LC", ["c11", "c12", "c13"]], ["L", []], ["C", []], ["", []]] as const) {
        const [s1] = await mesh.readStudent({ filter: { id: { eq: id(1) } }, load: ["courses", "courseCount"] }, as(actor));
        // The computed body is the entity's own rule: it counts every course whatever the caller.
        expect([actor, titles(s1.courses), s1.courseCount]).toEqual([actor, expected, 3]);
      }
      const all = await mesh.run(() => (Mesh.privileged(domain.Student as never) as any).read({ filter: { id: { eq: id(1) } }, load: ["courses"] }));
      expect(titles(all[0].courses)).toEqual(["c11", "c12", "c13"]);
    } finally { await db.close(); }
  });

  test("a write's load step under a caller the link's policies deny gives []", async () => {
    const { db, mesh } = await fresh();
    try {
      await db.transaction(school);
      expect(titles((await mesh.showStudent({ id: id(1) }, as("C"))).courses)).toEqual([]);
      expect(titles((await mesh.showStudent({ id: id(1) }, as("LC"))).courses)).toEqual(["c11", "c12", "c13"]);
    } finally { await db.close(); }
  });
});

describe("the generated files", () => {
  test("type-check under the strictest flags; the list is typed as the far records, and only once it is loaded", async () => {
    await Bun.write(join(dir, "check-through.ts"), [
      'import { Mesh } from "@meshfw/runtime";',
      'import { Student, type Course } from "./.mesh/domain/index.ts";',
      "const context = { actor: { id: 'a' } };",
      "export async function calls(): Promise<number> {",
      "  const [loaded] = await Student.read({ load: ['courses'] }, context);",
      "  const courses: readonly Course[] = loaded!.courses;",
      "  const title: string | undefined = loaded!.courses[0]?.title;",
      "  const [bare] = await Student.read({}, context);",
      "  // @ts-expect-error not loaded",
      "  void bare!.courses;",
      "  const [privileged] = await Mesh.privileged(Student).read({ load: ['courses'] });",
      "  const all: readonly Course[] = privileged!.courses;",
      "  void title;",
      "  return courses.length + all.length;",
      "}",
      "",
    ].join("\n"));
    const files = (await readdir(join(dir, ".mesh"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join(".mesh", name));
    const child = Bun.spawnSync([
      resolve(import.meta.dir, "../../../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess",
      "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--noUnusedLocals", "--noUnusedParameters",
      "--exactOptionalPropertyTypes", "--verbatimModuleSyntax", "--isolatedModules", "--allowImportingTsExtensions", "mesh.config.ts", "context.ts", "check-through.ts", ...files,
    ], { cwd: dir });
    expect(child.stdout.toString() + child.stderr.toString()).toBe("");
  }, 60_000);
});
