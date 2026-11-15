#!/usr/bin/env node
// The attachment test: are the files attached to Jira issues and Confluence pages indexed, found and answered from?
// It runs against the deployed app as the admin test account, on the data scripts/attach-fixtures.mjs put on the
// Atlassian test site (eval/attachments/cases.json: 6 containers, 23 files, one question per part of a file).
// Prints file names, states and verdicts; no address, account, token or password.
//
//   node scripts/attach-test.mjs                 sync, docs, cases, scope, lifecycle
//   node scripts/attach-test.mjs sync            sync both sources and wait until the documents are indexed
//   node scripts/attach-test.mjs docs            every fixture file is in its source's document list, with its state,
//                                                and so is the text document of a file that gets one (prepare.mjs)
//   node scripts/attach-test.mjs cases [id...]   ask each question; all, or the named cases (A-xlsx-1 ...)
//   node scripts/attach-test.mjs scope           a member without a source's grant gets nothing from that source
//   node scripts/attach-test.mjs lifecycle       attach a new file, sync, ask; remove it, sync, ask again
//
// A case passes when the answer holds the expected facts and a passage of the expected file (or issue) was
// retrieved. The results go to eval/out/attach-test.json, with a table of formats by system.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aws, knowledgeBases, dataSources } from '../infra/kb.mjs';
import { manifest, located, jiraAttach, jiraDetach, confluenceAttach, confluenceDetach } from './attach-fixtures.mjs';
import { kindOf } from '../src/lib/prepare.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'eval', 'out');
const local = JSON.parse(readFileSync(join(ROOT, 'infra', 'deploy.local.json'), 'utf8'));
const SITE = local.site;
const SOURCES = { jira: 'jira-scrum', confluence: 'confluence-engdocs' };
const GROUPS = ['sync', 'docs', 'cases', 'scope', 'lifecycle'];
const args = process.argv.slice(2);
const groups = new Set(args.filter((a) => GROUPS.includes(a)));
const caseIds = new Set(args.filter((a) => !GROUPS.includes(a)));
const want = (group) => !groups.size || groups.has(group);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const mask = (s) => String(s).replace(/https?:\/\/[^\s"')]+/g, '<url>').replace(/[0-9]{12}/g, '<acct>');
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${mask(detail)}` : ''}`);
  return ok;
}

// ---------- the app, as a test account (as in scripts/e2e.mjs)

