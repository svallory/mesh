// Helpers for the corpus tests: `parseEntity` lowers a source as `parseEntitySource` (`src/front-end/build.ts`) does, with the
// frozen contracts of the corpus (see fixtures/mesh-corpus/README.md), and `corpusFiles` lists the corpus.
import { lowerSource, type CustomTag, type Dialect, type LowerSourceResult } from "@mxlang/core";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { deepFreeze } from "../src/front-end/deep-freeze.ts";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";

export const CORPUS = join(import.meta.dir, "fixtures/mesh-corpus");
export const GOLDEN = join(CORPUS, "__golden__/golden.json");
// The frozen contracts are loaded by path, not imported: they are typed against MX's API of their day (`type: "atom"`,
// `Attr.atom`), which MX 0.1.0-alpha.33 removed, so the type check leaves them out (`exclude` in `tsconfig.json`) and
// `migrateVocabulary` reads them as alpha.34 needs.
const FROZEN_CONTRACTS: string = join(CORPUS, "contracts.ts");
const contracts = migrateVocabulary((await import(FROZEN_CONTRACTS)).default as Record<string, CustomTag>);

/**
 * The frozen contracts, read under MX 0.1.0-alpha.34. They were written for core's `type: "atom"`, which alpha.33
 * removed (an unknown `type` is `MX_INVALID_CONTRACT`), and for core's `type: "member"`, which alpha.34 removed; their
 * `analyze` reads a static attribute's `atom`, which alpha.33 replaced with `node` (a `mesh:Atom`), and the
 * `extra.mxMember` mark on a member's `self.name`, which alpha.34 no longer sets (a member is a `mesh:Member` node in
 * `Expr.nodes`). The file itself stays frozen; this reads it as alpha.34 needs, the way Mesh's live contracts
 * (`src/front-end/contracts.ts`) moved: a slot written as a list of atoms (`values`, `types`, `auto`) is
 * `{ type: "array", items: "mesh:Atom" }`, every other atom slot is `{ type: "mesh:Atom" }`, a member slot is
 * `{ type: "mesh:Member" }`, and each `analyze` hook sees a static attribute's `mesh:Atom` node as the `atom` it was
 * written against and an expression whose members carry the `extra.mxMember` mark it reads (on a copy: the IR the
 * golden records is left as lowered).
 */
function migrateVocabulary(frozen: Record<string, CustomTag>): Record<string, CustomTag> {
  const LISTS = new Set(["values", "types", "auto"]);
  type Declaration = { type?: unknown } & Record<string, unknown>;
  const attributes = (declared: Record<string, unknown> | undefined) =>
    declared &&
    Object.fromEntries(
      Object.entries(declared).map(([name, declaration]) => {
        const d = declaration as Declaration;
        if (d?.type === "member") return [name, { ...d, type: "mesh:Member" }];
        if (d?.type !== "atom") return [name, declaration];
        return [name, LISTS.has(name) ? { ...d, type: "array", items: "mesh:Atom" } : { ...d, type: "mesh:Atom" }];
      }),
    );
  type Analyze = NonNullable<CustomTag["analyze"]>;
  type Call = Parameters<Analyze>[0][number];
  /** A copy of `value` where each member forward carries the mark alpha.33 set: `extra.mxMember = { name, span }`. */
  const marked = (value: unknown, marks: ReadonlyMap<unknown, { name: string; span: unknown }>): unknown => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((each) => marked(each, marks));
    const copy = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "loc" ? v : marked(v, marks)]));
    const mark = marks.get(value);
    return mark ? { ...copy, extra: { ...(copy.extra as object | undefined), mxMember: mark } } : copy;
  };
  const withAtom = (call: Call): Call => ({
    ...call,
    attrs: call.attrs.map((a) => {
      if (a.kind === "dynamic" || a.kind === "bound") {
        const marks = new Map(
          (a.value.nodes ?? [])
            .filter((each) => each.type === "mesh:Member")
            .map((each) => [each.forward, { name: (each.node as unknown as { name: string }).name, span: each.span }] as const),
        );
        return marks.size ? ({ ...a, value: { ...a.value, node: marked(a.value.node, marks) } } as typeof a) : a;
      }
      const node = a.kind === "static" ? (a.node as { type?: string; name?: string; span?: unknown } | undefined) : undefined;
      return node?.type === "mesh:Atom" ? { ...a, atom: { kind: "atom", name: node.name, span: node.span } } : a;
    }),
  });
  return Object.fromEntries(
    Object.entries(frozen).map(([tag, contract]) => {
      const analyze = contract.analyze;
      return [
        tag,
        {
          ...contract,
          ...(contract.attributes ? { attributes: attributes(contract.attributes as Record<string, unknown>) } : {}),
          ...(analyze ? { analyze: ((calls, ctx) => analyze(calls.map(withAtom), ctx)) as Analyze } : {}),
        } as CustomTag,
      ];
    }),
  );
}

const withContracts = new WeakMap<Dialect, Dialect>();
/** The frozen contracts replace the live ones on the dialect; its strictness and tag rules stay the dialect's own. One object per dialect, deep-frozen, because MX (since alpha.22) checks a dialect once only when every plain object and array in it is frozen, and re-checks any other on every call (46 ms against 3 ms). */
function withCorpusContracts(dialect: Dialect): Dialect {
  let found = withContracts.get(dialect);
  if (!found) withContracts.set(dialect, (found = deepFreeze({ ...dialect, contracts })));
  return found;
}

/** `parseEntitySource` (`src/front-end/build.ts`) with the contracts of the corpus and the dialect as a parameter. */
export function parseEntity(source: string, file: string, dialect: Dialect = MESH_DIALECT): LowerSourceResult {
  return lowerSource(source, file, { dialect: withCorpusContracts(dialect) });
}

/** Every `.mesh.mx` file under the corpus, by its path relative to it, sorted. */
export function corpusFiles(dir = CORPUS): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...corpusFiles(path));
    else if (entry.name.endsWith(".mesh.mx")) files.push(relative(CORPUS, path));
  }
  return files.sort();
}
