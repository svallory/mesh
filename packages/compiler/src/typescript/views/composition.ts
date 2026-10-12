import type { EmitInput } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { orderedEntities } from "../emitters/order.ts";
import { actionsView } from "./actions.ts";
import { hasLoader } from "./load.ts";
import { entityInputs, entityPath, typeName } from "./inputs.ts";
import { hasTxLoadable, txLoadTypes } from "./types.ts";

/**
 * What `composition.ts.jig` renders: `.mesh/composition.ts`, the types of `actions` and `tx` (ADR-0068). Types only,
 * importing nothing but the entities' types files, so the expressions files can name them without importing the
 * index or another entity's actions. Every string is final; the template prints and loops.
 */
export interface CompositionView {
  /** True when some action exists: only then does the file import `ActionContext`. */
  readonly hasActions: boolean;
  /** Type imports from the entities' types files, in entity order: only the names the signatures use. */
  readonly imports: readonly { readonly names: string; readonly fromLiteral: string }[];
  /** One member of `Actions` per action function, in the order of the index. */
  readonly actions: readonly CompositionFunction[];
  /** One member of `Reads` per read action, in the same order. */
  readonly reads: readonly CompositionFunction[];
}

/** `readonly <name>: <generics>(input: <inputType>...) => Promise<<returnType>>;` */
export interface CompositionFunction {
  /** The top-level function name, e.g. `createPost`. */
  readonly name: string;
  /** The type parameter list as printed (a read that takes `load`: `<const N extends keyof PostLoadable = never>`), or the empty string. */
  readonly generics: string;
  /** The input type, e.g. `CreatePostInput`, or `ReadPostInput<N>`. */
  readonly inputType: string;
  /** The resolved type, e.g. `Post`, `Post[]` or `PostWith<"comments">`. */
  readonly returnType: string;
  /**
   * The result a function of an entity file sees: deeply read-only. A read generic in its load names is
   * `readonly ($DeepReadonly<Record> & Pick<$DeepReadonly<RecordLoadable>, RecordLoadNames<L>>)[]` and not `$DeepReadonly<RecordWith<N>[]>`,
   * because a deep-readonly conditional type over the generic `N` cannot be related to its mutable twin, and the plain
   * `Reads` must stay assignable to `ReadOnlyReads`.
   */
  readonly readOnlyReturnType: string;
}

/** The type names `composition.ts` and the index declare, which no entity type may take. */
export const COMPOSITION_TYPES: readonly string[] = Object.freeze(["Actions", "Reads", "ReadOnlyActions", "ReadOnlyReads"]);

const IDENTIFIERS = /[A-Za-z_$][A-Za-z0-9_$]*/g;

export function compositionView(input: EmitInput): CompositionView {
  const { document } = input;
  const actions: CompositionFunction[] = [];
  const reads: CompositionFunction[] = [];
  const imports: { names: string; fromLiteral: string }[] = [];
  for (const entity of orderedEntities(document)) {
    const view = actionsView(input, entity);
    const record = typeName(entity.name, entity.position);
    const own = new Set([record, ...entityInputs(entity, document).map((i) => i.name), ...(hasLoader(entity) ? [`${record}Loadable`, `${record}With`, `${record}LoadNames`, `${record}LoadArg`] : []), ...(hasTxLoadable(entity) ? [`${record}TxLoadable`, `${record}TxWith`] : [])]);
    for (const name of own)
      if (COMPOSITION_TYPES.includes(name))
        throw emitError("MESH_EMIT_NAME", `Entity ${entity.fqn} would generate the type ${name}, which .mesh/composition.ts declares and #mesh exports for \`actions\` and \`tx\``, entity.position, "Rename the entity or the action");
    const used = new Set<string>();
    const tx = txLoadTypes(entity);
    for (const method of view.methods) {
      const readOnly = (loadable: string, returnType: string) => method.isRead && method.generics
        ? `(L extends unknown ? readonly ($DeepReadonly<${record}> & Pick<$DeepReadonly<${loadable}>, ${record}LoadNames<L>>)[] : never)`
        : `$DeepReadonly<${returnType}>`;
      const fn = { name: method.functionName, generics: method.generics, inputType: method.inputType, returnType: method.returnType, readOnlyReturnType: readOnly(`${record}Loadable`, method.returnType) };
      actions.push(fn);
      // `tx` runs no policy (ADR-0068): what its reads load is typed as a load through it.
      const read = { ...fn, returnType: method.txReturnType, readOnlyReturnType: readOnly(tx.loadable, method.txReturnType) };
      if (method.isRead) reads.push(read);
      for (const name of `${method.generics} ${method.inputType} ${method.returnType} ${fn.readOnlyReturnType} ${method.isRead ? `${read.returnType} ${read.readOnlyReturnType}` : ""}`.match(IDENTIFIERS) ?? []) if (own.has(name)) used.add(name);
    }
    if (used.size) imports.push({ names: [...own].filter((name) => used.has(name)).join(", "), fromLiteral: JSON.stringify(`./${entityPath(entity)}.types`) });
  }
  return { hasActions: actions.length > 0, imports, actions, reads };
}
