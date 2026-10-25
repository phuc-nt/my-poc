#!/usr/bin/env node
// Recreates all of PoC 3 in one command, after `node infra/deploy.mjs down` and `node infra/kb.mjs down`.
//
//   node infra/redeploy.mjs          knowledge bases, first sync, app, test accounts, monitor run, end-to-end test
//   node infra/redeploy.mjs --no-e2e the same without the end-to-end test
//
// The time goes to AWS, not to the build: creating the knowledge bases and data sources, their first sync, and the
// CloudFront distribution. The knowledge bases and the app stack do not need each other at deploy time (the
// functions find the knowledge bases by name when they run), so the two are made side by side and the first sync
// runs while CloudFront is still being created. Only the data bucket, which holds the function code, comes first.
// infra/deploy.local.json is kept across a teardown, so the origin secret and the test passwords stay the same.

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 60000)} min`;

// Runs one step, its output lines prefixed with the lane's name; rejects when the step fails.
function run(lane, script, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(ROOT, script), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream.on('data', (chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) console.log(`[${lane}] ${line}`);
      });
      stream.on('end', () => rest && console.log(`[${lane}] ${rest}`));
    }
    child.on('close', (code) => (code ? reject(new Error(`${script} ${args.join(' ')} failed (${lane}, after ${elapsed()})`)) : resolve()));
  });
}

async function lane(name, steps) {
  for (const step of steps) await run(name, ...step);
  console.log(`[${name}] done after ${elapsed()}`);
}

try {
  await run('kb', 'infra/kb.mjs', 'bucket');
  await Promise.all([
    lane('kb', [['infra/kb.mjs', 'up'], ['infra/kb.mjs', 'sync'], ['infra/kb.mjs', 'wait']]),
    lane('app', [['infra/deploy.mjs', 'up'], ['infra/deploy.mjs', 'users']]),
  ]);
  await run('app', 'infra/deploy.mjs', 'monitor');
  if (!process.argv.includes('--no-e2e')) await run('e2e', 'scripts/e2e.mjs');
  console.log(`PoC 3 is up after ${elapsed()}; the site address is in infra/deploy.local.json (site)`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
