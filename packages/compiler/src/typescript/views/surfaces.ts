import type { Entity, Exposure, Surface } from "@meshfw/model";
import type { EmitInput } from "../emit.ts";
import { emitError } from "../emit-error.ts";
import { effectiveActions, entityInputs, entityLocal, entityPath, propertyName, takesLoad, typeName } from "./inputs.ts";
import { methodSignature } from "./actions.ts";
import { globalsImport, type GlobalsImport } from "./globals.ts";
import { entityFileComment } from "./types.ts";

/** The folder below the output directory that holds one folder per surface. */
export const SURFACES_FOLDER = "surfaces";

/**
 * What `surface.ts.jig` renders for one surface: `<output>/surfaces/<name>/index.ts`, the surface's manifest, which a
 * project imports as `#mesh/surfaces/<name>` and a reader (an adapter) reads at run time (ADR-0077, ruling D41). It exports
 * `surface`, made with `defineSurface` from `@meshfw/runtime`: per expose line, the entity's FQN, its label, the record
 * properties that may leave, and one `run` per listed action that calls the entity value's method with the caller's
 * context and returns its result projected to those properties (`project`); a listed read first refuses a filter, sort or
 * load outside them (`checkRead`). Every string is final; the template prints and loops. A project's own
 * `surface.ts.jig` depends on this shape.
 */
export interface SurfaceView {
  /** The surface file, project-relative, line terminators escaped as `\uXXXX`: printed in a comment. */
  readonly surfaceFile: string;
  /** The surface's name as written (`admin`): printed in a comment. */
  readonly name: string;
  /** The surface's name as a quoted string literal: the manifest's `name`. */
  readonly nameLiteral: string;
  /** What application code imports the manifest as, e.g. `#mesh/surfaces/admin`: printed in a comment. */
  readonly specifier: string;
  /** What the file imports from `@meshfw/runtime`, as printed inside `import { ... }`, sorted, each under a `$` alias. */
  readonly runtimeImports: readonly string[];
  /** The globals the file names (`$Omit`, `$Promise`), from `$globals.ts`; null when it names none. */
  readonly globals: GlobalsImport | null;
  /** One entry per expose line that lists an action: the entity value and the types its actions read. */
  readonly entityImports: readonly SurfaceEntityImport[];
  /** One entry per expose line, in written order. */
  readonly exposures: readonly SurfaceExposureView[];
  /** The FQNs of the events the surface sends out (its `publishes` section), in written order, each a quoted string literal; empty without the section. */
  readonly publishes: readonly string[];
}

/** `import { Task as $work$Task$value } from "../../domain/work/task.actions";` and the type import beside it. */
export interface SurfaceEntityImport {
  /** The entity value as imported, e.g. `Task as $work$Task$value`. */
  readonly value: string;
  /** The actions file as a quoted string literal, e.g. `"../../domain/work/task.actions"`. */
  readonly actionsFromLiteral: string;
  /** The types the actions read, each `Name as $local`, sorted by name; empty for none. */
  readonly types: readonly string[];
  /** The types file as a quoted string literal, e.g. `"../../domain/work/task.types"`. */
  readonly typesFromLiteral: string;
}

/** One expose line of the manifest. */
export interface SurfaceExposureView {
  /** What the line is, for a comment: `expose :tasks, work.Task`. */
  readonly comment: string;
  /** The exposed name as an object key (`tasks`; the `expose` contract holds it to an identifier, `propertyName` quotes it regardless). */
  readonly key: string;
  /** The entity's FQN as a quoted string literal. */
  readonly entityLiteral: string;
  /** `label=`, else the exposed name, as a quoted string literal. */
  readonly labelLiteral: string;
  /** The module-level constant of the properties that leave, e.g. `$0$fields`. */
  readonly fieldsLocal: string;
  /** Those properties as an array literal in the entity's declaration order (a belongs-to as its key column): `["id", "authorId"]`. */
  readonly fieldsLiteral: string;
  /** The type of one of them, e.g. `$0$Fields`; null when the line lists no action, which is the only reader of it. */
  readonly fieldsType: string | null;
  /** The constant of the listed computed fields a read may load, e.g. `$0$loadable`; null when the line lists no read. */
  readonly loadableLocal: string | null;
  /** Those computed fields as an array literal, e.g. `["excerpt"]`. */
  readonly loadableLiteral: string;
  /** `type $0$Loadable = keyof $blog$Post$PostLoadable & $0$Fields;` as printed, or null when no listed read takes `load`. */
  readonly loadableTypeLine: string | null;
  /** One per action line, in written order. */
  readonly actions: readonly SurfaceActionView[];
}

