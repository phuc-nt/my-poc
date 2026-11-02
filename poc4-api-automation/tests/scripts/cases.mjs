#!/usr/bin/env node
// The test-case catalogue's tooling: it keeps cases/, the specs and the product source in step.
//
//   node scripts/cases.mjs check [--strict]       every test has a documented case, every case a test, the matrix
//                                                 is current; --strict also fails on stale features and gaps
//   node scripts/cases.mjs impact [--base <ref>]  which features, cases and specs a source or contract change touches
//                                 [--json]        (default: everything changed since each feature's last review)
//   node scripts/cases.mjs stamp <FEATURE...>     record that a feature's cases and specs were reviewed against
//                                 | --all         its current source
//   node scripts/cases.mjs matrix                 rewrite cases/TRACEABILITY.md
//   node scripts/cases.mjs next-id <FEATURE>      the next free case id of a feature
//
// Settings are in kit.config.json. The format of a case file is in cases/README.md.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'kit.config.json'), 'utf8'));
const casesDir = path.join(root, config.casesDir ?? 'cases');
const lockFile = path.join(casesDir, 'review.lock.json');
const matrixFile = path.join(casesDir, 'TRACEABILITY.md');

const FEATURE_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)?$/;
const CASE_ID = /^([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)?)-(\d{2,3})$/;
const CASE_TAG = /^@?([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)?-\d{2,3})$/;
const STATUSES = ['automated', 'planned', 'manual'];
const REQUIRED_FIELDS = ['Rule', 'Given', 'When', 'Then'];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

const rel = (file) => path.relative(root, file).split(path.sep).join('/');

// ---------- case files ----------

function parseFrontMatter(text, file, problems) {
  const meta = {};
  let key = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    const pair = /^([a-z][a-z-]*):\s*(.*)$/.exec(line);
    if (item && key) (meta[key] = Array.isArray(meta[key]) ? meta[key] : []).push(item[1].trim());
    else if (pair) { key = pair[1]; meta[key] = pair[2].trim() === '' ? [] : pair[2].trim(); }
    else problems.error(`${rel(file)}: unreadable front matter line: ${line}`);
  }
  return meta;
}

function parseCaseFile(file, problems) {
  const text = fs.readFileSync(file, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) { problems.error(`${rel(file)}: no front matter`); return null; }
  const meta = parseFrontMatter(fm[1], file, problems);
  const lines = text.split('\n');
  const cases = [];
  let current = null;
  let field = null;
  lines.forEach((line, i) => {
    const heading = /^## +([A-Z][A-Z0-9-]*-\d+)\s+(.*)$/.exec(line);
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), fields: {}, line: i + 1, file };
      field = null;
      cases.push(current);
      return;
    }
    if (/^#{1,2} /.test(line)) { current = null; return; }
    if (!current) return;
    const bullet = /^- \*\*([A-Za-z ]+):\*\*\s*(.*)$/.exec(line);
    if (bullet) { field = bullet[1]; current.fields[field] = bullet[2].trim(); return; }
    if (field && /^\s+\S/.test(line)) current.fields[field] += ' ' + line.trim();
    else if (line.trim()) field = null;
  });
  return { file, meta, cases };
}

function operationsOf(c, feature) {
  const text = c.fields.Operations ?? '';
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => {
    const parts = m[1].trim().split(/\s+/);
    if (parts.length === 2) parts.unshift(feature.meta.service);
    return parts.join(' ');
  });
}

