#!/usr/bin/env node
// Compares two ways of asking the same knowledge base with the same model: the web UI (the chat API, agent mode by
// default) and Claude Code on this machine with the app's MCP server. Both run as the admin test account and reach
// the same sources. Prints verdicts and numbers; no address, account, token or password.
//
//   node scripts/compare.mjs cli [ids or sets...]   Claude Code CLI (claude -p) with the MCP server
//   node scripts/compare.mjs web [ids or sets...]   the chat API, as the web UI calls it
//   node scripts/compare.mjs score                  both arms side by side, and the questions they differ on
//   node scripts/compare.mjs show <id>              the answers to one question
//
// Sets: bench (the 24 questions of the AIPF benchmark whose documents are still sources: 20 on Confluence, 4 with no answer), attach (eval/attachments/cases.json, 38), multi
// (eval/compare/multi.json, questions that need several documents). --rest runs only what has no answer yet.
// Rows go to eval/out/compare-<arm>.jsonl. A question passes when its answer holds every expected fact; a question
// whose answer is not in the documents passes when the answer says so.
//
// The CLI arm: claude -p from an empty directory, no built-in tools, no user or project settings, only the app's MCP
// server with a one-day token that is revoked at the end. The `ask` tool is withheld: it hands the question to the
// app's own answer chain, and this arm is there to measure Claude Code's loop. It runs on the machine's Claude Code
// sign-in.
//
// COMPARE_MODEL (claude-sonnet-5-5), COMPARE_EFFORT (medium, the effort of the web UI's agent mode), COMPARE_MODE
// (agent; fast or deep for the web arm), COMPARE_WORKERS (3), COMPARE_TMP (where the CLI's directory is made).

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'eval', 'out');
const MODEL = process.env.COMPARE_MODEL || 'claude-sonnet-5-5';
const EFFORT = process.env.COMPARE_EFFORT || 'medium';
const MODE = process.env.COMPARE_MODE || 'agent';
const WORKERS = Number(process.env.COMPARE_WORKERS) || 3;
const SERVER = 'notebook';
const CLI_TOOLS = ['search', 'list_sources', 'list_documents', 'get_document', 'list_notebooks'];
const CLI_PROMPT = 'You answer questions about project documents. Look in the documents with the notebook tools before you answer, and answer from what they return. Reply in the language of the question.';
// Dollars per million tokens, to price the web arm's tokens (the CLI reports its own cost).
const PRICE = { 'claude-sonnet-5-5': { input: 2, output: 10 } };