const cfg = await (await fetch(`${SITE}/config.json`)).json();
async function signIn(email) {
  const response = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ ClientId: cfg.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: local.users[email] } }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`sign-in ${email.split('@')[0]}: ${data.__type}`);
  return data.AuthenticationResult.IdToken;
}
async function client(name) {
  const email = Object.keys(local.users).find((e) => e.startsWith(`${name}@`));
  const token = await signIn(email);
  const headers = (body) => ({ authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) });
  const call = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${SITE}${path}`, { method, headers: headers(body), body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  // One chat turn: the passages, the answer and its citations.
  const chat = async (notebookId, question) => {
    const started = Date.now();
    const response = await fetch(`${SITE}/api/chat`, { method: 'POST', headers: headers(''), body: JSON.stringify({ notebookId, question, mode: 'fast', lang: 'vi' }) });
    const events = {};
    for (const chunk of (await response.text()).split('\n\n')) {
      const event = chunk.match(/^event: (.+)$/m)?.[1];
      const data = chunk.match(/^data: (.+)$/m)?.[1];
      if (event && data && !events[event]) events[event] = JSON.parse(data);
    }
    return { passages: events.sources?.passages || [], answer: events.done?.answer || '', citations: events.done?.citations || [], error: events.error?.message,
      seconds: Math.round((Date.now() - started) / 100) / 10 };
  };
  const notebook = async (name, sources) => {
    const list = await call('/api/notebooks');
    // A test account gets its grants from the e2e test (node scripts/e2e.mjs grants); before that it is pending.
    if (list.status !== 200) throw new Error(`${email.split('@')[0]} cannot open notebooks (${list.status}): run node scripts/e2e.mjs grants`);
    const found = list.data.find((n) => n.name === name);
    if (found) return (await call(`/api/notebooks/${found.id}`, { method: 'PATCH', body: { sources } })).data;
    return (await call('/api/notebooks', { method: 'POST', body: { name, sources } })).data;
  };
  // Each question starts from an empty conversation, so one case cannot lean on another's answer.
  const ask = async (nb, question) => {
    await call(`/api/notebooks/${nb.id}/messages`, { method: 'DELETE' });
    return chat(nb.id, question);
  };
  return { email, call, notebook, ask };
}

const admin = await client('admin');
const sources = (await admin.call('/api/sources')).data;
const sourceOf = Object.fromEntries(Object.entries(SOURCES).map(([system, name]) => [system, sources.find((s) => s.name === name)]));
for (const [system, s] of Object.entries(sourceOf)) if (!s) throw new Error(`The app has no ${SOURCES[system]} source: run node infra/kb.mjs up`);
const where = await located();
for (const c of manifest.containers) if (!where[c.id]) throw new Error(`Container ${c.id} is not on the Atlassian site: run node scripts/attach-fixtures.mjs up`);
const documentsOf = async (system) => (await admin.call(`/api/sources/${sourceOf[system].id}/documents`)).data || [];

// ---------- matching

const plain = (s) => String(s || '').toLowerCase().normalize('NFC').replace(/\*\*/g, '');
// 486.500.000, 486,500,000 and 486 500 000 all read as 486500000.
const digits = (s) => plain(s).replace(/(?<=\d)[.,\s ](?=\d{3}(\D|$))/g, '');
const holds = (text, alternative) => plain(text).includes(plain(alternative)) || digits(text).includes(digits(alternative));
const missing = (text, expect) => expect.filter((group) => !group.some((alternative) => holds(text, alternative))).map((group) => group[0]);
const decoded = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
// Is this passage (or document) from the case's file, or from its issue when the fact is in the issue itself?
function from(p, test) {
  const text = `${p.title || ''} ${decoded(p.uri || '')}`;
  if (test.file) return text.includes(test.file);
  const { key } = where[test.container];
  return new RegExp(`/browse/${key}(\\b|$)`).test(text) || (p.title || '').startsWith(`${key} `);
}

// ---------- sync

function dataSource(name) {
  for (const kb of knowledgeBases()) {
    const ds = dataSources(kb.id).find((d) => d.name === name);
    if (ds) return { kb: kb.id, id: ds.dataSourceId };
  }
  throw new Error(`no data source ${name}`);
}
const latestJob = ({ kb, id }) => aws(['bedrock-agent', 'list-ingestion-jobs', '--knowledge-base-id', kb, '--data-source-id', id,
  '--sort-by', 'attribute=STARTED_AT,order=DESCENDING', '--max-results', '1']).ingestionJobSummaries?.[0];
const running = (job) => ['STARTING', 'IN_PROGRESS', 'STOPPING'].includes(job?.status);

// Syncs the Confluence source through the app and waits for the job. Returns the job.
async function syncConfluence() {
  const ds = dataSource(SOURCES.confluence);
  while (running(latestJob(ds))) await sleep(20000);
  const started = await admin.call(`/api/sources/${sourceOf.confluence.id}/sync`, { method: 'POST' });
  if (started.status !== 200) throw new Error(`Confluence sync not started: ${started.status} ${started.data?.error || ''}`);
  let job;
  do {
    await sleep(20000);
    job = latestJob(ds);
  } while (running(job));
  const s = job.statistics || {};
  console.log(`  confluence sync ${job.status}: scanned ${s.numberOfDocumentsScanned}, new ${s.numberOfNewDocumentsIndexed}, modified ${s.numberOfModifiedDocumentsIndexed}, deleted ${s.numberOfDocumentsDeleted}, failed ${s.numberOfDocumentsFailed}`);
  return job;
}

// Runs the monitor once: the Jira sync, and the refreshed document lists and failures of every source.
function monitor() {
  execFileSync('node', [join(ROOT, 'infra', 'deploy.mjs'), 'monitor'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
}

// Waits until the knowledge base has finished with a source's documents and their text documents (none PENDING).
// Returns the document list.
async function settled(system, minutes = 20) {
  for (let i = 0; i < minutes * 4; i++) {
    const docs = await documentsOf(system);
    const pending = docs.filter((d) => d.status === 'PENDING' || d.textStatus === 'PENDING').length;
    if (docs.length && !pending) return docs;
    if (i % 4 === 0) console.log(`  ${system}: ${docs.length} documents, ${pending} still being indexed`);
    await sleep(15000);
  }
  return documentsOf(system);
}
const jiraSettled = (minutes) => settled('jira', minutes);
// The fixture files that get a text document, and how many have one in the document list.
function texts(list) {
  const files = list.filter((d) => d.kind !== 'issue' && manifest.containers.some((c) => c.files.includes(d.title)) && kindOf(d.title));
  return { files: files.length, indexed: files.filter((d) => d.textStatus === 'INDEXED').length };
}

if (want('sync')) {
  const job = await syncConfluence();
  check('confluence sync completes', job.status === 'COMPLETE', job.status);
  monitor();
  const docs = await jiraSettled();
  const by = docs.reduce((a, d) => ((a[d.status] = (a[d.status] || 0) + 1), a), {});
  check('jira sync sends the issues and their attachments', docs.length > 0 && !by.PENDING, Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', '));
  const sync = (await admin.call('/api/sync')).data.sources.find((s) => s.name === SOURCES.jira);
  check('jira sync is on the sync page', sync?.latest?.status === 'COMPLETE', `${sync?.latest?.status} (${sync?.latest?.mode}), scanned ${sync?.latest?.scanned}, sent ${sync?.latest?.indexed}, failed ${sync?.latest?.failed}`);
  if (sync?.latest?.errors?.length) console.log(`  jira errors: ${mask(sync.latest.errors.join(' | '))}`);
  // The step before the knowledge base: the monitor run above also made the text documents. One more run takes
  // what the first did not finish.
  let made = { jira: texts(docs), confluence: texts(await settled('confluence')) };
  if (made.jira.indexed < made.jira.files || made.confluence.indexed < made.confluence.files) {
    monitor();
    made = { jira: texts(await jiraSettled()), confluence: texts(await settled('confluence')) };
  }
  for (const [system, t] of Object.entries(made)) check(`${system} sync makes the text documents of its attachments`, t.files > 0 && t.indexed === t.files, `${t.indexed} of ${t.files} files`);
}

// ---------- docs: every fixture file in its source's document list

const report = { at: new Date().toISOString(), documents: [], cases: [] };

if (want('docs')) {
  const lists = { jira: await documentsOf('jira'), confluence: await documentsOf('confluence') };
  for (const c of manifest.containers) {
    const at = where[c.id];
    const list = lists[c.system];
    if (c.system === 'jira') {
      const issue = list.find((d) => d.kind === 'issue' && d.issue === at.key);
      check(`${c.id} jira ${at.key} issue text`, issue?.status === 'INDEXED', issue ? `${issue.kbStatus}${issue.reason ? `: ${issue.reason}` : ''}` : 'not in the document list');
      report.documents.push({ container: c.id, system: c.system, file: null, status: issue?.status || 'MISSING', reason: issue?.reason });
    }
    for (const file of c.files) {
      const doc = list.find((d) => (c.system === 'jira' ? d.issue === at.key && d.title === file : d.title === file));
      check(`${c.id} ${c.system} ${file}`, doc?.status === 'INDEXED', doc ? `${doc.kbStatus || doc.status}${doc.reason ? `: ${doc.reason}` : ''}` : 'not in the document list');
      report.documents.push({ container: c.id, system: c.system, file, status: doc?.status || 'MISSING', reason: doc?.reason,
        ...(kindOf(file) ? { text: doc?.text, textStatus: doc?.textStatus || 'MISSING' } : {}) });
      if (kindOf(file)) check(`${c.id} ${c.system} ${file}: text document`, doc?.textStatus === 'INDEXED', doc?.text ? `${doc.textStatus}, ${doc.text}` : `${doc?.textError || 'none'}`);
    }
  }
}

// ---------- cases: one question per part of a file

async function runCase(nb, test) {
  const r = await admin.ask(nb, test.question);
  const system = manifest.containers.find((c) => c.id === test.container).system;
  const lacks = missing(r.answer, test.expect);
  const retrieved = r.passages.filter((p) => from(p, test));
  const cited = r.citations.some((c) => from(c, test));
  const verdict = !lacks.length && retrieved.length ? 'PASS' : !lacks.length ? 'ANSWERED-FROM-ELSEWHERE' : retrieved.length ? 'FOUND-NOT-ANSWERED' : 'MISS';
  return { id: test.id, system, container: test.container, file: test.file, format: test.format, part: test.part, verdict, lacks, cited,
    passagesFromFile: retrieved.length, rank: r.passages.findIndex((p) => from(p, test)) + 1, seconds: r.seconds, error: r.error,
    answer: mask(r.answer), passages: r.passages.map((p) => ({ n: p.n, title: p.title, source: p.sourceTitle, page: p.page, score: p.score })) };
}

if (want('cases')) {
  const tests = manifest.cases.filter((t) => !caseIds.size || caseIds.has(t.id));
  const ids = [sourceOf.confluence.id, sourceOf.jira.id];
  const notebooks = [];
  for (let i = 1; i <= 3; i++) notebooks.push(await admin.notebook(`attach-test-${i}`, ids));
  const queue = [...tests];
  const results = [];
  await Promise.all(notebooks.map(async (nb) => {
    for (let test = queue.shift(); test; test = queue.shift()) results.push(await runCase(nb, test));
  }));
  results.sort((a, b) => tests.findIndex((t) => t.id === a.id) - tests.findIndex((t) => t.id === b.id));
  for (const r of results) {
    check(`${r.id.padEnd(12)} ${r.system.padEnd(10)} ${r.format.padEnd(16)} ${r.part}`, r.verdict === 'PASS',
      `${r.verdict}${r.lacks.length ? `, answer lacks: ${r.lacks.join('; ')}` : ''}; ${r.passagesFromFile} passages of the file${r.rank ? ` (first at ${r.rank})` : ''}, cited ${r.cited ? 'yes' : 'no'}, ${r.seconds}s${r.error ? `, error ${r.error}` : ''}`);
  }
  report.cases = results;
  // Formats by system: passed / asked.
  const table = {};
  for (const r of results) {
    const cell = ((table[r.format] ||= {})[r.system] ||= { pass: 0, all: 0 });
    cell.all += 1;
    if (r.verdict === 'PASS') cell.pass += 1;
  }
  console.log(`\n${'format'.padEnd(18)}${'jira'.padEnd(10)}confluence`);
  for (const [format, row] of Object.entries(table)) {
    const cell = (c) => (c ? `${c.pass}/${c.all}` : '-');
    console.log(`${format.padEnd(18)}${cell(row.jira).padEnd(10)}${cell(row.confluence)}`);
  }
  console.log('');
  report.table = table;
}

// ---------- scope: a member without the grant

// Two members: brse-company reads only the company wiki (another knowledge base); sa-dbmate reads the Confluence
// source but not the Jira one, which is in the same knowledge base, so only the search filter keeps Jira out.
if (want('scope')) {
  const ask = async (who, name, system) => {
    const granted = (await who.call('/api/sources')).data.filter((s) => s.granted).map((s) => s.name);
    const test = manifest.cases.find((t) => t.format === 'xlsx' && where[t.container].system === system);
    const r = await who.ask(await who.notebook('attach-test', []), test.question);
    const leaked = r.passages.filter((p) => p.sourceTitle === sourceOf[system].title);
    check(`scope: ${name}, without the ${system} grant, gets nothing of a ${system} attachment`, !granted.includes(SOURCES[system]) && !leaked.length && missing(r.answer, test.expect).length > 0,
      `grants: ${granted.join(', ')}; ${r.passages.length} passages, ${leaked.length} from the ${system} source`);
  };
  const brse = await client('brse-company');
  await ask(brse, 'brse-company', 'jira');
  await ask(brse, 'brse-company', 'confluence');
  const sa = await client('sa-dbmate');
  await ask(sa, 'sa-dbmate', 'jira');
  for (const [name, who] of [['brse-company', brse], ['sa-dbmate', sa]]) {
    const denied = await who.call(`/api/sources/${sourceOf.jira.id}/documents`);
    check(`scope: the Jira document list is refused to ${name}`, denied.status === 403 || denied.status === 404, `${denied.status}`);
  }
}

// ---------- lifecycle: a file attached later is found after the next sync, a removed file is gone after the next

async function lifecycle(system) {
  const container = manifest.containers.find((c) => c.system === system);
  const at = where[container.id];
  const code = `HA-${Math.floor(1000 + Math.random() * 9000)}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
  const name = `Ma-phe-duyet-khan-cap-${system}.txt`;
  const path = join(OUT, name);
  const subject = system === 'jira' ? 'đợt Hải Âu' : 'dự án my-db-mate 2.0';
  writeFileSync(path, `GHI CHÚ NỘI BỘ\n\nMã phê duyệt khẩn cấp của ${subject} là ${code}.\nMã này do Ban điều hành cấp, chỉ dùng khi cần triển khai ngoài khung giờ đã duyệt.\n`);
  const question = `Mã phê duyệt khẩn cấp của ${subject} là gì?`;
  const test = { file: name, container: container.id };
  const nb = await admin.notebook('attach-test-lifecycle', [sourceOf[system].id]);
  const sync = async () => {
    if (system === 'confluence') {
      await syncConfluence();
      return;
    }
    // The app's own manual sync: the API starts the monitor function for this source.
    const started = await admin.call(`/api/sources/${sourceOf.jira.id}/sync`, { method: 'POST' });
    if (started.status !== 200) throw new Error(`Jira sync not started: ${started.status} ${started.data?.error || ''}`);
  };
  // Polls the question until the file is (or is no longer) what the answer comes from.
  const until = async (present, minutes) => {
    let r;
    for (let i = 0; i < minutes * 3; i++) {
      r = await admin.ask(nb, question);
      const found = r.passages.some((p) => from(p, test)) && holds(r.answer, code);
      if (found === present) return { ok: true, r, waited: i * 20 };
      await sleep(20000);
    }
    return { ok: false, r, waited: minutes * 60 };
  };

  // Leftovers of an earlier run would answer the question with an old code.
  for (const old of at.attachments.filter((a) => a.name === name)) await (system === 'jira' ? jiraDetach(old.id) : confluenceDetach(old.id));
  const added = system === 'jira' ? await jiraAttach(at.key, path, name) : await confluenceAttach(at.id, path, name);
  console.log(`  ${system}: ${name} attached to ${at.key || container.type} ${container.id}`);
  await sync();
  const present = await until(true, 12);
  check(`lifecycle ${system}: a newly attached file is answered from after a sync`, present.ok, `after ${present.waited}s; ${present.r.passages.filter((p) => from(p, test)).length} passages of the file`);
  await (system === 'jira' ? jiraDetach(added.id) : confluenceDetach(added.id));
  await sync();
  const gone = await until(false, 12);
  check(`lifecycle ${system}: a removed file is gone after a sync`, gone.ok, `after ${gone.waited}s; ${gone.r.passages.filter((p) => from(p, test)).length} passages of the file left`);
  if (system === 'jira') {
    const listed = (await documentsOf('jira')).some((d) => d.title === name);
    check('lifecycle jira: the removed file left the document list', !listed);
  }
}

mkdirSync(OUT, { recursive: true });
if (want('lifecycle')) {
  for (const system of ['jira', 'confluence']) {
    try {
      await lifecycle(system);
    } catch (error) {
      check(`lifecycle ${system}`, false, error.message);
    }
  }
}

if (report.documents.length || report.cases.length) {
  const file = join(OUT, 'attach-test.json');
  let previous = {};
  try {
    previous = JSON.parse(readFileSync(file, 'utf8'));
  } catch { /* first run */ }
  // A run of some groups keeps the other groups' last results.
  writeFileSync(file, `${JSON.stringify({ ...previous, at: report.at, ...(report.documents.length && { documents: report.documents }),
    ...(report.cases.length && !caseIds.size && { cases: report.cases, table: report.table }) }, null, 2)}\n`);
  console.log('results in eval/out/attach-test.json');
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
