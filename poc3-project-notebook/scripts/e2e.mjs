#!/usr/bin/env node
// End-to-end test of the deployed app through the CloudFront site, as the test accounts of infra/deploy.mjs users:
// sign-in, approval and grants, per-user source scoping, chat (fast, deep, agent and research), exact counts (the live
// Jira query, the table query, the files of a page), studio, source guide, documents,
// the sync monitor, the MCP server with a personal access token, and what only the web page offers (live search, the
// reader, one-document questions, votes, the shared library, the KB quality page). Prints no address, token or password.
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
check('admin sees the 3 sources', sources.length === 3, sources.map((s) => s.name).join(', '));
const idOf = Object.fromEntries(sources.map((s) => [s.name, s.id]));

if (want('grants')) {
  const plan = {
    'ba-translator': ['confluence-engdocs', 'jira-scrum'],
    'sa-dbmate': ['confluence-engdocs'],
    'brse-company': ['confluence-company'],
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
  const req = await users.pending.call('/api/access-request', { method: 'POST', body: { sources: [idOf['confluence-company']], note: 'e2e' } });
  const listed = (await admin.call('/api/admin/users')).data.find((u) => u.email === users.pending.email);
  check('access request reaches the admin list', req.status === 200 && listed?.requested.includes(idOf['confluence-company']), `${req.status}`);
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
  const baAllowed = new Set(['confluence-engdocs', 'jira-scrum'].map((n) => sources.find((s) => s.name === n).title));
  check('chat passages come only from granted sources', passages.every((p) => baAllowed.has(p.sourceTitle)), [...new Set(passages.map((p) => p.sourceTitle))].join(', '));
  check('chat offers follow-up questions', done?.followups?.length > 0, (done?.followups || []).slice(0, 2).join(' | '));
  console.log(`  answer: ${mask(done?.answer?.slice(0, 300).replace(/\n/g, ' '))}…`);

  const deep = await ba.stream('/api/chat', { notebookId: nb.id, question: 'So sánh kiến trúc của bản web và bản mobile của My Translator', mode: 'deep' });
  const deepDone = deep.first('done');
  check('chat deep (agentic) answers', deepDone?.answer?.length > 50, `${deep.seconds}s, ${deep.events.filter((e) => e.event === 'step').length} steps, ${(deep.first('sources')?.passages || []).length} passages`);
  if (!deepDone) console.log(`  deep error: ${mask(JSON.stringify(deep.first('error')))}`);

  // Agent mode: the model searches and reads in several steps. Every passage it was shown must come from a granted
  // source, and the answer may only cite passages that are sent with it.
  const seen = (run) => run.events.filter((e) => e.event === 'sources').flatMap((e) => e.data.passages);
  const agent = await ba.stream('/api/chat', { notebookId: nb.id, question: 'So sánh kiến trúc bản web và bản mobile của My Translator, và cho biết các issue Jira nào liên quan tới hai bản này.', mode: 'agent' });
  const agentDone = agent.first('done');
  const stats = agentDone?.stats || {};
  check('chat agent answers after several tool calls', agentDone?.answer?.length > 50 && stats.calls >= 2 && /\[\d+\]/.test(agentDone.answer),
    `${agent.seconds}s, ${stats.rounds} turns, ${stats.calls} tool calls, ${stats.found} passages read, ${stats.input}+${stats.output} tokens, ${stats.model}`);
  if (!agentDone) console.log(`  agent error: ${mask(JSON.stringify(agent.first('error')))}`);
  check('chat agent reads only granted sources', seen(agent).length > 0 && seen(agent).every((p) => baAllowed.has(p.sourceTitle)), [...new Set(seen(agent).map((p) => p.sourceTitle))].join(', '));
  const kept = new Set((agent.events.filter((e) => e.event === 'sources').at(-1)?.data.passages || []).map((p) => p.n));
  const citedNumbers = [...new Set([...(agentDone?.answer || '').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
  check('chat agent cites only passages sent with the answer', citedNumbers.length > 0 && citedNumbers.every((n) => kept.has(n)), `${citedNumbers.length} numbers cited, ${kept.size} passages kept`);
  console.log(`  steps: ${mask(agent.events.filter((e) => e.event === 'step').map((e) => e.data.text.slice(0, 70)).join(' | '))}`);

  // Research mode: an outline, every section researched on its own, a report with a summary and citations.
  const research = await ba.stream('/api/chat', { notebookId: nb.id, question: 'Tổng hợp thiết kế my-db-mate 2.0: kiến trúc, cơ sở dữ liệu, phân quyền và vận hành.', mode: 'research' });
  const report = research.first('done');
  const rs = report?.stats || {};
  const sectionSteps = research.events.filter((e) => e.event === 'step' && /^§\d/.test(e.data.text)).length;
  check('research writes a report: a title, a summary, sections, citations', /^# /.test(report?.answer || '') && (report.answer.match(/^## /gm) || []).length >= 4 && (report.answer.match(/\[\d+\]/g) || []).length >= 10,
    `${research.seconds}s, ${rs.sections} sections, ${rs.rounds} turns, ${rs.calls} tool calls (${sectionSteps} inside sections), ${report?.answer?.length} chars, $${rs.usd}`);
  if (!report) console.log(`  research error: ${mask(JSON.stringify(research.first('error')))}`);
  check('research: every section searched on its own', sectionSteps >= rs.sections, `${sectionSteps} tool calls in ${rs.sections} sections`);
  check('research reads only granted sources and reports its cost', seen(research).every((p) => baAllowed.has(p.sourceTitle)) && rs.usd > 0 && rs.usd < 1.5, `$${rs.usd}`);
  const keptR = new Set((research.events.filter((e) => e.event === 'sources').at(-1)?.data.passages || []).map((p) => p.n));
  const citedR = [...new Set([...(report?.answer || '').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
  check('research cites only passages sent with the report', citedR.length > 0 && citedR.every((n) => keptR.has(n)), `${citedR.length} numbers cited, ${keptR.size} passages kept`);

  const msgs = (await ba.call(`/api/notebooks/${nb.id}/messages`)).data;
  check('chat history is saved', msgs.length >= 4, `${msgs.length} messages`);

  // The BrSE only reads the company wiki: a project question must not reach the project's Confluence space or Jira.
  const brse = users['brse-company'];
  const brseNb = await notebookOf(brse);
  const leak = await brse.stream('/api/chat', { notebookId: brseNb.id, question: 'My Translator dùng engine dịch nào?', mode: 'fast' });
  const brsePassages = leak.first('sources')?.passages || [];
  const brseTitle = sources.find((s) => s.name === 'confluence-company').title;
  check('scoping: the BrSE gets no project passages', brsePassages.every((p) => p.sourceTitle === brseTitle), `${brsePassages.length} passages from ${[...new Set(brsePassages.map((p) => p.sourceTitle))].join(', ') || 'none'}`);
  // The SA reads the project's Confluence space but not Jira, which is in the same knowledge base.
  const sa = users['sa-dbmate'];
  const saNb = await notebookOf(sa);
  const jiraLeak = await sa.stream('/api/chat', { notebookId: saNb.id, question: 'Các ticket Jira của dự án SCRUM đang mở nói về việc gì?', mode: 'fast' });
  const saPassages = jiraLeak.first('sources')?.passages || [];
  const saTitle = sources.find((s) => s.name === 'confluence-engdocs').title;
  check('scoping: the SA gets no Jira passages', saPassages.every((p) => p.sourceTitle === saTitle), `${saPassages.length} passages from ${[...new Set(saPassages.map((p) => p.sourceTitle))].join(', ') || 'none'}`);
  // The same question in agent mode: whatever the model asks its tools for, Jira stays out of reach.
  const saAgent = await sa.stream('/api/chat', { notebookId: saNb.id, question: 'Các ticket Jira của dự án SCRUM đang mở nói về việc gì?', mode: 'agent' });
  check('scoping: the SA\'s agent gets no Jira passages', Boolean(saAgent.first('done')) && seen(saAgent).every((p) => p.sourceTitle === saTitle),
    `${saAgent.seconds}s, ${saAgent.first('done')?.stats?.calls} tool calls, ${seen(saAgent).length} passages from ${[...new Set(seen(saAgent).map((p) => p.sourceTitle))].join(', ') || 'none'}`);
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
  for (const name of ['jira-scrum', 'confluence-engdocs']) {
    const r = await ba.call(`/api/sources/${idOf[name]}/documents`);
    const failed = (r.data || []).filter((d) => d.status === 'FAILED');
    check(`documents of ${name}`, r.status === 200 && r.data.length > 0, `${r.data?.length} documents, ${failed.length} failed${failed.length ? ` (${failed.map((d) => d.title).join(', ')})` : ''}`);
  }
  const denied = await ba.call(`/api/sources/${idOf['confluence-company']}/documents`);
  check('documents of a source without grant are refused', denied.status === 403, `${denied.status}`);
  const docs = (await ba.call(`/api/sources/${idOf['confluence-engdocs']}/documents`)).data;
  const page = docs.find((d) => d.kind === 'page') || docs[0];
  const g = await ba.call('/api/documents/guide', { method: 'POST', body: { source: idOf['confluence-engdocs'], uri: page.uri, docId: page.docId, title: page.title, lang: 'vi' } });
  check('source guide of a Confluence page', g.status === 200 && g.data.summary?.length > 30, `${g.status} ${g.data?.error || `${g.data.topics?.length} topics, ${g.data.questions?.length} questions, ${g.data.characters} chars`}`);
  const file = (await ba.call(`/api/sources/${idOf['jira-scrum']}/documents`)).data.find((d) => d.status === 'INDEXED' && /docx|pdf|xlsx/i.test(d.kind));
  if (file) {
    const g2 = await ba.call('/api/documents/guide', { method: 'POST', body: { source: idOf['jira-scrum'], uri: file.uri, docId: file.docId, title: file.title, lang: 'vi' } });
    check(`source guide of a Jira ${file.kind} attachment`, g2.status === 200 && g2.data.summary?.length > 30 && g2.data.characters > 100, `${g2.status} ${g2.data?.error || `${g2.data.characters} chars of ${file.title}`}`);
  } else check('source guide of a Jira attachment', false, 'no indexed docx, pdf or xlsx in the Jira source');
}

if (want('sync')) {
  const r = await admin.call('/api/sync');
  check('sync status of the 3 sources', r.status === 200 && r.data.sources.length === 3 && r.data.sources.every((s) => s.latest), `${r.data?.sources?.map((s) => `${s.name}:${s.latest?.status}`).join(', ')}`);
  const own = await users['sa-dbmate'].call('/api/sync');
  check('a member sees the sync of its sources only', own.data?.sources?.length === 1, `${own.data?.sources?.length}`);
  const failed = r.data.sources.flatMap((s) => s.failedDocuments || []);
  check('sync status names failed documents with a reason', failed.every((f) => f.title && f.reason), failed.map((f) => `${f.title}: ${f.reason?.slice(0, 60)}`).join('; '));
  const member = await users['sa-dbmate'].call(`/api/sources/${idOf['confluence-engdocs']}/sync`, { method: 'POST' });
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
  check('mcp tools/list', tools.data?.result?.tools?.length === 8, tools.data?.result?.tools?.map((t) => t.name).join(', '));
  const ls = await tool('list_sources', {});
  check('mcp list_sources shows only granted sources', !ls.isError && JSON.parse(ls.text).length === 2, JSON.parse(ls.text || '[]').map((s) => s.name).join(', '));
  const search = await tool('search', { query: 'text to speech engine', limit: 5 });
  check('mcp search', !search.isError && search.text.length > 100, `${search.text.length} chars`);
  const ask = await tool('ask', { question: 'My Translator có những tính năng chính nào?' });
  check('mcp ask', !ask.isError && /\[\d+\]/.test(ask.text), `${ask.text.length} chars`);
  const docs = await tool('list_documents', { source: 'confluence-engdocs' });
  check('mcp list_documents', !docs.isError && docs.text.length > 100, `${docs.text.length} chars`);
  const first = (() => { try { return JSON.parse(docs.text).documents?.[0] || JSON.parse(docs.text)[0]; } catch { return null; } })();
  if (first) {
    const doc = await tool('get_document', { source: 'confluence-engdocs', link: first.uri || first.link });
    check('mcp get_document', !doc.isError && doc.text.length > 50, `${doc.text.length} chars of ${first.title}`);
  } else check('mcp get_document', false, 'could not read a link from list_documents');
  const denied = await tool('list_documents', { source: 'confluence-company' });
  check('mcp refuses a source without grant', denied.isError, mask(denied.text.slice(0, 80)));

  // Exact answers, computed instead of retrieved. The expected numbers come from the test data of
  // scripts/attach-fixtures.mjs and, for the issue count, from Jira itself.
  const attached = await tool('list_documents', { source: 'confluence-engdocs', parent: 'Hồ sơ thiết kế' });
  const names = (() => { try { return JSON.parse(attached.text); } catch { return {}; } })();
  check('mcp list_documents gives every file attached to a page', names.total === 6 && names.documents.every((d) => d.parent), `${names.total} files: ${(names.documents || []).map((d) => d.title).join(', ')}`);
  const everything = await tool('query_jira', { jql: '', count_by: 'status', limit: 5 });
  const total = Number(everything.text.match(/(\d+) issues? match/i)?.[1] ?? everything.text.match(/total[^\d]{0,12}(\d+)/i)?.[1]);
  let inJira = null;
  try {
    const { atlassian, PROJECT } = await import('./attach-fixtures.mjs');
    inJira = (await atlassian('POST', '/rest/api/3/search/approximate-count', { json: { jql: `project = "${PROJECT}"` } })).count;
  } catch { /* no Atlassian settings on this machine: the number is only shown */ }
  check('mcp query_jira counts every issue, as Jira does', !everything.isError && total > 0 && (inJira === null || total === inJira), `${total} issues${inJira === null ? '' : `, Jira says ${inJira}`}`);
  const outside = await tool('query_jira', { jql: 'project = NOPE OR project is not EMPTY' });
  check('mcp query_jira stays inside the granted projects', outside.isError || Number(outside.text.match(/(\d+) issues? match/i)?.[1] ?? 0) <= total, mask(outside.text.slice(0, 80).replace(/\s+/g, ' ')));
  const csv = (() => { try { return JSON.parse(text0.text).documents?.[0]; } catch { return null; } });
  const text0 = await tool('list_documents', { source: 'jira-scrum', title_contains: 'Ket-qua-do-luong' });
  const sheet = csv();
  if (sheet) {
    const sum = await tool('query_table', { source: 'jira-scrum', link: sheet.link, aggregate: 'sum:so_van_ban_loi' });
    check('mcp query_table sums a column of an attached CSV', !sum.isError && /1[.,]?284/.test(sum.text), sum.text.slice(0, 160).replace(/\s+/g, ' '));
    const bad = await tool('query_table', { source: 'jira-scrum', link: sheet.link, aggregate: 'sum:khong_co_cot_nay' });
    check('mcp query_table names the columns when one is wrong', bad.isError && /so_van_ban_loi/.test(bad.text), bad.text.slice(0, 120).replace(/\s+/g, ' '));
  } else check('mcp query_table sums a column of an attached CSV', false, 'the test file is not in the knowledge base');
  await ba.call(`/api/tokens/${encodeURIComponent(created.data.prefix)}`, { method: 'DELETE' });
  const revoked = await rpc('tools/list');
  check('a revoked token is refused', revoked.status === 401, `${revoked.status}`);
}

// What the web page adds over an MCP client. Every one of these reads the knowledge base or what people asked, so
// every one is checked against the grants.
if (want('kb')) {
  const ba = users['ba-translator'];
  const sa = users['sa-dbmate'];
  const brse = users['brse-company'];
  const nb = await notebookOf(ba);
  const titleOf = (name) => sources.find((s) => s.name === name).title;
  const baAllowed = new Set(['confluence-engdocs', 'jira-scrum'].map(titleOf));

  // Live search: passages with no model in between.
  const found = await ba.call('/api/search', { method: 'POST', body: { query: 'text to speech engine', limit: 8 } });
  check('search returns passages of granted sources', found.status === 200 && found.data.passages.length > 0 && found.data.passages.every((p) => baAllowed.has(p.sourceTitle) && p.excerpt && p.text === undefined),
    `${found.data?.passages?.length} passages in ${found.data?.ms} ms from ${[...new Set((found.data?.passages || []).map((p) => p.sourceTitle))].join(', ')}`);
  const other = await ba.call('/api/search', { method: 'POST', body: { query: 'quy định nghỉ phép', sources: [idOf['confluence-company']] } });
  check('search in a source without grant finds nothing', other.status === 200 && other.data.passages.length === 0, `${other.status}, ${other.data?.passages?.length} passages`);
  const saFound = await sa.call('/api/search', { method: 'POST', body: { query: 'ticket Jira SCRUM đang mở', limit: 12 } });
  check('search: the SA gets no Jira passages', saFound.status === 200 && saFound.data.passages.every((p) => p.sourceTitle === titleOf('confluence-engdocs')),
    `${saFound.data?.passages?.length} passages from ${[...new Set((saFound.data?.passages || []).map((p) => p.sourceTitle))].join(', ') || 'none'}`);
  const short = await ba.call('/api/search', { method: 'POST', body: { query: 'a' } });
  check('search refuses a one-letter query', short.status === 400, `${short.status}`);

  // The reader: the whole extracted text of a document, where a found passage can be located.
  const hit = found.data.passages.find((p) => p.uri && p.sourceId);
  const text = await ba.call('/api/documents/text', { method: 'POST', body: { source: hit.sourceId, uri: hit.uri } });
  const flat = (t) => String(t).replace(/\s+/g, ' ');
  check('document text for the reader', text.status === 200 && text.data.text.length > 100 && text.data.total >= text.data.text.length,
    `${text.status}, ${text.data?.total} chars of ${hit.title}, passage ${flat(text.data?.text).includes(flat(hit.excerpt).slice(0, 60)) ? 'located' : 'not located'} in it`);
  const companyDocs = (await brse.call(`/api/sources/${idOf['confluence-company']}/documents`)).data || [];
  const foreign = companyDocs.find((d) => d.uri);
  const refused = await ba.call('/api/documents/text', { method: 'POST', body: { source: idOf['confluence-company'], uri: foreign?.uri || 'https://example.invalid/x' } });
  check('document text of a source without grant is refused', refused.status === 403, `${refused.status}`);
  // A granted source does not open another source's document: the link is looked up inside the named source.
  if (foreign) {
    const crossed = await ba.call('/api/documents/text', { method: 'POST', body: { source: idOf['confluence-engdocs'], uri: foreign.uri } });
    check('document text of another source\'s link is not found', crossed.status === 404, `${crossed.status}`);
  }

  // Recently changed documents.
  const recent = await ba.call(`/api/recent?notebookId=${nb.id}`);
  check('recent documents of granted sources', recent.status === 200 && recent.data.length > 0 && recent.data.every((d) => baAllowed.has(d.sourceTitle) && d.modified),
    `${recent.data?.length} documents, newest ${String(recent.data?.[0]?.modified).slice(0, 10)}`);
  const brseRecent = await brse.call('/api/recent');
  check('recent: the BrSE sees the company wiki only', brseRecent.status === 200 && brseRecent.data.every((d) => d.sourceTitle === titleOf('confluence-company')), `${brseRecent.data?.length} documents`);

  // One-document questions: the answer reads that document alone.
  const pages = (await ba.call(`/api/sources/${idOf['confluence-engdocs']}/documents`)).data;
  const page = pages.find((d) => d.kind === 'page' && d.status !== 'FAILED') || pages[0];
  const focused = await ba.stream('/api/chat', { notebookId: nb.id, question: 'Tài liệu này nói về những nội dung chính nào?', mode: 'fast', focus: { source: idOf['confluence-engdocs'], uri: page.uri, title: page.title } });
  const focusDone = focused.first('done');
  const focusPassages = focusDone?.passages || [];
  check('chat in one document reads that document alone', focusDone?.answer?.length > 50 && focusPassages.length > 0 && focusPassages.every((p) => p.uri === page.uri),
    `${focused.seconds}s, ${focusPassages.length} passages of ${page.title}${focused.first('error') ? `, error ${focused.first('error').message}` : ''}`);
  const stolen = await ba.stream('/api/chat', { notebookId: nb.id, question: 'Tài liệu này nói gì?', mode: 'fast', focus: { source: idOf['confluence-company'], uri: foreign?.uri || 'https://example.invalid/x', title: 'x' } });
  check('chat in a document of a source without grant is refused', !stolen.first('done') && (stolen.status === 403 || Boolean(stolen.first('error'))), `${stolen.status} ${stolen.first('error')?.message || ''}`);

  // A question on Jira alone, in agent mode: its steps are kept with the answer, and its passages are all Jira's,
  // which makes it the entry to share below.
  const asked = await ba.stream('/api/chat', { notebookId: nb.id, question: 'Các ticket Jira nào của dự án SCRUM có file đính kèm, và các file đó nói về gì?', mode: 'agent', sources: [idOf['jira-scrum']] });
  const askedDone = asked.first('done');
  const live = asked.events.filter((e) => e.event === 'step');
  const closed = asked.events.filter((e) => e.event === 'stepdone');
  check('agent steps arrive with a text and are closed', live.length > 0 && live.every((e) => typeof e.data.text === 'string' && e.data.kind) && live.filter((e) => e.data.id).every((e) => closed.some((c) => c.data.id === e.data.id)),
    `${live.length} steps, ${closed.length} closed, ${asked.seconds}s${asked.first('error') ? `, error ${asked.first('error').message}` : ''}`);
  const history = (await ba.call(`/api/notebooks/${nb.id}/messages`)).data;
  const saved = history.find((m) => m.id === askedDone?.id);
  check('steps, passages and time are saved with the answer', saved?.steps?.length > 0 && saved.steps.every((x) => x.text) && saved.passages?.length > 0 && saved.seconds > 0,
    `${saved?.steps?.length} steps, ${saved?.passages?.length} passages, ${saved?.seconds}s`);
  check('a one-document question is saved with its document', history.some((m) => m.role === 'user' && m.focus?.uri === page.uri), '');

  // Votes: on the message for its reader, in the question log for the admin.
  const down = await ba.call(`/api/notebooks/${nb.id}/feedback`, { method: 'POST', body: { message: focusDone?.id, vote: 'down', reason: 'missing', note: 'e2e' } });
  const voted = (await ba.call(`/api/notebooks/${nb.id}/messages`)).data.find((m) => m.id === focusDone?.id);
  check('a vote stays on the answer', down.status === 200 && down.data.feedback?.vote === 'down' && voted?.feedback?.reason === 'missing', `${down.status} ${voted?.feedback?.vote}/${voted?.feedback?.reason}`);
  const notMine = await sa.call(`/api/notebooks/${nb.id}/feedback`, { method: 'POST', body: { message: focusDone?.id, vote: 'up' } });
  check('nobody votes in another person\'s notebook', notMine.status === 404 || notMine.status === 403, `${notMine.status}`);

  // KB quality: what was asked, answered, declined and voted down. Admin only, and without the asker.
  const denied = await sa.call('/api/admin/insights');
  check('a member cannot read the KB quality page', denied.status === 403, `${denied.status}`);
  const ins = await admin.call('/api/admin/insights');
  const gap = ins.data?.gaps?.find((g) => g.vote === 'down' && g.note === 'e2e');
  check('KB quality counts the questions of the month', ins.status === 200 && ins.data.totals.questions > 0 && ins.data.days.length > 0,
    `${ins.data?.totals?.questions} questions, ${ins.data?.totals?.answered} answered, ${ins.data?.totals?.declined} declined, ${ins.data?.totals?.down} voted down, ${ins.data?.documents?.length} documents cited`);
  check('a down vote appears as a gap, without the asker', Boolean(gap) && gap.reason === 'missing' && !JSON.stringify(ins.data).includes('@'), gap ? `${gap.mode}, reason ${gap.reason}` : 'not found');
  if (gap) {
    const closedGap = await admin.call(`/api/admin/insights/${ins.data.month}/${gap.id}`, { method: 'PATCH', body: { resolved: true } });
    const again = (await admin.call(`/api/admin/insights?month=${ins.data.month}`)).data.gaps.find((g) => g.id === gap.id);
    check('a gap can be marked as handled', closedGap.status === 200 && again?.resolved === true, `${closedGap.status}`);
  }
  const up = await ba.call(`/api/notebooks/${nb.id}/feedback`, { method: 'POST', body: { message: focusDone?.id, vote: null } });
  check('a vote can be taken back', up.status === 200 && up.data.feedback === null, `${up.status}`);

  // The library: an answer shared with everyone who may read every source it cites.
  const shared = await ba.call('/api/library', { method: 'POST', body: { notebookId: nb.id, message: askedDone?.id } });
  const entry = shared.data;
  const onlyJira = shared.status === 200 && entry.sourceIds.length === 1 && entry.sourceIds[0] === idOf['jira-scrum'];
  check('share an answer to the library', shared.status === 200 && entry.passages.length > 0 && entry.mine === true, `${shared.status} ${shared.data?.error || `${entry.passages.length} cited passages, ${entry.sourceIds.length} source(s)`}`);
  if (shared.status === 200) {
    const sees = async (u) => ((await u.call('/api/library')).data || []).some((e) => e.id === entry.id);
    check('library: the one who shared and the admin see the entry', (await sees(ba)) && (await sees(admin)), '');
    check('library: the BrSE does not see an entry on project sources', !(await sees(brse)), '');
    if (onlyJira) check('library: the SA does not see an entry that cites Jira', !(await sees(sa)), '');
    else console.log('  (the shared answer cites more than Jira: the SA check is skipped)');
    const twice = await ba.call('/api/library', { method: 'POST', body: { notebookId: nb.id, message: askedDone?.id } });
    check('sharing twice keeps one entry', twice.status === 200 && twice.data.id === entry.id, `${twice.status}`);
    const memberVerify = await ba.call(`/api/library/${entry.id}`, { method: 'PATCH', body: { verified: true } });
    const adminVerify = await admin.call(`/api/library/${entry.id}`, { method: 'PATCH', body: { verified: true } });
    check('only an admin marks an entry as verified', memberVerify.status === 403 && adminVerify.status === 200 && adminVerify.data.verified === true, `member ${memberVerify.status}, admin ${adminVerify.status}`);
    const strangerRemove = await brse.call(`/api/library/${entry.id}`, { method: 'DELETE' });
    const ownRemove = await ba.call(`/api/library/${entry.id}`, { method: 'DELETE' });
    check('only its owner or an admin removes an entry', strangerRemove.status === 403 && ownRemove.status === 200 && !(await sees(ba)), `stranger ${strangerRemove.status}, owner ${ownRemove.status}`);
  }
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
