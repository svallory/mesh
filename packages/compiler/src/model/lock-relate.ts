import type { Action, Always, Diagnostic, Entity, ModelDocument, Step } from "@meshfw/model";
import { error } from "./diagnostics.ts";
import { lockField, lockOf, locksIn, relatesOf, type LockStep, type RelateStep } from "./derived-input.ts";
import { alwaysCovers } from "./policies.ts";
import { entitiesByFile, keyHolderOf } from "./key-holder.ts";

const key = (step: { position: { file: string; line: number; column: number } }) => `${step.position.file}:${step.position.line}:${step.position.column}`;
const article = (word: string) => (/^[aeiou]/.test(word) ? "an" : "a");

/** What a locked member is when it is no required integer attribute, for `MESH_LOCK_MEMBER`; undefined when it is one or names nothing (`MESH_UNKNOWN_MEMBER` is the builder's). */
function wrongMember(entity: Entity, name: string): string | undefined {
  const attribute = entity.attributes.find((candidate) => candidate.name === name);
  if (attribute) {
    if (attribute.primaryKey) return "the primary key";
    if (attribute.type !== "integer") return `${article(attribute.type)} ${attribute.type} attribute`;
    return attribute.nullable ? "a nullable integer attribute" : undefined;
  }
  if (entity.relationships.some((relation) => relation.name === name)) return "a relationship";
  if (entity.computed.some((field) => field.name === name)) return "a computed field";
  return undefined;
}

/** Every `set &<member>` line among the steps, at any depth of `when`. */
function setsOf(steps: readonly Step[], member: string): { position: Step["position"] }[] {
  return steps.flatMap((step) => step.kind === "set" ? step.assignments.filter((assignment) => assignment.member.name === member).map((assignment) => ({ position: assignment.member.position }))
    : step.kind === "when" ? setsOf(step.steps, member) : []);
}

/**
 * The rules of the `lock` step that need the actions it reaches (ADR-0100; the builder refuses one under a step `when`):
 *
 * - `MESH_LOCK_STEP`: a lock in a create's own `do`; one in an `always` block with no `types=`/`actions=` or whose scope
 *   covers a create (reported once, at the block's lock line); a second lock reaching one action (at the later line);
 * - `MESH_LOCK_MEMBER`: the member is no required integer attribute other than the key; it is an input of an action the
 *   lock reaches; a `set` of it reaches an update the lock reaches;
 * - `MESH_DUPLICATE_INPUT`: an authored input is named like the field the lock adds (`expectedVersion`).
 *
 * And those of the `relate` step (the builder refuses one under a step `when`, in an `always` block and with no option),
 * `checkRelates` below.
 *
 * Called by `buildModel` after the relationships are resolved and before `checkCommands`, which reads the derived field.
 */
