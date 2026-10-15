/// <reference types="bun" />
// Fails when a link's #fragment, in the same page or to another page of the site, names no id in the target
// page. It reads the built site (`site/`), so run it after `docmd build`. docmd 0.9.7 builds heading ids from
// the parent headings and `docmd validate` does not look at fragments at all, which let `#continuous-integration`
// links open their page without jumping to the section.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^"'>]|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = (name: string) =>
  new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");

const entities: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };
const decodeEntities = (text: string) => text.replace(/&(?:amp|quot|#39|lt|gt);/g, (match) => entities[match]!);

function attribute(attributes: string, name: string): string | undefined {
  const match = ATTRIBUTE(name).exec(attributes);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeEntities(value);
}

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

/** The URL path a built file answers: `docs/entities/index.html` is `/docs/entities/`. */
function urlOf(site: string, file: string): string {
  const path = "/" + relative(site, file).split("\\").join("/");
  return path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path;
}

export type Page = { ids: Set<string>; links: string[] };

/** The ids of a page and the `href` of each of its anchors. Script and style bodies hold no markup. */
export function readPage(html: string): Page {
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const ids = new Set<string>();
  const links: string[] = [];
  for (const [, tag, attributes] of markup.matchAll(TAG)) {
    const id = attribute(attributes!, "id");
    if (id) ids.add(id);
    if (tag!.toLowerCase() === "a") {
      const name = attribute(attributes!, "name");
      if (name) ids.add(name);
      const href = attribute(attributes!, "href");
      if (href !== undefined) links.push(href);
    }
  }
  return { ids, links };
}

/** Every link of the built site at `site` whose fragment names no id in its target page. */
export function fragmentProblems(site: string, origin = ""): string[] {
  const pages = new Map<string, Page>();
  for (const file of htmlFiles(site)) pages.set(urlOf(site, file), readPage(readFileSync(file, "utf8")));

  const problems: string[] = [];
  for (const [url, page] of [...pages].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const link of page.links) {
      let href = link.trim();
      if (origin && href.startsWith(origin)) href = href.slice(origin.length) || "/";
      const hash = href.indexOf("#");
      if (hash === -1) continue;
      const fragment = href.slice(hash + 1);
      const target = href.slice(0, hash);
      // `#` and `#top` name the top of the page; other schemes and hosts are not this site's pages.
      if (fragment === "" || fragment === "top") continue;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//")) continue;
      const path = target.split("?")[0]!;
      const resolved = path === "" ? url : path.startsWith("/") ? posix.normalize(path) : posix.normalize(posix.join(posix.dirname(url + "x"), path));
      const targetUrl = pages.has(resolved) ? resolved : resolved.endsWith("/") ? resolved : `${resolved}/`;
      const found = pages.get(targetUrl) ?? pages.get(resolved);
      // A link to a file this check does not hold (a download, a page outside the site) is not its concern.
      if (!found) continue;
      let wanted = fragment;
      try { wanted = decodeURIComponent(fragment); } catch { /* a malformed escape is matched as written */ }
      if (!found.ids.has(wanted) && !found.ids.has(fragment)) problems.push(`${url}: ${link} (no id "${wanted}" in ${targetUrl})`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const site = join(import.meta.dir, "site");
  if (!existsSync(site)) {
    console.error("fragment check: site/ is missing; run `bun run build` first");
    process.exit(1);
  }
  const config = await Bun.file(join(import.meta.dir, "docmd.config.json")).json();
  const problems = fragmentProblems(site, String(config.url ?? "").replace(/\/$/, ""));
  if (problems.length > 0) {
    console.error(`${problems.length} link fragment(s) name no id in their target page:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("every link fragment names an id in its target page");
}
