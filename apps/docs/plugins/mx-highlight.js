// `mx` fences on the docs site are highlighted with MX's own highlighter: the
// tree-sitter grammar, queries and TypeScript injection vendored under ./mx (see
// ./mx/SOURCE.md), run through web-tree-sitter at build time. Nothing is parsed
// in the browser; the page gets static spans ([ADR-0065]).
//
// This module is the single docmd entry point for `mx`:
//   - it routes every ```mx fence through the vendored `renderFence`, through
//     `md.options.highlight` (not `renderer.rules.fence`), so docmd's own
//     ```lang "title" wrapper, header and copy button keep working;
//   - it wraps the fence rule to turn a highlight failure into a build failure
//     that names the page and the line;
//   - it emits the stylesheet that maps the grammar's capture names to the two
//     themes docmd highlights every other language with, so an `mx` block sits
//     beside a `ts` block without a seam in either theme.
//
// `mx-figure` fences import `highlightMx` from here, so the annotated figure and
// ordinary fences can never drift apart.
import { readFileSync } from 'node:fs';
import { classesOf, captureNames, classOf, escapeHtml, renderFence } from './mx/mx-highlight.mjs';

/** One `<pre>` for one `mx` fence or one figure segment. */
export function highlightMx(source) {
  return renderFence(source);
}

/**
 * A renderer for slices of one parsed `source`.
 *
 * The annotated figure is one entity file cut into consecutive segments, and a
 * segment that starts at an indented section tag (`  attributes`) is not a
 * document on its own: parsed alone it is an error tree and colours nothing.
 * So the figure parses the whole file once and each segment reads its own line
 * range out of the result, which is also what makes a segment look exactly like
 * the same lines in a full-file fence.
 *
 * @param {string} source
 * @returns {(start: number, end: number) => string} highlighted HTML of
 *   `source.slice(start, end)`, the same markup `renderFence` would produce.
 */
export function mxHighlighter(source) {
  const classes = classesOf(source);
  return (start, end) => {
    let html = '';
    let at = start;
    while (at < end) {
      const cls = classes[at] ?? null;
      let stop = at + 1;
      while (stop < end && (classes[stop] ?? null) === cls) stop++;
      const text = escapeHtml(source.slice(at, stop));
      html += cls ? `<span class="${cls}">${text}</span>` : text;
      at = stop;
    }
    return html;
  };
}

/**
 * Capture name -> [light colour, dark colour].
 *
 * The hexes are the ones docmd's own highlight stylesheets use, the light and
 * the dark variant of the same theme (`assets/css/docmd-highlight-light.css`
 * and `-dark.css` in `@docmd/ui`, the classes `.hljs-keyword`, `.hljs-string`,
 * `.hljs-attr`, `.hljs-title`, `.hljs-literal`, `.hljs-number`,
 * `.hljs-built_in`, `.hljs-comment`). docmd highlights every language except
 * `mx` with those two stylesheets, so borrowing their hexes is what makes an
 * `mx` block and the `ts` block beside it one piece of page: same keyword
 * purple, same string green, same background, in both themes.
 *
 * `none` (the grammar's deliberately unstyled text) and `embedded` produce no
 * span, and the captures listed as `null` below inherit docmd's `pre` colour,
 * which is what the other blocks use for a plain word.
 */
const PALETTE = {
  // MX syntax.
  tag: ['#a626a4', '#c678dd'], //        a tag name, like hljs-keyword
  keyword: ['#a626a4', '#c678dd'], //    `return`, `static`
  operator: ['#a626a4', '#c678dd'], //   `=`, `=>`, `===`
  label: ['#4078f2', '#61aeee'], //     `:label` after a tag
  constant: ['#0184bb', '#56b6c2'], //  `#name` after a space
  attribute: ['#986801', '#d19a66'], // an attribute name
  string: ['#50a14f', '#98c379'],
  // A regex literal: TypeScript captures its body as `string.special`, and the
  // theme colours a regex like a string, so the italic is what tells them apart.
  'string.special': ['#50a14f', '#98c379'],
  comment: ['#a0a1a7', '#5c6370'],
  'punctuation.bracket': ['#a0a1a7', '#5c6370'],
  'punctuation.delimiter': ['#a0a1a7', '#5c6370'],
  'punctuation.special': ['#a0a1a7', '#5c6370'],
  // TypeScript injected into MX: a function body, an attribute value, a pattern.
  function: ['#4078f2', '#61aeee'],
  'function.method': ['#4078f2', '#61aeee'],
  type: ['#c18401', '#e6c07b'],
  'type.builtin': ['#c18401', '#e6c07b'],
  'function.builtin': ['#c18401', '#e6c07b'],
  'constant.builtin': ['#c18401', '#e6c07b'], // `true`, `false`, `null`
  'variable.builtin': ['#c18401', '#e6c07b'],
  number: ['#c18401', '#e6c07b'],
  // A plain word: a variable, a parameter, a property. docmd's `pre` colour
  // already is the plain colour, so these need no rule.
  variable: null,
  'variable.parameter': null,
  property: null,
};

