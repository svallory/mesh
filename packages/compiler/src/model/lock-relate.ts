import type { Action, Always, Diagnostic, Entity, ModelDocument, Step } from "@meshfw/model";
import { error } from "./diagnostics.ts";
import { lockField, locksIn, type LockStep } from "./derived-input.ts";
import { alwaysCovers } from "./policies.ts";

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
 * Called by `buildModel` after the relationships are resolved and before `checkCommands`, which reads the derived field.
 */
export function checkLockRelate(document: ModelDocument, diagnostics: Diagnostic[]): void {
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
