import { describe, expect, test } from "bun:test";
import {
  ATTRIBUTE_TYPES,
  findNonJsonValue,
  isProjectRelativePath,
  type Attribute,
  type ModelDocument,
} from "../src/index.ts";
import { bareDocument, postDocument, postFile, postSource } from "./sample.ts";
import { positionOf } from "./source.ts";

const docs: [string, ModelDocument][] = [
  ["post", postDocument],
  ["bare", bareDocument],
];

describe("model documents", () => {
  test.each(docs)("%s document round-trips through JSON unchanged", (_n, doc) => {
    // toStrictEqual: toEqual ignores undefined-valued keys, which is the defect to catch
    expect(JSON.parse(JSON.stringify(doc))).toStrictEqual(doc);
  });

  test("the round trip fails on an undefined-valued key", () => {
    const broken = structuredClone(postDocument) as ModelDocument;
    (broken.resources[0] as unknown as Record<string, unknown>).table = undefined;
    expect(JSON.parse(JSON.stringify(broken))).not.toStrictEqual(broken);
  });

  test.each(docs)("%s document is plain data", (_n, doc) => {
    expect(findNonJsonValue(doc)).toBeNull();
  });

  test("the sample uses every attribute type and every action kind", () => {
    const r = postDocument.resources[0]!;
    expect(new Set(r.attributes.map((a) => a.type))).toEqual(
      new Set(ATTRIBUTE_TYPES.map((t) => t.name)),
    );
    expect(r.actions.map((a) => a.kind)).toEqual(["create", "update", "destroy", "read"]);
  });
});

describe("findNonJsonValue", () => {
  test.each([
    ["undefined value", { a: undefined }, "$.a"],
    ["nested undefined", { a: [{ b: undefined }] }, "$.a[0].b"],
    ["undefined array item", [1, undefined], "$[1]"],
    ["function", { a: () => 1 }, "$.a"],
    ["Infinity (JSON writes null)", { d: { value: Infinity } }, "$.d.value"],
    ["-Infinity", [-Infinity], "$[0]"],
    ["NaN", { a: NaN }, "$.a"],
    ["bigint", { a: 1n }, "$.a"],
    ["symbol", { a: Symbol("x") }, "$.a"],
    ["Map", { a: new Map() }, "$.a"],
    ["Set", { a: new Set() }, "$.a"],
    ["Date", { a: new Date(0) }, "$.a"],
    ["class instance", { a: new (class X {})() }, "$.a"],
  ])("rejects %s", (_l, value, path) => {
    expect(findNonJsonValue(value)).toBe(path);
  });

  test.each([
    [null],
    [0],
    [-0.5],
    [1e300],
    [""],
    [false],
    [[]],
    [{}],
    [{ a: [1, "x", null, { b: true }] }],
    [Object.create(null)],
  ])("accepts %p", (value) => {
    expect(findNonJsonValue(value)).toBeNull();
  });

  test("a non-finite default in a model is found at its path", () => {
    const doc = structuredClone(postDocument) as ModelDocument;
    const views = doc.resources[0]!.attributes.find((a) => a.name === "views")!;
    views.default = { value: Infinity, position: views.position };
    expect(findNonJsonValue(doc)).toBe("$.resources[0].attributes[3].default.value");
  });
});

describe("primary key and timestamps are attributes carrying their facts", () => {
  const attrs = postDocument.resources[0]!.attributes;
  const by = (name: string): Attribute => attrs.find((a) => a.name === name)!;

  test("uuid-primary-key (row 15, D4)", () => {
    expect(by("id")).toMatchObject({
      source: "uuid-primary-key",
      type: "uuid",
      public: true,
      writable: false,
      primaryKey: true,
      allowNil: false,
    });
  });

  test.each([
    ["insertedAt", "create-timestamp"],
    ["updatedAt", "update-timestamp"],
  ])("%s (row 18)", (name, source) => {
    expect(by(name)).toMatchObject({
      source,
      type: "datetime",
      public: false,
      writable: false,
      primaryKey: false,
      allowNil: false,
    });
  });

  test("declared attributes are writable and not keys", () => {
    for (const a of attrs.filter((a) => a.source === "attribute")) {
      expect(a.writable).toBe(true);
      expect(a.primaryKey).toBe(false);
    }
  });

  test("only atom attributes carry constraints", () => {
    for (const a of attrs) expect(a.type === "atom" || a.constraints === null).toBe(true);
  });
});

