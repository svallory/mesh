// The vocabulary and the sources of the atom contract matrix (ported from MX's `lowered-unit.test.ts` at MX commit 750c80ec1):
// contracts that use `values`, `pattern`, `ref` and `declares`, the sources the checks must reject, those they must accept, and
// the registration errors for malformed claimed keys. `atom-contracts.test.ts` runs them through `MESH_DIALECT`.
import type { CustomTag } from "@mxlang/core";


/** Analyze hook: declares `name` (of `kind`) at each call, optionally scoped. */
function deriving(
  kind: string,
  name: string,
  scope?: string | string[],
): CustomTag {
  return {
    analyze(calls, ctx) {
      for (const call of calls) {
        if (call.span) ctx.declare(kind, name, { span: call.span, scope });
      }
    },
  };
}

export const NAMES = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
];

export const vocab: Record<string, CustomTag> = {
  entity: {},
  attributes: {},
  actions: {},
  arguments: {},
  relationships: {},
  string: {
    attributes: { name: { type: "mesh:Atom" } },
    declares: [
      { kind: "attribute", from: "name", under: "attributes" },
      {
        kind: "argument",
        from: "name",
        under: "arguments",
        scope: ["create", "read", "update", "destroy", "action"],
      },
    ],
  },
  action: {
    attributes: { name: { type: "mesh:Atom" } },
    declares: { kind: "action", from: "name" },
  },
  "has-many": {
    attributes: { name: { type: "mesh:Atom" } },
    declares: { kind: "relationship", from: "name" },
  },
  calc: {
    attributes: { name: { type: "mesh:Atom" } },
    declares: { kind: "computed", from: "name" },
  },
  policy: {
    attributes: {
      // MX's `atom` type took one atom or a list; a node-type slot is one or the other, so the slots the matrix writes as lists are lists.
      accept: { type: "array", items: "mesh:Atom", ref: "attribute" },
      load: { type: "array", items: "mesh:Atom", ref: ["relationship", "computed"] },
      require: { type: "array", items: "mesh:Atom", ref: ["attribute", "argument"] },
      types: { type: "mesh:Atom", values: ["create", "read", "update", "destroy"] },
      only: { type: "mesh:Atom", ref: "attribute", values: ["title", "body"] },
      shaped: { type: "mesh:Atom", ref: "attribute", pattern: "^t" },
    },
  },
  setter: {
    attributes: { name: { type: "mesh:Atom", ref: "attribute" }, value: {} },
  },
  set: { defaultTag: "setter" },
  box: {
    attributes: {
      any: { type: "mesh:Atom" },
      mode: { type: "mesh:Atom", values: ["strict", "loose"] },
      modes: { type: "array", items: "mesh:Atom", values: ["strict", "loose"] },
      slug: { type: "mesh:Atom", pattern: "^[a-z]+$" },
      both: { type: "mesh:Atom", values: ["a1", "b2"], pattern: "^[a-z]\\d$" },
      many: { type: "mesh:Atom", values: NAMES },
      ten: { type: "mesh:Atom", values: NAMES.slice(0, 10) },
    },
    attributeTags: {
      row: {
        attributes: {
          mode: { type: "mesh:Atom", values: ["a", "b"] },
          to: { type: "mesh:Atom", ref: "node" },
        },
        attributeTags: {
          cell: {
            attributes: {
              k: { type: "mesh:Atom", values: ["x", "y"] },
              ks: { type: "array", items: "mesh:Atom", values: ["x", "y"] },
            },
          },
        },
      },
      "*": {
        pattern: "col-.*",
        attributes: { to: { type: "mesh:Atom", ref: "node" } },
      },
    },
  },
  node: { attributes: { id: {} }, declares: { kind: "node", from: "id" } },
  link: { attributes: { to: { type: "mesh:Atom", ref: "node" } } },
  slot: {
    attributes: { name: { type: "mesh:Atom" } },
    declares: { kind: "slot", from: "name", uniqueWith: ["node"] },
  },
  scoped: {
    attributes: { name: { type: "mesh:Atom" } },
    declares: { kind: "item", from: "name", scope: ["list", "grid"] },
  },
  list: {},
  item: {
    attributes: { name: { type: "mesh:Atom" } },
    declares: { kind: "item", from: "name", scope: "list" },
  },
  pick: { attributes: { of: { type: "mesh:Atom", ref: "item" } } },
  derive: deriving("node", "made"),
  "derive-scoped": deriving("node", "lost", "nowhere"),
  "derive-list": deriving("item", "auto", "list"),
};

export const nodes = (names: readonly string[]) =>
  names.map((name) => `<node#${name}/>`).join("");

