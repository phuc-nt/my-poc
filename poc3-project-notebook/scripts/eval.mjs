#!/usr/bin/env node
// Asks the AIPF knowledge-base benchmark's 48 questions through the deployed chat API, as the admin test account, in
// a notebook limited to the project sources (Confluence ENGDOCS and the three SharePoint project folders). History is
// cleared before each question, so each one is answered on its own. Rows go to eval/out/<arm>.jsonl in the shape of
// the benchmark's runs (bench/kb/projects/score.py reads them); the summary checks the source document, the key facts
// in the answer, the absent questions and the answer language.
//
//   node scripts/eval.mjs fast [ids...]    fast mode (Retrieve, then the chat model)
//   node scripts/eval.mjs deep [ids...]    deep mode (agentic retrieval, then the studio model)
//   node scripts/eval.mjs score            summarise every run in eval/out
//
// POC3_QUESTIONS points at questions.json (default: the aipf-sdlc checkout next to this repo). EVAL_TAG names a variant
// run (eval/out/poc3-<mode>-<tag>.jsonl); POC3_CHAT_MODEL and POC3_STUDIO_MODEL only label the rows with the
// deployed models.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'eval', 'out');
const BENCH = process.env.POC3_QUESTIONS ? dirname(process.env.POC3_QUESTIONS) : join(homedir(), 'workspace', 'aipf-sdlc', 'bench', 'kb', 'projects');
const QUESTIONS = JSON.parse(readFileSync(join(BENCH, 'questions.json'), 'utf8'));
const DOCUMENTS = JSON.parse(readFileSync(join(BENCH, 'out', 'documents.json'), 'utf8'));
const PROJECT_SOURCES = ['confluence-engdocs', 'sp-my-db-mate', 'sp-my-translator', 'sp-my-translator-mobile'];
const WORKERS = 3;

// The benchmark's folding: no accents, đ as d, single spaces, lower case.
const fold = (s) => String(s).replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/\p{Mn}/gu, '').replace(/\s+/g, ' ').toLowerCase();
const stem = (s) => s.replace(/\.(pdf|docx|pptx|xlsx|html|md|txt|csv)$/i, '');

// A passage is from the question's document when its title holds the Confluence page title or the file's name.
function docKeys(rel) {
  return DOCUMENTS.filter((d) => d.rel === rel).map((d) => fold(d.where.startsWith('confluence') ? d.title.split(' (phần ')[0] : stem(d.where.split('/').pop())));
}
const NOT_FOUND = /không tìm thấy|không có thông tin|không bao gồm|không có nội dung|không đề cập|không được đề cập|chưa có thông tin|không nêu|not found|no information|not mentioned|do(es)? not (mention|say|specify|contain|include|cover)|do(es)?n't (mention|say|specify|contain)|isn't (mentioned|specified)|not (specified|documented|covered)|no mention/i;
// Vietnamese when accented letters are more than 2% of the letters: an English answer may quote a Vietnamese title.
const langOf = (s) => {
  if (/[\u3040-\u30ff]/.test(s)) return 'ja';
  const letters = (s.match(/\p{L}/gu) || []).length || 1;
  return (s.match(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹáàãéèíìóòõúùýđ]/gi) || []).length / letters > 0.02 ? 'vi' : 'en';
};

function scoreRow(row) {
  const q = QUESTIONS.find((x) => x.id === row.id);
  const answer = row.answer || '';
  const keys = q.rel ? docKeys(q.rel) : [];
  return {
    absent: !q.rel,
    doc: q.rel ? (row.passages || []).some((p) => keys.some((k) => k && fold(stem(p.title || '')).includes(k))) : null,
    facts: q.must?.length ? q.must.filter((m) => fold(answer).includes(fold(m))).length / q.must.length : null,
    refused: NOT_FOUND.test(answer),
    lang: langOf(answer.replace(/```[\s\S]*?```/g, '')) === q.lang,
    cited: /\[\d+\]/.test(answer),
  };
}

function summary(name, rows) {
  const s = rows.map((r) => ({ r, ...scoreRow(r), q: QUESTIONS.find((x) => x.id === r.id) }));
  const pct = (a, n) => (n ? `${Math.round((100 * a) / n)}%` : '-');
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
  const groups = { all: s, ...Object.groupBy(s, (x) => (x.absent ? 'absent' : x.q.where.split(':')[0])) };
  console.log(`\n== ${name} (${rows[0]?.model || '-'})`);
  console.log(`${'group'.padEnd(12)}${'n'.padStart(4)}${'doc hit'.padStart(9)}${'facts'.padStart(8)}${'refused'.padStart(9)}${'lang ok'.padStart(9)}${'cited'.padStart(7)}${'errors'.padStart(8)}${'p50 s'.padStart(7)}`);
  for (const [k, items] of Object.entries(groups)) {
    const present = items.filter((x) => !x.absent);
    const facts = present.filter((x) => x.facts !== null);
    console.log(`${k.padEnd(12)}${String(items.length).padStart(4)}${pct(present.filter((x) => x.doc).length, present.length).padStart(9)}`
      + `${pct(facts.reduce((a, x) => a + x.facts, 0), facts.length).padStart(8)}`
      + `${(k === 'absent' ? pct(items.filter((x) => x.refused).length, items.length) : `${items.filter((x) => x.refused).length}`).padStart(9)}`
      + `${pct(items.filter((x) => x.lang).length, items.length).padStart(9)}${pct(items.filter((x) => x.cited).length, items.length).padStart(7)}`
      + `${String(items.filter((x) => x.r.error).length).padStart(8)}${(median(items.map((x) => x.r.ms)) / 1000).toFixed(1).padStart(7)}`);
  }
}

