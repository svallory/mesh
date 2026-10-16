// A check's `message=` as a function: the function takes the arguments `that=` gets, runs only for a failed
// check that `when=` did not skip, and the issue carries its text. One that throws or returns anything but a string is
// a `FrameworkError` naming the entity, the check and its line.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { callsOf } from "./calls.ts";
import { openPolicies } from "./open-policy.ts";
import build from "../src/build.ts";
import { FrameworkError, InvalidInputError, type Issue } from "@meshfw/runtime";
import { createSchema, sqlite } from "../src/index.ts";

const owner = `import { Note } from "./note.mesh.mx"
entity :Owner table="owners"
  attributes
    uuid :id primary-key
    string :name
  relationships
    has-many :notes entity=Note inverse=:owner
  actions auto=[:read]
`;

const note = `import { Owner } from "./owner.mesh.mx"
entity :Note table="notes"
  attributes
    uuid :id primary-key
    string :title
    integer :qty default=1
  relationships
    belongs-to :owner entity=Owner
  actions auto=[:read]
    update :probe
      input
        &qty
      validate
        check :fixed [
          that=() => false
          code="fixed"
          message="fixed text"
        ]
        check :fromSelf [
          that=() => false
          code="from-self"
          message=({ self }) => "the note is " + self.title
        ]
        check :fromInput [
          that=() => false
          code="from-input"
          message=({ input }) => "qty is " + input.qty
        ]
        check :fromRelation [
          that=() => false
          code="from-relation"
          message=() => "owned by " + &owner.name
        ]
        check :awaited [
          that=() => false
          code="awaited"
          message=async ({ self }) => await Promise.resolve("awaited " + self.title)
        ]
        check :skipped [
          that=() => false
          when=({ input }) => input.qty < 0
          code="skipped"
          message=() => { throw new Error("a skipped check never computes its message") }
        ]
        check :passes [
          that=() => true
          code="passes"
          message=() => { throw new Error("a passing check never computes its message") }
        ]
        check :whenTrue [
          that=() => false
          when=({ input }) => input.qty > 100
          code="when-true"
          message=({ input }) => "big qty " + input.qty
        ]
    update :throws
      validate
        check :explodes [
          that=() => false
          code="explodes"
          message=() => { throw new Error("no luck") }
        ]
    update :number
      validate
        check :notText [
          that=() => false
          code="not-text"
          message=() => 42
        ]
    update :nothing
      validate
        check :unknownText [
          that=({ self }) => self.title === "x"
          code="unknown-text"
          message=({ self }) => self.title === "never" ? "x" : undefined
        ]
    update :nullable
      validate
        check :missing [
          that=() => false
          code="missing"
          message=() => &owner.name === "never" ? "x" : null
        ]
`;

const SQLITE: ResolvedConfig["data"] = {
  kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build",
  capabilities: { adapter: "sqlite", capabilities: ["aggregates", "integer-key-fill"] }, options: { file: ":memory:" },
};
let dir: string;
let app: any;
let domain: object;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".message-function-"));
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data: SQLITE };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies([{ file: "src/domain/owner.mesh.mx", source: owner }, { file: "src/domain/note.mesh.mx", source: note }]) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  app = await import(join(dir, ".mesh/index.ts"));
  domain = await import(join(dir, ".mesh/domain/index.ts"));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const ownerId = "018f0000-0000-7000-8000-0000000000a1";
const noteId = "018f0000-0000-7000-8000-0000000000b1";
async function world() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  await db.transaction(async (tx: any) => {
    await tx.insert(app.tables.owners, { id: ownerId, name: "Ada" });
    await tx.insert(app.tables.notes, { id: noteId, title: "groceries", qty: 1, ownerId });
  });
  return callsOf(app.bind(db, {}), domain);
}
const fail = async (call: Promise<unknown>): Promise<any> => call.then(() => { throw new Error("expected the call to fail"); }, (error: unknown) => error);
const messages = (error: unknown): Record<string, string> => {
  expect(error).toBeInstanceOf(InvalidInputError);
  return Object.fromEntries((error as InvalidInputError).issues.map((issue: Issue) => [issue.code, issue.message]));
};

describe("a check's message as a function", () => {
  test("text keeps working; a function reads self, input, a loaded relation and may be async", async () => {
    const mesh = await world();
    const found = messages(await fail(mesh.probeNote({ id: noteId, qty: 3 }, {})));
    expect(found.fixed).toBe("fixed text");
    expect(found["from-self"]).toBe("the note is groceries");
    expect(found["from-input"]).toBe("qty is 3");
    expect(found["from-relation"]).toBe("owned by Ada");
    expect(found.awaited).toBe("awaited groceries");
  });

  test("a check that passes or that `when` skips never computes its message", async () => {
    const mesh = await world();
    const found = messages(await fail(mesh.probeNote({ id: noteId, qty: 3 }, {})));
    expect(Object.keys(found)).not.toContain("passes");
    expect(Object.keys(found)).not.toContain("skipped");
    expect(Object.keys(found)).not.toContain("when-true");
  });

  test("`when` true runs the check and its message function", async () => {
    const mesh = await world();
    const found = messages(await fail(mesh.probeNote({ id: noteId, qty: 101 }, {})));
    expect(found["when-true"]).toBe("big qty 101");
    expect(found.skipped).toBeUndefined();
  });

  test("the issue keeps its label, code and the source line of the check", async () => {
    const mesh = await world();
    const error = await fail(mesh.probeNote({ id: noteId, qty: 3 }, {}));
    const issue = error.issues.find((each: Issue) => each.code === "from-self");
    expect(issue).toMatchObject({ label: "fromSelf", message: "the note is groceries", path: [], details: null });
    expect(issue.source.file).toBe("src/domain/note.mesh.mx");
    expect(typeof issue.source.line).toBe("number");
  });

  test("a function that throws is a FrameworkError naming the entity, the check and the line; it is not swallowed", async () => {
    const mesh = await world();
    const error = await fail(mesh.throwsNote({ id: noteId }, {}));
    expect(error).toBeInstanceOf(FrameworkError);
    expect(error).not.toBeInstanceOf(InvalidInputError);
    expect(error.message).toContain("Note");
    expect(error.message).toContain(":explodes");
    expect(error.message).toMatch(/note\.mesh\.mx:\d+/);
    expect(error.message).toContain("no luck");
    expect((error.cause as Error).message).toBe("no luck");
  });

  test("a result that is not a string is a FrameworkError: a number, undefined and null all refuse", async () => {
    const mesh = await world();
    const number = await fail(mesh.numberNote({ id: noteId }, {}));
    expect(number).toBeInstanceOf(FrameworkError);
    expect(number.message).toContain(":notText");
    expect(number.message).toContain("must return a string");
    expect(number.message).toContain("number");
    const nothing = await fail(mesh.nothingNote({ id: noteId }, {}));
    expect(nothing).toBeInstanceOf(FrameworkError);
    expect(nothing.message).toContain(":unknownText");
    expect(nothing.message).toContain("undefined");
    const nullable = await fail(mesh.nullableNote({ id: noteId }, {}));
    expect(nullable).toBeInstanceOf(FrameworkError);
    expect(nullable.message).toContain(":missing");
    expect(nullable.message).toContain("null");
  });
});
