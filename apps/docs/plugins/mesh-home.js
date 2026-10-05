// The home page: its stylesheet, and the `mx-flow` fence that renders the entity
// file of the build diagram.
//
// The page (docs/index.md) is self-contained HTML blocks around one docmd
// `grids` container. docmd 0.9.7 reads an HTML block until its tags balance, so
// a `<div>` opened around a fence swallows the fence as raw text: the diagram's
// two halves are therefore the two items of a `grids` container, the entity file
// (an `mx-flow` fence) on the left and the build step and everything it writes
// (an HTML block) on the right.
//
// Everything here is static: the diagram, its connectors, and the highlighting of
// a box's source lines on hover (CSS `:has()`) all work without JavaScript, in
// print and with reduced motion. A small island (island/home-flow.ts, built into
// site/assets/home-flow.js) takes the diagram over after first paint and draws
// one edge from each part of the file to the build; when it is not there,
// nothing is missing.
//
// Every rule is scoped to the content column that holds `.mh-hero` (`HOME`), or
// to the body that holds it for the page chrome. `:has()` keeps the scope right
// in both directions of docmd's client-side navigation, which swaps the content
// without a reload and resets the body's classes.
import { mxHighlighter } from './mx-highlight.js';

const HOME = '.main-content:has(>.mh-hero)';
const BODY = 'body:has(.mh-hero)';
const FLOW = `${HOME}>.mh-hero+.grids`;

/** The sections of an entity file that a box can come from, in file order. */
export const FLOW_SECTIONS = ['entity', 'attributes', 'relationships', 'computed', 'actions', 'policies'];

/**
 * The entity file as one highlighted `<pre>`, one block per section, each
 * marked with the section it is (`data-section`), so a box that names that
 * section can tint its lines. The root line is the `entity` section; a line at
 * two spaces opens the section its first word names; blank lines between
 * sections stay outside them.
 */
export function renderMxFlow(source, file) {
  const lines = source.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const whole = lines.join('\n');
  const render = mxHighlighter(whole, file);
  const starts = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const sections = [];
  lines.forEach((line, index) => {
    const indent = line.length - line.trimStart().length;
    const word = line.trim().split(/[\s=]/)[0];
    if (line.trim() !== '' && (indent === 0 || (indent === 2 && FLOW_SECTIONS.includes(word)))) {
      const name = indent === 0 ? 'entity' : word;
      if (indent === 0 && sections.length > 0) throw new Error(`${file}: mx-flow line ${index + 1} is a second root line; an entity file holds one entity`);
      sections.push({ name, from: index, to: index });
    } else if (line.trim() !== '' && sections.length > 0) {
      if (indent === 2) throw new Error(`${file}: mx-flow line ${index + 1} opens "${word}", which is not one of ${FLOW_SECTIONS.join(', ')}`);
      sections.at(-1).to = index;
    } else if (line.trim() !== '') {
      throw new Error(`${file}: mx-flow line ${index + 1} comes before the entity line`);
    }
  });
  const lineHtml = (k) => `<span class="mh-l">${render(starts[k], starts[k] + lines[k].length)}</span>`;
  let code = '';
  let next = 0;
  for (const section of sections) {
    for (; next < section.from; next++) code += lineHtml(next);
    code += `<span class="mh-sec" data-section="${section.name}">`;
    for (; next <= section.to; next++) code += lineHtml(next);
    code += '</span>';
  }
  for (; next < lines.length; next++) code += lineHtml(next);
  // docmd's own fence rule wraps this in its titled code block (the header with
  // the file name and the copy button), as it does every fence with a title.
  return `<pre class="hljs mx-hl mh-file-code"><code class="language-mx">${code}</code></pre>`;
}

const installed = new WeakSet();

export function installMxFlow(md) {
  // docmd 0.9.7 invokes markdownSetup twice on the same processor.
  if (installed.has(md)) return;
  installed.add(md);
  const previousFence = md.renderer.rules.fence;
  md.renderer.rules.fence = function (tokens, index, options, env, self) {
    const token = tokens[index];
    const info = token.info.trim();
    if (info.split(/\s+/)[0] !== 'mx-flow') return previousFence.call(this, tokens, index, options, env, self);
    try {
      return renderMxFlow(token.content, env?.filePath);
    } catch (cause) {
      // Render-time errors escape docmd's isolated setup hooks and abort the build.
      throw new Error(`${cause.message}\n\`\`\`mx-flow\n${token.content}\`\`\``, { cause });
    }
  };
}

// A box names the sections it comes from (`data-from`); hovering it tints those
// sections' lines. One rule per section, generated, so the list cannot drift.
const tints = FLOW_SECTIONS.map((name) =>
  `${FLOW}:has(.mh-box[data-from~="${name}"]:is(:hover,.is-hot)) .mh-sec[data-section="${name}"]`).join(',');