export function checkLockRelate(document: ModelDocument, diagnostics: Diagnostic[], nearestName: (name: string, candidates: Iterable<string>) => string | undefined = () => undefined): void {
  const byFile = entitiesByFile(document);
  for (const entity of document.entities) checkRelates(entity, byFile, diagnostics, nearestName);
  for (const entity of document.entities) {
    const reported = new Set<string>();
    const report = (code: string, message: string, at: { position: Step["position"] }, fix: string) => {
      if (reported.has(key(at) + code)) return;
      reported.add(key(at) + code);
      diagnostics.push(error(code, message, at.position, fix));
    };
    const actions: Pick<Action, "kind" | "name" | "input" | "do" | "position">[] = [
      ...entity.actions,
      ...entity.auto.map((kind) => ({ kind, name: kind as string, input: [], do: [], position: entity.position })),
    ];
    // The member of every lock, once per step.
    for (const step of [...entity.actions.flatMap((action) => locksIn(action.do)), ...entity.always.flatMap((block) => locksIn(block.do))]) {
      const wrong = wrongMember(entity, step.member.name);
      if (wrong)
        report("MESH_LOCK_MEMBER", `\`lock &${step.member.name}\`: &${step.member.name} is ${wrong} of ${entity.fqn}, and a lock counts versions in a required integer attribute`,
          step.member, `declare \`integer :${step.member.name} default=1\` and lock it`);
    }
    // A create has no stored version; an always block that may reach one is refused whatever else it covers.
    for (const action of entity.actions)
      if (action.kind === "create")
        for (const step of locksIn(action.do))
          report("MESH_LOCK_STEP", `create :${action.name} of ${entity.fqn} has a \`lock\` step, and a create has no stored version to compare: a lock guards an update or a destroy`,
            step, "remove the `lock` line, or move it to the update or destroy it guards");
    const refused = new Set<Always>();
    for (const block of entity.always) {
      const locks = locksIn(block.do);
      if (!locks.length) continue;
      const create = actions.find((action) => action.kind === "create" && alwaysCovers(block, action));
      const why = !block.types && !block.actions ? "has no `types=` or `actions=`, so it covers every action"
        : create ? `covers create :${create.name} of ${entity.fqn}` : undefined;
      if (why === undefined) continue;
      refused.add(block);
      for (const step of locks)
        report("MESH_LOCK_STEP", `the \`always\` block at line ${block.position.line} ${why}, and has a \`lock\` step, and a lock guards only an update or a destroy`,
          step, "scope the block to updates and destroys: `types=[:update, :destroy]`");
    }
    for (const action of actions) {
      if (action.kind !== "update" && action.kind !== "destroy") continue;
      const blocks = entity.always.filter((block) => !refused.has(block) && alwaysCovers(block, action));
      const reaching: { step: LockStep; block?: Always }[] = [
        ...blocks.flatMap((block) => locksIn(block.do).map((step) => ({ step, block }))),
        ...locksIn(action.do).map((step) => ({ step })),
      ];
      const first = reaching[0];
      if (!first) continue;
      const where = (entry: { step: LockStep; block?: Always }) => `line ${entry.step.position.line}${entry.block ? ` through the \`always\` block at line ${entry.block.position.line}` : ""}`;
      for (const later of reaching.slice(1))
        report("MESH_LOCK_STEP", `${action.kind} :${action.name} of ${entity.fqn} has two \`lock\` steps (${where(first)} and ${where(later)}): an action compares one version`,
          later.step, "remove one of them");
      const member = first.step.member.name;
      const field = lockField(member);
      const owns = `\`lock &${member}\` (line ${first.step.position.line})`;
      for (const input of action.input) {
        const name = input.kind === "member" ? input.ref.name : input.name;
        const at = input.kind === "member" ? input.ref : input;
        if (input.kind === "member" && name === member)
          report("MESH_LOCK_MEMBER", `&${member} is an input of ${action.kind} :${action.name} of ${entity.fqn}, and ${owns} owns it: the caller sends \`${field}\`, and the lock writes &${member}`,
            at, `remove \`&${member}\` from \`input\``);
        if (name === field)
          report("MESH_DUPLICATE_INPUT", `Input ${field} conflicts with the one ${owns} adds`, at,
            input.kind === "member" ? `remove \`&${field}\` from \`input\`, or rename the attribute` : "rename the argument");
      }
      // A destroy's `set` is `MESH_DESTROY_STEP` already.
      if (action.kind === "update")
        for (const set of [...blocks.flatMap((block) => setsOf(block.do, member)), ...setsOf(action.do, member)])
          report("MESH_LOCK_MEMBER", `\`set &${member}\` in ${action.kind} :${action.name} of ${entity.fqn} writes the version that ${owns} owns: the lock adds 1 on every write`,
            set, "remove the `set` line");
    }
  }
}

type ActionLike = Pick<Action, "kind" | "name" | "input" | "do" | "position">;
/** The declared actions of an entity, then its generated (`auto=`) ones, which take no input and have no step. */
const actionsOf = (entity: Entity): ActionLike[] => [
  ...entity.actions,
  ...entity.auto.map((kind) => ({ kind, name: kind as string, input: [], do: [], position: entity.position })),
];
const atoms = (names: readonly string[]) => names.map((name) => `:${name}`).join(", ");

/** What a related member is when it is no has-many, for `MESH_RELATE_STEP`; undefined when it is one or names nothing (`MESH_UNKNOWN_MEMBER` is the builder's). */
function notHasMany(entity: Entity, name: string): { what: string; fix: string } | undefined {
  const relation = entity.relationships.find((candidate) => candidate.name === name);
  if (relation?.kind === "belongs-to") return { what: "a belongs-to", fix: `set a belongs-to with \`set &${name}=...\`` };
  if (relation?.kind === "has-one") return { what: "a has-one", fix: "call its target's action from a `run [after=:write]` step" };
  if (relation) return undefined;
  if (entity.attributes.some((attribute) => attribute.name === name)) return { what: "an attribute", fix: `write it with \`set &${name}=...\`` };
  if (entity.computed.some((field) => field.name === name)) return { what: "a computed field", fix: "relate a has-many of the entity" };
  return undefined;
}

/**
 * The rules of the `relate` step that need the model (ADR-0100, "The relate step"), each at its position:
 *
 * - `MESH_RELATE_STEP`: a relate in a destroy; the same relationship related twice by one action (at the later line); a
 *   member that is no has-many, or a has-many `through=` a link entity;
 * - `MESH_UNKNOWN_ACTION`: `create=`, `update=` or `destroy=` names no action of the related entity;
 * - `MESH_RELATE_ACTION`: it names an action of another kind; the create takes no input of the inverse `belongs-to`; the
 *   create or update has a `relate` of its own; the destroy takes a required input besides the key;
 * - `MESH_DUPLICATE_INPUT`: an authored input is named like the relationship (the field the relate adds).
 *
 * A has-many whose inverse the build could not resolve carries its own error and is skipped here.
 */