const mask = (s) => String(s).replace(/https?:\/\/[^\s"')\]]+/g, '<url>').replace(/(?<![0-9.])[0-9]{12}(?![0-9])/g, '<acct>').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');

// ---------- the questions

function questions() {
  const all = [];
  const bench = process.env.POC3_QUESTIONS || join(homedir(), 'workspace', 'aipf-sdlc', 'bench', 'kb', 'projects', 'questions.json');
  if (existsSync(bench)) {
    // The benchmark's SharePoint documents left the knowledge bases with SharePoint on 2026-11-14: their 24 questions are left out.
    for (const q of JSON.parse(readFileSync(bench, 'utf8')).filter((q) => !/^sharepoint/.test(q.where || ''))) all.push({ id: q.id, set: 'bench', lang: q.lang, question: q.question, expect: (q.must || []).map((m) => [m]), absent: !q.rel });
  } else console.log('no benchmark questions on this machine (POC3_QUESTIONS): the bench set is left out');
  for (const t of JSON.parse(readFileSync(join(ROOT, 'eval', 'attachments', 'cases.json'), 'utf8')).cases) {
    all.push({ id: t.id, set: 'attach', lang: 'vi', question: t.question, expect: t.expect, file: t.file });
  }
  for (const q of JSON.parse(readFileSync(join(ROOT, 'eval', 'compare', 'multi.json'), 'utf8')).questions) all.push({ ...q, set: 'multi' });
  return all;
}
const QUESTIONS = questions();
const SETS = ['bench', 'attach', 'multi'];

// ---------- grading (the matchers of eval.mjs and attach-test.mjs together)

const plain = (s) => String(s || '').toLowerCase().normalize('NFC').replace(/\*\*|`/g, '');
// 486.500.000, 486,500,000 and 486 500 000 all read as 486500000.
const digits = (s) => plain(s).replace(/(?<=\d)[.,\s ](?=\d{3}(\D|$))/g, '');
// No accents, đ as d, single spaces.
const fold = (s) => plain(s).replace(/đ/g, 'd').normalize('NFD').replace(/\p{Mn}/gu, '').replace(/\s+/g, ' ');
const holds = (text, alternative) => plain(text).includes(plain(alternative)) || digits(text).includes(digits(alternative)) || fold(text).includes(fold(alternative));
const NOT_FOUND = /không tìm thấy|không có thông tin|không bao gồm|không có nội dung|không đề cập|không được đề cập|chưa có thông tin|không nêu|không thấy|không tìm được|không được ghi|không có trong|không nằm trong|not found|no information|not mentioned|do(es)? not (mention|say|specify|contain|include|cover|list|state|give)|do(es)?n't (mention|say|specify|contain|include|cover|list|state|give)|isn't (mentioned|specified|documented)|not (specified|documented|covered|stated|listed)|no mention|could ?n[o']t find|did ?n[o']t find|found no|nothing (in|about)|no (documented|stated|listed)/i;
const langOf = (s) => {
  const letters = (s.match(/\p{L}/gu) || []).length || 1;
  return (s.match(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹáàãéèíìóòõúùý]/gi) || []).length / letters > 0.02 ? 'vi' : 'en';
};

function grade(q, row) {
  const answer = row.answer || '';
  const lacks = q.expect.filter((group) => !group.some((a) => holds(answer, a))).map((group) => group[0]);
  const refused = NOT_FOUND.test(answer);
  const pass = !row.error && answer.length > 0 && (q.absent ? refused : !lacks.length && (!q.absentPart || refused));
  return { pass, facts: q.expect.length ? 1 - lacks.length / q.expect.length : null, lacks, refused, lang: langOf(answer.replace(/```[\s\S]*?```/g, '')) === q.lang };
}

// ---------- rows

const fileOf = (arm) => join(OUT, `compare-${arm}.jsonl`);
const load = (arm) => (existsSync(fileOf(arm)) ? readFileSync(fileOf(arm), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function saver(arm, keep) {
  const rows = new Map(keep.map((r) => [r.id, r]));
  return (row) => {
    rows.set(row.id, row);
    const ordered = QUESTIONS.map((q) => rows.get(q.id)).filter(Boolean);
    writeFileSync(fileOf(arm), ordered.map((r) => `${JSON.stringify(r)}\n`).join(''));
  };
}

function selection(args, arm) {
  const rest = args.includes('--rest');
  const names = args.filter((a) => !a.startsWith('--'));
  const unknown = names.filter((n) => !SETS.includes(n) && !QUESTIONS.some((q) => q.id === n));
  if (unknown.length) throw new Error(`unknown question or set: ${unknown.join(', ')}`);
  let todo = QUESTIONS.filter((q) => !names.length || names.includes(q.set) || names.includes(q.id));
  const before = load(arm);
  if (rest) todo = todo.filter((q) => !before.some((r) => r.id === q.id && r.answer && !r.error));
  // A run of everything starts a new file; a run of some questions replaces only those.
  const keep = !names.length && !rest ? [] : before.filter((r) => !todo.some((q) => q.id === r.id));
  return { todo, save: saver(arm, keep) };
}

async function pool(todo, workers, one) {
  const queue = [...todo];
  let done = 0;
  await Promise.all(workers.map(async (worker) => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      const row = await one(q, worker);
      done += 1;
      const g = grade(q, row);
      console.log(`${String(done).padStart(3)}/${todo.length} ${q.id.padEnd(10)} ${g.pass ? 'PASS' : 'FAIL'} ${String(row.seconds).padStart(6)}s ${String(row.calls ?? '-').padStart(2)} calls`
        + `${g.lacks.length ? `, lacks: ${g.lacks.join('; ')}` : ''}${row.error ? `, error: ${mask(row.error).slice(0, 160)}` : ''}`);
    }
  }));
}

// ---------- the app, as the admin test account

async function app() {
  const local = JSON.parse(readFileSync(join(ROOT, 'infra', 'deploy.local.json'), 'utf8'));
  const site = local.site;
  const email = Object.keys(local.users).find((e) => e.startsWith('admin@'));
  const cfg = await (await fetch(`${site}/config.json`)).json();
  const auth = await (await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ ClientId: cfg.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: local.users[email] } }),
  })).json();
  const token = auth.AuthenticationResult?.IdToken;
  if (!token) throw new Error(`sign-in failed: ${auth.__type}`);
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${site}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { site, token, call };
}

// ---------- the web arm

async function web(args) {
  const arm = `web-${MODE}`;
  const { todo, save } = selection(args, arm);
  const { site, token, call } = await app();
  // Every source the account may read: what its MCP token reaches too.
  const granted = (await call('/api/sources')).data.filter((s) => s.granted);
  console.log(`${arm}: ${todo.length} questions, ${MODEL}, sources: ${granted.map((s) => s.name).join(', ')}`);
  const list = (await call('/api/notebooks')).data;
  const books = [];
  for (let i = 1; i <= WORKERS; i += 1) {
    const sources = granted.map((s) => s.id);
    const found = list.find((n) => n.name === `compare-${i}`);
    books.push(found ? (await call(`/api/notebooks/${found.id}`, { method: 'PATCH', body: { sources } })).data : (await call('/api/notebooks', { method: 'POST', body: { name: `compare-${i}`, sources } })).data);
  }
  const TOOL_OF = [[/^Tìm: /, 'search'], [/^Xem danh sách nguồn/, 'list_sources'], [/^Liệt kê tài liệu/, 'list_documents'], [/^Đọc toàn văn/, 'get_document']];

  await pool(todo, books, async (q, nb) => {
    await call(`/api/notebooks/${nb.id}/messages`, { method: 'DELETE' });
    const started = Date.now();
    const row = { arm, model: MODEL, id: q.id, set: q.set };
    try {
      const response = await fetch(`${site}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ notebookId: nb.id, question: q.question, mode: MODE, lang: q.lang }) });
      const events = (await response.text()).split('\n\n').map((c) => ({ event: c.match(/^event: (.+)$/m)?.[1], data: c.match(/^data: (.+)$/m)?.[1] }))
        .filter((e) => e.event && e.data).map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
      const done = events.findLast((e) => e.event === 'done')?.data;
      const steps = events.filter((e) => e.event === 'step').map((e) => e.data.text);
      const stats = done?.stats;
      row.answer = mask(done?.answer || '');
      row.error = events.find((e) => e.event === 'error')?.data.message || (response.status !== 200 ? `status ${response.status}` : undefined);
      row.cited = /\[\d+\]/.test(row.answer);
      const seen = events.filter((e) => e.event === 'sources').flatMap((e) => e.data.passages || []);
      if (q.file) row.found = seen.some((p) => `${p.title || ''} ${decodeURIComponent(p.uri || '')}`.includes(q.file));
      if (stats) {
        Object.assign(row, { model: stats.model, calls: stats.calls, turns: stats.rounds, input: stats.input, output: stats.output, read: stats.found });
        row.tools = {};
        for (const s of steps) {
          const name = TOOL_OF.find(([re]) => re.test(s))?.[1];
          if (name) row.tools[name] = (row.tools[name] || 0) + 1;
        }
        const price = PRICE[stats.model];
        if (price) row.cost = Math.round(((stats.input * price.input + stats.output * price.output) / 1e6) * 1e4) / 1e4;
      }
    } catch (error) {
      row.error = error.message;
    }
    row.seconds = Math.round((Date.now() - started) / 100) / 10;
    save(row);
    return row;
  });
}

