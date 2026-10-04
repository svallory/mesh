import { readFileSync } from 'node:fs';
import { createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import marko from 'shiki/langs/marko.mjs';
import light from 'shiki/themes/github-light.mjs';
import dark from 'shiki/themes/github-dark.mjs';

// Eager, synchronous initialization: docmd's markdown-it highlight hook cannot await.
// Module loading happens once, not once per page or fenced block.
const highlighter = createHighlighterCoreSync({
  langs: [marko],
  themes: [light, dark],
  engine: createJavaScriptRegexEngine(),
});

export function highlightMx(source) {
  return highlighter.codeToHtml(source, {
    lang: 'marko',
    themes: { light: 'github-light', dark: 'github-dark' },
  });
}

export const themeStyles = `<style>
:root[data-theme="dark"] .shiki,
:root[data-theme="dark"] .shiki span {
  color: var(--shiki-dark) !important;
  background-color: var(--shiki-dark-bg) !important;
  font-style: var(--shiki-dark-font-style) !important;
  font-weight: var(--shiki-dark-font-weight) !important;
  text-decoration: var(--shiki-dark-text-decoration) !important;
}
</style>`;

// Recover the fence by its exact content, not a guessed preprocessing offset.
// Only the error path reads the source; this uses the same APIs on Node and Bun.
function fenceLocation(token, env) {
  const bodyLine = (token.map?.[0] ?? 0) + 1;
  const file = env?.filePath ?? '<markdown>';
  const unavailable = (reason) =>
    `FrameworkError: ${file}: mx block could not be located in the source ` +
    `(line ${bodyLine} relative to the page body; ${reason})`;
  if (!env?.filePath) return unavailable('source path unavailable');
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    return unavailable(`source could not be read: ${error.message}`);
  }
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const content = token.content.replace(/\r\n/g, '\n');
  for (let start = bodyLine - 1; start < lines.length; start++) {
    const opening = lines[start].match(/^ {0,3}(`{3,}|~{3,})[\t ]*mx(?:[\t ].*)?$/);
    if (!opening) continue;
    const marker = opening[1];
    const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[\\t ]*$`);
    for (let end = start + 1; end < lines.length; end++) {
      if (!closing.test(lines[end])) continue;
      const rawBlock = lines.slice(start + 1, end).join('\n') + (end > start + 1 ? '\n' : '');
      if (rawBlock === content) return `${file}:${start + 1}:1`;
      break;
    }
  }
  return unavailable('no matching mx fence with identical block content');
}

const installed = new WeakSet();
export function installMxHighlight(md, renderMx = highlightMx) {
  // docmd 0.9.7 invokes markdownSetup twice on the same processor.
  if (installed.has(md)) return;
  installed.add(md);
  const previousHighlight = md.options.highlight;
  md.options.highlight = function (source, lang, ...args) {
    return lang === 'mx'
      ? renderMx(source)
      : previousHighlight.call(this, source, lang, ...args);
  };
  const previousFence = md.renderer.rules.fence;
  md.renderer.rules.fence = function (tokens, index, options, env, self) {
    const token = tokens[index];
    if (token.info.trim().split(/\s+/)[0] !== 'mx') {
      return previousFence.call(this, tokens, index, options, env, self);
    }
    try {
      return previousFence.call(this, tokens, index, options, env, self);
    } catch (cause) {
      // Render-time errors escape docmd's isolated setup hooks and abort the build.
      throw new Error(
        `${fenceLocation(token, env)}: ` +
        `Failed to highlight mx block with Shiki's Marko grammar. Check the block and highlighter configuration.\n` +
        `\`\`\`mx\n${token.content}\`\`\``,
        { cause },
      );
    }
  };
}

export default {
  plugin: { name: 'mesh-mx-highlight', version: '1.0.0', capabilities: ['markdown', 'head'] },
  markdownSetup: (md) => installMxHighlight(md),
  generateMetaTags: () => themeStyles,
};
