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
// dependency), each figure is marked live and the list gives way to one note
// panel per figure: hovering a segment or focusing its marker shows that
// segment's note in the panel and tints the segment's lines; a click, Enter or
// Space pins it; Escape or a click elsewhere closes it. The panel floats over the
// right side of the code block and stays in view while the file scrolls (moving
// to the bottom of the view, or narrowing, when the hovered lines run under it);
// on a phone it is a sheet that slides in from the bottom, or from the top when
// the segment is in the lower half, and in landscape a drawer from the right.
//
// The live state is a class on each figure, set by a MutationObserver, never a
// class on the root: docmd's client-side navigation rewrites the root's class
// attribute (docmd-main.js, `document.documentElement.className = ...`), which
// once left a page half in list mode and half in popover mode.
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
  // The stage holds the code and, once the script runs, the note panel, in one
  // grid cell, so the panel floats over the code. docmd wraps the `<pre>` in its
  // own `.code-wrapper` for the copy button; nothing here depends on the `<pre>`
  // being a direct child.
  return `<div class="mx-figure-wrap"><figure class="mx-figure" id="${id}">` +
    `<div class="mx-stage"><div class="mx-code"><pre class="hljs mx-hl"><code class="language-mx">${code}</code></pre></div></div>` +
    `<ol class="mx-notes">${notes}</ol></figure></div>`;
}

