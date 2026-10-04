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
        `${env?.filePath ?? '<markdown>'}:${(token.map?.[0] ?? 0) + 1}:1: ` +
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
