/**
 * The one name for a directory a test creates inside the checkout, and the one predicate every repository scan uses
 * to skip it.
 *
 * A test that needs a temporary project inside the checkout (so that it resolves `@meshfw/*` through the workspace's
 * `node_modules`) names it `.scratch-<name>-XXXXXX`; the grep guard in `repository-checks.test.ts` fails any other
 * in-checkout `mkdtemp` prefix. While tests run side by side (files in parallel workers, packages in the
 * `test:affected` pool), such a directory appears and disappears under a scan that walks the checkout: a file listed
 * and then deleted before it is read throws ENOENT, and a generated or planted file reads as a violation. Every
 * repository walker therefore skips it.
 */
export const SCRATCH_PREFIX = ".scratch-";

/**
 * True when any `/`-separated segment of `relativePath` starts with `.scratch-`.
 *
 * Call it on a path relative to the scan's own root, never on an absolute path: a planted workspace that itself lives
 * under `<checkout>/.scratch-check-XXXXXX/` and is scanned with that directory as its root must still report what was
 * planted in it.
 */
export function isScratchPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith(SCRATCH_PREFIX));
}
