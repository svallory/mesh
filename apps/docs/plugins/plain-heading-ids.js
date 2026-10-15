// Plain heading ids. docmd 0.9.7 builds a heading's id from its text and the ids of the headings above it
// (`contributing-to-these-docs-continuous-integration`), with no option to turn that off, so a link written
// `#continuous-integration` finds no element. This plugin sets the id first, from the heading's own text only,
// and docmd's own rule (`heading_anchors`, which keeps an id that is already there) then builds its permalink and
// its table of contents from it.
//
// The slug is docmd's own. A repeated heading keeps the plain slug on its first occurrence and gets `-1`,
// `-2`, ... on the later ones, skipping any id the page already uses (an id written with `{#id}` included).

const RULE = 'mesh_plain_heading_ids';

export function slugOf(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/--+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

export function plainHeadingIds(state) {
  const used = new Set();
  for (const token of state.tokens) {
    if (token.type === 'heading_open' && token.attrGet('id')) used.add(token.attrGet('id'));
  }
  // docmd gives no heading inside a container an id (steps and custom containers), so none takes part here.
  let depth = 0;
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    if (token.type === 'steps_open' || (token.type.startsWith('custom_') && token.type.endsWith('_open'))) depth++;
    if (token.type === 'steps_close' || (token.type.startsWith('custom_') && token.type.endsWith('_close'))) depth--;
    if (token.type !== 'heading_open' || token.attrGet('id')) continue;
    if (state.env?.isInsideContainer || depth > 0) continue;
    const inline = state.tokens[i + 1];
    const slug = inline && inline.content ? slugOf(inline.content) : '';
    if (!slug) continue;
    let id = slug;
    for (let n = 1; used.has(id); n++) id = `${slug}-${n}`;
    used.add(id);
    token.attrSet('id', id);
  }
}

export function installPlainHeadingIds(md) {
  // docmd 0.9.7 invokes markdownSetup twice on the same processor.
  if (md.core.ruler.__find__(RULE) !== -1) return;
  md.core.ruler.before('heading_anchors', RULE, plainHeadingIds);
}

export default {
  plugin: { name: 'mesh-plain-heading-ids', version: '1.0.0', capabilities: ['markdown'] },
  markdownSetup: (md) => installPlainHeadingIds(md),
};
