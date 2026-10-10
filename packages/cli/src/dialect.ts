/**
 * The entry of Mesh's dialect module: `scripts/build-dialect.ts` bundles it to `dist/dialect.js`,
 * which `mx.dialect.module` in this package's `package.json` names. MX loads that file with Node, so
 * it must be built JavaScript with nothing left to resolve; this re-export is the only source.
 */
export { MESH_DIALECT as default } from "@meshfw/compiler/dialect";
