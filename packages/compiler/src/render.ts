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
  readonly contents: string;
}

const edge = Edge.create({ cache: false });

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