/** Sources the built-in path rejects: the module must reject them identically. */
export const FAILING: readonly string[] = [
  "<box mode=:strct/>",
  "<box mode=:zzzzzz/>",
  "<box slug=:ab-c/>",
  "<box both=:b9/>",
  "<box both=:c3/>",
  "<box modes=[:strict, :lose]/>",
  "<box mode=(c ? :strict : :lose)/>",
  "<box many=:zz/>",
  "<box many=:alpah/>",
  "<box ten=:zz/>",
  "<box mode='strict'/>",
  "<box mode=1/>",
  "<link to='a'/>",
  `${nodes(["a", "b"])}<link to="c"/>`,
  `${nodes(["a"])}<link to=:b/>`,
  `${nodes(["alpha"])}<link to=:alpah/>`,
  `${nodes(NAMES)}<link to=:zz/>`,
  `${nodes(["a"])}\n<node#a/>`,
  `<entity>\n  <attributes><string :a/></attributes>\n</entity>\n<slot :a/><node#a/>`,
  "<node#a/><slot :a/>",
  "<scoped :q/>",
  "<derive-scoped/>",
  "<derive/><node#made/>",
  "<list><item :a/></list><pick of=:a/>",
  "<list><item :a/></list><list><item :b/><pick of=:a/></list>",
  "<list><derive-list/><pick of=:autoo/></list>",
  `<entity :invoice>
  <attributes>
    <string :title/>
    <string :body/>
  </attributes>
  <policy accept=[:title, :bdy]/>
</entity>`,
  `<entity :invoice>
  <relationships><has-many :items/></relationships>
  <attributes><string :title/><calc :total/></attributes>
  <policy load=[:items, :title]/>
</entity>`,
  `<entity :invoice>
  <attributes><string :status/></attributes>
  <actions>
    <action :pay>
      <set>
        <setter :statuss="paid"/>
      </set>
    </action>
  </actions>
</entity>`,
  `<entity :invoice>
  <attributes><string name="title"/></attributes>
</entity>`,
  `<entity :invoice>
  <attributes><string :title/></attributes>
  <actions>
    <action :rename>
      <arguments><string :newTitle/></arguments>
    </action>
    <action :other>
      <policy require=[:newTitle]/>
    </action>
  </actions>
</entity>`,
  `<entity>
  <attributes><string :title/><string :body/><string :tag/></attributes>
  <policy only=:tag/>
  <policy shaped=:body/>
</entity>`,
  `<entity>\n  <attributes><string :title/></attributes>\n  <policy accept="title"/>\n</entity>`,
  "<box><@row mode=:c/></box>",
  `${nodes(["n"])}<box><@row to=:m/></box>`,
  "<box><@row><@cell k=:z/></@row></box>",
  "<box><@row><@cell ks=[:x, :w]/></@row></box>",
  `${nodes(["n"])}<box><@col-1 to=:nn/></box>`,
  `${nodes(["n"])}<box><@col-1 to="n"/></box>`,
  // Review 466 B1: a plain string against a `ref` atom, alone, after a
  // module error, and with no declarations; a bare atom and a `values` atom.
  '<link to="red"/>',
  `${nodes(["a"])}<link to=:zz/><link to="red"/>`,
  `${nodes(["a"])}<link to="red"/><link to=:zz/>`,
  '<box any="red"/>',
  '<box mode="red"/>',
];

/** Sources the built-in path accepts. */
export const PASSING: readonly string[] = [
  "<box mode=:strict slug=:abc both=:a1/>",
  "<box modes=[:strict, :loose]/>",
  `${nodes(["a"])}<link to=:a/>`,
  "<link to=:later/><node#later/>",
  "<list><item :a/><pick of=:a/></list>",
  "<list><derive-list/><pick of=:auto/></list>",
  "<derive/><link to=:made/>",
  `<entity :invoice>
  <attributes><string :title/></attributes>
  <actions>
    <action :rename>
      <arguments><string :newTitle/></arguments>
      <policy require=[:title, :newTitle]/>
    </action>
  </actions>
</entity>`,
  `${nodes(["n"])}<box><@row mode=:a to=:n><@cell k=:x/></@row><@col-2 to=:n/></box>`,
];

/** Registration errors core raises for the claimed keys; the module raises them file-level. */
export const REGISTRATION: ReadonlyArray<
  readonly [string, Record<string, CustomTag>]
> = [
  ["values", { box: { attributes: { a: { type: "string", values: ["a"] } } } }],
  ["pattern", { box: { attributes: { a: { type: "string", pattern: "a" } } } }],
  ["ref", { box: { attributes: { a: { ref: "k" } } } }],
  ["bad values", { box: { attributes: { a: { type: "mesh:Atom", values: [1] } } } }],
  [
    "bad pattern",
    { box: { attributes: { a: { type: "mesh:Atom", pattern: "(" } } } },
  ],
  ["bad ref", { box: { attributes: { a: { type: "mesh:Atom", ref: [] } } } }],
  [
    "nested values",
    {
      box: {
        attributeTags: {
          row: { attributes: { a: { type: "string", values: ["a"] } } },
        },
      },
    },
  ],
  [
    "wildcard values",
    {
      box: {
        attributeTags: {
          "*": {
            pattern: "r.*",
            attributes: { a: { type: "string", values: ["a"] } },
          },
        },
      },
    },
  ],
  ["declares from", { box: { declares: { kind: "k", from: "nope" } } }],
  ["declares kind", { box: { declares: { from: "name" } } }],
  [
    "declares key",
    { box: { declares: { kind: "k", from: "id", scoped: "x" } } },
  ],
  ["declares empty", { box: { declares: [] } }],
  ["declares entry", { box: { declares: [1] } }],
  [
    "declares scope",
    { box: { declares: { kind: "k", from: "id", scope: "" } } },
  ],
  [
    "declares uniqueWith",
    { box: { declares: { kind: "k", from: "id", uniqueWith: "x" } } },
  ],
  [
    "unknown key beside the claimed ones",
    { box: { attributes: { a: { type: "mesh:Atom", bogus: 1 } } } },
  ],
  [
    "inline children contract",
    {
      box: {
        children: {
          "*": [
            { pattern: "a-.*", contract: "box" },
            { pattern: "b-.*", attributes: { a: { pattern: "x" } } },
          ],
        },
      },
    },
  ],
  [
    "attribute tag inside an inline children contract",
    {
      box: {
        children: {
          "*": {
            pattern: "b-.*",
            attributeTags: {
              row: { attributes: { a: { type: "mesh:Atom", ref: "" } } },
            },
          },
        },
      },
    },
  ],
] as unknown as ReadonlyArray<readonly [string, Record<string, CustomTag>]>;
