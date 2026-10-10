import contracts, { ATTRIBUTE_TYPES } from "../src/front-end/contracts.ts";

interface Node { line: string; children: Node[] }
const node = (line: string, children: Node[] = []): Node => ({ line, children });
const defaults: Record<string, string> = { entity: "entity :Sample", create: "create :work", read: "read :work", update: "update :work", destroy: "destroy :work", policy: "policy :rule" };

/** Put an actual table cell in its declared context; never rewrite its syntax. */
export function coverageProject(tag: string, option: string | undefined, example: string) {
  const attributes = node("attributes", [node("uuid :id primary-key"), node("string :title"), node("boolean :done")]);
  const relationships = node("relationships", [node("has-many :lines entity=Line")]);
  const actions = node("actions", [node("read :custom")]);
  const root = node("entity :Sample", [attributes, relationships, actions]);
  const chain = option === "member" && contracts[tag]!.children?.["*"] ? [tag, "member"] : [tag];
  let parent = ATTRIBUTE_TYPES.includes(tag as typeof ATTRIBUTE_TYPES[number]) && option === "value" ? "computed" : contracts[tag]!.parents![0]!;
  while (parent !== "#root") {
    chain.unshift(parent);
    parent = contracts[parent]!.parents![0]!;
  }
  let current = root;
  for (const name of chain.slice(1, -1)) {
    let child = current.children.find((child) => child.line.split(" ")[0] === name);
    if (!child) { child = node(defaults[name] ?? name); current.children.push(child); }
    current = child;
  }
  if (tag === "entity") root.line = example;
  else {
    const section = current.children.find((child) => child.line === tag);
    if (section) section.line = example;
    else current.children.push(node(example));
  }
  if (option === "primary-key") attributes.children.shift();
  const render = (entry: Node, indent = ""): string => indent + entry.line + "\n" + entry.children.map((child) => render(child, indent + "  ")).join("");
  return { root: "/project", files: [
    { file: "docs/sample.mesh.mx", source: 'import { Line } from "./line.mesh.mx"\n' + render(root) },
    { file: "docs/line.mesh.mx", source: "entity :Line\n  attributes\n    uuid :id primary-key\n    decimal :amount\n    date :dueOn\n" },
  ] };
}