// ---------- the CLI arm

function claude(args, { cwd, timeout = 300000 }) {
  // The environment of a plain terminal: nothing of the session that started this script.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k)));
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (error) => { clearTimeout(timer); resolve({ out, err: error.message, code: -1 }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ out, err: signal ? `stopped after ${timeout / 1000}s` : err, code }); });
  });
}

async function cli(args) {
  const arm = 'cli';
  const { todo, save } = selection(args, arm);
  const { site, call } = await app();
  const created = await call('/api/tokens', { method: 'POST', body: { name: 'compare', days: 1 } });
  if (created.status !== 200 || !created.data?.token) throw new Error(`no MCP token: ${created.status}`);
  const dir = mkdtempSync(join(process.env.COMPARE_TMP || tmpdir(), 'poc3-compare-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const mcp = join(dir, 'mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: `${site}/mcp`, headers: { Authorization: `Bearer ${created.data.token}` } } } }), { mode: 0o600 });
  const cleanup = async () => {
    rmSync(dir, { recursive: true, force: true });
    await call(`/api/tokens/${encodeURIComponent(created.data.prefix)}`, { method: 'DELETE' });
  };
  process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
  const version = (await claude(['--version'], { cwd: work })).out.trim();
  console.log(`${arm}: ${todo.length} questions, ${MODEL}, effort ${EFFORT}, Claude Code ${version}`);

  try {
    await pool(todo, Array.from({ length: WORKERS }, (_, i) => i), async (q) => {
      const started = Date.now();
      const row = { arm, model: MODEL, id: q.id, set: q.set };
      const run = await claude(['-p', q.question, '--model', MODEL, '--effort', EFFORT, '--mcp-config', mcp, '--strict-mcp-config', '--tools', '',
        '--allowedTools', CLI_TOOLS.map((t) => `mcp__${SERVER}__${t}`).join(','), '--disallowedTools', `mcp__${SERVER}__ask`,
        '--setting-sources', 'project', '--disable-slash-commands', '--no-session-persistence', '--append-system-prompt', CLI_PROMPT,
        '--output-format', 'stream-json', '--verbose'], { cwd: work });
      const events = run.out.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
      const result = events.findLast((e) => e.type === 'result');
      const uses = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message?.content || []).filter((b) => b.type === 'tool_use');
      const results = events.filter((e) => e.type === 'user').flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : [])).filter((b) => b.type === 'tool_result');
      const server = init?.mcp_servers?.find((s) => s.name === SERVER);
      row.answer = mask(result?.result || '');
      if (!result) row.error = run.err.trim().split('\n').pop() || `claude exited with ${run.code}`;
      else if (result.is_error) row.error = `${result.subtype}: ${String(result.result || '').slice(0, 200)}`;
      else if (server && server.status !== 'connected') row.error = `the MCP server is ${server.status}`;
      row.calls = uses.length;
      row.tools = {};
      for (const u of uses) {
        const name = u.name.replace(`mcp__${SERVER}__`, '');
        row.tools[name] = (row.tools[name] || 0) + 1;
      }
      const evidence = JSON.stringify(results);
      if (q.file) row.found = evidence.includes(q.file) || decodeURIComponent(evidence.replace(/%(?![0-9a-f]{2})/gi, '%25')).includes(q.file);
      row.cited = /https?:\/\/|<url>/.test(row.answer);
      if (result) {
        const u = result.usage || {};
        // Counted as the web arm counts them: a cache write is 1.25 input tokens, a cache read 0.05.
        Object.assign(row, { turns: result.num_turns, input: Math.round((u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.05 * (u.cache_read_input_tokens || 0)),
          output: u.output_tokens || 0, cost: Math.round((result.total_cost_usd || 0) * 1e4) / 1e4, models: Object.keys(result.modelUsage || {}) });
      }
      row.seconds = Math.round((Date.now() - started) / 100) / 10;
      save(row);
      return row;
    });
  } finally {
    await cleanup();
  }
}

