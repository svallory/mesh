import { expect, test } from "bun:test";
import { ACTION_TYPES, ATTRIBUTE_TYPES, findNonJsonValue, type Diagnostic } from "@mesh/model";
import { buildModel } from "../src/build.ts";
import contracts from "../src/contracts.ts";
import { IMPLEMENTED, NOT_IMPLEMENTED } from "../src/support.ts";
import { postDocument, postFile, postSource } from "../../model/test/sample.ts";
import { positionOf } from "../../model/test/source.ts";
import { fixture, parse } from "./helpers.ts";

const build = (source: string, file = "post.mx") => buildModel({ root: "/project", files: [{ file, source }] });
const bare = 'resource="post"\n  attributes\n    uuid-primary-key="id"\n';
function check(d: Diagnostic | undefined, message: string, line: number, column: number) {
  expect(d).toBeDefined();
  expect(d!.message).toBe(message);
  expect(d!.position.line).toBe(line);
  expect(d!.position.column).toBe(column);
}

test("M1 test 4: empty file requires exactly one resource", () => {
  const result = build("");
  expect(result.document).toBeNull();
  check(result.diagnostics[0], "A resource file must contain exactly one `resource`", 1, 0);
});
test("M1 test 4: two resources point at the second resource tag", () => {
  const result = build(bare + bare);
  expect(result.document).toBeNull();
  check(result.diagnostics[0], "A resource file must contain exactly one `resource`", 4, 0);
});
test("M1 test 4: duplicate resource points at the second name", () => {
  const result = buildModel({ root: "/project", files: [{ file: "a.mx", source: bare }, { file: "nested/b.mx", source: bare }] });
  expect(result.document).toBeNull();
  check(result.diagnostics[0], 'Duplicate resource name "post"', 1, 9);
  expect(result.diagnostics[0]!.position.file).toBe("nested/b.mx");
});
test("M1 test 4: unknown accept points at the missing item", () => {
  const result = build(bare + '  actions\n    create="create" accept=["missing"]\n');
  expect(result.document).toBeNull();
  check(result.diagnostics[0], '`accept` names "missing", which is not an attribute of post.', 5, 28);
});
test("M1 test 5: full post fixture fails at its first unsupported tag", () => {
  const input = fixture("post.mx");
  const result = build(input.source);
  expect(result.document).toBeNull();
  check(result.diagnostics[0], "Tag `relationships` is not implemented; it will be implemented in M7", 10, 2);
});
test("M1 test 6: attribute and action contract vocabularies equal model registries", () => {
  expect(new Set(contracts.attribute.attributes!.type!.enum)).toEqual(new Set(ATTRIBUTE_TYPES.map((t) => t.name)));
  expect(new Set(Object.keys(contracts.actions.children!))).toEqual(new Set(ACTION_TYPES));
  for (const kind of ACTION_TYPES) {
    expect(parse(bare + `  actions defaults=["${kind}"]\n    ${kind}="custom"\n`).diagnostics).toEqual([]);
    expect(parse(bare + `  policies\n    policy=action_type("${kind}")\n      authorize-if=() => true\n`).diagnostics).toEqual([]);
  }
  expect(parse(bare + '  actions defaults=["bogus"]\n').tree).toBeUndefined();
  expect(parse(bare + '  policies\n    policy=action_type("bogus")\n      authorize-if=() => true\n').tree).toBeUndefined();
});
test("every contract tag and attribute has explicit implementation coverage", () => {
  const all = [...Object.keys(IMPLEMENTED), ...Object.keys(NOT_IMPLEMENTED)];
  expect(all.length).toBe(new Set(all).size);
  expect(new Set(all)).toEqual(new Set(Object.keys(contracts)));
  for (const [tag, attributes] of Object.entries(IMPLEMENTED)) {
    expect(new Set(attributes)).toEqual(new Set(Object.keys(contracts[tag as keyof typeof contracts].attributes!)));
  }
});
test("reduced post builds to the full expected ModelDocument with every source position", () => {
  const { source } = fixture("reduced-post.mx");
  expect(source).toBe(postSource);
  const result = build(source, postFile);
  expect(result.diagnostics).toEqual([]);
  expect(result.document).toStrictEqual(postDocument);
  expect(findNonJsonValue(result.document)).toBeNull();
  let count = 0;
  JSON.stringify(result.document, (_key, value) => {
    if (value && typeof value === "object" && "offset" in value && "file" in value) {
      count++;
      const offset = value.offset as number;
      const prefix = postSource.slice(0, offset);
      expect(value.line).toBe(prefix.split("\n").length);
      expect(value.column).toBe(offset - prefix.lastIndexOf("\n") - 1);
      expect(value.file).toBe(postFile);
      expect(postSource[offset]).not.toMatch(/\s/);
    }
    return value;
  });
  expect(count).toBeGreaterThan(30);
});
test("two failing files collect all Mesh checks, including same-kind duplicates", () => {
  const source = bare.replace('  attributes\n', '  attributes\n    attribute="x" type="string"\n    attribute="x" type="integer"\n') + '  actions\n    create="save" accept=["bad", "worse"]\n    read="save"\n';
  const result = buildModel({ root: "/project", files: [{ file: "a.mx", source }, { file: "b.mx", source }] });
  expect(result.document).toBeNull();
  expect(result.diagnostics.map((d) => d.code)).toEqual([
    "MESH_DUPLICATE_ATTRIBUTE", "MESH_UNKNOWN_ACCEPT", "MESH_UNKNOWN_ACCEPT", "MESH_DUPLICATE_ACTION",
    "MESH_DUPLICATE_RESOURCE", "MESH_DUPLICATE_ATTRIBUTE", "MESH_UNKNOWN_ACCEPT", "MESH_UNKNOWN_ACCEPT", "MESH_DUPLICATE_ACTION",
  ]);
});
test("MX errors pass through unchanged with project-relative file names", () => {
  const sources = ['resourse="post"\n  attributes\n', bare + '  actions\n    read="r" accept=[]\n'];
  const result = buildModel({ root: "/project", files: sources.map((source, i) => ({ source, file: `/project/resources/${i}.mx` })) });
  expect(result.document).toBeNull();
  expect(result.diagnostics).toHaveLength(2);
  sources.forEach((source, i) => {
    const direct = parse(source, `resources/${i}.mx`).diagnostics[0]!;
    expect(result.diagnostics[i]).toMatchObject({ severity: direct.severity, message: direct.message, position: { file: `resources/${i}.mx`, line: direct.line, column: direct.column, offset: direct.offset } });
  });
});
test("UTF-16 positions preserve astral characters, CRLF and authored literal nodes", () => {
  const source = 'resource="😀"\r\n  attributes\r\n    attribute="x" type="float" default=-1.5\r\n    uuid-primary-key="id"\r\n  actions\r\n    destroy="d" accept=["missing"]\r\n';
  const result = build(source);
  const d = result.diagnostics[0]!;
  expect(d.position).toEqual(positionOf(source, "post.mx", '"missing"'));
  const good = build(source.replace('"missing"', '"x"'));
  expect(good.diagnostics).toEqual([]);
  expect(good.document!.resources[0]!.attributes[0]!.default).toEqual({ value: -1.5, position: positionOf(source, "post.mx", "-1.5") });
});
test("a non-finite default becomes a JSON diagnostic instead of silently emitting null", () => {
  const source = bare.replace('  attributes\n', '  attributes\n    attribute="x" type="float" default=1e999\n');
  const result = build(source);
  expect(result.document).toBeNull();
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_NON_JSON", message: "Model is not JSON-compatible: $.resources[0].attributes[0].default.value", position: positionOf(source, "post.mx", "1e999"), fix: "Use a finite JSON-compatible value" });
});
test("D31: a resource without a key fails at its name with the declaration fix", () => {
  const result = build('resource="post"\n  attributes\n');
  expect(result.document).toBeNull();
  check(result.diagnostics[0], "Resource must declare a primary key; declare `uuid-primary-key`", 1, 9);
});
test("minimal keyed resource has null optionals and a bare public flag is recorded", () => {
  expect(build(bare).document!.resources[0]).toMatchObject({ table: null, domain: null, defaults: null, actions: [] });
  const result = build(bare.replace('  attributes\n', '  attributes\n    attribute="x" type="string" public allow-nil\n'));
  expect(result.document!.resources[0]!.attributes[0]).toMatchObject({ public: true, allowNil: true });
});
