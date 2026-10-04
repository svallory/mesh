// Renders an annotated entity figure: one complete `.mx` file, cut into consecutive
// segments, each paired with a note that says what the user gets from it.
//
// The page stays Markdown. The author writes a single `mx-figure` fence whose
// content is the whole file, with `// @key: Title — Body` lines as the
// annotations. Those lines are valid Marko comments, so the fence is still a
// legal `.mx` file, and each one starts a new segment: every line of the file
// appears exactly once, in file order, in exactly one segment.
//
//     ```mx-figure
//     entity="todo" table="todos"
//     // @name: Name and table — todo lives in the todos table.
//       attributes
//     // @fields: Fields you send — title is a required string.
//         uuid-primary-key="id"
//     ```
//
// Segments are highlighted with the same Marko grammar, themes and dark-mode
// handling as every `mx` fence on the site (see ./mx-highlight.js). The layout is
// a grid at wide widths and one column under 760px, measured on the container so
// it does not depend on the viewport.
import { highlightMx } from './mx-highlight.js';

const NOTE = /^\/\/\s*@([a-z][a-z0-9-]*):\s*(.+?)\s+—\s+(.+)$/;
const EMPTY_SEGMENT = 'a segment must hold at least one line of the file';

function indentOf(line) {
  return line.length - line.trimStart().length;
}

export function parseMxFigure(source, file = '<markdown>') {
  const segments = [];
  const problems = [];
  let current = null;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  lines.forEach((line, index) => {
    const note = NOTE.exec(line);
    if (note) {
      const title = note[2];
      if (title.split(/\s+/).length > 4) {
        problems.push(`${file}: mx-figure note "${note[1]}" has a ${title.split(/\s+/).length}-word title; use two to four words`);
      }
      current = { key: note[1], title, body: note[3], code: [], line: index + 1 };
      segments.push(current);
      return;
    }
    if (!current) {
      if (line.trim() === '') return;
      problems.push(`${file}: mx-figure starts with code, before any "// @key: Title — Body" note`);
      current = { key: 'untitled', title: 'Untitled', body: '', code: [], line: index + 1 };
      segments.push(current);
    }
    current.code.push(line);
  });
  // A segment must not end with a line less indented than the first line of the next
  // one: that means a block was left open at the end of the previous segment, so the
  // note beside it describes the wrong lines. A note placed above the section tag it
  // heads is the other way round and is fine. The file's root line is exempt: it is
  // the only line that legitimately stands above everything that follows it.
  for (let i = 1; i < segments.length; i++) {
    const previous = segments[i - 1].code[segments[i - 1].code.length - 1] ?? "";
    const first = segments[i].code[0] ?? "";
    const root = segments[i - 1].code.length === 1 && indentOf(previous) === 0;
    if (!root && indentOf(previous) < indentOf(first)) {
      problems.push(
        `${file}:${segments[i].line}: mx-figure note "${segments[i].key}" starts at ${indentOf(first)} spaces ` +
        `but the previous segment ends at ${indentOf(previous)}: that segment kept a section tag its note does not head`,
      );
    }
  }
  const kept = segments.filter((segment) => {
    if (segment.code.length > 0) return true;
    problems.push(`${file}:${segment.line}: mx-figure note "${segment.key}" has ${EMPTY_SEGMENT}`);
    return false;
  });
  return { segments: kept, problems };
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline code spans and emphasis only: a note is a sentence, not a page. */
function noteBody(body) {
  return escapeHtml(body)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export function renderMxFigure(source, file) {
  const { segments, problems } = parseMxFigure(source, file);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const rows = segments
    .map((segment, index) => {
      const code = highlightMx(`${segment.code.join('\n')}\n`);
      const note = `<div class="mx-row mx-note"><span class="mx-badge">${index + 1}</span>` +
        `<p><strong>${escapeHtml(segment.title)}</strong> ${noteBody(segment.body)}</p></div>`;
      return `<div class="mx-row mx-code">${code}</div>${note}`;
    })
    .join('');
  return `<div class="mx-figure-wrap"><figure class="mx-figure">${rows}</figure></div>`;
}

export const figureStyles = `<style>
.mx-figure-wrap{container-type:inline-size}
.mx-figure{display:grid;grid-template-columns:minmax(0,max-content) minmax(14rem,1fr);gap:0 2.25rem;margin:2rem 0;align-items:start}
.mx-figure .mx-row{min-width:0}
.mx-figure .mx-code{position:relative}
.mx-figure .mx-code::after{content:"";position:absolute;top:1.1rem;left:100%;width:2.25rem;border-top:1px solid color-mix(in srgb,currentColor 40%,transparent)}
.mx-figure pre.shiki{margin:0;padding:.55rem .85rem;border-radius:8px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.8rem;line-height:1.6;white-space:pre;tab-size:2}
.mx-figure pre.shiki code{font:inherit;background:none}
.mx-figure .mx-note{display:flex;gap:.6rem;align-items:baseline;padding:.55rem 0;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent)}
.mx-figure .mx-note:first-of-type{border-top:0}
.mx-figure .mx-note p{margin:0;max-width:34rem}
.mx-figure .mx-badge{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;min-width:1.5rem;height:1.5rem;border:1px solid color-mix(in srgb,currentColor 45%,transparent);border-radius:999px;font-size:.75rem;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@container (max-width:860px){
  .mx-figure{grid-template-columns:1fr;gap:.1rem}
  .mx-figure .mx-code::after{display:none}
  .mx-figure .mx-note{border-top:0;padding:.1rem 0 .7rem}
  .mx-figure pre.shiki{font-size:.82rem}
}
</style>`;

const installed = new WeakSet();

export function installMxFigure(md, render = renderMxFigure) {
  // docmd 0.9.7 invokes markdownSetup twice on the same processor.
  if (installed.has(md)) return;
  installed.add(md);
  const previousFence = md.renderer.rules.fence;
  md.renderer.rules.fence = function (tokens, index, options, env, self) {
    const token = tokens[index];
    if (token.info.trim().split(/\s+/)[0] !== 'mx-figure') {
      return previousFence.call(this, tokens, index, options, env, self);
    }
    try {
      return render(token.content, env?.filePath);
    } catch (cause) {
      // Render-time errors escape docmd's isolated setup hooks and abort the build.
      throw new Error(`${cause.message}\n\`\`\`mx-figure\n${token.content}\`\`\``, { cause });
    }
  };
}

export default {
  plugin: { name: 'mesh-mx-figure', version: '1.0.0', capabilities: ['markdown', 'head'] },
  markdownSetup: (md) => installMxFigure(md),
  generateMetaTags: () => figureStyles,
};