function loadCatalogue(problems) {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md') && !/^(README|TRACEABILITY|_.*)\.md$/.test(entry.name)) files.push(full);
    }
  })(casesDir);
  const features = new Map();
  const cases = new Map();
  for (const file of files.sort()) {
    const feature = parseCaseFile(file, problems);
    if (!feature) continue;
    const { meta } = feature;
    const where = rel(file);
    for (const key of ['feature', 'title', 'specs', 'source']) {
      if (!meta[key] || meta[key].length === 0) problems.error(`${where}: front matter needs "${key}"`);
    }
    if (!FEATURE_ID.test(meta.feature ?? '')) { problems.error(`${where}: "${meta.feature}" is not a feature id like A-PIN`); continue; }
    if (features.has(meta.feature)) { problems.error(`${where}: feature ${meta.feature} is also in ${rel(features.get(meta.feature).file)}`); continue; }
    if (meta.service && !config.contracts[meta.service]) problems.error(`${where}: unknown service "${meta.service}" (kit.config.json contracts)`);
    for (const spec of [].concat(meta.specs ?? [])) {
      if (!fs.existsSync(path.join(root, spec))) problems.error(`${where}: spec ${spec} does not exist`);
    }
    features.set(meta.feature, feature);
    if (feature.cases.length === 0) problems.error(`${where}: no cases (## ${meta.feature}-01 <title>)`);
    for (const c of feature.cases) {
      const at = `${where}:${c.line}`;
      const id = CASE_ID.exec(c.id);
      if (!id || id[1] !== meta.feature) { problems.error(`${at}: "${c.id}" is not a case id of ${meta.feature} (${meta.feature}-01)`); continue; }
      if (cases.has(c.id)) { problems.error(`${at}: ${c.id} is used twice`); continue; }
      if (!c.title) problems.error(`${at}: ${c.id} has no title`);
      for (const f of REQUIRED_FIELDS) if (!c.fields[f]) problems.error(`${at}: ${c.id} needs "- **${f}:**"`);
      c.status = (c.fields.Status ?? 'automated').toLowerCase();
      if (!STATUSES.includes(c.status)) problems.error(`${at}: ${c.id} status "${c.status}" is not one of ${STATUSES.join(', ')}`);
      c.feature = meta.feature;
      c.operations = operationsOf(c, feature);
      for (const op of c.operations) {
        const [service, method] = op.split(' ');
        if (!config.contracts[service] || !METHODS.includes(method)) problems.error(`${at}: ${c.id} operation "${op}" is not "[service] METHOD /path"`);
      }
      c.tests = [];
      cases.set(c.id, c);
    }
  }
  return { features, cases };
}

// ---------- tests ----------

