import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { type WildcardChildEntry } from "@mxlang/core";
import contracts, { ATTRIBUTE_TYPES } from "../src/front-end/contracts.ts";
import { buildModel } from "../src/front-end/build.ts";
import { coverageProject } from "./coverage-examples.ts";
import { fixture, fixtureDir, parse, parseFixture } from "./helpers.ts";
import { build, keyed, todo } from "./v4.ts";

describe("v4 contracts", () => {
  test("one closed contract per v4 tag", () => {
    for (const contract of Object.values(contracts)) {
      expect(contract.attributes).toBeDefined();
      expect(contract.children).toBeDefined();
      expect(contract.attributeTags).toEqual({});
      expect(contract.transform).toBeUndefined();
      expect(contract.finalize).toBeUndefined();
    }
  });
  test("the package manifest has no mx key: the dialect carries the contracts", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.mx).toBeUndefined();
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
  test("comments are non-structural under structural rejection", () =>
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
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics.length).toBeGreaterThan(0);
    },
  );
  test.each([
    'record="Todo"',
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
    '  actions\n    create :create\n      validate\n        check :ok that=() => true code=:bad message="bad"\n',
    "  actions\n    read :read filter=someFunction\n",
    "  policies\n    policy :owner actions=[:read]\n",
  ])("rejects old options or invalid shapes %s", (suffix) =>
    expect(parse(keyed + suffix).diagnostics.length).toBeGreaterThan(0),
  );
  // A `check` line may declare a check or use a named one (`check &name`), so the contract requires none of a
  // declaration's options: the builder reports the one missing, with MX's text.
  test("rejects a check without `that`", () =>
    expect(buildModel({ root: "/p", files: [{ file: "todo/todo.mesh.mx", source: `${keyed}  actions\n    create :create\n      validate\n        check :ok code="bad" message="bad"\n` }] }).diagnostics.map((d) => d.code)).toContain("MESH_MISSING_OPTION"),
  );
  test("a single atom in a list slot is refused with the list spelling (MX alpha.33: list slots are arrays of `mesh:Atom`)", () => {
    const result = parse(`${keyed}  actions auto=:read\n`);
    expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["MESH_OPTION_VALUE", "`actions`: option `auto` must be array, got atom; write it as a list: `[:read]`"],
    ]);
  });
  test("old-relationship: exact message and position (the value-position atom row ends the default at the spaced name; Mesh's words since MX alpha.31)", () => {
    const result = parseFixture("negative/old-relationship.mesh.mx");
    expect(result.diagnostics.map((d) => [d.code, d.message, d.line, d.column])).toEqual([
      [ "MESH_UNKNOWN_OPTION", "`belongs-to`: unknown option `value`", 5, 14],
    ]);
  });
  test("every negative fixture fails with a positioned diagnostic", () => {
    const files = readdirSync(`${fixtureDir}negative`).filter((f) =>
      f.endsWith(".mesh.mx"),
    );
    const expected: Record<string, readonly [string, number, number]> = {
      "primary-keys": ["MESH_PRIMARY_KEY", 1, 0],
      let: ["MESH_NOT_IN_ENTITY_FILE", 1, 0],
      "unknown-root": ["MESH_UNKNOWN_TAG", 1, 0],
      "primary-key-boolean": ["MESH_UNKNOWN_OPTION", 3, 16],
      "duplicate-member": ["MESH_DUPLICATE_MEMBER", 4, 4],
      "enum-values": ["MESH_ENUM_VALUES", 4, 4],
      "member-options": ["MESH_PARSE_INVALID_CHARACTER", 7, 12],
      "unknown-member": ["MESH_UNKNOWN_MEMBER", 7, 8],
      "old-arguments": ["MESH_UNKNOWN_TAG", 6, 6],
      "unknown-option": ["MESH_UNKNOWN_OPTION", 1, 13],
      "member-assignment": ["MESH_UNKNOWN_OPTION", 7, 8],
      "member-assign-expression": ["MESH_MEMBER_ASSIGN", 6, 33],
      "duplicate-set": ["MESH_DUPLICATE_SET", 10, 10],
      "check-that": ["MESH_MISSING_OPTION", 7, 8],
      "atom-sort": ["MESH_UNKNOWN_OPTION", 7, 12],
      "has-many-nullable": ["MESH_UNKNOWN_OPTION", 5, 32],
      "old-accept": ["MESH_UNKNOWN_OPTION", 5, 19],
      "unknown-entity": ["MESH_UNKNOWN_ENTITY", 5, 28],
      const: ["MESH_STRUCTURAL_CONSTRUCT", 1, 0],
      "old-module": ["MESH_UNKNOWN_OPTION", 1, 13],
      "old-relationship": ["MESH_UNKNOWN_OPTION", 5, 14],
      "atom-input": ["MESH_UNSPACED_NAME", 7, 8],
      "read-input-member": ["MESH_READ_INPUT_MEMBER", 7, 8],
      "unknown-import": ["MESH_UNKNOWN_IMPORT", 1, 0],
      "duplicate-input": ["MESH_DUPLICATE_INPUT", 8, 8],
      if: ["MESH_STRUCTURAL_CONSTRUCT", 1, 0],
      "check-code-atom": ["MESH_OPTION_VALUE", 7, 39],
      for: ["MESH_PARSE_MISSING_END_TAG", 1, 0],
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
        expect(d.code).toMatch(/^(MESH|MX)_/);
        expect(d.position.line).toBeGreaterThan(0);
        expect(d.position.offset).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

const members = [
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
    keyed + "  actions\n    always actions=[&custom]\n    update :custom\n",
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
for (const [name, source] of members)
  test(
    `${name} parses and builds`,
    () => {
      expect(parse(source).diagnostics).toEqual([]);
      expect(build(source).diagnostics).toEqual([]);
    },
  );
test(
  "unknown expression member suggests nearest",
  () => {
    expect(
      build(
        keyed +
          "    string :title\n  actions\n    read :custom filter=() => &titel !== null\n",
      ).diagnostics[0],
    ).toMatchObject({
      code: "MESH_UNKNOWN_MEMBER",
      message: "&titel is not a member of todo.Todo. Did you mean &title?",
    });
  },
);
test(
  "on:load must name a read",
  () => {
    expect(
      build(
        keyed + "  actions on:load=&custom\n    update :custom\n",
      ).diagnostics.map((d) => d.code),
    ).toContain("MESH_ON_LOAD");
  },
);
// A read writes nothing, so it has no step to run and no write for a check to guard: its contract leaves `validate` and
// `do` out of its children, and MX refuses either at its own line, whatever it holds.
describe("a read takes no validate and no do", () => {
  const CHECK = '        check :ok that=() => true code="x" message="m"\n';
  const RUN = "        run (ctx) { return ctx }\n";
  const read = (body: string) =>
    build(`${keyed}    integer :n\n  actions\n    read :open\n${body}`).diagnostics.map((d) => [d.position.line, d.position.column, d.severity, d.code, d.message, d.fix]);
  const refused = (child: string, line = 7) =>
    [line, 6, "error", "MESH_TAG_NOT_ALLOWED", `\`read\`: \`${child}\` is not allowed here; allowed children: \`input\`, \`filter\`, \`sort\``, null];
  test.each([
    ["a validate with a check", `      validate\n${CHECK}`, "validate"],
    ["an empty validate", "      validate\n", "validate"],
    ["a do with a step", `      do\n${RUN}`, "do"],
    ["an empty do", "      do\n", "do"],
    ["a do under the read's own input and filter", `      do\n${RUN}      input\n        integer :m\n      filter=({ self, input }) => self.n > input.m\n`, "do"],
  ])("%s is MESH_TAG_NOT_ALLOWED at its own line", (_, body, child) => {
    expect(read(body)).toEqual([refused(child)]);
  });
  test("a read with both is refused at the one written first: MX stops at the first child a tag does not take", () => {
    expect(read(`      validate\n${CHECK}      do\n${RUN}`)).toEqual([refused("validate")]);
    expect(read(`      do\n${RUN}      validate\n${CHECK}`)).toEqual([refused("do")]);
  });
  test("the legal neighbours stay legal: a read's input, filter and sort; validate and do on the three writes and in an always block beside a read", () => {
    expect(read("      input\n        integer :m\n      filter=({ self, input }) => self.n > input.m\n      sort\n        asc &n\n")).toEqual([]);
    // A check's name is a member of the entity, counted once (SYN-08): each block names its own.
    const body = (name: string) => `      validate\n${CHECK.replace(":ok", `:${name}`)}      do\n${RUN}`;
    expect(build(`${keyed}    integer :n\n  actions auto=[:read]\n    read :open\n    create :add\n${body("addOk")}    update :change\n${body("changeOk")}    destroy :remove\n${body("removeOk")}    always\n${body("alwaysOk")}`).diagnostics).toEqual([]);
  });
});
// An `always` block holds `validate` and `do`, and a read runs neither: a block scoped to a read never applies to it. The
// `types=` half is a contract hook (the model keeps no position for a `types` item); the `actions=` half needs the
// entity's actions and is in `build.test.ts`.
describe("always types= cannot list :read", () => {
  const BODY = '      validate\n        check :ok that=() => true code="x" message="m"\n';
  const always = (line: string, body = BODY) =>
    build(`${keyed}    integer :n\n  actions auto=[:read]\n    update :change\n    read :all\n${line}\n${body}`).diagnostics.map((d) => [d.position.line, d.position.column, d.severity, d.code, d.message, d.fix]);
  const refused = (column: number) =>
    [8, column, "error", "MESH_OPTION_VALUE", "`always`: `types=` lists `:read`, and a read runs neither `validate` nor `do`, so an always block never applies to it; remove `:read`", null];
  test("at the :read atom, alone or among the other types, wherever it is in the list", () => {
    expect(always("    always types=[:read]")).toEqual([refused(18)]);
    expect(always("    always types=[:read, :update]")).toEqual([refused(18)]);
    expect(always("    always types=[:create, :read, :destroy]")).toEqual([refused(27)]);
    expect(always("    always types=[\n      :update,\n      :read\n    ]").map((d) => [d[0], d[1], d[3]])).toEqual([[10, 6, "MESH_OPTION_VALUE"]]);
  });
  test("with no validate and no do too: the rule is about the scope, not about what the block holds", () => {
    expect(always("    always types=[:read]", "")).toEqual([refused(18)]);
  });
  test("the legal neighbours stay legal: the three write types, a block with no scope beside a read, and a policy's types=[:read]", () => {
    expect(always("    always types=[:create, :update, :destroy]")).toEqual([]);
    expect(always("    always")).toEqual([]);
    expect(build(`${keyed}  actions auto=[:read]\n  policies\n    policy :readers types=[:read] authorize-if=({ actor }) => !!actor\n`).diagnostics).toEqual([]);
  });
});
test(
  "reference fixture parses",
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
  for (const row of rows) {
    const cell = row[2]!.replaceAll("`", "");
    const [tag, option] = cell.split(".");
    const example = row[1]!.replace(/^`|`$/g, "");
    const check = () => {
      const project = coverageProject(tag!, option, example);
      for (const file of project.files) expect(parse(file.source).diagnostics).toEqual([]);
      // The docs sample for `run` calls `audit`, a helper it does not import: a free variable, by design (M4). The one for
      // `policy.actions` covers named actions only, so the relationship the project adds to it loads nothing (R2-N2).
      expect(buildModel(project).diagnostics.filter((d) => !(d.code === "MESH_EXPR_FREE_VARIABLE" && example.includes("audit(")) && !(d.code === "MESH_LOAD_NO_POLICY" && cell === "policy.actions") && !(d.code === "MESH_COMMAND_UNANSWERED" && tag === "command") && !(d.code === "MESH_JSON_NULLABLE" && cell === "json.nullable") && !(d.code === "MESH_NOT_IMPLEMENTED" && /^(sum|avg|min)\b/.test(example)))).toEqual([]);
    };
    test(`${cell} example parses and builds`, check);
  }
  test("one row per tag and option, no untested or stale contract cells", () => {
    const expected = Object.entries(contracts)
      .flatMap(([tag, contract]) => {
        const wildcard = contract.children?.["*"] as WildcardChildEntry | undefined;
        // The lowered `member` line has no named-tag row: list its options
        // beyond the lowered `name`, or the bare line.
        const options = Object.keys(wildcard?.attributes ?? {}).filter((option) => option !== "name");
        const inline = !wildcard ? [] : options.length
          ? options.map((option) => `${tag}.${wildcard.pattern}.${option}`)
          : [`${tag}.${wildcard.pattern}`];
        return [tag, ...Object.keys(contract.attributes ?? {}).map((option) => `${tag}.${option}`), ...inline];
      })
      .sort();
    expect(rows.map((r) => r[2]!.replaceAll("`", "")).sort()).toEqual(expected);
    for (const row of rows) {
      expect(row).toHaveLength(4);
      expect(row[1]!.length).toBeGreaterThan(2);
      expect(row[3]).toBe("on main");
    }
  });
});
