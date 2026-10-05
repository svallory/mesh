// Renders an annotated entity figure: one complete `.mx` file, shown as one
// uninterrupted code block, with a numbered marker on each annotated part and a
// note for each marker.
//
// The page stays Markdown. The author writes a single `mx-figure` fence whose
// content is the whole file, with `// @key: Title — Body` lines as the
// annotations. Those lines are valid MX comments, so the fence is still a legal
// `.mx` file, and each one starts a new segment: every line of the file appears
// exactly once, in file order, in exactly one segment.
//
//     ```mx-figure
//     // @name: Name and table — Todo lives in the todos table.
//     entity :Todo table="todos"
//     // @fields: Fields you send — title is a required string.
//       attributes
//         string :title min=1
//     ```
//
// The annotation lines are not shown. The rest of the file is highlighted once by
// MX's own highlighter (./mx-highlight.js) and rendered as one `<pre>`, line for
// line as an editor shows it. Each segment is a block in that `<pre>` with a
// marker button at the end of its first line; the notes are an ordered list
// under the code, one item per marker, each linked to its marker by
// `aria-describedby`.
//
// Without JavaScript, and in print, that list is what the reader gets: the code,
// then the numbered notes. With JavaScript (the small inline script below, no
// dependency), the list becomes the set of popovers: hovering a segment or
// focusing its marker shows its note beside the segment, right-aligned in the
// code block, whenever the segment's own lines end left of it (otherwise, and in
// a column under 600px, under the segment, so a note never covers its own lines), the segment's lines are tinted while its
// note is open, a click, Enter or Space pins the note, and Escape or a click
// elsewhere closes it.
import { mxHighlighter } from './mx-highlight.js';

