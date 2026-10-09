export const SITE = "https://mesh.hyperlab.sh";

export function message(): string {
  return [
    "Mesh is coming soon.",
    "",
    "`bun create mesh` will create a Mesh project once the first release is out.",
    `Until then, read about Mesh at ${SITE}`,
  ].join("\n");
}