function listTests() {
  const env = { ...process.env, PW_LIST_ALL: '1', PW_ONLY_FRAMEWORK: '1' };
  if (config.listEnv) env.TEST_ENV = config.listEnv;
  const run = spawnSync('npx', ['playwright', 'test', '--list', '--reporter=json'], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  let report;
  try { report = JSON.parse(run.stdout); } catch { throw new Error(`playwright --list failed:\n${run.stderr || run.stdout}`); }
  if (report.errors?.length) throw new Error(`playwright --list: ${report.errors.map((e) => e.message).join('\n')}`);
  const tests = [];
  (function walk(suite, titles) {
    for (const spec of suite.specs ?? []) {
      const file = rel(path.resolve(report.config.rootDir, spec.file));
      tests.push({ file, line: spec.line, title: [...titles, spec.title].filter(Boolean).join(' › '), tags: spec.tags ?? [] });
    }
    for (const child of suite.suites ?? []) walk(child, child.title && !child.title.endsWith('.ts') ? [...titles, child.title] : titles);
  })({ suites: report.suites }, []);
  return tests;
}

// ---------- source ----------

function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}): ${run.stderr.trim()}`);
  return run.stdout;
}

function splitEntry(entry) {
  const at = entry.indexOf(':');
  const name = entry.slice(0, at);
  if (at < 1 || !config.roots[name]) throw new Error(`source entry "${entry}" needs a root from kit.config.json: ${Object.keys(config.roots).join(', ')}`);
  return { name, dir: path.resolve(root, config.roots[name]), glob: entry.slice(at + 1) };
}

/** Files (tracked or new, not ignored) that a source entry matches, as root:path. */
const fileCache = new Map();
function filesOf(entry) {
  if (!fileCache.has(entry)) {
    const { name, dir, glob } = splitEntry(entry);
    const out = git(dir, ['ls-files', '-co', '--exclude-standard', '-z', '--', `:(glob)${glob}`]);
    fileCache.set(entry, out.split('\0').filter(Boolean).map((f) => `${name}:${f}`));
  }
  return fileCache.get(entry);
}

function readSource(key) {
  const at = key.indexOf(':');
  const file = path.join(path.resolve(root, config.roots[key.slice(0, at)]), key.slice(at + 1));
  return fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
}

function sourceState(feature) {
  const files = [...new Set([].concat(feature.meta.source ?? []).flatMap(filesOf))].sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(f).update('\0').update(readSource(f)).update('\0');
  const rootsUsed = [...new Set([].concat(feature.meta.source ?? []).map((e) => splitEntry(e).name))].sort();
  return { files, hash: hash.digest('hex').slice(0, 16), roots: rootsUsed };
}

/** The roots that are missing or not inside a git work tree. */
function sourceUnavailable() {
  return Object.entries(config.roots).filter(([, dir]) => {
    const full = path.resolve(root, dir);
    return !fs.existsSync(full) || spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: full, encoding: 'utf8' }).status !== 0;
  }).map(([name]) => name);
}

function readLock() {
  return fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : {};
}

function scopeFiles() {
  const ignored = new Set((config.sourceIgnore ?? []).flatMap(filesOf));
  return [...new Set((config.sourceScope ?? []).flatMap(filesOf))].filter((f) => !ignored.has(f)).sort();
}

// ---------- contracts ----------

function contractOperations(service) {
  const file = path.join(root, config.contracts[service].reviewed);
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => METHODS.includes(m.toUpperCase())).map((m) => `${service} ${m.toUpperCase()} ${p}`));
}

async function contractChanges() {
  const { diffContracts } = await import(pathToFileURL(path.join(root, 'src', 'contract-diff.ts')).href);
  const changes = [];
  for (const [service, c] of Object.entries(config.contracts)) {
    const build = path.resolve(root, c.build);
    if (!fs.existsSync(build)) { changes.push({ service, missing: rel(build) }); continue; }
    const before = JSON.parse(fs.readFileSync(path.join(root, c.reviewed), 'utf8'));
    const after = JSON.parse(fs.readFileSync(build, 'utf8'));
    const { breaking, info } = diffContracts(before, after);
    for (const [kind, list] of [['breaking', breaking], ['info', info]]) {
      for (const text of list) {
        const op = /^([A-Z]+) (\/\S*)/.exec(text);
        changes.push({ service, kind, text, operation: op ? `${service} ${op[1]} ${op[2]}` : null });
      }
    }
  }
  return changes;
}

// ---------- commands ----------

function problemsCollector() {
  const errors = [];
  const warnings = [];
  return { errors, warnings, error: (m) => errors.push(m), warn: (m) => warnings.push(m) };
}

function link(catalogue, tests, problems) {
  const { features, cases } = catalogue;
  for (const t of tests) {
    const ids = t.tags.map((tag) => CASE_TAG.exec(tag)?.[1]).filter(Boolean);
    const at = `${t.file}:${t.line} "${t.title}"`;
    if (ids.length !== 1) { problems.error(`${at}: needs exactly one case tag (has ${ids.length ? ids.map((i) => '@' + i).join(' ') : 'none'})`); continue; }
    const c = cases.get(ids[0]);
    if (!c) { problems.error(`${at}: @${ids[0]} is not documented in ${config.casesDir ?? 'cases'}/`); continue; }
    c.tests.push(t);
    const feature = features.get(c.feature);
    if (![].concat(feature.meta.specs ?? []).includes(t.file)) problems.error(`${at}: ${t.file} is not in the specs of ${rel(feature.file)}`);
  }
  const specsWithTests = new Set(tests.map((t) => t.file));
  for (const feature of features.values()) {
    for (const spec of [].concat(feature.meta.specs ?? [])) {
      if (fs.existsSync(path.join(root, spec)) && !specsWithTests.has(spec)) problems.warn(`${rel(feature.file)}: ${spec} has no tests`);
    }
  }
  for (const c of cases.values()) {
    const at = `${rel(c.file)}:${c.line} ${c.id}`;
    if (c.status === 'automated' && c.tests.length === 0) problems.error(`${at}: automated, but no test carries @${c.id}`);
    if (c.status !== 'automated' && c.tests.length > 0) problems.error(`${at}: status ${c.status}, but ${c.tests.length} test(s) carry @${c.id}`);
  }
}

function coverage(catalogue) {
  const byOperation = new Map();
  for (const service of Object.keys(config.contracts)) for (const op of contractOperations(service)) byOperation.set(op, []);
  const unknown = [];
  for (const c of catalogue.cases.values()) {
    for (const op of c.operations) {
      if (byOperation.has(op)) byOperation.get(op).push(c);
      else unknown.push({ c, op });
    }
  }
  return { byOperation, unknown };
}

function renderMatrix(catalogue) {
  const { features, cases } = catalogue;
  const { byOperation } = coverage(catalogue);
  const extraTags = (c) => [...new Set(c.tests.flatMap((t) => t.tags).filter((tag) => !CASE_TAG.test(tag)).map((tag) => '@' + tag.replace(/^@/, '')))].sort().join(' ');
  const out = [
    '# Traceability matrix',
    '',
    'Generated by `npm run cases:matrix` from the case files and the test list. Do not edit by hand.',
    '',
    '## Features',
    '',
    '| Feature | Title | Cases | Automated | Planned | Manual | Tests |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const f of features.values()) {
    const list = f.cases.filter((c) => cases.get(c.id) === c);
    const count = (s) => list.filter((c) => c.status === s).length;
    out.push(`| [${f.meta.feature}](${path.relative(casesDir, f.file).split(path.sep).join('/')}) | ${f.meta.title} | ${list.length} | ${count('automated')} | ${count('planned')} | ${count('manual')} | ${list.reduce((n, c) => n + c.tests.length, 0)} |`);
  }
  out.push('', '## Cases', '', '| Case | Title | Status | Tests | Spec | Tags |', '|---|---|---|---|---|---|');
  for (const c of cases.values()) {
    const specs = [...new Set(c.tests.map((t) => t.file))].join(', ');
    out.push(`| ${c.id} | ${c.title} | ${c.status} | ${c.tests.length} | ${specs} | ${extraTags(c)} |`);
  }
  out.push('', '## API operations', '', 'Every operation in the reviewed contracts, and the cases that call it.', '', '| Service | Operation | Cases |', '|---|---|---|');
  for (const [op, list] of byOperation) {
    const [service, method, p] = op.split(' ');
    const waiver = config.uncoveredOperations?.[op];
    const ids = [...new Set(list.map((c) => c.id))].join(', ');
    out.push(`| ${service} | \`${method} ${p}\` | ${ids || (waiver ? `not covered: ${waiver}` : '**none**')} |`);
  }
  return out.join('\n') + '\n';
}

