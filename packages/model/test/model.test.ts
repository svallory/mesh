import { describe, expect, test } from "bun:test";
import {
  ATTRIBUTE_TYPES,
  findNonJsonValue,
  isProjectRelativePath,
  type Attribute,
  type ModelDocument,
  type SourcePosition,
  type Spanned,
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
    const views = doc.resources[0]!.attributes.find((a) => a.name.value === "views")!;
    views.default = { value: Infinity, position: views.position };
    expect(findNonJsonValue(doc)).toBe("$.resources[0].attributes[3].default.value");
  });
});

describe("primary key and timestamps are attributes carrying their facts", () => {
  const attrs = postDocument.resources[0]!.attributes;
  const by = (name: string): Attribute => attrs.find((a) => a.name.value === name)!;

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

  /** Every `Spanned` in the document: path, value and position. */
  function spans(value: unknown, path = "$", out: [string, Spanned<unknown>][] = []) {
    if (Array.isArray(value)) value.forEach((v, i) => spans(v, `${path}[${i}]`, out));
    else if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      if ("value" in o && "position" in o) out.push([path, o as unknown as Spanned<unknown>]);
      else for (const [k, v] of Object.entries(o)) spans(v, `${path}.${k}`, out);
    }
    return out;
  }
  const written = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));

  test("every Spanned points at the first character of its value as written", () => {
    const all = spans(postDocument);
    // 3 resource + 11 attribute names + 3 defaults + 2 one-of + 2 defaults items + 4 action names + 3 accept
    expect(all.length).toBe(28);
    for (const [path, s] of all) {
      const text = written(s.value);
      expect({ path, text: postSource.slice(s.position.offset, s.position.offset + text.length) })
        .toEqual({ path, text });
    }
  });

  test("author-written names are Spanned: resource, table, domain, attributes, actions", () => {
    const r = postDocument.resources[0]!;
    const paths = spans(r).map(([p]) => p);
    for (const p of [
      "$.name",
      "$.table",
      "$.domain",
      "$.attributes[0].name",
      "$.attributes[9].name",
      "$.attributes[10].name",
      "$.actions[0].name",
      "$.actions[3].name",
    ]) {
      expect(paths).toContain(p);
    }
  });

  test("a name's position is inside its tag, after the tag's own position", () => {
    const r = postDocument.resources[0]!;
    const pairs: [Spanned<string>, { position: SourcePosition }][] = [
      [r.name, r],
      ...r.attributes.map((a): [Spanned<string>, { position: SourcePosition }] => [a.name, a]),
      ...r.actions.map((a): [Spanned<string>, { position: SourcePosition }] => [a.name, a]),
    ];
    for (const [name, owner] of pairs) {
      expect(name.position.offset).toBeGreaterThan(owner.position.offset);
      expect(name.position.line).toBe(owner.position.line);
    }
    const title = r.attributes[1]!;
    expect(title.position).toMatchObject({ line: 4, column: 4 });
    expect(title.name.position).toMatchObject({ line: 4, column: 14 });
  });

  test("a default points at the value, not at the attribute name", () => {
    const r = postDocument.resources[0]!;
    const by = (n: string) => r.attributes.find((a) => a.name.value === n)!.default!;
    expect(postSource.slice(by("views").position.offset, by("views").position.offset + 1)).toBe("0");
    expect(by("featured").position.column).toBe(postSource.split("\n")[7]!.indexOf("false"));
    expect(by("state").position.column).toBe(postSource.split("\n")[10]!.lastIndexOf('"draft"'));
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