export const figureStyles = `<style>
/* Site identity uses the page's text colour, not the theme's link accent. */
.sidebar-header h1 a{color:var(--text-color,inherit)}
/* docmd's flex heading splits text around code into separate columns. Keep
   inline code in the normal text flow, not a code-block-sized badge. */
.docmd-heading:is(h1,h2,h3,h4):has(code){display:block}
:is(h1,h2,h3,h4) code{display:inline;font-size:.85em;font-weight:inherit;line-height:inherit;padding:.05em .15em;background:none;border:0;border-radius:0;white-space:normal;overflow-wrap:anywhere}
.mx-figure-wrap{--mx-accent:var(--link-color,#068ad5);--mx-gutter:3.4em}
.mx-figure{position:relative;margin:2rem 0}
.mx-figure .mx-stage{display:grid}
.mx-figure .mx-stage>*{grid-area:1/1;min-width:0}
.mx-figure .mx-code{container-type:inline-size}
.mx-figure pre.mx-hl{margin:0;padding:.85rem 0;border-radius:10px;border:1px solid var(--border-color-codeblock,#0a0a0a17);overflow-x:auto;font-family:var(--font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:.8rem;line-height:1.65;white-space:pre;tab-size:2;counter-reset:mx-line}
.mx-figure pre.mx-hl code{display:block;min-width:max-content;font:inherit;background:none;padding:0}
.mx-figure .mx-seg{display:block;transition:background-color .14s ease,box-shadow .14s ease}
.mx-figure .mx-line{display:block;position:relative;min-height:1.65em;padding-left:calc(var(--mx-gutter) + var(--i,0) * 1ch);padding-right:1.25rem;text-indent:calc(var(--i,0) * -1ch)}
.mx-figure .mx-line::before{counter-increment:mx-line;content:counter(mx-line);position:absolute;left:0;width:calc(var(--mx-gutter) - 1.4em);text-align:right;text-indent:0;color:color-mix(in srgb,currentColor 32%,transparent);-webkit-user-select:none;user-select:none}
.mx-figure .mx-mark{display:inline-flex;align-items:center;justify-content:center;vertical-align:.08em;margin-left:1.2ch;min-width:1.4rem;height:1.4rem;padding:0 .3rem;border:0;border-radius:.4rem;background:color-mix(in srgb,var(--mx-accent) 16%,transparent);color:var(--mx-accent);font:600 .72rem/1 var(--font-family-sans,system-ui,sans-serif);text-indent:0;cursor:pointer;-webkit-user-select:none;user-select:none;transition:background-color .12s ease,color .12s ease}
.mx-figure .mx-mark::before{content:attr(data-n)}
.mx-figure .mx-mark:focus-visible{outline:2px solid var(--mx-accent);outline-offset:2px}
.mx-figure .mx-seg.is-active{background:color-mix(in srgb,var(--mx-accent) 9%,transparent);box-shadow:inset 3px 0 0 var(--mx-accent)}
.mx-figure .mx-seg.is-active .mx-mark,.mx-figure .mx-mark:hover{background:var(--mx-accent);color:var(--bg-color,#fff)}
.mx-figure .mx-notes{list-style:none;margin:1rem 0 0;padding:0;display:grid;gap:.55rem}
.mx-figure .mx-note{display:block;position:relative;padding-left:2.2rem;line-height:1.55;max-width:42rem}
.mx-figure :is(.mx-note,.mx-panel)::before{content:attr(data-n);position:absolute;left:0;top:.1em;display:inline-flex;align-items:center;justify-content:center;min-width:1.45rem;height:1.45rem;border-radius:.45rem;background:color-mix(in srgb,var(--mx-accent) 16%,transparent);color:var(--mx-accent);font-size:.75rem;font-weight:600}
.mx-figure :is(.mx-note,.mx-panel) strong{color:var(--text-heading,inherit)}
.mx-figure :is(.mx-note,.mx-panel) code{font-size:.85em}
.mx-figure :is(.mx-note,.mx-panel) strong::after{content:" \\2014";font-weight:400}
/* Live (the script has marked this figure): the list gives way to one panel. The
   list stays in the document, hidden, because each marker's aria-describedby
   points at its item. */
.mx-figure .mx-panel{display:none}
.mx-figure.is-live .mx-notes{display:none}
.mx-figure.is-live .mx-panel{display:block;position:sticky;top:var(--mx-top,64px);align-self:start;justify-self:end;z-index:5;box-sizing:border-box;width:360px;max-width:calc(100% - 24px);margin:48px 12px 12px;padding:.7rem .95rem .8rem 2.85rem;border:1px solid var(--border-color,#e4e4e7);border-radius:12px;background:var(--bg-color,#fff);box-shadow:0 1px 2px rgb(0 0 0/.06),0 14px 36px -10px rgb(0 0 0/.28);font-size:.875rem;line-height:1.55;overflow:hidden;opacity:0;visibility:hidden;pointer-events:none;transform:translate3d(0,var(--dy,-6px),0) scale(.98);transform-origin:top right;transition:opacity .14s cubic-bezier(.2,.7,.3,1),transform .16s cubic-bezier(.2,.7,.3,1),height .16s cubic-bezier(.2,.7,.3,1),visibility 0s linear .16s}
.mx-figure.is-live .mx-panel::before{left:.8rem;top:.75rem}
.mx-figure.is-live .mx-panel[data-side=bottom]{align-self:end;top:auto;bottom:16px;--dy:6px;transform-origin:bottom right}
.mx-figure.is-live .mx-panel.is-open{opacity:1;visibility:visible;pointer-events:auto;transform:none;transition-delay:0s}
.mx-figure .mx-panel-body.is-swap{animation:mx-swap .12s cubic-bezier(.2,.7,.3,1)}
@keyframes mx-swap{from{opacity:0;transform:translateY(3px)}}
/* A phone held upright: a sheet from the bottom, or from the top when the part
   sits in the lower half of the screen. Held sideways: a drawer from the right.
   The slide is a clip-path wipe, so the box never sits outside the viewport (a
   box translated off screen widens a phone's layout viewport). */
.mx-figure.is-live .mx-panel:is([data-mode=sheet],[data-mode=drawer]){position:fixed;align-self:stretch;justify-self:stretch;height:auto;margin:0;max-width:none;z-index:60;transform:none;transition:opacity .1s linear,clip-path .2s cubic-bezier(.2,.7,.3,1),visibility 0s linear .2s}
.mx-figure.is-live .mx-panel[data-mode=sheet]{left:8px;right:8px;width:auto;top:auto;bottom:max(8px,env(safe-area-inset-bottom));clip-path:inset(100% 0 0 0 round 12px)}
.mx-figure.is-live .mx-panel[data-mode=sheet][data-side=top]{top:var(--mx-top,64px);bottom:auto;clip-path:inset(0 0 100% 0 round 12px)}
.mx-figure.is-live .mx-panel[data-mode=drawer]{top:var(--mx-top,64px);bottom:8px;right:8px;left:auto;overflow:auto;clip-path:inset(0 0 0 100% round 12px)}
.mx-figure.is-live .mx-panel:is([data-mode=sheet],[data-mode=drawer]).is-open{clip-path:inset(0 round 12px);transition-delay:0s}
:root[data-theme=dark] .mx-figure.is-live .mx-panel{background:#1a1a1f;border-color:#34343a;box-shadow:0 14px 36px -10px rgb(0 0 0/.75)}
@media (prefers-reduced-motion:reduce){
  .mx-figure.is-live .mx-panel,.mx-figure.is-live .mx-panel:is([data-mode=sheet],[data-mode=drawer]){transform:none!important;clip-path:none!important;transition:opacity .06s linear,visibility 0s linear .06s}
  .mx-figure .mx-panel-body.is-swap{animation:none}
  .mx-figure .mx-seg,.mx-figure .mx-mark{transition:none}
}
@container (max-width:640px){
  /* A narrow column wraps a long line under its own indentation instead of
     scrolling it out of the box. Nothing is ever clipped. */
  .mx-figure pre.mx-hl{--mx-gutter:2.6em;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.76rem}
  .mx-figure pre.mx-hl code{min-width:0}
}
@media print{
  .mx-figure.is-live .mx-notes{display:grid}
  .mx-figure.is-live .mx-panel{display:none}
  .mx-figure pre.mx-hl{white-space:pre-wrap}
  .mx-figure .mx-seg{background:none!important;box-shadow:none!important}
}
</style>`;