/** `<key>: { kind, async run<generics>(input: <inputType>, ...context: $ContextArgument): $Promise<<returnType>> { <statements> } }` */
export interface SurfaceActionView {
  /** The action's name as an object key. */
  readonly key: string;
  /** The action's type as a quoted string literal (`"read"`). */
  readonly kindLiteral: string;
  /** The type parameter list as printed, or the empty string. */
  readonly generics: string;
  /** The input's type as printed: the entity value's, a read's filter and sort narrowed to the properties that leave. */
  readonly inputType: string;
  /** The resolved type as printed: the entity value's result, projected. */
  readonly returnType: string;
  /** The body, each statement in full. */
  readonly statements: readonly string[];
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const member = (object: string, name: string) => (IDENTIFIER.test(name) ? `${object}.${name}` : `${object}[${JSON.stringify(name)}]`);
/** A double-quoted string literal, as `JSON.stringify` prints one: the load names in a type, which are never renamed. */
const STRING = /"(?:[^"\\]|\\.)*"/g;

/**
 * The record properties an expose line lets leave, in the entity's declaration order: attributes, then each
 * `belongs-to`'s key column, then computed fields (OD3 (b)); `:all` is every one of them. The order is the entity's, not
 * the written list's, so reordering `fields=` changes nothing generated.
 */
export function exposedProperties(entity: Entity, fields: Exposure["fields"]): { properties: string[]; computed: string[] } {
  const listed = (name: string) => fields === "all" || fields.includes(name);
  const computed = entity.computed.filter(({ name }) => listed(name)).map(({ name }) => name);
  const properties = [
    ...entity.attributes.filter(({ name }) => listed(name)).map(({ name }) => name),
    ...entity.relationships.filter((relation) => relation.kind === "belongs-to" && relation.keyColumn && listed(relation.name)).map((relation) => relation.keyColumn!),
    ...computed,
  ];
  return { properties, computed };
}

/** `../../domain/work/task` from `<output>/surfaces/<name>/index.ts`. */
const fromSurface = (path: string) => `../../${path}`;