async function check(strict) {
  const problems = problemsCollector();
  const catalogue = loadCatalogue(problems);
  link(catalogue, listTests(), problems);

  const { byOperation, unknown } = coverage(catalogue);
  for (const { c, op } of unknown) problems.error(`${rel(c.file)}:${c.line} ${c.id}: ${op} is not in the reviewed contract (removed or renamed?)`);
  const gap = strict ? problems.error : problems.warn;
  for (const [op, list] of byOperation) {
    const automated = list.some((c) => c.status === 'automated');
    if (list.length === 0 && !config.uncoveredOperations?.[op]) gap(`${op}: no case covers it (add one, or a reason in kit.config.json uncoveredOperations)`);
    else if (list.length && !automated) problems.warn(`${op}: only planned or manual cases cover it`);
  }

  // A pipeline may hold only this folder: without the product source (or git), only the catalogue is checked.
  const absent = sourceUnavailable();
  if (absent.length) (strict ? problems.error : problems.warn)(`product source not available here (${absent.join(', ')}): staleness and unmapped source not checked`);
  const lock = readLock();
  for (const feature of absent.length ? [] : catalogue.features.values()) {
    let state;
    try { state = sourceState(feature); } catch (e) { problems.error(`${rel(feature.file)}: ${e.message}`); continue; }
    for (const entry of [].concat(feature.meta.source ?? [])) {
      if (filesOf(entry).length === 0) problems.error(`${rel(feature.file)}: source "${entry}" matches no file (moved or renamed?)`);
    }
    const reviewed = lock[feature.meta.feature];
    if (!reviewed) gap(`${feature.meta.feature}: never reviewed (npm run cases:stamp -- ${feature.meta.feature})`);
    else if (reviewed.hash !== state.hash) gap(`${feature.meta.feature}: source changed since the review of ${reviewed.date} (npm run cases:impact)`);
  }
  for (const id of Object.keys(lock)) if (!catalogue.features.has(id)) problems.warn(`review.lock.json: ${id} is not a feature any more`);

  const mapped = absent.length ? new Set() : new Set([...catalogue.features.values()].flatMap((f) => [].concat(f.meta.source ?? []).flatMap(filesOf)));
  const unmapped = absent.length ? [] : scopeFiles().filter((f) => !mapped.has(f));
  for (const f of unmapped) gap(`${f}: product source that no feature lists (add it to a feature's source, or to sourceIgnore)`);

  const current = fs.existsSync(matrixFile) ? fs.readFileSync(matrixFile, 'utf8') : '';
  if (problems.errors.length === 0 && current !== renderMatrix(catalogue)) problems.error(`${rel(matrixFile)} is out of date (npm run cases:matrix)`);

  for (const w of problems.warnings) console.log(`warn  ${w}`);
  for (const e of problems.errors) console.log(`ERROR ${e}`);
  const tests = [...catalogue.cases.values()].reduce((n, c) => n + c.tests.length, 0);
  console.log(`${catalogue.features.size} features, ${catalogue.cases.size} cases, ${tests} tests: ${problems.errors.length} errors, ${problems.warnings.length} warnings`);
  return problems.errors.length === 0;
}

