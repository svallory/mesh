import { expect, test } from "bun:test";
import { buildModel } from "../src/build.ts";
import contracts from "../src/contracts.ts";
import { NOT_IMPLEMENTED } from "../src/support.ts";
import { positionOf } from "../../model/test/source.ts";
import { parse } from "./helpers.ts";
const keyed = 'resource="post"\n  attributes\n    uuid-primary-key="id"\n';
const build = (source: string) => buildModel({ root: "/project", files: [{ file: "post.mx", source }] });

test("L1: tabs, CRLF, single quotes, quoted one_of, and later-line list items keep authored spans", () => {
  const source = "resource='post' table='😀é' domain='blog'\r\n\tattributes\r\n\t\tuuid-primary-key='id'\r\n\t\tattribute='x' type='atom' constraints={\r\n      \"one_of\": ['é',\r\n        '😀']\r\n    } default='é'\r\n\tactions defaults=[\r\n    'create', 'read'\r\n  ]\r\n\t\tcreate='save' accept=[\r\n      'x'\r\n    ]\r\n";
  const result = build(source);
  expect(result.diagnostics).toEqual([]);
  const r = result.document!.resources[0]!;
  expect(r.domain).toEqual({ value: "blog", position: positionOf(source, "post.mx", "'blog'") });
  expect(r.domain!.position.column).toBe(35); // UTF-16: the earlier emoji counts twice.
  const a = r.attributes[1]!;
  expect(a.type).toBe("atom");
  expect(a.constraints!.oneOf).toEqual([
    { value: "é", position: positionOf(source, "post.mx", "'é'") },
    { value: "😀", position: positionOf(source, "post.mx", "'😀'") },
  ]);
  expect(r.defaults!.kinds).toEqual((["create", "read"] as const).map((value) => ({ value, position: positionOf(source, "post.mx", `'${value}'`) })));
  expect(r.actions[0]).toMatchObject({ accept: [{ value: "x", position: positionOf(source, "post.mx", "'x'", 1) }] });
});
test("L1: reordered attributes and explicit false flags preserve scalar spans after same-line astral text", () => {
  const source = keyed.replace('resource="post"', 'resource table="😀é" domain="blog" value="post"') + '    attribute public=false allow-nil=false type="string" value="title" default="hé"\n';
  const result = build(source);
  expect(result.diagnostics).toEqual([]);
  const r = result.document!.resources[0]!;
  expect(r.name).toEqual({ value: "post", position: positionOf(source, "post.mx", '"post"') });
  expect(r.attributes[1]).toMatchObject({ public: false, allowNil: false, default: { value: "hé", position: positionOf(source, "post.mx", '"hé"') } });
});
test("L1: scalar on a later line points at its literal token", () => {
  const source = keyed + '    attribute="x" type="float" default=(\n      -1.5\n    )\n';
  const result = build(source);
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.resources[0]!.attributes[1]!.default).toEqual({ value: -1.5, position: positionOf(source, "post.mx", "-1.5") });
});
test.each(["create", "update", "destroy"])("L1: omitted accept on %s is an empty model list", (kind) => {
  const result = build(keyed + `  actions\n    ${kind}="save"\n`);
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.resources[0]!.actions[0]).toMatchObject({ kind, accept: [] });
});
test("L1: MX duplicate-attribute warnings pass through and model uses the last value", () => {
  const source = keyed.replace('resource="post"', 'resource="post" value="last"') + '    attribute="x" type="string" public=false public=true\n';
  const direct = parse(source, "post.mx");
  const result = build(source);
  expect(result.document!.resources[0]!.name.value).toBe("last");
  expect(result.document!.resources[0]!.attributes[1]!.public).toBe(true);
  expect(result.diagnostics).toHaveLength(2);
  expect(result.diagnostics.map((d) => ({ severity: d.severity, message: d.message, line: d.position.line, column: d.position.column, offset: d.position.offset }))).toEqual(direct.diagnostics.map(({ severity, message, line, column, offset }) => ({ severity, message, line, column, offset })));
  expect(result.diagnostics.every((d) => d.severity === "warning")).toBe(true);
});
test("L1: comments-only input preserves MX structural rejection exactly", () => {
  const source = "// comment\n";
  const d = parse(source, "post.mx").diagnostics[0]!;
  expect(build(source).diagnostics[0]).toMatchObject({ code: "MX", message: d.message, position: { file: "post.mx", line: d.line, column: d.column, offset: d.offset } });
});

