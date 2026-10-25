#!/usr/bin/env node
// End-to-end test of the deployed app through the CloudFront site, as the test accounts of infra/deploy.mjs users:
// sign-in, approval and grants, per-user source scoping, chat (fast and deep), studio, source guide, documents,
// the sync monitor, and the MCP server with a personal access token. Prints no address, token or password.
//
//   node scripts/e2e.mjs            all checks
//   node scripts/e2e.mjs mcp chat   only the named groups

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const local = JSON.parse(readFileSync(join(ROOT, 'infra', 'deploy.local.json'), 'utf8'));
const SITE = local.site;
const only = new Set(process.argv.slice(2));
const want = (group) => !only.size || only.has(group);

let failures = 0;
const mask = (s) => String(s).replace(/https?:\/\/[^\s"')]+/g, '<url>').replace(/\/sites\/[^/\s"]+/g, '/sites/<site>').replace(/[0-9]{12}/g, '<acct>');
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${mask(detail)}` : ''}`);
}

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

function client(token) {
  const call = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${SITE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = response.status === 202 ? null : await response.json().catch(() => null);
    return { status: response.status, data };
  };
  const stream = async (path, body) => {
    const started = Date.now();
    const response = await fetch(`${SITE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text();
    const events = [];
    for (const chunk of text.split('\n\n')) {
      const event = chunk.match(/^event: (.+)$/m)?.[1];
      const data = chunk.match(/^data: (.+)$/m)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) });
    }
    const first = (name) => events.find((e) => e.event === name)?.data;
    return { status: response.status, events, first, seconds: ((Date.now() - started) / 1000).toFixed(1) };
  };
  return { call, stream };
}

const users = Object.fromEntries(await Promise.all(Object.keys(local.users).map(async (email) => [email.split('@')[0], { email, ...client(await signIn(email)) }])));
check('sign-in of the 5 test accounts', Object.keys(users).length === 5);

// Profiles appear on the first /api/me.
const me = Object.fromEntries(await Promise.all(Object.entries(users).map(async ([k, u]) => [k, (await u.call('/api/me')).data])));
check('admin is an active admin', me.admin?.admin && me.admin.status === 'active', `${me.admin?.role}/${me.admin?.status}`);

const { admin } = users;
const sources = (await admin.call('/api/sources')).data;
check('admin sees the 6 sources', sources.length === 6, sources.map((s) => s.name).join(', '));
const idOf = Object.fromEntries(sources.map((s) => [s.name, s.id]));

if (want('grants')) {
  const plan = {
    'ba-translator': ['confluence-engdocs', 'sp-my-translator', 'sp-my-translator-mobile'],
    'sa-dbmate': ['sp-my-db-mate'],
    'brse-company': ['confluence-company', 'sp-company'],
  };
  for (const [k, names] of Object.entries(plan)) {
    const r = await admin.call(`/api/admin/users/${encodeURIComponent(users[k].email)}`, { method: 'PATCH', body: { status: 'active', grants: names.map((n) => idOf[n]) } });
    check(`approve ${k} with ${names.length} sources`, r.status === 200 && r.data.status === 'active', `${r.status}`);
  }
  for (const [k, names] of Object.entries(plan)) {
    const seen = (await users[k].call('/api/sources')).data.filter((s) => s.granted).map((s) => s.name).sort();
    check(`${k} is granted exactly its sources`, JSON.stringify(seen) === JSON.stringify([...names].sort()), seen.join(', '));
  }
  const pend = await users.pending.call('/api/notebooks');
  check('pending account cannot open notebooks', pend.status === 403, `${pend.status} ${pend.data?.error}`);
  const req = await users.pending.call('/api/access-request', { method: 'POST', body: { sources: [idOf['sp-company']], note: 'e2e' } });
  const listed = (await admin.call('/api/admin/users')).data.find((u) => u.email === users.pending.email);
  check('access request reaches the admin list', req.status === 200 && listed?.requested.includes(idOf['sp-company']), `${req.status}`);
  const notAdmin = await users['sa-dbmate'].call('/api/admin/users');
  check('member cannot use the admin API', notAdmin.status === 403, `${notAdmin.status}`);
  const noAuth = await fetch(`${SITE}/api/sources`);
  check('no token is refused', noAuth.status === 401, `${noAuth.status}`);
}

async function notebookOf(u) {
  const list = (await u.call('/api/notebooks')).data;
  return list.find((n) => n.name === 'e2e') || (await u.call('/api/notebooks', { method: 'POST', body: { name: 'e2e', sources: [] } })).data;
}

if (want('chat')) {
  const ba = users['ba-translator'];
  const nb = await notebookOf(ba);
  const fast = await ba.stream('/api/chat', { notebookId: nb.id, question: 'My Translator hỗ trợ những ngôn ngữ nào và dịch bằng engine gì?', mode: 'fast' });
  const done = fast.first('done');
  const passages = fast.first('sources')?.passages || [];
  check('chat fast answers with citations', done?.answer?.length > 50 && /\[\d+\]/.test(done.answer), `${fast.seconds}s, ${passages.length} passages, ${done?.answer?.length} chars`);
  const baAllowed = new Set(['confluence-engdocs', 'sp-my-translator', 'sp-my-translator-mobile'].map((n) => sources.find((s) => s.name === n).title));
  check('chat passages come only from granted sources', passages.every((p) => baAllowed.has(p.sourceTitle)), [...new Set(passages.map((p) => p.sourceTitle))].join(', '));
  check('chat offers follow-up questions', done?.followups?.length > 0, (done?.followups || []).slice(0, 2).join(' | '));
  console.log(`  answer: ${mask(done?.answer?.slice(0, 300).replace(/\n/g, ' '))}…`);

  const deep = await ba.stream('/api/chat', { notebookId: nb.id, question: 'So sánh kiến trúc của bản web và bản mobile của My Translator', mode: 'deep' });
  const deepDone = deep.first('done');
  check('chat deep (agentic) answers', deepDone?.answer?.length > 50, `${deep.seconds}s, ${deep.events.filter((e) => e.event === 'step').length} steps, ${(deep.first('sources')?.passages || []).length} passages`);
  if (!deepDone) console.log(`  deep error: ${mask(JSON.stringify(deep.first('error')))}`);

  const msgs = (await ba.call(`/api/notebooks/${nb.id}/messages`)).data;
  check('chat history is saved', msgs.length >= 4, `${msgs.length} messages`);

  // The SA only reads my-db-mate: a translator question must not reach translator documents.
  const sa = users['sa-dbmate'];
  const saNb = await notebookOf(sa);
  const leak = await sa.stream('/api/chat', { notebookId: saNb.id, question: 'My Translator dùng engine dịch nào?', mode: 'fast' });
  const saPassages = leak.first('sources')?.passages || [];
  const saTitle = sources.find((s) => s.name === 'sp-my-db-mate').title;
  check('scoping: the SA gets no translator passages', saPassages.every((p) => p.sourceTitle === saTitle), `${saPassages.length} passages from ${[...new Set(saPassages.map((p) => p.sourceTitle))].join(', ') || 'none'}`);
}

if (want('studio')) {
  const ba = users['ba-translator'];
  const nb = await notebookOf(ba);
  const outputs = (await ba.call('/api/studio/outputs')).data;
  check('studio lists 6 outputs', outputs.length === 6, outputs.map((o) => o.kind).join(', '));
  for (const kind of ['briefing', 'mindmap']) {
    const r = await ba.stream('/api/studio', { notebookId: nb.id, kind, lang: 'vi' });
    const text = r.events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    const ok = r.first('done') && (kind !== 'mindmap' || /```mermaid/.test(text));
    check(`studio ${kind}`, ok, `${r.seconds}s, ${text.length} chars${r.first('error') ? `, error ${r.first('error').message}` : ''}`);
  }
  const notes = (await ba.call(`/api/notebooks/${nb.id}/notes`)).data;
  check('studio outputs are saved as notes', notes.filter((n) => n.kind.startsWith('studio:')).length >= 2, `${notes.length} notes`);
}

