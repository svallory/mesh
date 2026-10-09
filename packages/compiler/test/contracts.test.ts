import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { createTargetLookup, getCustomTags } from "@mxlang/core";
import descriptor from "@mxlang/data/descriptor";
import contracts, { ATTRIBUTE_TYPES, ROLLUPS } from "../src/contracts.ts";
import { fixture, fixtureDir, parse, parseFixture } from "./helpers.ts";
import { build, keyed, todo } from "./v4.ts";
const TAG_NAMES = [
  "entity",
  "attributes",
  ...ATTRIBUTE_TYPES,
  "relationships",
  "belongs-to",
  "has-many",
  "has-one",
  "computed",
  ...ROLLUPS,
  "actions",
  "always",
  "create",
  "read",
  "update",
  "destroy",
  "input",
  "member",
  "validate",
  "check",
  "do",
  "set",
  "when",
  "load",
  "run",
  "filter",
  "sort",
  "asc",
  "desc",
  "policies",
  "policy",
  "authorize-if",
  "forbid-if",
].sort();

describe("v4 contracts", () => {
  test("one closed contract per v4 tag", () => {
    expect(Object.keys(contracts).sort()).toEqual(TAG_NAMES);
    for (const contract of Object.values(contracts)) {
      expect(contract.attributes).toBeDefined();
      expect(contract.children).toBeDefined();
      expect(contract.attributeTags).toEqual({});
      expect(contract.transform).toBeUndefined();
      expect(contract.finalize).toBeUndefined();
    }
  });
  test("manifest exposes the same contracts through the tree target", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(manifest.mx).toEqual({
      target: "tree",
      contracts: "./src/contracts.ts",
    });
    const loaded = getCustomTags(`${fixtureDir}post.mesh.mx`, {
      targets: createTargetLookup([descriptor]),
      host: null,
    });
    expect(Object.keys(loaded).sort()).toEqual(TAG_NAMES);
  });
  test("full currently supported vocabulary parses with contracts", () =>
    expect(parse(todo).diagnostics).toEqual([]));
  test.each(["attributes", "relationships", "computed", "actions", "policies"])(
    "optional %s section may be empty",
    (section) =>
      expect(parse(`entity :Todo\n  ${section}\n`).diagnostics).toEqual([]),
  );
  test.each(ATTRIBUTE_TYPES)(
    "%s is accepted as stored field, argument and computed function",
    (kind) => {
      const values = kind === "enum" ? " values=[:draft, :sent]" : "";
      expect(
        parse(
          keyed +
            `    ${kind} :field${values}\n  computed\n    ${kind} :derived() { return 1 }\n  actions\n    create :custom\n      input\n        ${kind} :argument${values}\n`,
        ).diagnostics,
      ).toEqual([]);
    },
  );
  test("comments are non-structural under alpha.11", () =>
    expect(
      parse("// comment\n" + keyed + "    // inside\n").diagnostics,
    ).toEqual([]));
  test.each(["if", "for", "let", "const", "define"])(
    "rejects structural <%s>",
    (tag) => {
      const sources: Record<string, string> = {
        if: "<if(true)>\n</if>",
        for: "<for of=[1]|x|>\n</for>",
        let: "<let/x=1/>",
        const: "<const/x=1/>",
        define: "<define/foo>\n</define>",
      };
      const result = parse(sources[tag]!);
      expect(result.tree).toBeUndefined();
      expect(result.diagnostics.length).toBeGreaterThan(0);
    },
  );
  test.each([
    'resource="Todo"',
    'entity :Todo module="todo"',
    'entity "Todo"',
    'entity name="Todo"',
  ])("rejects old root spelling %s", (source) =>
    expect(parse(`${source}\n`).diagnostics.length).toBeGreaterThan(0),
  );
  test.each([
    "  actions\n    create :create accept=[]\n",
    "  actions\n    create :create\n      arguments\n",
    "  actions\n    create :create\n      validate require=[]\n",
    "  relationships\n    belongs-to=:List :list\n",
    "  relationships\n    has-many :list entity=List nullable\n",
    '  actions auto=["read"]\n',
    "  actions auto=:read\n",
    "  actions auto=[:read, :read]\n",
    "  actions\n    always types=[:upsert]\n",
    "  actions\n    read :read\n      sort\n        asc :id\n",
    "  actions\n    create :create\n      input\n        :id\n",
    '  actions\n    create :create\n      validate\n        check :ok code="bad" message="bad"\n',
    '  actions\n    create :create\n      validate\n        check :ok that=() => true code=:bad message="bad"\n',
    "  actions\n    read :read filter=someFunction\n",
    "  policies\n    policy :owner actions=[:read]\n",
  ])("rejects old options or invalid shapes %s", (suffix) =>
    expect(parse(keyed + suffix).diagnostics.length).toBeGreaterThan(0),
  );
  test("every negative fixture fails with a positioned diagnostic", () => {
    const files = readdirSync(`${fixtureDir}negative`).filter((f) =>
      f.endsWith(".mesh.mx"),
    );
    const expected: Record<string, readonly [string, number, number]> = {
      "primary-keys": ["MESH_PRIMARY_KEY", 1, 0],
      let: ["MESH_SYNTAX", 1, 0],
      "old-resource": ["MESH_SYNTAX", 1, 0],
      "duplicate-member": ["MESH_DUPLICATE_MEMBER", 4, 4],
      "enum-values": ["MESH_ENUM_VALUES", 4, 4],
      "member-options": ["MESH_MEMBER_LINE_OPTIONS", 7, 12],
      "unknown-member": ["MESH_UNKNOWN_MEMBER", 7, 8],
      "old-arguments": ["MESH_SYNTAX", 6, 6],
      "unknown-option": ["MESH_SYNTAX", 1, 13],
      "member-assignment": ["MESH_MEMBER_LINE_OPTIONS", 7, 8],
      "check-that": ["MESH_SYNTAX", 7, 8],
      "atom-sort": ["MESH_SYNTAX", 7, 12],
      "has-many-nullable": ["MESH_SYNTAX", 5, 32],
      "old-accept": ["MESH_SYNTAX", 5, 19],
      "unknown-entity": ["MESH_UNKNOWN_ENTITY", 5, 28],
      const: ["MESH_SYNTAX", 1, 0],
      "old-module": ["MESH_SYNTAX", 1, 13],
      "old-relationship": ["MESH_SYNTAX", 5, 14],
      "atom-input": ["MESH_SYNTAX", 7, 8],
      "read-input-member": ["MESH_READ_INPUT_MEMBER", 7, 8],
      "unknown-import": ["MESH_UNKNOWN_IMPORT", 1, 0],
      "duplicate-input": ["MESH_DUPLICATE_INPUT", 8, 8],
      if: ["MESH_SYNTAX", 1, 4],
      "check-code-atom": ["MESH_SYNTAX", 7, 39],
      for: ["MESH_SYNTAX", 1, 0],
    };
    expect(files.map((name) => name.replace(".mesh.mx", "")).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const file of files) {
      const source = fixture(`negative/${file}`).source;
      const result = build(source);
      expect(result.document, file).toBeNull();
      expect(result.diagnostics.length, file).toBeGreaterThan(0);
      const first = result.diagnostics[0]!;
      expect(
        [first.code, first.position.line, first.position.column],
        file,
      ).toEqual([...expected[file.replace(".mesh.mx", "")]!]);
      for (const d of result.diagnostics) {
        expect(d.code).toStartWith("MESH_");
        expect(d.position.line).toBeGreaterThan(0);
        expect(d.position.offset).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

const pending = [
  [
    "asc member",
    keyed + "  actions\n    read :custom\n      sort\n        asc &id\n",
  ],
  [
    "desc member",
    keyed + "  actions\n    read :custom\n      sort\n        desc &id\n",
  ],
  ["on:load", keyed + "  actions on:load=&custom\n    read :custom\n"],
  [
    "load",
    keyed +
      "  computed\n    integer :n() { return 1 }\n  actions\n    update :custom\n      do\n        load=[&n]\n",
  ],
  [
    "always actions",
    keyed + "  actions\n    always actions=[&custom]\n    read :custom\n",
  ],
  [
    "policy actions",
    keyed +
      "  actions\n    read :custom\n  policies\n    policy :owner actions=[&custom]\n      authorize-if=() => true\n",
  ],
  [
    "expression member",
    keyed + "  actions\n    read :custom filter=() => &id !== null\n",
  ],
] as const;
for (const [name, source] of pending)
  test.todo(
    `${name} — MX lang-ext-syntax-table: & after a kind / in expressions`,
    () => {
      expect(parse(source).diagnostics).toEqual([]);
      expect(build(source).diagnostics).toEqual([]);
    },
  );
test.todo(
  "unknown expression member suggests nearest — MX lang-ext-syntax-table: & after a kind / in expressions",
  () => {
    expect(
      build(
        keyed +
          "    string :title\n  actions\n    read :custom filter=() => &titel !== null\n",
      ).diagnostics[0],
    ).toMatchObject({
      code: "MESH_UNKNOWN_MEMBER",
      message: "&titel is not a member of :Todo. Did you mean &title?",
    });
  },
);
test.todo(
  "on:load must name a read — MX lang-ext-syntax-table: & after a kind / in expressions",
  () => {
    expect(
      build(
        keyed + "  actions on:load=&custom\n    update :custom\n",
      ).diagnostics.map((d) => d.code),
    ).toContain("MESH_ON_LOAD");
  },
);
test.todo(
  "reference fixture parses — MX lang-ext-syntax-table: & after a kind / in expressions",
  () => expect(parseFixture("post.mesh.mx").diagnostics).toEqual([]),
);

describe("vocabulary-mapping section 3 Contract coverage", () => {
  const page = readFileSync(
    new URL(
      "../../../apps/docs/docs/architecture/roadmap/vocabulary-mapping.md",
      import.meta.url,
    ),
    "utf8",
  );
  const section = page.slice(
    page.indexOf("## 3. Contract coverage"),
    page.indexOf("## 4. Deviations"),
  );
  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) =>
      line
        .split("|")
        .map((cell) => cell.trim())
        .slice(1, -1),
    );
  test("one row per tag and option, no untested or stale contract cells", () => {
    const expected = Object.entries(contracts)
      .flatMap(([tag, contract]) => [
        tag,
        ...Object.keys(contract.attributes ?? {}).map(
          (option) => `${tag}.${option}`,
        ),
      ])
      .sort();
    expect(rows.map((r) => r[2]!.replaceAll("`", "")).sort()).toEqual(expected);
    for (const row of rows) {
      expect(row).toHaveLength(4);
      expect(row[1]!.length).toBeGreaterThan(2);
      expect(row[3]).toBe("on main");
    }
  });
});
