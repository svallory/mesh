/**
 * The file extensions Mesh entity files carry: the one list the CLI, the
 * build's file discovery and the generators read. Nothing else may spell
 * `.mesh.mx`. Today it is `.mesh.mx` alone (operator, 2026-10-10); `.mesh`
 * may join it later, and adding an entry here is the whole change.
 *
 * It is also the `extensions` of Mesh's dialect registration (`mx.dialect` in
 * `meshfw`'s package.json, a separate change).
 */
export const MESH_EXTENSIONS: readonly string[] = Object.freeze([".mesh.mx"]);

/** Whether `path` names an entity file. */
export const hasMeshExtension = (path: string): boolean =>
  MESH_EXTENSIONS.some((extension) => path.endsWith(extension));

/** A glob matching every entity file below a folder. */
export const meshGlob: string =
  MESH_EXTENSIONS.length === 1
    ? `**/*${MESH_EXTENSIONS[0]}`
    : `**/*{${MESH_EXTENSIONS.join(",")}}`;

/** The extensions as prose for a message: `.mesh.mx`, or `.mesh.mx or .mesh`. */
export const meshExtensionsText: string = MESH_EXTENSIONS.join(" or ");