function score() {
  const runs = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.endsWith('.jsonl')) : [];
  for (const f of runs) summary(f, readFileSync(join(OUT, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  // The AIPF run on AWS (same corpus, Bedrock KB, an earlier model) for comparison.
  const l1 = join(BENCH, 'out', 'runs', 'l1-aws.jsonl');
  if (existsSync(l1)) summary('aipf l1-aws', readFileSync(l1, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

async function run(mode, ids) {
  const local = JSON.parse(readFileSync(join(ROOT, 'infra', 'deploy.local.json'), 'utf8'));
  const SITE = local.site;
  const email = Object.keys(local.users).find((e) => e.startsWith('admin@'));
  const cfg = await (await fetch(`${SITE}/config.json`)).json();
  const auth = await (await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ ClientId: cfg.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: local.users[email] } }),
  })).json();
  const token = auth.AuthenticationResult?.IdToken;
  if (!token) throw new Error(`sign-in failed: ${auth.__type}`);
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${SITE}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
    return r.status === 202 || r.status === 204 ? null : r.json().catch(() => null);
  };

  const sources = await call('/api/sources');
  const ids4 = PROJECT_SOURCES.map((n) => sources.find((s) => s.name === n)?.id);
  if (ids4.some((x) => !x)) throw new Error('the admin does not see the four project sources');
  const notebooks = await call('/api/notebooks');
  const books = [];
  for (let i = 0; i < WORKERS; i += 1) {
    const name = `eval-${i + 1}`;
    const nb = notebooks.find((n) => n.name === name) || (await call('/api/notebooks', { method: 'POST', body: { name, sources: ids4 } }));
    await call(`/api/notebooks/${nb.id}`, { method: 'PATCH', body: { sources: ids4 } });
    books.push(nb);
  }

  mkdirSync(OUT, { recursive: true });
  const arm = `poc3-${mode}${process.env.EVAL_TAG ? `-${process.env.EVAL_TAG}` : ''}`;
  const file = join(OUT, `${arm}.jsonl`);
  const todo = QUESTIONS.filter((q) => !ids.length || ids.includes(q.id));
  if (!ids.length) writeFileSync(file, '');
  const queue = [...todo];
  await Promise.all(books.map(async (nb) => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      await call(`/api/notebooks/${nb.id}/messages`, { method: 'DELETE' });
      const started = Date.now();
      const row = { arm, model: (mode === 'deep' ? process.env.POC3_STUDIO_MODEL : process.env.POC3_CHAT_MODEL) || 'zai.glm-5', id: q.id };
      try {
        const response = await fetch(`${SITE}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ notebookId: nb.id, question: q.question, mode, lang: q.lang }) });
        // Reads the stream as it comes, to time the passages and the first piece of the answer.
        let text = '';
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          text += decoder.decode(chunk, { stream: true });
          if (!row.sourcesMs && text.includes('event: sources')) row.sourcesMs = Date.now() - started;
          if (!row.firstMs && text.includes('event: delta')) row.firstMs = Date.now() - started;
        }
        const events = text.split('\n\n').map((c) => ({ event: c.match(/^event: (.+)$/m)?.[1], data: c.match(/^data: (.+)$/m)?.[1] })).filter((e) => e.event && e.data)
          .map((e) => ({ ...e, data: JSON.parse(e.data) }));
        const at = (name) => events.find((e) => e.event === name)?.data;
        row.status = response.status;
        row.passages = (at('sources')?.passages || []).map((p) => ({ title: p.title, source: p.sourceTitle, text: p.excerpt }));
        row.steps = events.filter((e) => e.event === 'step').map((e) => e.data.text);
        row.answer = at('done')?.answer || '';
        row.error = at('error')?.message;
      } catch (error) {
        row.error = error.message;
      }
      row.ms = Date.now() - started;
      appendFileSync(file, `${JSON.stringify(row)}\n`);
      const s = scoreRow(row);
      console.log(`${q.id} ${(row.ms / 1000).toFixed(1)}s doc=${s.doc ?? '-'} facts=${s.facts === null ? '-' : s.facts.toFixed(2)} refused=${s.refused}${row.error ? ' ERROR' : ''}`);
    }
  }));
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'score') score();
else if (command === 'fast' || command === 'deep') { await run(command, rest); score(); }
else { console.error('usage: node scripts/eval.mjs fast|deep [ids...] | score'); process.exit(1); }
