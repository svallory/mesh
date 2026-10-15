import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fragmentProblems, readPage } from "../check-fragments.ts";
import plugin, { installPlainHeadingIds, slugOf } from "../plugins/plain-heading-ids.js";

// Resolve docmd's own parser, rather than pinning a second markdown implementation.
const require = createRequire(import.meta.url);
const coreRequire = createRequire(require.resolve("@docmd/core"));
const { createMarkdownProcessor } = await import(coreRequire.resolve("@docmd/parser"));
const render = (markdown: string, setup = true) =>
  createMarkdownProcessor({}, setup ? installPlainHeadingIds : undefined).render(markdown) as string;
const headingIds = (html: string) => [...html.matchAll(/<h[1-6]\b[^>]*\sid="([^"]*)"/g)].map((m) => m[1]);

test("docmd alone builds ids from the parent headings, which is what the plugin undoes", () => {
  const markdown = "# Guide\n\n## Build\n\n### Continuous integration\n";
  expect(headingIds(render(markdown, false))).toEqual(["guide", "guide-build", "guide-build-continuous-integration"]);
  expect(headingIds(render(markdown))).toEqual(["guide", "build", "continuous-integration"]);
});

test("a heading's id is its own text, and docmd's permalink and links use it", () => {
  const html = render("# Contributing to these docs\n\n## Continuous integration\n\nSee [CI](#continuous-integration).\n");
  expect(html).toContain('id="continuous-integration"');
  expect(html).toContain('<a href="#continuous-integration" class="heading-anchor"');
  expect(slugOf("  The `mesh build` step: what, why? ")).toBe("the-mesh-build-step-what-why");
});

test("a repeated heading keeps the plain id first and then gets -1, -2, skipping ids in use", () => {
  const html = render("# Page\n\n## Notes\n\n### Example\n\n## Other\n\n### Example\n\n### Example\n\n### Example 1\n\n### Example\n");
  expect(headingIds(html)).toEqual(["page", "notes", "example", "other", "example-1", "example-2", "example-1-1", "example-3"]);
  expect(new Set(headingIds(html)).size).toBe(8);
});

test("an id written with {#id} is kept and never given to a second heading", () => {
  const html = render("# Page\n\n## Alpha {#beta}\n\n## Beta\n\n## Beta\n");
  expect(headingIds(html)).toEqual(["page", "beta", "beta-1", "beta-2"]);
});

test("a heading with no letters or digits gets no id", () => {
  expect(headingIds(render("# Page\n\n## ???\n\n## Real\n"))).toEqual(["page", "real"]);
});

test("the plugin installs once even when docmd calls markdownSetup twice", () => {
  const md = createMarkdownProcessor({});
  plugin.markdownSetup(md);
  plugin.markdownSetup(md);
  expect(headingIds(md.render("# A\n\n## B\n\n## B\n"))).toEqual(["a", "b", "b-1"]);
  expect(plugin.plugin.capabilities).toContain("markdown");
});

// --- the check on a built site ---

const roots: string[] = [];
function site(pages: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mesh-fragments-"));
  roots.push(root);
  for (const [path, body] of Object.entries(pages)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `<html><body>${body}</body></html>`);
  }
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("links whose fragments name an id pass, in the page and across pages", () => {
  const root = site({
    "index.html": '<h2 id="top-section">x</h2><a href="#top-section">in page</a><a href="docs/a/#intro">down</a><a href="/docs/a/#intro">root</a>',
    "docs/a/index.html": '<h1 id="intro">A</h1><a href="../b/#deep">sibling</a><a href="../../#top-section">up</a><a href="../b/index.html#deep">file</a>',
    "docs/b/index.html": '<h3 id="deep">B</h3><a name="old">anchor</a><a href="../a/#intro">back</a><a href="#old">name</a>',
  });
  expect(fragmentProblems(root)).toEqual([]);
});

test("a planted broken fragment fails the check, in the page and across pages", () => {
  const root = site({
    "index.html": '<h2 id="real">x</h2><a href="#missing">in page</a><a href="docs/a/#nowhere">cross</a>',
    "docs/a/index.html": '<h1 id="intro">A</h1><a href="../../#real">fine</a><a href="../../#Real">case matters</a>',
  });
  expect(fragmentProblems(root)).toEqual([
    '/: #missing (no id "missing" in /)',
    '/: docs/a/#nowhere (no id "nowhere" in /docs/a/)',
    '/docs/a/: ../../#Real (no id "Real" in /)',
  ]);
});

test("the old docmd ids fail: a link to the plain slug of a nested heading names no id", () => {
  const root = site({
    "contributing/index.html": '<h1 id="contributing">C</h1><h2 id="contributing-continuous-integration">CI</h2><a href="#continuous-integration">link</a>',
  });
  expect(fragmentProblems(root)).toEqual(['/contributing/: #continuous-integration (no id "continuous-integration" in /contributing/)']);
});

test("the site's own origin counts as the site, other origins, schemes and the top of a page do not", () => {
  const root = site({
    "index.html": [
      '<h2 id="a">a</h2>',
      '<a href="https://mesh.example/#a">own ok</a>',
      '<a href="https://mesh.example/#b">own broken</a>',
      '<a href="https://other.example/#b">external</a>',
      '<a href="mailto:x@y.z#b">mail</a>',
      '<a href="//cdn.example/x#b">protocol-relative</a>',
      '<a href="#">top</a><a href="#top">top too</a>',
      '<a href="no-such-page/#x">page outside the check</a>',
      '<a href="file.zip#x">file</a>',
    ].join(""),
  });
  expect(fragmentProblems(root, "https://mesh.example")).toEqual(['/: https://mesh.example/#b (no id "b" in /)']);
});

test("percent-encoded fragments, entities and single-quoted attributes read as the browser reads them", () => {
  const root = site({
    "index.html": "<h2 id='café'>x</h2><h2 id=bare>y</h2><a href='#caf%C3%A9'>enc</a><a href=\"#bare\">bare</a><a href=\"?q=1&amp;r=2#bare\">query</a><a href=\"#bad%E0\">bad escape</a>",
  });
  expect(fragmentProblems(root)).toEqual(['/: #bad%E0 (no id "bad%E0" in /)']);
});

test("ids and links inside scripts, styles and comments are not the page's", () => {
  const page = readPage('<script>x = \'<a href="#nope" id="fake">\'</script><style>#a{}</style><!-- <a href="#gone" id="ghost"> --><h2 id="real">r</h2><a href="#real">ok</a>');
  expect([...page.ids]).toEqual(["real"]);
  expect(page.links).toEqual(["#real"]);
});
