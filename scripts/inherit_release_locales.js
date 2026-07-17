/* Copy upstream translations from iD's stable release branch. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';


const ref = process.env.ID_TRANSLATION_REF || 'release';  // eslint-disable-line no-process-env
if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
  throw new Error('Invalid ID_TRANSLATION_REF');
}

const destination = path.resolve('dist/locales');
const localEnglishPath = path.join(destination, 'en.min.json');
let localEnglish;
try { localEnglish = await fs.readFile(localEnglishPath); } catch { /* generated later */ }

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'betterid-locales-'));
try {
  const archive = path.join(temporary, 'id.tar.gz');
  const response = await fetch(`https://github.com/openstreetmap/iD/archive/refs/heads/${ref}.tar.gz`);
  if (!response.ok) throw new Error(`Unable to download iD ${ref}: HTTP ${response.status}`);
  await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));

  execFileSync('tar', ['-xzf', archive, '-C', temporary], { stdio: 'inherit' });
  const extracted = (await fs.readdir(temporary, { withFileTypes: true }))
    .find(entry => entry.isDirectory() && entry.name.startsWith('iD-'));
  if (!extracted) throw new Error('Downloaded iD archive did not contain a source directory');

  const source = path.join(temporary, extracted.name, 'dist', 'locales');
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, { recursive: true, force: true });

  // `build:data` creates BetteriD's English strings from data/core.yaml.
  // Keep those while inheriting every translated locale from stable iD.
  if (localEnglish) await fs.writeFile(localEnglishPath, localEnglish);
  console.log(`Inherited stable iD translations from ${ref}`);  // eslint-disable-line no-console
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
