// Mesh's dialect without its vocabulary or strictness: the syntax rows, the hooks and the tag rules, but no `contracts` and none of
// `structural`, `unknownTags` and `imports`. Since MX 0.1.0-alpha.21 (current: alpha.26) `MESH_DIALECT` carries those, so a test of the syntax alone (what
// `&x`, `:x` and the `kind :name` sugar lower to, for any tag) uses this one, as it used `MESH_DIALECT` before the move.
import type { Dialect } from "@mxlang/core";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";

const { contracts: _contracts, structural: _structural, unknownTags: _unknownTags, imports: _imports, ...syntaxOnly } = MESH_DIALECT;

export const SYNTAX_DIALECT: Dialect = Object.freeze(syntaxOnly);
