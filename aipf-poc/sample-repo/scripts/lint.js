// Checks every JavaScript file parses, and that application code does not log with console.*
// (the server writes to process.stdout/stderr on purpose, so logs stay one line per event).
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

const problems = [];
for (const file of await files('.')) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`${file}: does not parse\n${error.stderr}`);
  }
  if (file.startsWith('src/') && /\bconsole\.(log|info|debug)\(/.test(await readFile(file, 'utf8'))) {
    problems.push(`${file}: uses console.log/info/debug`);
  }
}
if (problems.length) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('lint ok\n');
