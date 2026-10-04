/**
 * Generated TypeScript is built from templates and then formatted here, by one
 * established formatter pinned to an exact version (roadmap M1, "Build or reuse").
 *
 * Prettier 3.6.2 is the choice. Its `format` is a documented public API that takes
 * the options as an argument, so the configuration is fixed in this module and never
 * read from the user's project: a `.prettierrc`, an editor setting or a `prettier`
 * plugin in `node_modules` cannot change what Mesh writes. Biome's JavaScript API is
 * still marked unstable in 2.x, which is the wrong property to depend on for the
 * guard: the guard compares bytes, so a formatter upgrade must be a deliberate edit
 * here, in a commit that says so.
 *
 * The options below are the whole contract. Changing one changes every committed
 * generated file, which is what `mesh build --check` will report.
 */
import { format, type Options } from "prettier";

/** Fixed here on purpose: a fixed configuration, not the project's own. */
export const FORMATTER_OPTIONS: Options = Object.freeze({
  parser: "typescript",
  // LF, spaces and a bounded width keep the committed tree diffable on any host.
  endOfLine: "lf",
  tabWidth: 2,
  useTabs: false,
  printWidth: 100,
  // Double quotes and semicolons: the house style of the Mesh sources.
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  bracketSpacing: true,
  arrowParens: "always",
});

/**
 * Format one generated TypeScript file. A parse failure is never swallowed: the
 * caller turns this into a positioned build error naming the resource file.
 */
export function formatTypescript(source: string): Promise<string> {
  return format(source, FORMATTER_OPTIONS);
}