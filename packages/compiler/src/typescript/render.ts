/**
 * The one place Mesh imports Jig (ADR-0061). Jig's disk loader resolves `.edge`
 * files only, so Mesh reads its `*.ts.jig` templates itself and renders their text
 * with `renderRaw`; the path passed along is only what Jig names in its errors.
 * `{{ }}` prints values verbatim (Jig's `escape` is the identity), which generated
 * TypeScript needs: it holds `<`, `&`, quotes and backticks.
 */
import { Edge, EdgeError } from "@jig-lang/jig";
import { emitError } from "./emit-error.ts";

/** A template's text and the path it was read from, which render errors name. */
export interface Template {
  /** Where the template was read from: project-relative for a project's override, absolute for Mesh's own. */
  readonly path: string;
  /** The template's text, as read. */
  readonly contents: string;
}

const edge = Edge.create({ cache: false });

/**
 * Jig loops over `undefined` as over an empty list, so a project's template that loops over a view field the view
 * no longer has (`@each(m in record.old)`) builds and prints nothing. Jig has no strict mode, so the `@each` tag is
 * registered again (the extension API every Jig tag uses) with one extra statement before the loop: the macro
 * `meshLoopable` throws when the list is `undefined`, which Jig reports at the loop's line and column. `null` and
 * `[]` are values the view chose, and still loop zero times. The loop itself is Jig's own tag.
 */
const each = edge.tags.each!;
type Compile = Edge["tags"][string]["compile"];
edge.registerTag({
  ...each,
  compile(parser: Parameters<Compile>[0], buffer: Parameters<Compile>[1], token: Parameters<Compile>[2]) {
    const { expression } = parser.utils.generateAST(token.properties.jsArg, token.loc, token.filename);
    const list = parser.utils.stringify(parser.utils.transformAst((expression as { right: never }).right, token.filename, parser));
    buffer.writeStatement(`template.meshLoopable(${list}, ${JSON.stringify(token.properties.jsArg)})`, token.filename, token.loc.start.line);
    each.compile(parser, buffer, token);
  },
  boot(template) {
    each.boot?.(template);
    (template as { macro(name: string, fn: (...args: never[]) => void): void }).macro("meshLoopable", (list: unknown, loop: string) => {
      if (list === undefined)
        throw new Error(`\`@each(${loop})\` loops over \`${loop.replace(/^.*?\s+in\s+/s, "")}\`, which the view does not have: the template is written for another version of this view`);
    });
  },
});

/**
 * Render one template with a view as its state. A Jig error, at compile or at
 * render time, is a `MESH_TEMPLATE_RENDER` build error positioned on the template
 * at Jig's line and column and naming the generator.
 */
export async function renderTemplate(template: Template, view: object, generator: string): Promise<string> {
  try {
    return await edge.renderRaw(template.contents, { ...view }, template.path);
  } catch (cause) {
    if (!(cause instanceof EdgeError)) throw cause;
    const { line, col } = cause as EdgeError & { line?: number; col?: number };
    throw emitError(
      "MESH_TEMPLATE_RENDER",
      `Generator "${generator}" cannot render ${template.path}: ${cause.message}`,
      { file: template.path, line: line ?? 1, column: col ?? 0, offset: 0 },
      "Fix the template; it receives the view documented for this generator",
    );
  }
}
