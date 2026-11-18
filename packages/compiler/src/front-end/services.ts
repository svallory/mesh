import { basename, resolve } from "node:path";
import type { Argument, Diagnostic, Expression, Import, MemberRef, Operation, Policy, Service, ServiceUse, SourcePosition } from "@meshfw/model";
import {
  PROTOTYPE_SETTING_NAME,
  attributeReaders,
  fileImports,
  SERVICE_PACKAGES,
  importable,
  moduleOfFolder,
  readInputLines,
  readPolicyLine,
  referenceKind,
  type DeclarationKind,
  type DeclaredFile,
  type ParsedImport,
} from "./build.ts";
import { classNameOf, isClassName } from "../model/class-name.ts";
import { nearestName } from "./nearest-name.ts";
import { referenceText, resolveReference, writtenReference, type ReferenceKind, type ReferenceScope, type Resolution, type WrittenReference } from "./references.ts";
import { atomForwards, atomOf, attr, attrOffset, declaredName, expression, isMemberLine, nodeOf, readAt, readMemberLine, readMembers, tags, type Attr, type IrImport, type Tag } from "./tree.ts";

/** Where a resolved reference points, so that two spellings of one declaration compare equal (`Task`, `w.Task`). */
const targetKey = (file: string, resolved: Extract<Resolution, { ok: true }>) => `${resolve("/", file, "..", resolved.from)}\0${resolved.declared}`;

/** The message of a `self`, `before` or `&name` in a function of a service file. */
const NO_RECORD = (name: string) =>
  `\`${name}\` is not defined in a service function: a service has no record; read \`input\`, \`actor\` and \`context\`, and the entities through their values`;

/**
 * A service file (`notes/spec/other-file-kinds.md`, "Services"; services design, sections 3 and 5.1; ruling D42):
 * `service :Name`, one or more `operation` lines, each with its `uses` lines, its `input` and its `run` body, and an
 * optional `policies` section scoped to the operations. What needs the built entities (each `uses` line's FQN and the
 * actions it names, the one-entity warning, policies with no check) is `checkServices`' (`model/services.ts`).
 *
 * The file imports entity files, helper modules and `Mesh` from "meshfw" (OD-12): a binding of an event or a command,
 * from a file of its own or an owner's inline declaration, is `MESH_UNKNOWN_IMPORT` and binds nothing, so a reference
 * through it reports nothing more. An import of another service file binds nothing already (`fileImports`) and is the
 * import check's to report (`buildModel`). Every function is plain code (`ConvertContext.service`); the body is a `run`
 * step, the policies' functions `why: "service"`. A service has no record: `self`, `before` and `&name` in any of its
 * functions are `MESH_EXPR_FREE_VARIABLE`. A name the body writes for an entity, or a member of a namespace import, that
 * no `uses` line of the operation lists is `MESH_SERVICE_USES` at the `run` line (OD-4, the build half).
 */