describe("positions in the sample", () => {
  test("every file is project-relative", () => {
    const seen = new Set<string>();
    JSON.stringify(postDocument, (_k, v) => {
      if (v && typeof v === "object" && "file" in v) seen.add(v.file as string);
      return v;
    });
    expect([...seen]).toEqual([postFile]);
    for (const f of seen) expect(isProjectRelativePath(f)).toBe(true);
  });

  test("each author-written name sits at its own text, not at the tag", () => {
    const r = postDocument.resources[0]!;
    const text = (p: { offset: number }, len: number) => postSource.slice(p.offset, p.offset + len);
    const create = r.actions[0]!;
    if (create.kind === "read") throw new Error("unreachable");
    expect(create.accept.map((s) => text(s.position, s.value.length + 2))).toEqual([
      '"title"',
      '"body"',
    ]);
    expect(create.accept[0]!.position.line).toBe(16);
    expect(create.accept[0]!.position).not.toEqual(create.position);
    const state = r.attributes.find((a) => a.name === "state")!;
    if (state.type !== "atom") throw new Error("unreachable");
    expect(state.constraints!.oneOf.map((s) => text(s.position, s.value.length + 2))).toEqual([
      '"draft"',
      '"published"',
    ]);
    expect(text(state.default!.position, 15)).toBe('default="draft"');
    expect(r.defaults!.kinds.map((s) => s.position.line)).toEqual([15, 15]);
  });
});

describe("positionOf (the sample builder)", () => {
  test("line is 1-based, column 0-based, offset in UTF-16 units", () => {
    expect(positionOf("ab\ncd", "f.mx", "a")).toEqual({ file: "f.mx", line: 1, column: 0, offset: 0 });
    expect(positionOf("ab\ncd", "f.mx", "d")).toEqual({ file: "f.mx", line: 2, column: 1, offset: 4 });
  });

  test("counts an astral character as two UTF-16 units", () => {
    expect(positionOf("😀x", "f.mx", "x")).toEqual({ file: "f.mx", line: 1, column: 2, offset: 2 });
  });

  test("nth occurrence, and a missing needle throws naming the file", () => {
    expect(positionOf("a a a", "f.mx", "a", 2).offset).toBe(4);
    expect(() => positionOf("a", "f.mx", "b")).toThrow('f.mx: occurrence 0 of "b" not found');
    expect(() => positionOf("a", "f.mx", "a", 1)).toThrow('f.mx: occurrence 1 of "a" not found');
  });
});

describe("isProjectRelativePath", () => {
  test.each([["resources/post.mx"], ["post.mx"], ["a/b/c.mx"], ["with space/a.mx"]])(
    "accepts %p",
    (f) => expect(isProjectRelativePath(f)).toBe(true),
  );

  test.each([
    ["absolute POSIX", "/Users/me/app/post.mx"],
    ["Windows drive", "C:/app/post.mx"],
    ["Windows drive, lower case", "c:\\app\\post.mx"],
    ["backslashes", "resources\\post.mx"],
    ["parent segment", "../post.mx"],
    ["inner parent segment", "a/../post.mx"],
    ["dot segment", "./post.mx"],
    ["double slash", "a//post.mx"],
    ["trailing slash", "a/"],
    ["empty", ""],
  ])("rejects %s", (_l, f) => expect(isProjectRelativePath(f)).toBe(false));
});
