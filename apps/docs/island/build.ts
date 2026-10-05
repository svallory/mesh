// Bundles the home page's island (home-flow.ts, Svelte Flow) into one minified
// ES module at site/assets/home-flow.js. Runs after `docmd build`, which creates
// site/, both in `bun run build` and in the Docker image build.
//
// bun-plugin-svelte always emits the components' styles as a separate CSS file.
// A <link> added at run time would not survive docmd's client-side navigation
// (it drops stylesheets the next page's head does not list), so the CSS is put
// into the module instead, as the constant `__mhComponentCss` that home-flow.ts
// injects with the rest of its styles.
import { SveltePlugin } from 'bun-plugin-svelte';
import { join } from 'node:path';

const target = join(import.meta.dir, '../site/assets/home-flow.js');
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, 'home-flow.ts')],
  target: 'browser',
  format: 'esm',
  minify: true,
  plugins: [SveltePlugin({ development: false })],
  define: { 'process.env.NODE_ENV': '"production"' },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const js = result.outputs.filter((output) => output.kind === 'entry-point');
const css = result.outputs.filter((output) => output.path.endsWith('.css'));
const other = result.outputs.filter((output) => !js.includes(output) && !css.includes(output));
if (js.length !== 1 || other.length > 0) {
  console.error(`island build: expected one entry and CSS only, got ${result.outputs.map((o) => o.path).join(', ')}`);
  process.exit(1);
}
const componentCss = (await Promise.all(css.map((output) => output.text()))).join('\n');
const module = `const __mhComponentCss=${JSON.stringify(componentCss)};\n${await js[0]!.text()}`;
await Bun.write(target, module);
const bytes = new TextEncoder().encode(module);
console.log(`island: site/assets/home-flow.js ${(bytes.length / 1024).toFixed(1)} KB, ${(Bun.gzipSync(bytes).length / 1024).toFixed(1)} KB gzip`);
