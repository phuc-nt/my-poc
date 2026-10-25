// Bundles the two Lambda functions into dist/<name>/index.mjs and zips them for the deploy.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS = { api: 'src/api/handler.mjs', monitor: 'src/monitor/handler.mjs' };

rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
for (const [name, entry] of Object.entries(FUNCTIONS)) {
  const out = join(ROOT, 'dist', name);
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [join(ROOT, entry)],
    outfile: join(out, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    // Some dependencies still call require(); give the ES module bundle one.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  execFileSync('zip', ['-q', '-j', join(ROOT, 'dist', `${name}.zip`), join(out, 'index.mjs')]);
  console.log(`dist/${name}.zip`);
}
