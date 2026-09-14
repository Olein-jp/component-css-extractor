import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/devtools/devtools.ts', 'src/panel/panel.ts'],
  outdir: 'dist',
  entryNames: '[name]',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: false,
});
await build({
  entryPoints: ['src/inspector/inspect-page.ts'],
  outfile: 'dist/inspect-page.js',
  bundle: true,
  format: 'iife',
  globalName: '__componentCssInspector',
  target: 'chrome120',
  minify: false,
});
await Promise.all(['manifest.json', 'icon.png', 'src/devtools/devtools.html', 'src/panel/panel.html', 'src/panel/panel.css'].map(async (file) => {
  const name = file.split('/').at(-1);
  if (name) await cp(file, `dist/${name}`);
}));