const deferred: Record<string, { suffix: string; first: string; milestone: string }> = {
  relationships: { suffix: "  relationships\n", first: "relationships", milestone: "M7" },
  "belongs-to": { suffix: '  relationships\n    belongs-to="owner" destination="user"\n', first: "relationships", milestone: "M7" },
  "has-many": { suffix: '  relationships\n    has-many="items" destination="item"\n', first: "relationships", milestone: "M7" },
  change: { suffix: '  actions\n    create="save"\n      change=() => true\n', first: "change", milestone: "M4" },
  validate: { suffix: '  actions\n    create="save"\n      validate=() => true\n', first: "validate", milestone: "M4" },
  filter: { suffix: '  actions\n    read="list"\n      filter=() => true\n', first: "filter", milestone: "M4" },
  sort: { suffix: '  actions\n    read="list"\n      sort=["id"]\n', first: "sort", milestone: "M3" },
  policies: { suffix: "  policies\n", first: "policies", milestone: "M8" },
  policy: { suffix: '  policies\n    policy=action_type("read")\n      authorize-if=() => true\n', first: "policies", milestone: "M8" },
  "authorize-if": { suffix: '  policies\n    policy=action_type("read")\n      authorize-if=() => true\n', first: "policies", milestone: "M8" },
  calculations: { suffix: "  calculations\n", first: "calculations", milestone: "M7" },
  calculate: { suffix: '  calculations\n    calculate="x" type="string"\n      value=() => "x"\n', first: "calculations", milestone: "M7" },
  value: { suffix: '  calculations\n    calculate="x" type="string"\n      value=() => "x"\n', first: "calculations", milestone: "M7" },
  aggregates: { suffix: "  aggregates\n", first: "aggregates", milestone: "M7" },
  count: { suffix: '  aggregates\n    count="n" relationship-path="items"\n', first: "aggregates", milestone: "M7" },
};
test("L1: behavioural deferred cases cover the entire milestone table", () => {
  expect(new Set(Object.keys(deferred))).toEqual(new Set(Object.keys(NOT_IMPLEMENTED)));
});
test.each(Object.entries(deferred))("L1: deferred %s context reports its first unsupported subtree with milestone and position", (_tag, { suffix, first, milestone }) => {
  const source = keyed + suffix;
  const result = build(source);
  expect(result.document).toBeNull();
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code: "MESH_NOT_IMPLEMENTED", message: `Tag \`${first}\` is not implemented; it will be implemented in ${milestone}`, position: positionOf(source, "post.mx", first), fix: `Remove this tag until ${milestone}` });
});
test("H1: unexpected shape after a passing contract returns a named diagnostic and continues", () => {
  const original = contracts.attribute.analyze;
  try {
    // Simulate a future contract regression: MX accepts a shape the builder
    // cannot project. The source remains the only input to the public API.
    contracts.attribute.analyze = undefined;
    const source = keyed + '    attribute="x" type="atom" constraints={one_of:[{}]}\n';
    const next = keyed.replace('"post"', '"next"') + '  actions\n    create="save" accept=["missing"]\n';
    const result = buildModel({ root: "/project", files: [{ file: "shape.mx", source }, { file: "next.mx", source: next }] });
    expect(result.document).toBeNull();
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MESH_MODEL_SHAPE", "MESH_UNKNOWN_ACCEPT"]);
    expect(result.diagnostics[0]).toMatchObject({ message: "Cannot build element `attribute`: Unexpected MX literal node ObjectExpression", position: positionOf(source, "shape.mx", "attribute=\"x\"") });
  } finally { contracts.attribute.analyze = original; }
});
