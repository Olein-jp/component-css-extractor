import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const name = `component-css-extractor-v${version}`;
const output = resolve('release');
const archive = join(output, `${name}.zip`);
const checksum = join(output, `${name}.sha256`);
const temporary = await mkdtemp(join(tmpdir(), 'component-css-extractor-release-'));

try {
  await cp('dist', join(temporary, name), { recursive: true });
  await mkdir(output, { recursive: true });
  await rm(archive, { force: true });
  await run('zip', ['-q', '-r', archive, basename(join(temporary, name))], { cwd: temporary });
  await run('unzip', ['-tq', archive]);
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(checksum, `${digest}  ${basename(archive)}\n`);
  process.stdout.write(`${archive}\nSHA-256: ${digest}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
