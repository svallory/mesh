import contracts, { ATTRIBUTE_TYPES } from "../src/front-end/contracts.ts";
import { MESH_EXTENSIONS } from "../src/front-end/extensions.ts";

interface Node { line: string; children: Node[] }
const node = (line: string, children: Node[] = []): Node => ({ line, children });
const defaults: Record<string, string> = { entity: "entity :Sample", create: "create :work", read: "read :work", update: "update :work", destroy: "destroy :work", policy: "policy :rule" };

/** Put an actual table cell in its declared context; never rewrite its syntax. */
export function coverageProject(tag: string, option: string | undefined, example: string) {
  // An event or a command is the root of a file of its own: the example is the whole file.
  if (tag === "event" || tag === "command") return { root: "/project", files: [{ file: "docs/sample.mesh.mx", source: `${example}\n  uuid :id\n` }] };
  // A mixin is the root of a file of its own, whose body is a section: `uuid` is no child of `mixin`.
  if (tag === "mixin") return { root: "/project", files: [{ file: "docs/sample.mesh.mx", source: `${example}\n  attributes\n    uuid :x\n` }] };
  // A concept is the root of a file of its own, directly in a `concepts` folder and named after it, with one field line.
  if (tag === "concept") return { root: "/project", files: [{ file: "docs/concepts/Sample.mesh.mx", source: `${example}\n  uuid :id\n` }] };
  // An aggregate is the root of a file of its own: Sample is its root, and Line, tied to Sample by its one belongs-to, its part.
  if (tag === "aggregate" || tag === "root" || tag === "entities") {
    const lines = tag === "aggregate" ? [example, "  root entity=Sample"]
      : tag === "root" ? ["aggregate :Sales", `  ${example}`]
      : ["aggregate :Sales", "  root entity=Sample", ...(option === "reference" ? ["  entities", `    ${example}`] : [`  ${example}`, "    Line"])];
    return { root: "/project", files: [
      { file: "docs/sales.mesh.mx", source: `import { Sample } from "./sample.mesh.mx"\nimport { Line } from "./line.mesh.mx"\n${lines.join("\n")}\n` },
      { file: "docs/sample.mesh.mx", source: "entity :Sample\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n" },
      { file: "docs/line.mesh.mx", source: 'import { Sample } from "./sample.mesh.mx"\nentity :Line\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :owner entity=Sample\n' },
    ] };
  }
  // The architecture file is a file of its own at the domain root, the virtual project root here. `use` is placed by its
  // text, never by its tag alone: a `use` that includes a mixin (`mixin=`) belongs to an entity, below.
  if (tag === "architecture" || tag === "severity" || tag === "disable" || (tag === "use" && example.includes("preset="))) {
    const file = `architecture${MESH_EXTENSIONS[0]}`;
    const source = tag === "architecture" ? `${example}\n` : `import { MeshRecommended } from "meshfw/architecture"\narchitecture :project\n  ${example}\n`;
    return { root: "/project", files: [{ file, source }] };
  }
  // A surface file lives in the surfaces folder, in the folder named after its surface, and exposes the domain's Sample;
  // its `publishes` listing line lists the domain's event `Paid`.
  if (tag === "surface" || tag === "expose" || tag === "action" || tag === "publishes") {
    const lines = tag === "surface" ? [example]
      : tag === "expose" ? ["surface :admin", `  ${example}`]
      : tag === "publishes" ? ["surface :admin", option === "reference" ? `  publishes\n    ${example}` : `  ${example}`]
      : ["surface :admin", "  expose :samples entity=Sample", `    ${example}`];
    return { root: "/project", domainRoot: "domain", files: [
      { file: "domain/sample.mesh.mx", source: "entity :Sample\n  attributes\n    uuid :id primary-key\n    string :title\n  actions auto=[:read]\n" },
      { file: "domain/paid.mesh.mx", source: "event :Paid\n  uuid :id\n" },
    ], surfaces: { root: "surfaces", files: [
      { file: "surfaces/admin/admin.mesh.mx", source: `import { Sample } from "../../domain/sample.mesh.mx"\nimport { Paid } from "../../domain/paid.mesh.mx"\n${lines.join("\n")}\n` },
    ] } };
  }
  // A service file sits in the domain beside Sample and Line: its one operation uses both, so no one-entity warning.
  if (tag === "service" || tag === "operation" || tag === "uses") {
    const lines = [
      tag === "service" ? example : "service :Work",
      `  ${tag === "operation" ? example : "operation :close"}`,
      `    ${tag === "uses" ? example : "uses entity=Sample actions=[:read]"}`,
      "    uses entity=Line actions=[:read]",
      "    run() {}",
    ];
    return { root: "/project", files: [
      { file: "docs/work.mesh.mx", source: `import { Sample } from "./sample.mesh.mx"\nimport { Line } from "./line.mesh.mx"\n${lines.join("\n")}\n` },
      { file: "docs/sample.mesh.mx", source: "entity :Sample\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n" },
      { file: "docs/line.mesh.mx", source: "entity :Line\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n" },
    ] };
  }
  // A `use` that includes a mixin sits under Sample, which imports the project mixin beside it, `Stamp`.
  if (tag === "use") return { root: "/project", files: [
    { file: "docs/stamp.mesh.mx", source: "mixin :Stamp\n  attributes\n    string :note\n" },
    { file: "docs/sample.mesh.mx", source: `import { Stamp } from "./stamp.mesh.mx"\nentity :Sample\n  ${example}\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n` },
  ] };
  // The kind's contract is shared, but `optional` is legal only on a command's field. Keep the table cell as authored.
  if (option === "optional" && ATTRIBUTE_TYPES.includes(tag as typeof ATTRIBUTE_TYPES[number])) return { root: "/project", files: [
    { file: "docs/change.mesh.mx", source: `command :Change\n  uuid :id\n  ${example}\n` },
    { file: "docs/sample.mesh.mx", source: `import { Change } from "./change.mesh.mx"\nentity :Sample\n  attributes\n    uuid :id primary-key\n    ${tag} :field${tag === "enum" ? " values=[:draft, :sent]" : ""}\n  actions\n    update on=Change\n      input\n        &field\n` },
  ] };
  // A lock guards an update or a destroy and counts in a required integer: under `update :work`, on Sample's `version`.
  const attributes = node("attributes", [node("uuid :id primary-key"), node("string :title"), node("boolean :done"), ...(tag === "lock" ? [node("integer :version default=1")] : [])]);
  // A `has-one` example follows Line's only `belongs-to` back, which a `has-many` beside it could not follow too (`MESH_HAS_ONE_SHARED_KEY`).
  const relationships = node("relationships", tag === "has-one" ? [] : [node("has-many :lines entity=Line")]);
  // `&custom` is a read, which `on:load=`, a policy and a sort can name; an `always` block's `actions=` names no read
  // (`MESH_OPTION_VALUE`), so for that cell it is an update. Line reaches Sample through its `belongs-to`, so Sample has
  // the auto read a load runs (`MESH_ON_LOAD`), unless the cell is an `actions` line of its own.
  const actions = node("actions auto=[:read]", [node(tag === "always" && option === "actions" ? "update :custom" : "read :custom")]);
  // `check &valid` uses a check the entity's `checks` section declares.
  const named = tag === "check" && option === "member" ? [node("checks", [node('check :valid that=() => true code="invalid" message="Invalid input"')])] : [];
  const root = node("entity :Sample", [attributes, relationships, ...named, actions]);
  const chain = (option === "member" || option === "reference") && contracts[tag]!.children?.["*"] ? [tag, option] : [tag];
  let parent = ATTRIBUTE_TYPES.includes(tag as typeof ATTRIBUTE_TYPES[number]) && option === "value" ? "computed" : contracts[tag]!.parents![0]!;
  while (parent !== "#root") {
    chain.unshift(parent);
    parent = tag === "lock" && parent === "do" ? "update" : contracts[parent]!.parents![0]!;
  }
  let current = root;
  for (const name of chain.slice(1, -1)) {
    let child = current.children.find((child) => child.line.split(" ")[0] === name);
    if (!child) { child = node(defaults[name] ?? name); current.children.push(child); }
    current = child;
  }
  if (tag === "entity") root.line = example;
  else {
    const section = tag === "actions" ? actions : current.children.find((child) => child.line === tag);
    if (section) section.line = example;
    else current.children.push(node(example));
  }
  if (option === "primary-key") attributes.children.shift();
  const render = (entry: Node, indent = ""): string => indent + entry.line + "\n" + entry.children.map((child) => render(child, indent + "  ")).join("");
  // A `publish` raises an event the file imports: the project has one, `Paid`. An owner section's listing line lists one.
  const answers = option === "on" && ["create", "update", "destroy"].includes(tag);
  const listed = option === "reference" && (tag === "events" || tag === "commands");
  // A handler line's `on=` names an event the file imports: the same `Paid`.
  const handles = tag === "process" || tag === "listen";
  const paid = tag === "publish" || answers || listed || handles ? 'import { Paid } from "./paid.mesh.mx"\n' : "";
  // `through=` names a link entity with a belongs-to to each side: the project has one, `Tie`.
  const tie = tag === "has-many" && option === "through";
  return { root: "/project", files: [
    ...(tag === "publish" || handles || (listed && tag === "events") ? [{ file: "docs/paid.mesh.mx", source: "event :Paid\n  uuid :id\n" }] : []),
    ...(listed && tag === "commands" ? [{ file: "docs/paid.mesh.mx", source: "command :Paid\n  uuid :id\n" }] : []),
    // `on=` answers a command: its fields are the action's inputs, and a create has none, nor the key an update and a destroy select by.
    ...(answers ? [{ file: "docs/paid.mesh.mx", source: `command :Paid\n${tag === "create" ? "" : "  uuid :id\n"}` }] : []),
    ...(tie ? [{ file: "docs/tie.mesh.mx", source: 'import { Sample } from "./sample.mesh.mx"\nimport { Line } from "./line.mesh.mx"\nentity :Tie\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :sample entity=Sample\n    belongs-to :line entity=Line\n  actions auto=[:read]\n' }] : []),
    { file: "docs/sample.mesh.mx", source: paid + (tie ? 'import { Tie } from "./tie.mesh.mx"\n' : "") + 'import { Line } from "./line.mesh.mx"\n' + render(root) },
    // A relate names Line's actions: a create that takes the inverse `&owner`, an update and a destroy.
    { file: "docs/line.mesh.mx", source: 'import { Sample } from "./sample.mesh.mx"\nentity :Line\n  attributes\n    uuid :id primary-key\n    decimal :amount\n    date :dueOn\n  relationships\n    belongs-to :owner entity=Sample nullable\n  actions auto=[:read]\n'
      + (tag === "relate" ? "    create :add\n      input\n        &owner\n        &amount\n        &dueOn\n    update :rename\n      input\n        &amount\n    destroy :remove\n" : "") },
  ] };
}
