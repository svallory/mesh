import type { MessageTag } from "@mxlang/core";

/**
 * How a message spells a tag: as the user wrote its line head (`Dialect.messageVocabulary.formatTag`, MX alpha.29). A tag the
 * dialect's own trigger made (`&title`, which lowers to a `member` tag) prints as written; any other tag prints its name
 * (`attributes`, `belongs-to`); an `@name` attribute tag prints with its `@` (core's `name` has none); a dynamic head prints as a
 * Mesh file writes it, `${expr}`. Never throws; the result is non-empty, one line and without backticks (MX refuses anything
 * else as `MX_DIALECT_HOOK_ERROR`), so an odd name gives `undefined` and MX's own spelling stands.
 */
export function formatTag(tag: MessageTag): string | undefined {
  const written = tag.trigger?.text;
  const spelled =
    tag.form === "dynamic" ? `\${${tag.name}}` : written ?? (tag.form === "attributeTag" ? `@${tag.name}` : tag.name);
  return spelled.trim() === "" || /[`\r\n]/.test(spelled) ? undefined : spelled;
}

/** A tag Mesh's own hook messages name, in backticks, spelled as `formatTag` spells it (`<name>` when it cannot). */
export function tagLabel(name: string, form: MessageTag["form"] = "tag"): string {
  return `\`${formatTag({ name, form }) ?? `<${name}>`}\``;
}