if (want('docs')) {
  const ba = users['ba-translator'];
  for (const name of ['sp-my-translator', 'confluence-engdocs']) {
    const r = await ba.call(`/api/sources/${idOf[name]}/documents`);
    const failed = (r.data || []).filter((d) => d.status === 'FAILED');
    check(`documents of ${name}`, r.status === 200 && r.data.length > 0, `${r.data?.length} documents, ${failed.length} failed${failed.length ? ` (${failed.map((d) => d.title).join(', ')})` : ''}`);
  }
  const denied = await ba.call(`/api/sources/${idOf['sp-company']}/documents`);
  check('documents of a source without grant are refused', denied.status === 403, `${denied.status}`);
  const docs = (await ba.call(`/api/sources/${idOf['confluence-engdocs']}/documents`)).data;
  const page = docs.find((d) => d.kind === 'page') || docs[0];
  const g = await ba.call('/api/documents/guide', { method: 'POST', body: { source: idOf['confluence-engdocs'], uri: page.uri, docId: page.docId, title: page.title, lang: 'vi' } });
  check('source guide of a Confluence page', g.status === 200 && g.data.summary?.length > 30, `${g.status} ${g.data?.error || `${g.data.topics?.length} topics, ${g.data.questions?.length} questions, ${g.data.characters} chars`}`);
  const sp = (await ba.call(`/api/sources/${idOf['sp-my-translator']}/documents`)).data.find((d) => d.status === 'INDEXED' && /docx|pdf|xlsx/i.test(d.kind));
  if (sp) {
    const g2 = await ba.call('/api/documents/guide', { method: 'POST', body: { source: idOf['sp-my-translator'], uri: sp.uri, docId: sp.docId, title: sp.title, lang: 'vi' } });
    check(`source guide of a SharePoint ${sp.kind}`, g2.status === 200 && g2.data.summary?.length > 30, `${g2.status} ${g2.data?.error || `${g2.data.characters} chars`}`);
  }
}