async function impact(base, asJson) {
  const problems = problemsCollector();
  const catalogue = loadCatalogue(problems);
  if (problems.errors.length) { problems.errors.forEach((e) => console.log(`ERROR ${e}`)); return false; }
  const tests = listTests();
  link(catalogue, tests, problemsCollector());
  const lock = readLock();

  // Changed source files, per root: against --base, or since each feature's last review.
  const changedSince = new Map();
  function changed(rootName, ref) {
    const key = `${rootName}@${ref}`;
    if (!changedSince.has(key)) {
      const dir = path.resolve(root, config.roots[rootName]);
      const diff = git(dir, ['diff', '--name-only', '--relative', ref, '--', '.']).split('\n');
      const added = git(dir, ['ls-files', '-o', '--exclude-standard']).split('\n');
      changedSince.set(key, new Set([...diff, ...added].filter(Boolean).map((f) => `${rootName}:${f}`)));
    }
    return changedSince.get(key);
  }

  const contract = await contractChanges();
  const report = [];
  for (const feature of catalogue.features.values()) {
    const id = feature.meta.feature;
    const state = sourceState(feature);
    const reviewed = lock[id];
    let files = [];
    if (base) files = state.files.filter((f) => changed(f.split(':')[0], base).has(f));
    else if (!reviewed) files = state.files;
    else if (reviewed.hash !== state.hash) {
      files = state.files.filter((f) => {
        const r = f.split(':')[0];
        return reviewed.commits?.[r] ? changed(r, reviewed.commits[r]).has(f) : true;
      });
      if (files.length === 0) files = ['(the set of matched files changed)'];
    }
    const featureCases = feature.cases.filter((c) => catalogue.cases.get(c.id) === c);
    const ops = new Set(featureCases.flatMap((c) => c.operations));
    const contractHits = contract.filter((ch) => ch.operation && ops.has(ch.operation));
    if (files.length === 0 && contractHits.length === 0) continue;
    const hitCases = contractHits.length
      ? featureCases.filter((c) => c.operations.some((op) => contractHits.some((h) => h.operation === op)))
      : [];
    report.push({
      feature: id,
      title: feature.meta.title,
      file: rel(feature.file),
      reviewed: reviewed ? reviewed.date : null,
      sourceChanged: files,
      contractChanges: contractHits.map((h) => `${h.kind}: ${h.text}`),
      casesOnChangedOperations: hitCases.map((c) => c.id),
      cases: featureCases.map((c) => ({ id: c.id, title: c.title, status: c.status })),
      specs: [].concat(feature.meta.specs ?? []),
      run: `npx playwright test --grep "${featureCases.filter((c) => c.tests.length).map((c) => '@' + c.id).join('|')}"`,
    });
  }

  const mapped = new Set([...catalogue.features.values()].flatMap((f) => [].concat(f.meta.source ?? []).flatMap(filesOf)));
  let unmapped = [];
  if (base) unmapped = Object.keys(config.roots).flatMap((r) => [...changed(r, base)]).filter((f) => scopeFiles().includes(f) && !mapped.has(f));
  else unmapped = scopeFiles().filter((f) => !mapped.has(f));
  const newOperations = contract.filter((ch) => ch.operation && ![...catalogue.cases.values()].some((c) => c.operations.includes(ch.operation)));
  const missingBuilds = contract.filter((ch) => ch.missing);

  if (asJson) {
    console.log(JSON.stringify({ base: base ?? 'last review', features: report, unmappedSource: unmapped, uncoveredContractChanges: newOperations.map((c) => `${c.kind}: ${c.service} ${c.text}`), missingBuilds: missingBuilds.map((m) => m.missing) }, null, 2));
    return true;
  }
  console.log(`# Impact ${base ? `against ${base}` : 'since the last review of each feature'}\n`);
  if (missingBuilds.length) console.log(`Contract build output missing (build the services first): ${missingBuilds.map((m) => m.missing).join(', ')}\n`);
  if (report.length === 0 && unmapped.length === 0 && newOperations.length === 0) console.log('Nothing to review: every feature matches its source and the contracts match the build.');
  for (const r of report) {
    console.log(`## ${r.feature} ${r.title} (${r.file}, reviewed ${r.reviewed ?? 'never'})`);
    if (r.sourceChanged.length) console.log(`Source changed:\n${r.sourceChanged.map((f) => `  - ${f}`).join('\n')}`);
    if (r.contractChanges.length) console.log(`Contract changes:\n${r.contractChanges.map((f) => `  - ${f}`).join('\n')}`);
    if (r.casesOnChangedOperations.length) console.log(`Cases on the changed operations: ${r.casesOnChangedOperations.join(', ')}`);
    console.log(`Cases:\n${r.cases.map((c) => `  - ${c.id} ${c.title}${c.status === 'automated' ? '' : ` (${c.status})`}`).join('\n')}`);
    console.log(`Specs: ${r.specs.join(', ')}`);
    console.log(`Run: ${r.run}\n`);
  }
  if (newOperations.length) console.log(`## Contract changes no case covers\n${newOperations.map((c) => `  - ${c.kind}: ${c.service} ${c.text}`).join('\n')}\n`);
  if (unmapped.length) console.log(`## Source no feature lists\n${unmapped.map((f) => `  - ${f}`).join('\n')}\n`);
  return true;
}