// The behaviour, inline and dependency-free. It listens on the document, so it
// also works on a page docmd swapped in without a reload (the site is an SPA),
// and it reads nothing but the markup above. It writes inline styles only on
// the panel, and removes them when the panel closes; a note item never gets one.
export const figureScript = `<script>(function(){
var d=document,open=null,pinned=false,timer=0,raf=0,touched=0;
function live(){d.querySelectorAll('.mx-figure:not(.is-live)').forEach(function(f){f.classList.add('is-live');});}
new MutationObserver(live).observe(d.documentElement,{childList:true,subtree:true});
d.addEventListener('DOMContentLoaded',live);
function panelOf(fig){
  var p=fig.querySelector('.mx-panel');
  if(!p){p=d.createElement('div');p.className='mx-panel';p.setAttribute('aria-hidden','true');p.innerHTML='<div class="mx-panel-body"></div>';fig.querySelector('.mx-stage').appendChild(p);}
  return p;
}
function parts(seg){var fig=seg.closest('.mx-figure');return{fig:fig,seg:seg,mark:seg.querySelector('.mx-mark'),note:d.getElementById(seg.getAttribute('data-note')),panel:panelOf(fig)};}
function mode(){return innerHeight<=500&&innerWidth>innerHeight?'drawer':innerWidth<=640?'sheet':'float';}
function headerBottom(){var h=d.querySelector('.page-header');return h?Math.max(0,h.getBoundingClientRect().bottom):0;}
function place(p){
  var n=p.panel,m=mode(),s=p.seg.getBoundingClientRect(),top=headerBottom()+12;
  n.setAttribute('data-mode',m);n.style.setProperty('--mx-top',top+'px');
  if(m==='sheet'){n.setAttribute('data-side',(s.top+s.bottom)/2>innerHeight/2?'top':'bottom');return;}
  var c=p.fig.querySelector('pre').getBoundingClientRect(),r=d.createRange(),end=0,w=Math.min(360,Math.max(240,c.width*.42)),side='top';
  // Where the part's own text ends: a line is a full-width block, so measure its contents.
  p.seg.querySelectorAll('.mx-line').forEach(function(l){r.selectNodeContents(l);end=Math.max(end,r.getBoundingClientRect().right);});
  if(m==='drawer'){n.style.width=Math.max(240,Math.min(380,innerWidth-end-24))+'px';return;}
  if(end>c.right-w-24){
    var room=c.right-end-36;
    if(room>=220)w=room;
    else{
      // The lines run under the panel: keep them readable by moving the panel to
      // whichever end of the view they are not in.
      n.style.width=w+'px';var h=n.offsetHeight,t=Math.max(c.top,top);
      if(s.top<t+h+8&&s.bottom>t)side='bottom';
    }
  }
  n.style.width=w+'px';n.setAttribute('data-side',side);
}
function release(p){p.seg.classList.remove('is-active');p.mark.setAttribute('aria-expanded','false');}
// A closed panel keeps no inline style or placement: they are cleared once its
// fade has finished, unless it was reopened meanwhile.
function hide(n){n.classList.remove('is-open');setTimeout(function(){if(!n.classList.contains('is-open')){n.removeAttribute('style');n.removeAttribute('data-side');n.removeAttribute('data-mode');}},220);}
function close(){clearTimeout(timer);if(!open)return;var p=open;open=null;pinned=false;release(p);hide(p.panel);}
function show(seg,pin){
  clearTimeout(timer);
  if(open&&open.seg===seg){if(pin)pinned=true;return;}
  var p=parts(seg);if(!p.mark||!p.note)return;
  var n=p.panel,body=n.firstChild,swap=!!(open&&open.panel===n&&n.classList.contains('is-open')),h0=swap?n.offsetHeight:0;
  if(open){var q=open;open=null;release(q);if(q.panel!==n)hide(q.panel);}
  open=p;pinned=!!pin;
  seg.classList.add('is-active');p.mark.setAttribute('aria-expanded','true');
  body.innerHTML=p.note.innerHTML;n.setAttribute('data-n',p.note.getAttribute('data-n'));
  n.style.height='';place(p);
  if(swap){
    body.classList.remove('is-swap');void body.offsetWidth;body.classList.add('is-swap');
    if(n.getAttribute('data-mode')==='float'){var h1=n.offsetHeight;n.style.height=h0+'px';void n.offsetHeight;n.style.height=h1+'px';setTimeout(function(){if(open&&open.panel===n)n.style.height='';},180);}
  }
  n.classList.add('is-open');
}
function later(){clearTimeout(timer);if(open&&!pinned)timer=setTimeout(close,120);}
d.addEventListener('pointerover',function(e){
  if(e.pointerType!=='mouse'||!e.target.closest)return;
  var seg=e.target.closest('.mx-figure.is-live .mx-seg');
  if(seg){if(!pinned)show(seg,false);else if(open&&open.seg===seg)clearTimeout(timer);return;}
  if(open&&open.panel.contains(e.target)){clearTimeout(timer);return;}
  later();
});
d.addEventListener('pointerdown',function(e){if(e.pointerType!=='mouse')touched=Date.now();},true);
// A tap focuses the marker before its click arrives; the click decides, so a tap
// is one toggle, not an open followed by a close.
d.addEventListener('focusin',function(e){var t=e.target;if(Date.now()-touched>600&&t.classList&&t.classList.contains('mx-mark')&&t.closest('.mx-figure.is-live')){if(!(open&&pinned&&open.mark!==t))show(t.closest('.mx-seg'),false);}});
d.addEventListener('focusout',function(e){if(open&&e.target===open.mark&&!pinned)close();});
d.addEventListener('click',function(e){
  var t=e.target.closest&&e.target.closest('.mx-mark,.mx-seg,.mx-panel');
  if(t&&t.classList.contains('mx-panel'))return;
  if(!t&&e.target.closest&&e.target.closest('.mx-figure.is-live .mx-stage'))return;
  if(t&&t.closest('.mx-figure.is-live')){
    var seg=t.closest('.mx-seg');
    if(t.classList.contains('mx-mark')&&open&&open.seg===seg&&pinned){close();return;}
    show(seg,true);if(open)pinned=true;return;
  }
  if(open)close();
});
d.addEventListener('keydown',function(e){if(e.key==='Escape'&&open){var m=open.mark,inside=open.fig.contains(d.activeElement);close();if(inside)m.focus({preventScroll:true});}});
function again(){cancelAnimationFrame(raf);raf=requestAnimationFrame(function(){if(open){if(!open.seg.isConnected){close();return;}place(open);}});}
addEventListener('resize',again);addEventListener('scroll',again,{passive:true});
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

// docmd 0.9.7 renders Markdown in authored headings and TOC entries, but copies
// frontmatter/navigation titles as escaped plain text in its chrome. Strip paired
// code delimiters only from known text-only labels and title metadata. Keep HTML
// entities encoded, URLs untouched, and JSON-LD safe inside its script element.
// Authored code elements and fences are never rewritten.
export function cleanTitleLabels(html) {
  const plain = (text) => text.replace(/`([^`\n]+)`/g, '$1');
  const socialTitle = (tag) => {
    // Read complete quoted attributes, so attribute-like text inside a value
    // cannot accidentally select this tag or become a replacement target.
    const attrs = [...tag.matchAll(/(\s+)([^\s=/>]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/g)];
    if (!attrs.some((a) => (a[2] === 'property' && (a[4] ?? a[5]) === 'og:title') ||
      (a[2] === 'name' && (a[4] ?? a[5]) === 'twitter:title'))) return tag;
    const content = attrs.find((a) => a[2] === 'content');
    if (!content) return tag;
    const quote = content[4] === undefined ? "'" : '"';
    const value = content[4] ?? content[5];
    const replacement = content[1] + content[2] + content[3] + quote + plain(value) + quote;
    return tag.slice(0, content.index) + replacement + tag.slice(content.index + content[0].length);
  };
  const breadcrumbs = (match, open, source, close) => {
    let data;
    try { data = JSON.parse(source); } catch { return match; }
    // Only the top-level BreadcrumbList shape docmd emits, not arbitrary JSON-LD.
    if (data?.['@type'] !== 'BreadcrumbList' || !Array.isArray(data.itemListElement)) return match;
    let changed = false;
    for (const item of data.itemListElement) {
      if (item?.['@type'] !== 'ListItem' || typeof item.name !== 'string') continue;
      const name = plain(item.name);
      changed ||= name !== item.name;
      item.name = name;
    }
    if (!changed) return match;
    // JSON.stringify handles quotes/backslashes; HTML-significant characters
    // must stay escaped so a name can never terminate the containing script.
    const json = JSON.stringify(data).replace(/[<>&\u2028\u2029]/g,
      (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    return open + json + close;
  };
  return html
    .replace(/(<(?:span|h1|a)\b[^<>]*\bclass="(?:[^"<>]* )?(?:nav-item-title|header-title|docmd-focus-title|toc-link)(?: [^"<>]*)?"[^<>]*>)([^<>]*)(<\/(?:span|h1|a)>)/g,
      (_match, open, text, close) => open + plain(text) + close)
    .replace(/(<title>)([^<>]*)(<\/title>)/g,
      (_match, open, text, close) => open + plain(text) + close)
    .replace(/(<li\b[^<>]*class="breadcrumb-item active"[^<>]*>\s*<span>)([^<>]*)(<\/span>)/g,
      (_match, open, text, close) => open + plain(text) + close)
    .replace(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, socialTitle)
    .replace(/(<script\s+type="application\/ld\+json"\s*>)([\s\S]*?)(<\/script>)/g, breadcrumbs);
}

export default {
  plugin: { name: 'mesh-mx-figure', version: '1.0.0', capabilities: ['markdown', 'head', 'build'] },
  markdownSetup: (md) => installMxFigure(md),
  generateMetaTags: () => figureStyles + figureScript + noScriptStyles,
  onPageReady: (page) => { page.html = cleanTitleLabels(page.html); },
};