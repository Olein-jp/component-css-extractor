import { readFile } from 'node:fs/promises';

const tag = process.argv[2];
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const expected = `v${packageJson.version}`;

if (manifest.version !== packageJson.version) {
  throw new Error(`manifest.json (${manifest.version}) and package.json (${packageJson.version}) must use the same version.`);
}
if (tag !== expected) {
  throw new Error(`Release tag must be ${expected}; received ${tag ?? '(none)'}.`);
}

process.stdout.write(`Verified ${tag}.\n`);