export function buildService(
  root: Tag,
  irImports: readonly IrImport[],
  source: string,
  file: string,
  diagnostics: Diagnostic[],
  folder: string,
  importDetails: Map<Import, ParsedImport>,
  declaredFile: (from: string) => DeclaredFile | undefined,
): Service {
  const { at, pos, fail, ...readers } = attributeReaders(source, file, diagnostics);
  const written = declaredName(root);
  const name = classNameOf(written);
  if (!isClassName(name))
    fail("MESH_NAME", `Service :${written} makes no class name: Mesh drops each \`_\` and capitalises the letter after it, so the name needs a letter, such as :Work`, root);
  const { module, bareUnderscore } = moduleOfFolder(folder);
  if (bareUnderscore)
    fail("MESH_GROUP_NAME", `Group folder "_" has no name; write "_" followed by a name, such as "_services"`, root);
  for (const segment of module ? module.split("/") : []) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment))
      fail("MESH_MODULE_NAME", `Module segment ${JSON.stringify(segment)} must contain only letters, digits, - or _`, root);
  }
  const fqn = [...module.split("/").filter(Boolean), name].join(".");
  const service: Service = { name, fqn, file, module, imports: [], operations: [], policies: [], position: pos(root) };

  const { imports, importNames, duplicates, bindings } = fileImports(irImports, file, new Map(), importDetails, declaredFile, at, fail, SERVICE_PACKAGES);
  service.imports = imports;
  // The kind of declaration each binding stands for, as `buildEntity` reads it: a named import the declaration its imported
  // name names, a namespace alias every kind its file declares; a file the project lacks is an entity's (it is reported).
  const boundKinds = (entry: Import, index: number): readonly DeclarationKind[] => {
    if (entry.helper || entry.mesh) return [];
    const target = declaredFile(entry.from);
    if (!target) return ["entity"];
    if (entry.namespace) return [...new Set([target.kind, ...target.declares.map(({ kind }) => kind)])];
    const imported = entry.imported?.[index] ?? entry.identifiers[index]!;
    return [target.declares.find(({ name }) => name === imported)?.kind ?? target.kind];
  };
  const kept: typeof bindings = [];
  for (const binding of bindings) {
    const { entry, index, name: local } = binding;
    if (/^(\$|l\$)/.test(local)) {
      const localOffset = importDetails.get(entry)?.bindings[index]?.localOffset;
      fail("MESH_HELPER_NAME", `The ${entry.helper ? "helper" : entry.mesh ? "Mesh import" : "entity import"} name ${local} cannot start with $ or l$: generated code uses those prefixes for its own names`, localOffset === undefined ? entry.position : at(localOffset));
    }
    // An event or a command (OD-11, OD-12): a service owns none yet, so its file names none. A namespace import of an
    // entity file stays legal even when that file declares events inline: the alias names the file's entity.
    // A service file's import (OD-12) is reported once by the import loop; its alias binds nothing, so a `uses` line or
    // a body that names it draws no second error.
    if (declaredFile(entry.from)?.kind === "service") {
      importNames.delete(local);
      duplicates.add(local);
      continue;
    }
    const kinds = boundKinds(entry, index);
    const refused = entry.namespace
      ? (["event", "command"] as const).find((kind) => declaredFile(entry.from)?.kind === kind)
      : (["event", "command"] as const).find((kind) => kinds.includes(kind));
    if (refused) {
      const declared = entry.namespace ? importable(declaredFile(entry.from))?.[0]?.name ?? local : entry.imported?.[index] ?? local;
      fail("MESH_UNKNOWN_IMPORT", `A service file imports entity files, helper modules and \`Mesh\` from "meshfw": ${entry.from} declares the ${refused} ${declared}, and a service owns no ${refused}s yet`, entry.position, "remove the import");
      importNames.delete(local);
      duplicates.add(local);
      continue;
    }
    kept.push(binding);
  }
  const helpers = new Map<string, string>();
  const mesh = new Set<string>();
  for (const { entry, name: local } of kept) {
    if (entry.helper) helpers.set(local, entry.from);
    if (entry.mesh) mesh.add(local);
  }
  const entities = new Set(kept.filter(({ entry, index }) => boundKinds(entry, index).includes("entity")).map(({ name: local }) => local));
  const namespaces = new Set(kept.filter(({ entry }) => entry.namespace).map(({ name: local }) => local));
  const self = `./${basename(file)}`;
  const references: ReferenceScope = { imports: importNames, duplicates, own: [], self };
  const entityKind = referenceKind("entity", declaredFile);
  // A member of an alias whose file declares an entity and inline declarations: what the alias names, of any kind.
  const memberKind: ReferenceKind = {
    noun: "entity",
    declares: (from) => declaredFile(from) !== undefined,
    names: (from) => importable(declaredFile(from))?.filter((declaration) => declaration.kind === "entity").map(({ name: n }) => n),
    kindOf: (from, n) => importable(declaredFile(from))?.find((declaration) => declaration.name === n)?.kind,
    code: "MESH_UNKNOWN_ENTITY",
  };

  /**
   * One function of the file, always plain: the body with `runStep`, a policy's with `service`. `reached` collects the
   * target of every namespace member the function names (`w.Claim`), which `freeVariables` resolves through `reference`,
   * with the member as written.
   */
  const fn = (a: Attr | undefined, step: boolean, reached?: Map<string, string>): Expression => {
    const reference = (writtenRef: WrittenReference) => {
      const resolved = resolveReference(writtenRef, references, entityKind);
      if (resolved.ok && reached && !reached.has(targetKey(file, resolved))) reached.set(targetKey(file, resolved), referenceText(writtenRef));
      return resolved;
    };
    const result = expression(
      a,
      source,
      at,
      (ref) => fail("MESH_EXPR_FREE_VARIABLE", NO_RECORD(`&${ref.name}`), ref.position, "declare the value as an `input` field and read `input`"),
      () => {},
      {
        helpers,
        imported: new Set([...importNames.keys(), ...duplicates]),
        entities,
        namespaces,
        reference,
        memberReference: (writtenRef) => resolveReference(writtenRef, references, memberKind),
        events: new Set(),
        commands: new Set(),
        duplicates,
        mesh,
        report: (d) => {
          if (!diagnostics.some((x) => x.code === d.code && x.position.file === d.position.file && x.position.offset === d.position.offset)) diagnostics.push(d);
        },
        ...(step ? { runStep: true } : {}),
        service: true,
      },
    );
    for (const root of ["self", "before"])
      if (result.params.includes(root) || result.plain?.roots.includes(root))
        fail("MESH_EXPR_FREE_VARIABLE", NO_RECORD(root), result.position, "read `input`, `actor` and `context`");
    return result;
  };

  const operations = tags(root.children).filter((t) => t.name === "operation");
  const named = new Map<string, SourcePosition>();
  const member = (memberName: string, tag: Tag) => {
    if (named.has(memberName)) fail("MESH_DUPLICATE_MEMBER", `Duplicate member :${memberName}`, tag);
    else named.set(memberName, pos(tag));
    if (memberName === PROTOTYPE_SETTING_NAME)
      fail("MESH_NAME", `:${memberName} cannot be a member name: __proto__ sets an object's prototype instead of adding a property. Choose another name.`, tag);
  };
  for (const line of operations) {
    const opName = atomOf(attr(line, "name"))?.name ?? "";
    member(opName, line);
    const uses: ServiceUse[] = [];
    // Each line's resolved target, for the check of the body below.
    const listed = new Set<string>();
    for (const usesLine of tags(line.children).filter((t) => t.name === "uses")) {
      const writtenRef = writtenReference(nodeOf(attr(usesLine, "entity")));
      const target = writtenRef ? resolveReference(writtenRef, references, entityKind) : undefined;
      if (target && !target.ok && "code" in target) fail(target.code, target.message, at(target.offset), target.fix);
      if (target?.ok) listed.add(targetKey(file, target));
      const actions: MemberRef[] = [];
      for (const [forward, span] of atomForwards(attr(usesLine, "actions"))) {
        const action = { name: String((forward as { value?: unknown }).value), position: at(span.sourceStart) };
        if (actions.some(({ name: n }) => n === action.name))
          fail("MESH_ATOM_LIST", `actions lists :${action.name} twice`, action.position, `remove the second :${action.name}`);
        else actions.push(action);
      }
      uses.push({
        entity: { identifier: writtenRef ? referenceText(writtenRef) : "", from: target?.ok ? target.from : "" },
        actions,
        position: pos(usesLine),
      });
    }
    const input = readInputLines(line, {
      readers: { at, pos, fail, ...readers },
      memberLine: (inputLine) => {
        if (!isMemberLine(inputLine)) {
          fail("MESH_SYNTAX", "`<member>` is not a known tag: write a member line as `&name`", inputLine);
          return undefined;
        }
        const read = readAt(inputLine, at, () => readMemberLine(inputLine, at));
        if (read.diagnostic) diagnostics.push(read.diagnostic);
        else
          fail("MESH_UNKNOWN_MEMBER", `&${read.value.ref.name} is not a member of ${fqn}: a service has no members; declare the field with its type (\`string :${read.value.ref.name}\`)`, read.value.ref.position, `write \`string :${read.value.ref.name}\`, or the type the field has`);
        return undefined;
      },
    }).filter((field): field is Argument => field.kind === "argument");
    const runTag = tags(line.children).find((t) => t.name === "run");
    if (!runTag) continue; // MX reports the missing `run`
    const after = attr(runTag, "after");
    if (after)
      fail("MESH_UNKNOWN_OPTION", "`after` is not an option of an operation's `run`: the body is the whole operation, so there is no write to run after", at("nameSpan" in after && after.nameSpan ? after.nameSpan.sourceStart : attrOffset(after)), "remove `after=:write`");
    const reached = new Map<string, string>();
    const run = fn(attr(runTag, "value"), true, reached);
    // The build half of OD-4: every entity the body names, directly or as a namespace member, is one a `uses` line lists.
    const unlisted: string[] = [];
    const seenMembers = [...reached.values()];
    for (const entityName of run.plain?.entities ?? []) {
      if (namespaces.has(entityName)) {
        // An alias read bare (`const { Note } = ns`, or passed on whole) names every entity its file declares; one read
        // only as `ns.Member` was recorded member by member through `reference` above.
        if (seenMembers.some((written) => written.startsWith(`${entityName}.`))) continue;
        for (const declared of memberKind.names(importNames.get(entityName)?.from ?? "") ?? []) {
          const resolved = resolveReference({ qualifier: { name: entityName, offset: 0 }, name: declared, offset: 0 }, references, memberKind);
          if (resolved.ok && !listed.has(targetKey(file, resolved))) unlisted.push(`${entityName}.${declared}`);
        }
        continue;
      }
      const resolved = resolveReference({ name: entityName, offset: 0 }, references, entityKind);
      if (resolved.ok && !listed.has(targetKey(file, resolved))) unlisted.push(entityName);
    }
    for (const [key, writtenMember] of reached) if (!listed.has(key)) unlisted.push(writtenMember);
    for (const entityName of [...new Set(unlisted)])
      fail("MESH_SERVICE_USES", `operation :${opName} of ${fqn} names ${entityName}, which no \`uses\` line of the operation lists: an operation reaches only the entities its \`uses\` lines name`, pos(runTag), `add \`uses entity=${entityName} actions=[...]\` listing what it calls`);
    const operation: Operation = { name: opName, uses, input, run, position: pos(line) };
    service.operations.push(operation);
  }

  const policiesTag = tags(root.children).find((t) => t.name === "policies");
  for (const tag of tags(policiesTag?.children ?? [])) {
    const types = attr(tag, "types");
    if (types)
      fail("MESH_UNKNOWN_OPTION", "`types` is not an option of a policy of a service: an operation has no action type; scope the policy with `actions=[&operation]`", at("nameSpan" in types && types.nameSpan ? types.nameSpan.sourceStart : attrOffset(types)), "write `actions=[&operation]`, or remove `types` to cover every operation");
    const policy: Policy = readPolicyLine(tag, {
      expr: (a) => fn(a, false),
      scope: (t) => (attr(t, "actions") ? { actions: readMembers(attr(t, "actions"), at) } : {}),
      pos,
    });
    member(policy.name, tag);
    const opNames = service.operations.map((operation) => operation.name);
    for (const ref of policy.actions ?? [])
      if (!opNames.includes(ref.name)) {
        const near = nearestName(ref.name, opNames);
        fail("MESH_UNKNOWN_ACTION", `&${ref.name} is not an operation of ${fqn}: \`actions=\` names the service's own operations${opNames.length ? ` (${opNames.map((n) => `&${n}`).join(", ")})` : ""}.${near ? ` Did you mean &${near}?` : ""}`, ref.position);
      }
    service.policies.push(policy);
  }
  return service;
}