export function surfaceView({ document }: EmitInput, surface: Surface): SurfaceView {
  const runtime = new Set<string>(["defineSurface as $defineSurface"]);
  const entityImports: SurfaceEntityImport[] = [];
  const exposures = surface.expose.map((exposure, index): SurfaceExposureView => {
    const entity = document.entities.find((candidate) => candidate.fqn === exposure.entity);
    if (!entity) throw emitError("MESH_EMIT_NAME", `Surface ${surface.name} exposes ${exposure.entity}, which the model does not hold`, exposure.position);
    const recordName = typeName(entity.name, entity.position);
    // Locals are numbered by line, not named after the exposure: short, and stable when a line is renamed.
    const local = `$${index}`;
    const { properties, computed } = exposedProperties(entity, exposure.fields);
    const fieldsLocal = `${local}$fields`;
    const fieldsType = `${local}$Fields`;
    const loadableLocal = `${local}$loadable`;
    const loadableType = `${local}$Loadable`;
    const value = entityLocal(entity, "value");
    // Every type the printed signatures read from the entity's types file, renamed to its FQN-derived local, so that two
    // exposed entities with one name in two modules never import one name twice.
    const types = new Map<string, string>();
    const rename = (printed: string, names: readonly string[]) => {
      const pattern = new RegExp(`(?<![\\w$])(${[...new Set(names)].sort((a, b) => b.length - a.length).join("|")})(?![\\w$])`, "g");
      // Only a name the printed type reads is imported, each under one local.
      const local = (name: string) => {
        if (!types.has(name)) types.set(name, entityLocal(entity, name === recordName ? "Record" : name));
        return types.get(name)!;
      };
      // Split around string literals: a load name inside quotes is never a type.
      let out = "";
      let at = 0;
      for (const match of printed.matchAll(STRING)) {
        out += printed.slice(at, match.index).replace(pattern, local) + match[0];
        at = match.index! + match[0].length;
      }
      return out + printed.slice(at).replace(pattern, local);
    };
    const inputs = entityInputs(entity, document);
    const effective = effectiveActions(entity);
    let readListed = false;
    let readLoads = false;
    const actions = exposure.actions.map((listed): SurfaceActionView => {
      const at = effective.findIndex((action) => action.name === listed.name);
      if (at < 0) throw emitError("MESH_EMIT_NAME", `Surface ${surface.name} lists :${listed.name}, which is not an action of ${entity.fqn}`, listed.position);
      const action = effective[at]!;
      const input = inputs[at]!;
      const signature = methodSignature(entity, action, input);
      const names = [recordName, ...signature.typeNames];
      runtime.add("project as $project").add("type ContextArgument as $ContextArgument").add("type Projected as $Projected");
      const returnType = `$Projected<${rename(signature.returnType, names)}, ${fieldsType}>`;
      const call = member(value, action.name);
      if (action.kind !== "read")
        return {
          key: propertyName(action.name), kindLiteral: JSON.stringify(action.kind), generics: "",
          inputType: rename(signature.inputType, names), returnType,
          statements: [`return $project(await ${call}(input, ...context), ${fieldsLocal});`],
        };
      readListed = true;
      runtime.add("checkRead as $checkRead").add("type SurfaceReadInput as $SurfaceReadInput");
      const loads = takesLoad(input);
      if (loads) readLoads = true;
      // The read's filter and sort take only the properties that leave, and its `load` only the listed computed fields (R14a, OD12).
      const inputType = loads
        ? `$SurfaceReadInput<$Omit<${input.name}, "load">, ${fieldsType}> & ${recordName}LoadArg<L>`
        : `$SurfaceReadInput<${input.name}, ${fieldsType}>`;
      return {
        key: propertyName(action.name), kindLiteral: JSON.stringify(action.kind),
        generics: loads ? `<const L extends readonly ${loadableType}[] = readonly []>` : "",
        inputType: rename(inputType, names), returnType,
        statements: [
          `$checkRead(input, ${fieldsLocal}, ${loadableLocal});`,
          `return $project(await ${call}${loads ? "<L>" : ""}(input, ...context), ${fieldsLocal});`,
        ],
      };
    });
    // `keyof ... & Fields`, not `Extract<...>`: generated code names no global (`$globals.ts` has no `$Extract`).
    const loadableTypeLine = readLoads ? `type ${loadableType} = keyof ${rename(`${recordName}Loadable`, [`${recordName}Loadable`])} & ${fieldsType};` : null;
    if (actions.length) {
      const path = entityPath(entity);
      entityImports.push({
        value: `${recordName} as ${value}`,
        actionsFromLiteral: JSON.stringify(fromSurface(`${path}.actions`)),
        types: [...types].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, alias]) => `${name} as ${alias}`),
        typesFromLiteral: JSON.stringify(fromSurface(`${path}.types`)),
      });
    }
    return {
      comment: `expose :${exposure.name}, ${entity.fqn}`,
      key: propertyName(exposure.name),
      entityLiteral: JSON.stringify(entity.fqn),
      labelLiteral: JSON.stringify(exposure.label ?? exposure.name),
      fieldsLocal,
      fieldsLiteral: `[${properties.map((name) => JSON.stringify(name)).join(", ")}]`,
      fieldsType: actions.length ? fieldsType : null,
      loadableLocal: readListed ? loadableLocal : null,
      loadableLiteral: `[${computed.map((name) => JSON.stringify(name)).join(", ")}]`,
      loadableTypeLine,
      actions,
    };
  });
  const sorted = (names: Iterable<string>) => [...names].sort((a, b) => {
    const key = (text: string) => text.replace(/^type /, "");
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  });
  return {
    surfaceFile: entityFileComment(surface),
    name: surface.name,
    nameLiteral: JSON.stringify(surface.name),
    specifier: `#mesh/${SURFACES_FOLDER}/${surface.name}`,
    runtimeImports: sorted(runtime),
    // Only the printed code is scanned: the comments hold the author's names.
    globals: globalsImport(`${SURFACES_FOLDER}/${surface.name}/index`, exposures.map(({ actions, loadableTypeLine }) => ({ actions, loadableTypeLine })),
      exposures.some((exposure) => exposure.actions.length) ? ["Promise"] : [], true),
    entityImports,
    exposures,
    publishes: (surface.publishes ?? []).map((event) => JSON.stringify(event.fqn)),
  };
}