function stamp(ids) {
  const problems = problemsCollector();
  const catalogue = loadCatalogue(problems);
  if (problems.errors.length) { problems.errors.forEach((e) => console.log(`ERROR ${e}`)); return false; }
  const targets = ids.includes('--all') ? [...catalogue.features.keys()] : ids;
  if (targets.length === 0) { console.log('Name the features to stamp, or --all'); return false; }
  const lock = readLock();
  const today = new Date().toISOString().slice(0, 10);
  for (const id of targets) {
    const feature = catalogue.features.get(id);
    if (!feature) { console.log(`ERROR ${id} is not a feature`); return false; }
    const state = sourceState(feature);
    const commits = {};
    for (const r of state.roots) {
      const dir = path.resolve(root, config.roots[r]);
      commits[r] = git(dir, ['rev-parse', '--short', 'HEAD']).trim();
      const dirty = [].concat(feature.meta.source).filter((e) => splitEntry(e).name === r)
        .some((e) => git(dir, ['status', '--porcelain', '--', `:(glob)${splitEntry(e).glob}`]).trim());
      if (dirty) console.log(`warn  ${id}: ${r} has uncommitted changes in this feature's source; the review covers them, impact diffs start at ${commits[r]}`);
    }
    lock[id] = { hash: state.hash, date: today, commits };
    console.log(`${id}: reviewed ${today}, ${state.files.length} source files, ${state.hash}`);
  }
  const sorted = Object.fromEntries(Object.keys(lock).sort().map((k) => [k, lock[k]]));
  fs.writeFileSync(lockFile, JSON.stringify(sorted, null, 2) + '\n');
  return true;
}

function matrix() {
  const problems = problemsCollector();
  const catalogue = loadCatalogue(problems);
  link(catalogue, listTests(), problems);
  if (problems.errors.length) { problems.errors.forEach((e) => console.log(`ERROR ${e}`)); return false; }
  fs.writeFileSync(matrixFile, renderMatrix(catalogue));
  console.log(`${rel(matrixFile)}: ${catalogue.features.size} features, ${catalogue.cases.size} cases`);
  return true;
}

function nextId(featureId) {
  const catalogue = loadCatalogue(problemsCollector());
  const feature = catalogue.features.get(featureId);
  if (!feature) { console.log(`${featureId} is not a feature yet: create ${config.casesDir ?? 'cases'}/<area>/<name>.md from _template.md`); return false; }
  const numbers = feature.cases.map((c) => CASE_ID.exec(c.id)).filter(Boolean).map((m) => Number(m[2]));
  const width = feature.cases.map((c) => CASE_ID.exec(c.id)?.[2].length).find(Boolean) ?? 2;
  console.log(`${featureId}-${String(Math.max(0, ...numbers) + 1).padStart(width, '0')}`);
  return true;
}

const [command, ...args] = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
let ok;
try {
  switch (command) {
    case 'check': ok = await check(args.includes('--strict')); break;
    case 'impact': ok = await impact(option('--base'), args.includes('--json')); break;
    case 'stamp': ok = stamp(args); break;
    case 'matrix': ok = matrix(); break;
    case 'next-id': ok = nextId(args[0]); break;
    default:
      console.log('usage: node scripts/cases.mjs check [--strict] | impact [--base <ref>] [--json] | stamp <FEATURE...>|--all | matrix | next-id <FEATURE>');
      ok = false;
  }
} catch (e) {
  console.log(`ERROR ${e.message}`);
  ok = false;
}
process.exit(ok ? 0 : 1);