// ---------- score

const arms = () => (existsSync(OUT) ? readdirSync(OUT).filter((f) => /^compare-.+\.jsonl$/.test(f)).map((f) => f.slice(8, -6)).sort() : []);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };

function score() {
  // A person's verdict on an answer the matcher got wrong, per arm: { "<arm>": { "<id>": { "pass": true, "note": "..." } } }.
  const reviewFile = join(ROOT, 'eval', 'compare', 'review.json');
  const review = existsSync(reviewFile) ? JSON.parse(readFileSync(reviewFile, 'utf8')) : {};
  const graded = {};
  for (const arm of arms()) {
    const rows = load(arm).map((r) => ({ r, q: QUESTIONS.find((q) => q.id === r.id) })).filter((x) => x.q).map((x) => ({ ...x, g: grade(x.q, x.r) }))
      .map((x) => ({ ...x, seen: review[arm]?.[x.q.id], ok: review[arm]?.[x.q.id]?.pass ?? x.g.pass }));
    graded[arm] = rows;
    console.log(`\n== ${arm} (${[...new Set(rows.map((x) => x.r.model))].join(', ')})`);
    console.log(`${'set'.padEnd(8)}${'n'.padStart(4)}${'matcher'.padStart(9)}${'reviewed'.padStart(10)}${'facts'.padStart(7)}${'lang ok'.padStart(9)}${'errors'.padStart(8)}${'p50 s'.padStart(7)}${'mean s'.padStart(8)}${'calls'.padStart(7)}${'tokens in'.padStart(11)}${'out'.padStart(7)}${'$ each'.padStart(9)}${'$ total'.padStart(9)}`);
    for (const set of [...SETS, 'all']) {
      const items = rows.filter((x) => set === 'all' || x.q.set === set);
      if (!items.length) continue;
      const facts = items.filter((x) => x.g.facts !== null);
      const costs = items.map((x) => x.r.cost).filter((c) => c !== undefined);
      console.log(`${set.padEnd(8)}${String(items.length).padStart(4)}${`${items.filter((x) => x.g.pass).length}/${items.length}`.padStart(9)}${`${items.filter((x) => x.ok).length}/${items.length}`.padStart(10)}`
        + `${`${Math.round(100 * mean(facts.map((x) => x.g.facts)))}%`.padStart(7)}${`${Math.round(100 * mean(items.map((x) => (x.g.lang ? 1 : 0))))}%`.padStart(9)}`
        + `${String(items.filter((x) => x.r.error).length).padStart(8)}${median(items.map((x) => x.r.seconds)).toFixed(1).padStart(7)}${mean(items.map((x) => x.r.seconds)).toFixed(1).padStart(8)}`
        + `${mean(items.map((x) => x.r.calls || 0)).toFixed(1).padStart(7)}${String(Math.round(mean(items.map((x) => x.r.input || 0)))).padStart(11)}${String(Math.round(mean(items.map((x) => x.r.output || 0)))).padStart(7)}`
        + `${(costs.length ? mean(costs).toFixed(4) : '-').padStart(9)}${(costs.length ? costs.reduce((a, b) => a + b, 0).toFixed(2) : '-').padStart(9)}`);
    }
    const tools = {};
    for (const x of rows) for (const [name, n] of Object.entries(x.r.tools || {})) tools[name] = (tools[name] || 0) + n;
    if (Object.keys(tools).length) console.log(`tools: ${Object.entries(tools).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  const names = Object.keys(graded);
  console.log('\n== questions the arms differ on, that no arm passes, or that were reviewed');
  for (const q of QUESTIONS) {
    const cells = names.map((arm) => graded[arm].find((x) => x.q.id === q.id)).map((x) => (x ? (x.seen ? `${x.ok ? 'PASS' : 'FAIL'} (reviewed: ${x.seen.note})` : x.g.pass ? 'PASS' : `FAIL${x.r.error ? ' (error)' : x.g.lacks.length ? ` (lacks ${x.g.lacks.join('; ')})` : q.absent || q.absentPart ? ' (does not say it is missing)' : ''}`) : '-'));
    const verdicts = new Set(cells.map((c) => c.slice(0, 4)).filter((c) => c !== '-'));
    if (verdicts.size > 1 || (verdicts.size === 1 && verdicts.has('FAIL')) || cells.some((c) => c.includes('(reviewed'))) console.log(`${q.id.padEnd(10)} ${names.map((arm, i) => `${arm}: ${cells[i]}`).join(' | ')}`);
  }
}

function show(id) {
  const q = QUESTIONS.find((x) => x.id === id);
  if (!q) throw new Error(`unknown question ${id}`);
  console.log(`${q.id} (${q.set}) ${q.question}\nexpected: ${q.absent ? 'not in the documents' : q.expect.map((g) => g.join(' | ')).join('; ')}${q.absentPart ? '; and one part is not in the documents' : ''}`);
  for (const arm of arms()) {
    const r = load(arm).find((x) => x.id === id);
    if (!r) continue;
    const g = grade(q, r);
    console.log(`\n--- ${arm}: ${g.pass ? 'PASS' : 'FAIL'}, ${r.seconds}s, ${r.calls ?? '-'} calls ${JSON.stringify(r.tools || {})}${r.error ? `, error: ${mask(r.error)}` : ''}\n${mask(r.answer)}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
if (command === 'score') score();
else if (command === 'show') show(rest[0]);
else if (command === 'web') { await web(rest); score(); } else if (command === 'cli') { await cli(rest); score(); } else {
  console.error('usage: node scripts/compare.mjs cli|web [ids or sets...] [--rest] | score | show <id>');
  process.exit(1);
}
