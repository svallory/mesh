/**
 * `lowerMesh`: `lowerSource` plus the one check that no dialect hook can make.
 *
 * Since MX 0.1.0-alpha.17 a colon in a tag head is part of the name (`uuid:id`, `<string:title/>`, `entity:Todo` and
 * `<:x/>` are one tag name each), so such a tag is an unknown tag to MX, not a call with a name. A dialect's `afterLower`
 * sees only the tags a contract names (`LoweredUnit.calls`), so Mesh cannot refuse the form there. This reads the lowered
 * tree instead: a tag name with a `:` at any index is `MESH_UNSPACED_NAME`, Mesh's own error, since a line is
 * `kind :name`. It reads the IR only, never the source text.
 *
 * Under `unknownTags: "reject"` MX returns no IR for such a file, so the tags are read from a second lowering with the
 * contracts and rejections off. That lowering runs only when the first one failed.
 */
import { lowerSource, type IrDiagnostic, type LowerSourceOptions, type LowerSourceResult } from "@mxlang/core";
import type { Tag } from "./tree.ts";

type Node = NonNullable<LowerSourceResult["ir"]>["body"][number];

/** A tag whose name holds a colon, with the tag that holds it (for the default tag of its contract). */
interface Unspaced {
  readonly tag: Tag;
  readonly parent: string | undefined;
}

function collect(nodes: readonly Node[], parent: string | undefined, found: Unspaced[]): void {
  for (const node of nodes) {
    if (node.kind !== "DelegatedTag") continue;
    if (node.tag.name.includes(":")) found.push({ tag: node.tag, parent });
    collect(node.tag.children as readonly Node[], node.tag.name, found);
  }
}

/** The message, from the tag name alone: `uuid:id` is written `uuid :id`; `:x` has no kind, the parent's default tag names it. */
function message(name: string, defaultTag: string | undefined): string {
  const colon = name.indexOf(":");
  const kind = name.slice(0, colon);
  if (kind === "") {
    if (defaultTag === undefined)
      return `MESH_UNSPACED_NAME: \`${name}\` is a name with no tag before it; Mesh writes a tag, a space, then the name: \`kind ${name}\``;
    return `MESH_UNSPACED_NAME: \`${name}\` writes the name against the tag; Mesh writes a name after a space: \`${defaultTag} ${name}\``;
  }
  return `MESH_UNSPACED_NAME: \`${name}\` writes the name against the tag; Mesh writes a name after a space: \`${kind} ${name.slice(colon)}\``;
}

/**
 * MX answers the same tag with its own errors: "is not a known tag" and, inside a closed parent, "is not allowed here".
 * Mesh's error replaces them. The match is on MX's message text and the tag's offset, like the unknown-tag match in
 * `buildModel`; MX gives these no code.
 */
function restates(d: IrDiagnostic, name: string, offset: number): boolean {
  return d.offset === offset && (d.message.startsWith(`\`<${name}>\` is not a known tag`) || d.message.includes(`\`<${name}>\` is not allowed here`));
}

export function lowerMesh(source: string, file: string, options: LowerSourceOptions): LowerSourceResult {
  const lowered = lowerSource(source, file, options);
  let ir = lowered.ir;
  if (!ir) {
    // The first lowering failed, perhaps because of the very tags this looks for: read them with no contracts and
    // no rejection, so only a syntax error stops the tree (and then there is nothing to read).
    const { unknownTags: _unknown, structural: _structural, customTags: _contracts, ...open } = options;
    ir = lowerSource(source, file, open).ir;
  }
  if (!ir) return lowered;
  const found: Unspaced[] = [];
  collect(ir.body, undefined, found);
  if (found.length === 0) return lowered;
  const mine = found.map(({ tag, parent }): IrDiagnostic => {
    const offset = tag.nameSpan.sourceStart;
    return {
      severity: "error",
      message: message(tag.name, parent === undefined ? undefined : options.customTags?.[parent]?.defaultTag),
      line: tag.loc.line,
      column: tag.loc.column + (offset - tag.span.sourceStart),
      offset,
      code: "MESH_UNSPACED_NAME",
    };
  });
  const kept = lowered.diagnostics.filter((d) => !found.some(({ tag }) => restates(d, tag.name, tag.nameSpan.sourceStart)));
  const diagnostics = [...kept, ...mine].sort((a, b) => a.offset - b.offset);
  return { ir: undefined, diagnostics };
}
