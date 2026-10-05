// The home page's stylesheet. The page (docs/index.md) is self-contained HTML
// blocks around one docmd `grids` container holding two ordinary fences: docmd
// renders the fences, so the entity file is highlighted by the same `mx`
// highlighter as every other page, and this file only lays the page out.
//
// docmd 0.9.7 reads an HTML block until its tags balance, so a `<div>` opened
// around a fence swallows the fence as raw text. That is why the code pair is a
// `grids` container rather than a wrapper of our own, and why there is no page
// wrapper: every rule is scoped to the content column that holds `.mh-hero`
// (`HOME` below). `:has()` keeps the scope right after docmd's SPA navigation
// swaps a page in without a reload. Nothing here runs a script.
const HOME = '.main-content:has(>.mh-hero)';
const PAIR = `${HOME}>.mh-hero+.grids`;

export const homeStyles = `<style>
${HOME}{--mh-accent:var(--link-color,#068ad5);--mh-ink:var(--text-heading,#09090b);--mh-muted:var(--text-muted,#6b6b75);--mh-line:var(--border-color,#e4e4e7);--mh-panel:var(--code-bg,#fafafa);--mh-grid:rgb(9 9 11/.05);--mh-seam:3.5rem}
:root[data-theme=dark] ${HOME}{--mh-grid:rgb(250 250 250/.05)}
${HOME}>.docmd-breadcrumbs-row,${HOME}>h1.docmd-focus-title{display:none}
${HOME}>:is(.mh-hero,.grids,.mh-section,.mh-doors,.mh-colophon){box-sizing:border-box;width:100%;max-width:68rem;margin-left:auto;margin-right:auto}
${HOME} :is(h1,h2){border:0;padding:0}
${HOME} .mh-hero{padding:clamp(1.5rem,5vw,3.75rem) 0 2.25rem}
${HOME} .mh-hero>*{max-width:44rem}
@media (min-width:1180px){
  ${HOME} .mh-hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);column-gap:3.5rem;align-items:end;padding-bottom:2.5rem}
  ${HOME} .mh-hero>.mh-title{grid-row:1/4;margin:0;align-self:end}
  ${HOME} .mh-hero>:not(.mh-title){grid-column:2}
  ${HOME} .mh-hero .mh-lede{margin-bottom:1.5rem}
}
${HOME} .mh-title{margin:0 0 1.25rem;font-size:clamp(2.6rem,6.2vw,4.4rem);line-height:1;letter-spacing:-.045em;font-weight:750;color:var(--mh-ink)}
${HOME} .mh-lede{margin:0 0 1.75rem;font-size:clamp(1.05rem,1.6vw,1.2rem);line-height:1.6;max-width:38rem}
${HOME} .mh-lede code{font-size:.88em}
${HOME} .mh-actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:0 0 1.1rem}
${HOME} .mh-btn{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 1.15rem;border-radius:10px;border:1px solid var(--mh-line);color:var(--mh-ink);font-weight:600;text-decoration:none;transition:border-color .15s ease,background-color .15s ease,color .15s ease}
${HOME} .mh-btn:hover{border-color:var(--mh-accent);text-decoration:none}
${HOME} .mh-btn-main{background:var(--mh-ink);border-color:var(--mh-ink);color:var(--bg-color,#fff)}
${HOME} .mh-btn-main:hover{background:var(--mh-accent);border-color:var(--mh-accent);color:#fff}
:root[data-theme=dark] ${HOME} .mh-btn-main:hover{color:#06131c}
${HOME} :is(.mh-btn,.mh-door):focus-visible{outline:2px solid var(--mh-accent);outline-offset:3px}
${HOME} .mh-status{margin:0;font-size:.875rem;color:var(--mh-muted)}
${HOME} .mh-status::before{content:"";display:inline-block;width:.5rem;height:.5rem;margin-right:.55rem;border-radius:50%;background:#d97706;vertical-align:.05em}
/* The pairing: the file on the left, the call it gives you on the right, the
   build step on the seam between them, and a faint mesh behind both. */
${PAIR}{position:relative;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:var(--mh-seam);margin-top:.75rem;margin-bottom:4.5rem;padding:1.5rem 0;overflow:visible;isolation:isolate}
${PAIR}::before{content:"";position:absolute;inset:0 -1.5rem;z-index:-1;background-image:linear-gradient(var(--mh-grid) 1px,transparent 1px),linear-gradient(90deg,var(--mh-grid) 1px,transparent 1px);background-size:22px 22px;background-position:-1px -1px;-webkit-mask-image:radial-gradient(ellipse at center,#000 50%,transparent 100%);mask-image:radial-gradient(ellipse at center,#000 50%,transparent 100%)}
${PAIR}>.grid-item{position:relative;overflow:visible;display:flex;flex-direction:column;min-width:0;margin:0;padding:0;border:0;background:none}
${PAIR}>.grid-item>.docmd-code-block-wrapper{flex:1;display:flex;flex-direction:column;margin:0;border-radius:12px;background:var(--mh-panel);box-shadow:0 18px 40px -24px rgb(0 0 0/.35)}
${PAIR}>.grid-item>.docmd-code-block-wrapper>pre{flex:1;margin:0}
${PAIR} pre{font-size:.78rem;line-height:1.65}
${PAIR} .mh-seam{position:absolute;top:0;bottom:0;right:100%;width:var(--mh-seam);display:flex;align-items:center;justify-content:center}
${PAIR} .mh-seam::before{content:"";position:absolute;top:10%;bottom:10%;left:50%;border-left:1px dashed color-mix(in srgb,var(--mh-accent) 60%,transparent)}
${PAIR} .mh-build{position:relative;display:inline-flex;flex-direction:column;align-items:center;gap:.35rem;padding:.6rem .3rem;border-radius:999px;background:var(--bg-color,#fff);border:1px solid color-mix(in srgb,var(--mh-accent) 50%,transparent);color:var(--mh-accent)}
${PAIR} .mh-build code{writing-mode:vertical-rl;background:none;padding:0;border:0;color:inherit;font-size:.72rem;white-space:nowrap}
/* Below the pair: quiet, left-aligned, one measure. */
${HOME} .mh-section{margin-bottom:4rem}
${HOME} .mh-section h2{margin:0 0 .6rem;font-size:clamp(1.5rem,2.6vw,1.9rem);letter-spacing:-.025em;color:var(--mh-ink)}
${HOME} .mh-intro{margin:0 0 1.75rem;max-width:40rem;color:var(--mh-muted);line-height:1.6}
${HOME} .mh-gets{margin:0}
${HOME} .mh-gets>div{display:grid;grid-template-columns:11rem minmax(0,1fr);gap:1.5rem;padding:1.1rem 0;border-top:1px solid var(--mh-line)}
${HOME} .mh-gets>div:last-child{border-bottom:1px solid var(--mh-line)}
${HOME} .mh-gets dt{font-weight:650;color:var(--mh-ink)}
${HOME} .mh-gets dd{margin:0;display:grid;grid-template-columns:minmax(0,21rem) minmax(0,1fr);gap:1.5rem;align-items:baseline;line-height:1.55}
${HOME} .mh-gets .mh-src{justify-self:start;max-width:100%;overflow-wrap:anywhere;padding:.15rem .5rem;border-radius:6px;background:color-mix(in srgb,var(--mh-accent) 10%,transparent);color:var(--mh-ink);font-size:.78rem}
${HOME} .mh-who{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2rem}
${HOME} .mh-who li{margin:0;line-height:1.6}
${HOME} .mh-who strong{display:block;margin-bottom:.35rem;color:var(--mh-ink)}
${HOME} .mh-doors{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin-bottom:2.5rem}
${HOME} .mh-door{display:block;padding:1.4rem 1.5rem 1.5rem;border:1px solid var(--mh-line);border-radius:14px;color:var(--text-color);text-decoration:none;transition:border-color .15s ease,background-color .15s ease}
${HOME} .mh-door:hover{border-color:var(--mh-accent);background:color-mix(in srgb,var(--mh-accent) 5%,transparent);text-decoration:none}
${HOME} .mh-door strong{display:block;margin-bottom:.4rem;font-size:1.3rem;letter-spacing:-.02em;color:var(--mh-ink)}
${HOME} .mh-door span{display:block;line-height:1.55;color:var(--mh-muted)}
${HOME} .mh-colophon{margin-top:0;font-size:.875rem;color:var(--mh-muted)}
@media (max-width:1100px){
  ${HOME} .mh-gets dd{grid-template-columns:minmax(0,1fr);gap:.5rem}
}
@media (max-width:860px){
  ${PAIR}{grid-template-columns:minmax(0,1fr);padding:0;margin-bottom:3.5rem}
  ${PAIR}::before{inset:-1rem}
  ${PAIR} .mh-seam{top:auto;right:0;left:0;bottom:100%;width:auto;height:var(--mh-seam)}
  ${PAIR} .mh-seam::before{top:0;bottom:0}
  ${PAIR} .mh-build{flex-direction:row;padding:.3rem .75rem}
  ${PAIR} .mh-build code{writing-mode:horizontal-tb}
  ${PAIR} .mh-build svg{transform:rotate(90deg)}
  ${HOME} .mh-who{grid-template-columns:minmax(0,1fr);gap:1.25rem}
  ${HOME} .mh-doors{grid-template-columns:minmax(0,1fr)}
  ${HOME} .mh-gets>div{grid-template-columns:minmax(0,1fr);gap:.5rem}
}
@media (prefers-reduced-motion:reduce){${HOME} :is(.mh-btn,.mh-door){transition:none}}
</style>`;

export default {
  plugin: { name: 'mesh-home', version: '1.0.0', capabilities: ['head'] },
  generateMetaTags: () => homeStyles,
};