function checkRelates(entity: Entity, byFile: ReadonlyMap<string, Entity>, diagnostics: Diagnostic[], nearestName: (name: string, candidates: Iterable<string>) => string | undefined): void {
  for (const action of entity.actions) {
    const relates = action.do.filter((step): step is RelateStep => step.kind === "relate");
    if (!relates.length) continue;
    if (action.kind === "destroy") {
      for (const step of relates)
        diagnostics.push(error("MESH_RELATE_STEP", `destroy :${action.name} of ${entity.fqn} has a \`relate\` step, and a destroy writes no row its children could point to`, step.position, "remove the `relate` line"));
      continue;
    }
    const seen = new Map<string, RelateStep>();
    for (const step of relates) {
      const name = step.relationship.name;
      const first = seen.get(name);
      if (first) {
        diagnostics.push(error("MESH_RELATE_STEP", `${action.kind} :${action.name} of ${entity.fqn} relates &${name} twice (line ${first.position.line} and line ${step.position.line}): one list decides the rows`, step.position, "remove one of them"));
        continue;
      }
      seen.set(name, step);
      for (const input of action.input)
        if (input.kind === "argument" && input.name === name)
          diagnostics.push(error("MESH_DUPLICATE_INPUT", `Input ${name} conflicts with the one \`relate &${name}\` (line ${step.position.line}) adds`, input.position, "rename the argument"));
      const wrong = notHasMany(entity, name);
      if (wrong) {
        diagnostics.push(error("MESH_RELATE_STEP", `\`relate &${name}\`: &${name} is ${wrong.what} of ${entity.fqn}, and \`relate\` manages the rows of a has-many`, step.relationship.position, wrong.fix));
        continue;
      }
      const relation = entity.relationships.find((candidate) => candidate.name === name && candidate.kind === "has-many");
      if (!relation) continue;
      if (relation.through) {
        diagnostics.push(error("MESH_RELATE_STEP", `\`relate &${name}\`: &${name} goes through a link entity (through=${relation.through.entity.identifier}), and \`relate\` manages the rows of a has-many without one`, step.relationship.position, `call ${relation.through.entity.identifier}'s actions from a \`run [after=:write]\` step`));
        continue;
      }
      const target = keyHolderOf(byFile, entity, relation);
      if (!relation.inverse || !target) continue;
      const actions = actionsOf(target);
      for (const option of ["create", "update", "destroy"] as const) {
        const ref = step[option];
        if (!ref) continue;
        const named = actions.find((candidate) => candidate.name === ref.name);
        const ofKind = actions.filter((candidate) => candidate.kind === option).map((candidate) => candidate.name);
        if (!named) {
          const near = nearestName(ref.name, actions.map((candidate) => candidate.name));
          diagnostics.push(error("MESH_UNKNOWN_ACTION", `:${ref.name} is not an action of ${target.fqn}: \`${option}=\` names one of its ${option} actions${ofKind.length ? ` (${atoms(ofKind)})` : ", and it has none"}.${near === undefined ? "" : ` Did you mean :${near}?`}`, ref.position));
          continue;
        }
        if (named.kind !== option) {
          diagnostics.push(error("MESH_RELATE_ACTION", `\`${option}=:${ref.name}\` names ${named.kind} :${ref.name} of ${target.fqn}, and \`${option}=\` names ${option === "update" ? "an" : "a"} ${option} action`, ref.position,
            ofKind.length ? `name ${option === "update" ? "an" : "a"} ${option} action of ${target.fqn} (${atoms(ofKind)})` : `declare ${option === "update" ? "an" : "a"} ${option} action on ${target.fqn}`));
          continue;
        }
        const own = relatesOf(named)[0];
        if (option !== "destroy" && own) {
          diagnostics.push(error("MESH_RELATE_ACTION", `${named.kind} :${named.name} of ${target.fqn} has its own \`relate &${own.relationship.name}\` (line ${own.position.line}), and an item of \`relate &${name}\` cannot carry a list of its own`, ref.position, `name an action of ${target.fqn} without a \`relate\` step`));
          continue;
        }
        if (option === "create" && !named.input.some((input) => input.kind === "member" && input.ref.name === relation.inverse)) {
          const auto = !target.actions.includes(named as Action);
          diagnostics.push(error("MESH_RELATE_ACTION", `create :${named.name} of ${target.fqn} takes no &${relation.inverse}, so \`relate &${name}\` cannot attach the rows it creates to ${entity.fqn}`, ref.position,
            auto ? `declare a create on ${target.fqn} that takes \`&${relation.inverse}\` and name it` : `add \`&${relation.inverse}\` to the \`input\` of create :${named.name}`));
          continue;
        }
        if (option === "destroy") {
          const argument = named.input.find((input) => input.kind === "argument" && !input.nullable && input.default === undefined);
          const lock = lockOf(target, named);
          const takes = argument && argument.kind === "argument" ? `\`${argument.name}\``
            : lock && lock.step.optional !== true ? `\`${lock.field}\`, which \`lock &${lock.step.member.name}\` adds` : undefined;
          if (takes)
            diagnostics.push(error("MESH_RELATE_ACTION", `destroy :${named.name} of ${target.fqn} takes ${takes}, and \`relate &${name}\` destroys a child with its key alone`, ref.position,
              argument ? "name a destroy that takes only the key" : "name a destroy that takes only the key, or make the lock `optional`"));
        }
      }
    }
  }
}