/** Capture names the vendored queries can produce that need no colour. */
const UNSTYLED = ['none', 'embedded'];

/** Captures set in italic, so a regex literal reads apart from a plain string. */
const ITALIC = new Set(['string.special', 'comment']);

/**
 * The capture names with neither a colour nor a deliberate blank, for the tests:
 * a refreshed grammar that adds a capture fails on this until it is placed.
 */
export function unstyledCaptureNames() {
  return captureNames.filter((name) => !(name in PALETTE) && !UNSTYLED.includes(name));
}

const COLOURED = captureNames.filter((name) => PALETTE[name]);

/**
 * The whole stylesheet: one rule per capture in the light theme, one in the
 * dark. It colours spans and nothing else, so the `pre` itself is docmd's box
 * with docmd's background in both themes.
 */
export const themeStyles = `<style>
/* Colours for the mx highlighter's capture classes, in the two themes docmd
   switches with :root[data-theme="dark"]. Generated from PALETTE above. */
${COLOURED.map(
  (name) =>
    `.mx-hl .${classOf(name)}{color:${PALETTE[name][0]}` +
    (ITALIC.has(name) ? ';font-style:italic' : '') +
    '}',
).join('\n')}
${COLOURED.map(
  (name) => `:root[data-theme="dark"] .mx-hl .${classOf(name)}{color:${PALETTE[name][1]}}`,
).join('\n')}
</style>`;

// Recover the fence by its exact content, not a guessed preprocessing offset.
// Only the error path reads the source; this uses the same APIs on Node and Bun.
function fenceLocation(token, env, captured) {
  const bodyLine = (token.map?.[0] ?? 0) + 1;
  const file = env?.filePath ?? '<markdown>';
  // Recursive docmd renders dedent fragments and have no reliable page map.
  // Never match their content to a later, identical top-level fence.
  if (env?.isInsideContainer || captured?.isInsideContainer) {
    return `FrameworkError: ${file}: mx block is inside a container ` +
      `(line ${bodyLine} relative to that container's content)`;
  }
  let body = captured?.source;
  const unavailable = (reason) =>
    `FrameworkError: ${file}: mx block could not be located in the source ` +
    `(line ${bodyLine} relative to the page body after frontmatter; ${reason})`;
  if (!env?.filePath) return unavailable('source path unavailable');
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    return unavailable(`source could not be read: ${error.message}`);
  }
  source = source.replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const content = token.content.replace(/\r\n?/g, '\n');
  const candidates = [];
  for (let start = 0; start < lines.length; start++) {
    const opening = lines[start].match(/^ {0,3}(`{3,}|~{3,})[\t ]*mx(?:[\t ].*)?$/);
    if (!opening) continue;
    const marker = opening[1];
    const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[\\t ]*$`);
    for (let end = start + 1; end < lines.length; end++) {
      if (!closing.test(lines[end])) continue;
      const rawBlock = lines.slice(start + 1, end).join('\n') + (end > start + 1 ? '\n' : '');
      if (rawBlock === content) candidates.push(start + 1);
      break;
    }
  }
  if (typeof body === 'string') {
    body = body.replace(/\r\n?/g, '\n');
    if (source.endsWith(body)) {
      const sourceLine = bodyLine + lines.length - body.split('\n').length;
      if (candidates.includes(sourceLine)) return `${file}:${sourceLine}:1`;
      return unavailable('computed source line has no mx fence with identical block content');
    }
  }
  if (candidates.length === 1) return `${file}:${candidates[0]}:1`;
  if (candidates.length > 1) {
    return unavailable(`ambiguous matching fences; candidate source lines: ${candidates.join(', ')}`);
  }
  return unavailable('no matching mx fence with identical block content');
}

const installed = new WeakSet();
export function installMxHighlight(md, renderMx = highlightMx) {
  // docmd 0.9.7 invokes markdownSetup twice on the same processor.
  if (installed.has(md)) return;
  installed.add(md);
  // Keep the exact normalized input markdown-it parsed, keyed by render env.
  // A core rule observes it without modifying the body or the source file.
  const bodies = new WeakMap();
  md.core.ruler.push('mesh_mx_source', (state) => {
    if (!state.inlineMode) {
      bodies.set(state.env, {
        source: state.src,
        isInsideContainer: Boolean(state.env.isInsideContainer),
      });
    }
  });
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
        `${fenceLocation(token, env, bodies.get(env))}: ` +
        `Failed to highlight mx block with MX's tree-sitter highlighter (plugins/mx). ` +
        `Check the block and the vendored grammar.\n` +
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