const NOTE = /^\/\/\s*@([a-z][a-z0-9-]*):\s*(.+?)\s+—\s+(.+)$/;
const EMPTY_SEGMENT = 'a segment must hold at least one line of the file';

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** The fence content as lines: no CRLF, no trailing empty line. */
function sourceLines(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function parseMxFigure(source, file = '<markdown>') {
  const segments = [];
  const problems = [];
  let current = null;
  const lines = sourceLines(source);
  lines.forEach((line, index) => {
    const note = NOTE.exec(line);
    if (note) {
      const title = note[2];
      if (title.split(/\s+/).length > 4) {
        problems.push(`${file}: mx-figure note "${note[1]}" has a ${title.split(/\s+/).length}-word title; use two to four words`);
      }
      current = { key: note[1], title, body: note[3], code: [], line: index + 1, start: index + 1, end: index + 1 };
      segments.push(current);
      return;
    }
    if (!current) {
      if (line.trim() === '') return;
      problems.push(`${file}: mx-figure starts with code, before any "// @key: Title — Body" note`);
      current = { key: 'untitled', title: 'Untitled', body: '', code: [], line: index + 1, start: index + 1, end: index + 1 };
      segments.push(current);
    }
    current.code.push(line);
    // The half-open line range this segment occupies in the whole file, so the
    // renderer can highlight the file once and read this segment out of it.
    current.start = Math.min(current.start, index);
    current.end = index + 1;
  });
  // A segment must not end with a line less indented than the first line of the next
  // one: that means a block was left open at the end of the previous segment, so the
  // note beside it describes the wrong lines. A note placed above the section tag it
  // heads is the other way round and is fine. The file's root line is exempt: it is
  // the only line that legitimately stands above everything that follows it.
  for (let i = 1; i < segments.length; i++) {
    // Blank lines carry no indentation, so the check reads the last line with text.
    const previous = segments[i - 1].code.findLast((text) => text.trim() !== '') ?? "";
    const first = segments[i].code[0] ?? "";
    const root = segments[i - 1].code.filter((text) => text.trim() !== '').length === 1 && indentOf(previous) === 0;
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

// The same four characters the package's renderer escapes, so a title, a note
// and a code line are all safe in the HTML this file builds by hand.
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline code spans and emphasis only: a note is a sentence, not a page. */
function noteBody(body) {
  return escapeHtml(body)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// A short, stable hash of the fence, so the ids of two figures on one page never
// collide and a rebuild of the same page produces the same ids.
function figureId(source) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `mxf-${(hash >>> 0).toString(36)}`;
}

export function renderMxFigure(source, file) {
  const { segments, problems } = parseMxFigure(source, file);
  // One parse of the whole file, then each line reads its own range out of it:
  // a slice of an entity file is not a document on its own and would colour as
  // nothing (see ./mx-highlight.js).
  //
  // The `// @key:` lines are this figure's own notation, not part of the entity
  // file, so they are blanked before the file is parsed (the line count stays, so
  // every segment keeps its range, and no annotation is ever rendered). Blanking
  // them is also what keeps the parse whole: in concise syntax a line at the
  // left margin ends the root tag's block, a comment included, so an author who
  // wrote one of these notes at the left margin inside the entity would end the
  // entity there and leave every line below it unreadable. `mxHighlighter`
  // refuses a file the grammar could not read, so the figure would fail the
  // build rather than render those lines uncoloured.
  const lines = sourceLines(source).map((line) => (NOTE.test(line) ? '' : line));
  const whole = lines.join('\n');
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const lineStart = [];
  let at = 0;
  for (const line of lines) {
    lineStart.push(at);
    at += line.length + 1;
  }
  const render = mxHighlighter(whole, file);
  const id = figureId(sourceLines(source).join('\n'));
  // One block per line, carrying its indentation so a line that wraps on a narrow
  // screen hangs under its own first character instead of the left margin.
  const line = (index, extra = '') =>
    `<span class="mx-line" style="--i:${indentOf(lines[index])}">` +
    `${render(lineStart[index], lineStart[index] + lines[index].length)}${extra}</span>`;
  let code = '';
  segments.forEach((segment, index) => {
    const n = index + 1;
    let last = segment.end - 1;
    // Blank lines the author left at the end of a segment stay in the file, but
    // outside the segment, so the tint of an open note covers only its own code.
    while (last > segment.start && lines[last].trim() === '') last--;
    const first = segment.start + segment.code.findIndex((text) => text.trim() !== '');
    const marker = `<button type="button" class="mx-mark" id="${id}-m${n}" data-n="${n}" ` +
      `aria-label="Note ${n}: ${escapeHtml(segment.title)}" aria-describedby="${id}-n${n}" ` +
      `aria-controls="${id}-n${n}" aria-expanded="false"></button>`;
    code += `<span class="mx-seg" data-note="${id}-n${n}">`;
    for (let k = segment.start; k <= last; k++) code += line(k, k === first ? marker : '');
    code += '</span>';
    for (let k = last + 1; k < segment.end; k++) code += line(k);
  });
  // A file does not end with a blank line in an editor's view either.
  code = code.replace(/(<span class="mx-line" style="--i:0"><\/span>)+$/, '');
  const notes = segments
    .map((segment, index) =>
      `<li class="mx-note" id="${id}-n${index + 1}" data-n="${index + 1}">` +
      `<strong>${escapeHtml(segment.title)}</strong> ${noteBody(segment.body)}</li>`)
    .join('');
  return `<div class="mx-figure-wrap"><figure class="mx-figure" id="${id}">` +
    `<pre class="hljs mx-hl"><code class="language-mx">${code}</code></pre>` +
    `<ol class="mx-notes">${notes}</ol></figure></div>`;
}

export const figureStyles = `<style>
.mx-figure-wrap{container-type:inline-size;--mx-accent:var(--link-color,#068ad5);--mx-gutter:3.4em}
.mx-figure{position:relative;margin:2rem 0}
.mx-figure pre.mx-hl{margin:0;padding:.85rem 0;border-radius:10px;border:1px solid var(--border-color-codeblock,#0a0a0a17);overflow-x:auto;font-family:var(--font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:.8rem;line-height:1.65;white-space:pre;tab-size:2;counter-reset:mx-line}
.mx-figure pre.mx-hl code{display:block;min-width:max-content;font:inherit;background:none;padding:0}
.mx-figure .mx-seg{display:block;transition:background-color .14s ease,box-shadow .14s ease}
.mx-figure .mx-line{display:block;position:relative;min-height:1.65em;padding-left:calc(var(--mx-gutter) + var(--i,0) * 1ch);padding-right:1.25rem;text-indent:calc(var(--i,0) * -1ch)}
.mx-figure .mx-line::before{counter-increment:mx-line;content:counter(mx-line);position:absolute;left:0;width:calc(var(--mx-gutter) - 1.4em);text-align:right;text-indent:0;color:color-mix(in srgb,currentColor 32%,transparent);-webkit-user-select:none;user-select:none}
.mx-figure .mx-mark{display:inline-flex;align-items:center;justify-content:center;vertical-align:.08em;margin-left:1.2ch;min-width:1.4rem;height:1.4rem;padding:0 .3rem;border:0;border-radius:.4rem;background:color-mix(in srgb,var(--mx-accent) 16%,transparent);color:var(--mx-accent);font:600 .72rem/1 var(--font-family-sans,system-ui,sans-serif);text-indent:0;cursor:pointer;-webkit-user-select:none;user-select:none;transition:background-color .12s ease,color .12s ease,transform .12s ease}
.mx-figure .mx-mark::before{content:attr(data-n)}
.mx-figure .mx-mark:focus-visible{outline:2px solid var(--mx-accent);outline-offset:2px}
.mx-figure .mx-seg.is-active{background:color-mix(in srgb,var(--mx-accent) 9%,transparent);box-shadow:inset 3px 0 0 var(--mx-accent)}
.mx-figure .mx-seg.is-active .mx-mark,.mx-figure .mx-mark:hover{background:var(--mx-accent);color:var(--bg-color,#fff)}
.mx-figure .mx-notes{list-style:none;margin:1rem 0 0;padding:0;display:grid;gap:.55rem}
.mx-figure .mx-note{display:block;position:relative;padding-left:2.2rem;line-height:1.55;max-width:42rem}
.mx-figure .mx-note::before{content:attr(data-n);position:absolute;left:0;top:.1em;display:inline-flex;align-items:center;justify-content:center;min-width:1.45rem;height:1.45rem;border-radius:.45rem;background:color-mix(in srgb,var(--mx-accent) 16%,transparent);color:var(--mx-accent);font-size:.75rem;font-weight:600}
.mx-figure .mx-note strong{color:var(--text-heading,inherit)}
.mx-figure .mx-note code{font-size:.85em}
.mx-figure .mx-note strong::after{content:" \\2014";font-weight:400}
/* With the script: the list is the set of popovers. */
.mx-fig-js .mx-figure .mx-notes{display:block;margin:0}
.mx-fig-js .mx-figure .mx-note{position:absolute;top:0;left:0;z-index:5;box-sizing:border-box;width:min(24rem,calc(100% - 1rem));max-width:none;padding:.7rem .9rem .75rem 2.75rem;border:1px solid var(--border-color,#e4e4e7);border-radius:10px;background:var(--bg-color,#fff);box-shadow:0 1px 2px rgb(0 0 0/.06),0 12px 32px -8px rgb(0 0 0/.22);font-size:.875rem;opacity:0;visibility:hidden;pointer-events:none;transform:translate3d(var(--dx,0),var(--dy,-6px),0) scale(.97);transform-origin:var(--ox,24px) var(--oy,0);transition:opacity .14s cubic-bezier(.2,.7,.3,1),transform .16s cubic-bezier(.2,.7,.3,1),visibility 0s linear .16s}
.mx-fig-js .mx-figure .mx-note::before{left:.8rem;top:.8rem}
.mx-fig-js .mx-figure .mx-note[data-place=right]{--dx:-8px;--dy:0;--ox:0;--oy:1rem}
.mx-fig-js .mx-figure .mx-note[data-place=above]{--dy:6px;--oy:100%}
.mx-fig-js .mx-figure .mx-note.is-open{opacity:1;visibility:visible;pointer-events:auto;transform:none;transition-delay:0s}
.mx-fig-js .mx-figure .mx-note.is-swap{transition:opacity .07s linear,visibility 0s}
.mx-fig-js .mx-figure .mx-note.is-gone{transition:none}
:root[data-theme=dark].mx-fig-js .mx-figure .mx-note{background:#1a1a1f;border-color:#34343a;box-shadow:0 12px 32px -8px rgb(0 0 0/.7)}
@media (prefers-reduced-motion:reduce){
  .mx-fig-js .mx-figure .mx-note{transform:none!important;transition:opacity .06s linear,visibility 0s linear .06s}
  .mx-figure .mx-seg,.mx-figure .mx-mark{transition:none}
}
@container (max-width:640px){
  /* A narrow column wraps a long line under its own indentation instead of
     scrolling it out of the box. Nothing is ever clipped. */
  .mx-figure-wrap{--mx-gutter:2.6em}
  .mx-figure pre.mx-hl{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.76rem}
  .mx-figure pre.mx-hl code{min-width:0}
}
@media print{
  .mx-fig-js .mx-figure .mx-notes{display:grid;margin:1rem 0 0}
  .mx-fig-js .mx-figure .mx-note{position:static;width:auto;opacity:1;visibility:visible;transform:none;border:0;box-shadow:none;padding:0 0 0 2.2rem;background:none}
  .mx-fig-js .mx-figure .mx-note::before{left:0;top:.1em}
  .mx-figure pre.mx-hl{white-space:pre-wrap}
  .mx-figure .mx-seg{background:none!important;box-shadow:none!important}
}
</style>`;

// The behaviour, inline and dependency-free. It listens on the document, so it
// also works on a page docmd swapped in without a reload (the site is an SPA),
// and it reads nothing but the markup above.
export const figureScript = `<script>(function(){
var d=document,R=d.documentElement,open=null,pinned=false,timer=0;
R.classList.add('mx-fig-js');
function parts(seg){var fig=seg.closest('.mx-figure');return{fig:fig,seg:seg,mark:seg.querySelector('.mx-mark'),note:d.getElementById(seg.getAttribute('data-note'))};}
function place(p){
  var n=p.note,f=p.fig.getBoundingClientRect(),c=p.fig.querySelector('pre').getBoundingClientRect(),
      s=p.seg.getBoundingClientRect(),m=p.mark.getBoundingClientRect(),r=d.createRange(),end=0,w,x,y,where;
  // Where the part's own text ends: a line is a full-width block, so measure its contents.
  p.seg.querySelectorAll('.mx-line').forEach(function(l){r.selectNodeContents(l);end=Math.max(end,r.getBoundingClientRect().right);});
  w=Math.min(384,c.right-end-28);
  if(f.width>=600&&w>=240){x=c.right-f.left-w-12;y=s.top-f.top;where='right';n.style.removeProperty('--ox');}
  else{
    w=Math.min(f.width-8,384);x=Math.max(4,Math.min(m.left-f.left-24,f.width-w-4));
    n.style.width=w+'px';var h=n.offsetHeight,above=s.top-f.top-h-8;
    var fits=s.bottom+8+h<=innerHeight||above<0||s.top-h-8<0;
    y=fits?s.bottom-f.top+8:above;where=fits?'below':'above';
    n.style.setProperty('--ox',Math.max(12,m.left-f.left-x+10)+'px');
  }
  n.style.width=w+'px';n.style.left=x+'px';n.style.top=y+'px';n.setAttribute('data-place',where);
}
function close(instant){
  clearTimeout(timer);if(!open)return;var p=open;open=null;pinned=false;
  p.seg.classList.remove('is-active');p.mark.setAttribute('aria-expanded','false');
  if(instant){p.note.classList.add('is-gone');p.note.offsetWidth;}
  p.note.classList.remove('is-open','is-swap');
  if(instant)requestAnimationFrame(function(){p.note.classList.remove('is-gone');});
}
function show(seg,pin){
  clearTimeout(timer);
  if(open&&open.seg===seg){if(pin)pinned=true;return;}
  var swap=!!open;close(true);
  var p=parts(seg);if(!p.mark||!p.note)return;open=p;pinned=!!pin;
  p.seg.classList.add('is-active');p.mark.setAttribute('aria-expanded','true');
  place(p);p.note.classList.toggle('is-swap',swap);p.note.classList.add('is-open');
}
function later(){clearTimeout(timer);if(open&&!pinned)timer=setTimeout(function(){close(false);},120);}
d.addEventListener('pointerover',function(e){
  if(e.pointerType!=='mouse'||!e.target.closest)return;
  var seg=e.target.closest('.mx-seg');
  if(seg&&seg.closest('.mx-figure')){if(!pinned)show(seg,false);else if(open&&open.seg===seg)clearTimeout(timer);return;}
  if(open&&open.note.contains(e.target)){clearTimeout(timer);return;}
  later();
});
d.addEventListener('focusin',function(e){var t=e.target;if(t.classList&&t.classList.contains('mx-mark')){if(!(open&&pinned&&open.mark!==t))show(t.closest('.mx-seg'),false);}});
d.addEventListener('focusout',function(e){if(open&&e.target===open.mark&&!pinned)close(false);});
d.addEventListener('click',function(e){
  var t=e.target.closest&&e.target.closest('.mx-mark,.mx-seg,.mx-note');
  if(t&&t.classList.contains('mx-note'))return;
  if(t&&t.closest('.mx-figure')){
    var seg=t.closest('.mx-seg');
    if(t.classList.contains('mx-mark')&&open&&open.seg===seg&&pinned){close(false);return;}
    show(seg,true);if(open)pinned=true;return;
  }
  if(open)close(false);
});
d.addEventListener('keydown',function(e){if(e.key==='Escape'&&open){var m=open.mark,inside=open.fig.contains(d.activeElement);close(false);if(inside)m.focus({preventScroll:true});}});
addEventListener('resize',function(){if(open)place(open);});
})();</script>`;

// docmd hides the whole page until its theme script runs, so without JavaScript
// nothing at all would show, the figure's notes included. This undoes that one
// rule for readers without JavaScript; with it, it is inert.
export const noScriptStyles = '<noscript><style>html{visibility:visible!important}</style></noscript>';

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
  generateMetaTags: () => figureStyles + figureScript + noScriptStyles,
};