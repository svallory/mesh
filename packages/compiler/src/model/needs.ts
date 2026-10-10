import { dirname, resolve } from "node:path";
import type { Diagnostic, Entity, ExprNode, ModelDocument } from "@meshfw/model";
import { inverseProblem } from "./inverse.ts";
import { error } from "./diagnostics.ts";

/**
 * Which relationships and computed fields a computed field's body reads (M7), so that loading
 * the field can load them first. Language-neutral: it reads the model only.
 *
 * A translated body is walked as a tree: every access that starts at `self` (directly, or through
 * the parameter of a quantifier over a list reached from `self`) names a path, and every
 * relationship or computed field on that path is a need. A plain body has no tree, so the
 * only names known are the `&name` it reads on `self` (the edits that turn `&name` into
 * `self.name`) and the chain of `.name` / `?.name` written right after it. A read the text does not
 * show (through a variable) cannot be known here; `loadRows` guards a plain body at run time, so
 * it throws instead of reading an unloaded value as null.
 */
export function computeNeeds(document: ModelDocument, diagnostics: Diagnostic[]): void {
  const byFile = new Map(document.entities.map((entity) => [resolve(entity.file), entity]));
  const targetOf = (from: Entity, relation: Entity["relationships"][number]) =>
    byFile.get(resolve(dirname(from.file), relation.entity.from));

  const noInverse = new Set<object>();
  for (const entity of document.entities) {
    for (const computed of entity.computed) {
      if (!computed.body) continue;
      const needs = new Set<string>();
      const record = (path: readonly string[]) => {
        let owner: Entity | undefined = entity;
        const prefix: string[] = [];
        for (const segment of path) {
          if (!owner) return;
          const relation = owner.relationships.find((r) => r.name === segment);
          if (relation) {
            if (relation.kind !== "belongs-to" && relation.via === undefined && !noInverse.has(relation)) {
              noInverse.add(relation);
              const problem = inverseProblem(document, owner, relation);
              diagnostics.push(error(problem.code,
                `&${computed.name} reads ${relation.kind} :${relation.name}, which cannot be loaded: ${problem.because}`,
                computed.position, problem.fix));
            }
            prefix.push(segment);
            needs.add(prefix.join("."));
            owner = targetOf(owner, relation);
            continue;
          }
          if (owner.computed.some((c) => c.name === segment)) needs.add([...prefix, segment].join("."));
          return;
        }
      };
      const pathOf = (n: ExprNode, env: ReadonlyMap<string, readonly string[]>): readonly string[] | undefined => {
        if (n.kind === "var") return n.name === "self" ? [] : env.get(n.name);
        if (n.kind === "member") {
          const parent = pathOf(n.object, env);
          return parent ? [...parent, n.name] : undefined;
        }
        // The element `find` returns, and the elements `filter` keeps, are rows of the source list.
        if (n.kind === "quantify" && (n.op === "find" || n.op === "filter")) return pathOf(n.source, env);
        return undefined;
      };
      const visit = (n: ExprNode, env: ReadonlyMap<string, readonly string[]>): void => {
        if (n.kind === "member") {
          const path = pathOf(n, env);
          if (path) record(path);
          visit(n.object, env);
        } else if (n.kind === "call" || n.kind === "helper") n.args.forEach((arg) => visit(arg, env));
        else if (n.kind === "quantify") {
          visit(n.source, env);
          const source = pathOf(n.source, env);
          visit(n.body, source ? new Map([...env, [n.param, source]]) : env);
        }
      };
      if (computed.body.tree) visit(computed.body.tree, new Map());
      else if (computed.body.plain)
        for (const edit of computed.body.plain.edits) {
          const name = /^self\.(.+)$/.exec(edit.text)?.[1];
          if (!name) continue;
          // Follow the chain written right after `&name`: `&parent?.parent?.leaf` reads parent, parent.parent and parent.parent.leaf.
          // A read through a variable (`const p = &parent; p.leaf`) cannot be followed here; the loader guards plain bodies at run time.
          const path = [name];
          const rest = computed.body.source.slice(edit.to);
          for (const link of rest.matchAll(/\s*\??\.\s*([A-Za-z_$][\w$]*)/gy)) path.push(link[1]!);
          record(path);
        }
      computed.needs = [...needs].sort();
    }
    // Two computed fields that read each other can never be loaded.
    const edges = new Map(entity.computed.map((c) => [c.name, (c.needs ?? []).filter((n) => entity.computed.some((o) => o.name === n))]));
    const state = new Map<string, "walking" | "done">();
    const reported = new Set<string>();
    const walk = (name: string, trail: string[]): void => {
      if (state.get(name) === "done") return;
      if (state.get(name) === "walking") {
        const cycle = [...trail.slice(trail.indexOf(name)), name];
        const head = entity.computed.find((c) => c.name === name)!;
        if (!reported.has(cycle.join(">")) && !cycle.some((member) => reported.has(`in:${member}`))) {
          cycle.forEach((member) => reported.add(`in:${member}`));
          reported.add(cycle.join(">"));
          diagnostics.push(error("MESH_COMPUTED_CYCLE", `Computed fields read each other: ${cycle.map((member) => `&${member}`).join(" reads ")}`, head.position));
        }
        return;
      }
      state.set(name, "walking");
      for (const next of edges.get(name) ?? []) walk(next, [...trail, name]);
      state.set(name, "done");
    };
    for (const name of edges.keys()) walk(name, []);
  }
}
