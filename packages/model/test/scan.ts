import { dirname, resolve, sep } from "node:path";

/** Source text with `//` and block comments blanked, string contents kept. */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const n = source[i + 1];
    if (c === "/" && n === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Everything wrong with the module references in `source`, as strings; empty when fine.
 * The policy is an allow-list: the only references allowed are relative specifiers that
 * resolve inside `srcDir`. Bare names, `node:` built-ins, relative paths that escape
 * `srcDir`, and any `import(` or `require(` whose argument is not a plain quoted string
 * (template literals included) are failures.
 */
export function checkSource(source: string, file: string, srcDir: string): string[] {
  const code = stripComments(source);
  const problems: string[] = [];
  const specs: string[] = [];

  for (const m of code.matchAll(/\bfrom\s*(["'])((?:(?!\1).)*)\1/g)) specs.push(m[2]!);
  for (const m of code.matchAll(/\bimport\s*(["'])((?:(?!\1).)*)\1/g)) specs.push(m[2]!);
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*(["'])((?:(?!\1).)*)\1\s*[,)]/g)) {
    specs.push(m[2]!);
  }
  const calls = [...code.matchAll(/\b(?:import|require)\s*\(/g)].length;
  const literalCalls = [
    ...code.matchAll(/\b(?:import|require)\s*\(\s*(["'])((?:(?!\1).)*)\1\s*[,)]/g),
  ].length;
  if (calls !== literalCalls) {
    problems.push(`${file}: import() or require() with an argument that is not a plain string literal`);
  }

  const inside = srcDir.endsWith(sep) ? srcDir : srcDir + sep;
  for (const s of new Set(specs)) {
    if (!s.startsWith("./") && !s.startsWith("../")) {
      problems.push(`${file}: "${s}" is not a relative import`);
    } else if (!(resolve(dirname(file), s) + "").startsWith(inside)) {
      problems.push(`${file}: "${s}" resolves outside packages/model/src`);
    }
  }
  return problems;
}