export const homeStyles = `<style>
${HOME}{--mh-accent:var(--link-color,#068ad5);--mh-ink:var(--text-heading,#09090b);--mh-muted:var(--text-muted,#6b6b75);--mh-line:var(--border-color,#e4e4e7);--mh-panel:var(--code-bg,#fafafa);--mh-grid:rgb(9 9 11/.05);--mh-gap:6.5rem;--mh-stub:1.5rem;--mh-wire:color-mix(in srgb,var(--mh-accent) 55%,transparent)}
:root[data-theme=dark] ${HOME}{--mh-grid:rgb(250 250 250/.05)}
/* Full width: no sidebar on the home page. The top bar stays (site name, search,
   theme); the page's own nav leads into Docs and Architecture. */
${BODY}{--sidebar-width:0px}
${BODY} .sidebar,${BODY} #sidebar-toggle-button{display:none}
${BODY} .main-content-wrapper{margin-left:0}
${BODY} .content-area{max-width:84rem}
${HOME}>.docmd-breadcrumbs-row,${HOME}>h1.docmd-focus-title{display:none}
${HOME}>:is(.mh-nav,.mh-hero,.grids,.mh-section,.mh-doors,.mh-colophon,.docmd-code-block-wrapper){box-sizing:border-box;width:100%;max-width:76rem;margin-left:auto;margin-right:auto}
${HOME} :is(h1,h2,h3){border:0;padding:0}
${HOME} .mh-nav{display:flex;flex-wrap:wrap;gap:.25rem 1.5rem;margin-top:.25rem;font-weight:600;font-size:.95rem}
${HOME} .mh-nav a{color:var(--mh-ink);text-decoration:none;padding:.35rem 0;border-bottom:2px solid transparent}
${HOME} .mh-nav a:hover{border-bottom-color:var(--mh-accent);text-decoration:none}
${HOME} .mh-hero{padding:clamp(1.75rem,5vw,3.5rem) 0 1.5rem}
${HOME} .mh-hero>*{max-width:50rem}
${HOME} .mh-hero>.mh-title{max-width:64rem}
${HOME} .mh-title{margin:0 0 1.25rem;font-size:clamp(2.5rem,5.6vw,4.4rem);line-height:1.02;letter-spacing:-.045em;font-weight:750;color:var(--mh-ink);text-wrap:balance}
${HOME} .mh-lede{margin:0 0 1rem;font-size:clamp(1.05rem,1.5vw,1.2rem);line-height:1.6;max-width:46rem}
${HOME} .mh-lede+.mh-lede{margin-bottom:1.75rem}
${HOME} .mh-lede code{font-size:.88em}
${HOME} .mh-actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:0 0 1.1rem}
${HOME} .mh-btn{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 1.15rem;border-radius:10px;border:1px solid var(--mh-line);color:var(--mh-ink);font-weight:600;text-decoration:none;transition:border-color .15s ease,background-color .15s ease,color .15s ease}
${HOME} .mh-btn:hover{border-color:var(--mh-accent);text-decoration:none}
${HOME} .mh-btn-main{background:var(--mh-ink);border-color:var(--mh-ink);color:var(--bg-color,#fff)}
${HOME} .mh-btn-main:hover{background:var(--mh-accent);border-color:var(--mh-accent);color:#fff}
:root[data-theme=dark] ${HOME} .mh-btn-main:hover{color:#06131c}
${HOME} :is(.mh-btn,.mh-door,.mh-nav a):focus-visible{outline:2px solid var(--mh-accent);outline-offset:3px}
${HOME} .mh-status{margin:0;font-size:.875rem;color:var(--mh-muted)}
${HOME} .mh-status::before{content:"";display:inline-block;width:.5rem;height:.5rem;margin-right:.55rem;border-radius:50%;background:#d97706;vertical-align:.05em}
/* The build diagram: the entity file, the build on the seam, and one box per
   thing the build writes, wired to a trunk. The wires are CSS, so the diagram is
   whole without the island; the island hides them and draws its own. */
${FLOW}{position:relative;display:grid;grid-template-columns:minmax(0,.95fr) minmax(0,1.05fr);gap:var(--mh-gap);align-items:center;margin-top:.5rem;margin-bottom:4.5rem;padding:1.5rem 0;overflow:visible;isolation:isolate;border:0;box-shadow:none;background:none}
${FLOW}::before{content:"";position:absolute;inset:0 -1.5rem;z-index:-1;background-image:linear-gradient(var(--mh-grid) 1px,transparent 1px),linear-gradient(90deg,var(--mh-grid) 1px,transparent 1px);background-size:22px 22px;background-position:-1px -1px;-webkit-mask-image:radial-gradient(ellipse at center,#000 50%,transparent 100%);mask-image:radial-gradient(ellipse at center,#000 50%,transparent 100%)}
${FLOW}>.grid-item{position:relative;overflow:visible;display:flex;flex-direction:column;min-width:0;margin:0;padding:0;border:0;background:none;gap:0}
${FLOW} .mh-file,${FLOW}>.grid-item>.docmd-code-block-wrapper{margin:0;border-radius:12px;background:var(--mh-panel);box-shadow:0 18px 40px -24px rgb(0 0 0/.35)}
${FLOW} pre.mh-file-code{margin:0;padding:.9rem 0;font-size:.78rem;line-height:1.7;overflow-x:auto}
${FLOW} pre.mh-file-code code{display:block;min-width:max-content;padding:0}
${FLOW} .mh-l{display:block;min-height:1.7em;padding:0 1.1rem}
${FLOW} .mh-sec{display:block;transition:background-color .15s ease,box-shadow .15s ease}
${tints}{background:color-mix(in srgb,var(--mh-accent) 11%,transparent);box-shadow:inset 3px 0 0 var(--mh-accent)}
${FLOW} .mh-seam{position:absolute;top:0;bottom:0;right:100%;width:var(--mh-gap);display:flex;align-items:center;justify-content:center;z-index:1}
${FLOW} .mh-seam::before{content:"";position:absolute;top:50%;left:0;right:0;border-top:1.5px solid var(--mh-wire)}
${FLOW} .mh-build{position:relative;display:inline-flex;align-items:center;gap:.4rem;padding:.4rem .75rem;border-radius:999px;background:var(--bg-color,#fff);border:1.5px solid var(--mh-wire);color:var(--mh-accent);font-family:var(--font-family-mono,ui-monospace,monospace);font-size:.75rem;font-weight:600;white-space:nowrap}
${FLOW} .mh-out{position:relative;display:flex;flex-direction:column;gap:.5rem;padding-left:var(--mh-stub)}
${FLOW} .mh-out::before{content:"";position:absolute;left:0;top:2.6rem;bottom:2rem;border-left:1.5px solid var(--mh-wire)}
${FLOW} .mh-group{margin:.4rem 0 0;font-size:.8rem;font-weight:650;color:var(--mh-muted)}
${FLOW} .mh-group:first-child{margin-top:0}
${FLOW} .mh-box{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.15rem 1rem;align-items:start;padding:.6rem .85rem;border:1px solid var(--mh-line);border-radius:10px;background:var(--bg-color,#fff);transition:border-color .15s ease,box-shadow .15s ease}
${FLOW} .mh-box::before{content:"";position:absolute;right:100%;top:50%;width:var(--mh-stub);border-top:1.5px solid var(--mh-wire)}
${FLOW} .mh-box[data-via]::before{border-top-style:dashed}
${FLOW} .mh-box:is(:hover,.is-hot){border-color:var(--mh-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--mh-accent) 14%,transparent)}
${FLOW} .mh-box h3{grid-column:1;margin:0;font-size:.95rem;font-weight:650;letter-spacing:-.01em;color:var(--mh-ink)}
${FLOW} .mh-box p{grid-column:1;margin:0;font-size:.8rem;line-height:1.5;color:var(--mh-muted)}
${FLOW} .mh-box pre{grid-column:2;grid-row:1/span 4;align-self:center;margin:0;padding:.45rem .6rem;border-radius:7px;background:var(--mh-panel);font-size:.72rem;line-height:1.55;white-space:pre;overflow-x:auto}
${FLOW} .mh-box pre code{padding:0;background:none;font-size:inherit}
${FLOW} .mh-box code{font-size:.92em}
${FLOW} .mh-box .mh-from{font-size:.72rem}
/* The island's layer: it draws the wires once it has measured the boxes. */
${FLOW} .mh-flow-layer{position:absolute;inset:0;z-index:0;pointer-events:none;opacity:0;transition:opacity .2s ease}
${FLOW}.is-flow-live .mh-flow-layer{opacity:1}
${FLOW}.is-flow-live :is(.mh-seam,.mh-out,.mh-box)::before{opacity:0}
${FLOW}.is-flow-live :is(.docmd-code-block-wrapper,.mh-out,.mh-build){position:relative;z-index:1}
/* The sections under the diagram. */
${HOME} .mh-section{margin-bottom:4.5rem}
${HOME} .mh-section:has(+.docmd-code-block-wrapper){margin-bottom:1.25rem}
${HOME}>.mh-section+.docmd-code-block-wrapper{margin-bottom:4.5rem}
${HOME} .mh-section h2{margin:0 0 .6rem;font-size:clamp(1.55rem,2.6vw,2rem);letter-spacing:-.025em;color:var(--mh-ink)}
${HOME} .mh-intro{margin:0 0 1.75rem;max-width:46rem;color:var(--mh-muted);line-height:1.6}
${HOME} .mh-connect{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1.5rem 2rem}
${HOME} .mh-connect li{margin:0;line-height:1.6}
${HOME} .mh-connect strong{display:block;margin-bottom:.35rem;color:var(--mh-ink)}
${HOME} .mh-agent{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:1.5rem 3rem;align-items:start}
${HOME} .mh-agent>:is(h2,.mh-lead,.mh-more){grid-column:1/-1}
${HOME} .mh-agent .mh-lead{margin:0 0 .5rem;font-size:clamp(1.15rem,1.8vw,1.35rem);line-height:1.45;color:var(--mh-ink);max-width:46rem}
${HOME} .mh-why{list-style:none;margin:0;padding:0;display:grid;gap:1.1rem}
${HOME} .mh-why li{margin:0;line-height:1.6}
${HOME} .mh-why strong{color:var(--mh-ink)}
${HOME} .mh-tally{margin:0;padding:1.1rem 1.25rem;border:1px solid var(--mh-line);border-radius:12px;background:var(--mh-panel)}
${HOME} .mh-tally h3{margin:0 0 .75rem;font-size:1rem;color:var(--mh-ink)}
${HOME} .mh-tally p{margin:0 0 .6rem;font-size:.9rem;line-height:1.55}
${HOME} .mh-tally ul{margin:0;padding-left:1.1rem;font-size:.9rem;line-height:1.6;color:var(--mh-muted)}
${HOME} .mh-tally pre{margin:.9rem 0 0;padding:.6rem .75rem;border-radius:8px;background:var(--bg-color,#fff);font-size:.72rem;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
${HOME} .mh-tally pre code{padding:0;background:none}
${HOME} .mh-more{margin:.5rem 0 0}
${HOME} .mh-doors{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin-bottom:2.5rem}
${HOME} .mh-door{display:block;padding:1.4rem 1.5rem 1.5rem;border:1px solid var(--mh-line);border-radius:14px;color:var(--text-color);text-decoration:none;transition:border-color .15s ease,background-color .15s ease}
${HOME} .mh-door:hover{border-color:var(--mh-accent);background:color-mix(in srgb,var(--mh-accent) 5%,transparent);text-decoration:none}
${HOME} .mh-door strong{display:block;margin-bottom:.4rem;font-size:1.3rem;letter-spacing:-.02em;color:var(--mh-ink)}
${HOME} .mh-door span{display:block;line-height:1.55;color:var(--mh-muted)}
${HOME} .mh-colophon{margin-top:0;font-size:.875rem;color:var(--mh-muted)}
@media (max-width:1180px){
  ${FLOW} .mh-box{grid-template-columns:minmax(0,1fr)}
  ${FLOW} .mh-box pre{grid-column:1;grid-row:auto;margin-top:.35rem}
  ${HOME} .mh-connect{grid-template-columns:repeat(2,minmax(0,1fr))}
}
/* A narrow screen: the diagram becomes a vertical flow, file, then build, then
   the boxes on a trunk down their left side. */
@media (max-width:900px){
  ${FLOW}{grid-template-columns:minmax(0,1fr);gap:0;padding:0;margin-bottom:3.5rem}
  ${FLOW}::before{inset:-1rem}
  ${FLOW} .mh-seam{position:relative;right:auto;top:auto;bottom:auto;width:auto;height:4.25rem;justify-content:flex-start;padding-left:0}
  ${FLOW} .mh-seam::before{top:0;bottom:0;left:.75rem;right:auto;border-top:0;border-left:1.5px solid var(--mh-wire)}
  ${FLOW} .mh-out{padding-left:2rem}
  ${FLOW} .mh-out::before{left:.75rem;top:-.5rem}
  ${FLOW} .mh-box::before{width:1.25rem}
  ${HOME} .mh-agent,${HOME} .mh-doors{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:560px){
  ${HOME} .mh-connect{grid-template-columns:minmax(0,1fr)}
}
@media (prefers-reduced-motion:reduce){${HOME} :is(.mh-btn,.mh-door,.mh-box,.mh-sec){transition:none}}
@media print{
  ${FLOW} .mh-flow-layer{display:none}
  ${FLOW}.is-flow-live :is(.mh-seam,.mh-out,.mh-box)::before{opacity:1}
  ${FLOW} .mh-sec{background:none!important;box-shadow:none!important}
}
</style>`;

export default {
  plugin: { name: 'mesh-home', version: '1.0.0', capabilities: ['markdown', 'head'] },
  markdownSetup: (md) => installMxFlow(md),
  generateMetaTags: () => homeStyles,
};
