/**
 * The seam between the language-neutral front end (`../front-end/`, MX IR to
 * `MeshModel`) and the back ends (`../typescript/`, the model to files).
 *
 * The model itself is the `@meshfw/model` package: plain data with nothing
 * about MX or about any output language. This folder holds the few things
 * both halves and the project shell (`../config.ts`) share that are not the
 * model: what a build takes and returns, and how a diagnostic is made.
 */
export { error, positionAt } from "./diagnostics.ts";
export type { BuildResult, EntityFile, ProjectDescription } from "./project.ts";