if (want('sync')) {
  const r = await admin.call('/api/sync');
  check('sync status of the 6 sources', r.status === 200 && r.data.sources.length === 6 && r.data.sources.every((s) => s.latest), `${r.data?.sources?.map((s) => `${s.name}:${s.latest?.status}`).join(', ')}`);
  const own = await users['sa-dbmate'].call('/api/sync');
  check('a member sees the sync of its sources only', own.data?.sources?.length === 1, `${own.data?.sources?.length}`);
  const failed = r.data.sources.flatMap((s) => s.failedDocuments || []);
  check('sync status names failed documents with a reason', failed.every((f) => f.title && f.reason), failed.map((f) => `${f.title}: ${f.reason?.slice(0, 60)}`).join('; '));
  const member = await users['sa-dbmate'].call(`/api/sources/${idOf['sp-my-db-mate']}/sync`, { method: 'POST' });
  check('a member cannot start a sync', member.status === 403, `${member.status}`);
}

if (want('mcp')) {
  const ba = users['ba-translator'];
  const created = await ba.call('/api/tokens', { method: 'POST', body: { name: 'e2e', days: 1 } });
  check('create an MCP token', created.status === 200 && created.data.token?.startsWith('poc3_'), `${created.status}`);
  const pat = client(created.data.token);
  let id = 0;
  const rpc = async (method, params) => pat.call('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: ++id, method, params } });
  const tool = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { status: r.status, text: r.data?.result?.content?.[0]?.text || '', isError: r.data?.result?.isError || !!r.data?.error, error: r.data?.error };
  };
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  check('mcp initialize', init.data?.result?.serverInfo?.name === 'project-notebook', `${init.status} protocol ${init.data?.result?.protocolVersion}`);
  const note = await pat.call('/mcp', { method: 'POST', body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  check('mcp notification gets 202', note.status === 202, `${note.status}`);
  const tools = await rpc('tools/list');
  check('mcp tools/list', tools.data?.result?.tools?.length === 6, tools.data?.result?.tools?.map((t) => t.name).join(', '));
  const ls = await tool('list_sources', {});
  check('mcp list_sources shows only granted sources', !ls.isError && JSON.parse(ls.text).length === 3, JSON.parse(ls.text || '[]').map((s) => s.name).join(', '));
  const search = await tool('search', { query: 'text to speech engine', limit: 5 });
  check('mcp search', !search.isError && search.text.length > 100, `${search.text.length} chars`);
  const ask = await tool('ask', { question: 'My Translator có những tính năng chính nào?' });
  check('mcp ask', !ask.isError && /\[\d+\]/.test(ask.text), `${ask.text.length} chars`);
  const docs = await tool('list_documents', { source: 'confluence-engdocs' });
  check('mcp list_documents', !docs.isError && docs.text.length > 100, `${docs.text.length} chars`);
  const first = (() => { try { return JSON.parse(docs.text).documents?.[0] || JSON.parse(docs.text)[0]; } catch { return null; } })();
  if (first) {
    const doc = await tool('get_document', { source: 'confluence-engdocs', link: first.uri || first.link });
    check('mcp get_document', !doc.isError && doc.text.length > 100, `${doc.text.length} chars`);
  } else check('mcp get_document', false, 'could not read a link from list_documents');
  const denied = await tool('list_documents', { source: 'sp-company' });
  check('mcp refuses a source without grant', denied.isError, mask(denied.text.slice(0, 80)));
  await ba.call(`/api/tokens/${encodeURIComponent(created.data.prefix)}`, { method: 'DELETE' });
  const revoked = await rpc('tools/list');
  check('a revoked token is refused', revoked.status === 401, `${revoked.status}`);
}

if (want('admin')) {
  const report = await admin.call('/api/admin/import-permissions', { method: 'POST' });
  check('permission import runs', report.status === 200, `${report.status} ${mask(JSON.stringify(report.data).slice(0, 300))}`);
  const usage = await admin.call('/api/usage');
  check('usage of the month', usage.status === 200 && usage.data.total.questions > 0, `${usage.data?.total?.questions} questions, $${(usage.data.usd.models + usage.data.usd.retrieve + usage.data.usd.agentic).toFixed(4)}`);
}

const origin = await fetch(`${SITE}/`);
check('web page served', origin.status === 200 && /Project Notebook/.test(await origin.text()), `${origin.status}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
