// The API Lambda behind CloudFront (/api/*, /mcp), through a function URL with response streaming.
// Chat and studio answer as server-sent events; everything else is JSON.

import { config } from '../lib/config.mjs';
import { caller, isAdmin, grantedSourceIds, hashToken, newToken, HttpError } from '../lib/auth.mjs';
import { get, put, del, query, deleteAll, now, newId } from '../lib/store.mjs';
import { listSources, sourceDetail, jobs, startSync, documents, withTextDocuments, docKey, search, documentText, mayRead, visible } from '../lib/kb.mjs';
import { aclStatus } from '../lib/acl.mjs';
import { answer } from '../lib/answer.mjs';
import { claudeError } from '../lib/claude.mjs';
import { studio, sourceGuide, OUTPUTS } from '../lib/studio.mjs';
import { handleMcp } from '../lib/mcp.mjs';
import { importPermissions, applyImported } from '../lib/permissions.mjs';
import { monthUsage } from '../lib/usage.mjs';
import { logQuestion, feedback, insights, resolve, share, library, verify, remove, REASONS } from '../lib/insights.mjs';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({ region: config.region });

// ---------- responses

function open(stream, status, headers) {
  return awslambda.HttpResponseStream.from(stream, { statusCode: status, headers: { 'cache-control': 'no-store', ...headers } });
}

function json(stream, status, body) {
  const out = open(stream, status, { 'content-type': 'application/json; charset=utf-8' });
  // A streamed response sends its status with the first write, so an empty body still writes once.
  out.write(body !== undefined ? JSON.stringify(body) : '');
  out.end();
}

// Server-sent events, with a comment every 10 seconds so that CloudFront keeps the connection open.
function sse(stream) {
  const out = open(stream, 200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' });
  out.write(': open\n\n');
  const beat = setInterval(() => out.write(': ping\n\n'), 10_000);
  return {
    emit: (event, data) => out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    end: () => {
      clearInterval(beat);
      out.end();
    },
  };
}

// ---------- helpers

const body = (event) => {
  if (!event.body) return {};
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The body is not JSON');
  }
};
const rawBody = (event) => (event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '');

const requireActive = (user) => {
  if (user.status !== 'active') throw new HttpError(403, user.status === 'pending' ? 'Your account is waiting for approval' : 'Your account is disabled');
};
const requireAdmin = (user) => {
  if (!isAdmin(user)) throw new HttpError(403, 'Admins only');
};

async function notebook(user, id) {
  const nb = await get(`USER#${user.email}`, `NB#${id}`);
  if (!nb) throw new HttpError(404, 'No such notebook');
  return nb;
}

// What a request may search: the user's grants, narrowed to the notebook's sources and to the sources ticked in the UI.
async function scope(user, { notebookId, notebook: nbRef, sources } = {}) {
  const all = await listSources();
  let ids = await grantedSourceIds(user, all);
  const ref = notebookId || nbRef;
  if (ref) {
    let nb = await get(`USER#${user.email}`, `NB#${ref}`);
    if (!nb) nb = (await query(`USER#${user.email}`, 'NB#')).find((n) => n.name === ref);
    if (!nb) throw new HttpError(404, 'No such notebook');
    if (nb.sources?.length) ids = ids.filter((id) => nb.sources.includes(id));
  }
  if (Array.isArray(sources) && sources.length) {
    const wanted = new Set(sources.flatMap((s) => [s, ...all.filter((x) => x.name === s || x.title === s).map((x) => x.id)]));
    ids = ids.filter((id) => wanted.has(id));
  }
  return ids;
}

const latestSync = async (id) => (await get(`SOURCE#${id}`, 'LATEST'))?.job || null;

async function sourceViews(user) {
  const all = await listSources();
  const granted = new Set(await grantedSourceIds(user, all));
  const requested = new Set(user.requested || []);
  return Promise.all(all.map(async (s) => ({
    id: s.id, name: s.name, title: s.title, type: s.type, knowledgeBase: s.kbName,
    granted: granted.has(s.id), requested: requested.has(s.id),
    sync: await latestSync(s.id), documents: (await get(`SOURCE#${s.id}`, 'LATEST'))?.documents ?? null,
  })));
}

const notebookView = (n) => ({ id: n.id, name: n.name, description: n.description || '', sources: n.sources || [], createdAt: n.createdAt, updatedAt: n.updatedAt });

// ---------- routes

const routes = [];
const route = (method, pattern, fn, { auth = 'active' } = {}) =>
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn, auth });

route('GET', '/api/me', async ({ user }) => {
  const grants = await query(`USER#${user.email}`, 'GRANT#');
  return { email: user.email, name: user.name, role: user.role, status: user.status, admin: isAdmin(user),
    requested: user.requested || [], grants: grants.map((g) => ({ sourceId: g.sk.slice(6), origin: g.origin })), via: user.via };
}, { auth: 'any' });

route('POST', '/api/access-request', async ({ user, event }) => {
  const { sources = [], note = '' } = body(event);
  const known = new Set((await listSources()).map((s) => s.id));
  const requested = [...new Set(sources.filter((id) => known.has(id)))];
  await put({ ...user, via: undefined, requested, note: String(note).slice(0, 500), requestedAt: now() });
  return { requested };
}, { auth: 'any' });

route('GET', '/api/sources', async ({ user }) => sourceViews(user), { auth: 'any' });

// The document list, from the monitor's copy (live when there is none), with the documents that failed to index.
// A Jira source is always read live: its list carries each document's own state (INDEXED, PENDING or FAILED).
route('GET', '/api/sources/:id/documents', async ({ user, params }) => {
  const s = await readable(user, params.id);
  // A document restricted to other people is left out; one this reader is let into is marked restricted.
  if (s.type === 'JIRA') return visible(user.email, s, await documents(s));
  const saved = await get(`SOURCE#${s.id}`, 'CATALOG');
  const docs = await visible(user.email, s, saved?.documents ? await withTextDocuments(s, saved.documents) : await documents(s));
  const failed = new Map(((await get(`SOURCE#${s.id}`, 'LATEST'))?.failedDocuments || []).map((f) => [docKey(f.uri), f.reason]));
  return docs.map((d) => ({ ...d, status: failed.has(docKey(d.uri)) ? 'FAILED' : 'INDEXED', reason: failed.get(docKey(d.uri)) }));
});

route('GET', '/api/sources/:id', async ({ user, params }) => {
  const s = await readable(user, params.id);
  const history = (await query(`SOURCE#${s.id}`, 'JOB#', { forward: false, limit: 30 })).map((j) => j.job);
  return { ...s, ...(await sourceDetail(s)), history: history.length || s.type === 'JIRA' ? history : await jobs(s) };
});

route('POST', '/api/sources/:id/sync', async ({ user, params }) => {
  requireAdmin(user);
  const s = (await listSources()).find((x) => x.id === params.id);
  if (!s) throw new HttpError(404, 'No such source');
  // A Jira source has no ingestion job: the monitor function reads Jira and sends the documents (lib/jira.mjs).
  if (s.type === 'JIRA') {
    await lambda.send(new InvokeCommand({ FunctionName: config.monitorFunction, InvocationType: 'Event', Payload: JSON.stringify({ jira: s.id, full: true }) }));
    return { jobId: `jira-${now()}`, status: 'STARTING', startedAt: now() };
  }
  try {
    return await startSync(s);
  } catch (error) {
    throw new HttpError(409, /ConflictException|ongoing|running/i.test(`${error.name} ${error.message}`) ? 'A sync of this source is already running' : error.message);
  }
});

route('POST', '/api/documents/guide', async ({ user, event }) => {
  // The document is found from its link; an id sent by the browser is not trusted.
  const { source, uri, title, lang = 'vi' } = body(event);
  if (!uri) throw new HttpError(400, 'Which document?');
  const s = await readable(user, source);
  if (!(await mayRead(user.email, s, String(uri)))) throw new HttpError(404, MISSING);
  return sourceGuide(s, { uri: String(uri), title }, { lang });
});

// The full extracted text of one document, for the reader that shows a cited passage in its place. The document
// is found from its link inside the source the caller may read; an id sent by the browser is not trusted.
route('POST', '/api/documents/text', async ({ user, event }) => {
  const { source, uri } = body(event);
  if (!uri) throw new HttpError(400, 'Which document?');
  const s = await readable(user, String(source));
  if (!(await mayRead(user.email, s, String(uri)))) throw new HttpError(404, MISSING);
  let text;
  try {
    text = await documentText(s, { uri: String(uri) });
  } catch (error) {
    if (error.constructor === Error) throw new HttpError(404, error.message);
    throw error;
  }
  return { text: text.slice(0, TEXT_MAX), total: text.length, cut: text.length > TEXT_MAX };
});

// Search as you type: the passages themselves, with no model in between.
route('POST', '/api/search', async ({ user, event }) => {
  const b = body(event);
  const text = String(b.query || '').trim().slice(0, 300);
  if (text.length < 2) throw new HttpError(400, 'Type at least two characters');
  const allowed = await scope(user, { notebookId: b.notebookId || undefined, sources: b.sources });
  if (!allowed.length) return { passages: [], ms: 0 };
  const began = Date.now();
  const found = await search(text, allowed, { n: Math.min(Math.max(Number(b.limit) || 12, 1), 20), userId: user.email });
  return { passages: found.map(({ text: full, ...p }, i) => ({ n: i + 1, ...p, excerpt: full.slice(0, 700) })), ms: Date.now() - began };
});

// The documents that changed last, over the sources of a notebook (or all the caller's sources).
route('GET', '/api/recent', async ({ user, event }) => {
  const notebookId = new URLSearchParams(event.rawQueryString || '').get('notebookId') || undefined;
  const allowed = new Set(await scope(user, { notebookId }));
  const sources = (await listSources()).filter((s) => allowed.has(s.id));
  const lists = await Promise.all(sources.map(async (s) => {
    try {
      const docs = await visible(user.email, s, s.type === 'JIRA' ? await documents(s) : (await get(`SOURCE#${s.id}`, 'CATALOG'))?.documents || []);
      return docs.filter((d) => d.modified).map((d) => ({ title: d.title, uri: d.uri, kind: d.kind, modified: d.modified, sourceId: s.id, sourceTitle: s.title, sourceType: s.type }));
    } catch (error) {
      console.error('recent', s.name, error.name, error.message);
      return [];
    }
  }));
  return lists.flat().sort((a, b) => String(b.modified).localeCompare(String(a.modified))).slice(0, 12);
});

// Sync status of every source: the latest job, the last 14 days of jobs and the alarm thresholds.
route('GET', '/api/sync', async ({ user }) => {
  const all = await listSources();
  const granted = new Set(await grantedSourceIds(user, all));
  const visible = isAdmin(user) ? all : all.filter((s) => granted.has(s.id));
  const sources = await Promise.all(visible.map(async (s) => {
    const latest = await get(`SOURCE#${s.id}`, 'LATEST');
    const history = (await query(`SOURCE#${s.id}`, 'JOB#', { forward: false, limit: 20 })).map((j) => j.job);
    return { id: s.id, name: s.name, title: s.title, type: s.type, knowledgeBase: s.kbName, latest: latest?.job || null,
      lastSuccessAt: latest?.lastSuccessAt || null, documents: latest?.documents ?? null, failedDocuments: latest?.failedDocuments || [], history };
  }));
  const monitor = await get('MONITOR', 'LAST');
  return { sources, checkedAt: monitor?.at || null, staleHours: config.staleHours, schedule: 'daily (managed); Jira and the monitor every 15 minutes' };
});

// Notebooks
route('GET', '/api/notebooks', async ({ user }) => (await query(`USER#${user.email}`, 'NB#')).map(notebookView)
  .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));

route('POST', '/api/notebooks', async ({ user, event }) => {
  const { name = 'Notebook mới', description = '', sources = [] } = body(event);
  const id = newId();
  const item = { pk: `USER#${user.email}`, sk: `NB#${id}`, id, name: String(name).slice(0, 120), description: String(description).slice(0, 500),
    sources: sources.slice(0, 50), createdAt: now(), updatedAt: now() };
  await put(item);
  return notebookView(item);
});

route('GET', '/api/notebooks/:id', async ({ user, params }) => notebookView(await notebook(user, params.id)));

route('PATCH', '/api/notebooks/:id', async ({ user, params, event }) => {
  const nb = await notebook(user, params.id);
  const b = body(event);
  const next = { ...nb, ...(b.name !== undefined && { name: String(b.name).slice(0, 120) }), ...(b.description !== undefined && { description: String(b.description).slice(0, 500) }),
    ...(Array.isArray(b.sources) && { sources: b.sources.slice(0, 50) }), updatedAt: now() };
  await put(next);
  return notebookView(next);
});

route('DELETE', '/api/notebooks/:id', async ({ user, params }) => {
  await notebook(user, params.id);
  await deleteAll(`NB#${params.id}`);
  await del(`USER#${user.email}`, `NB#${params.id}`);
  return { deleted: true };
});

route('GET', '/api/notebooks/:id/messages', async ({ user, params }) => {
  await notebook(user, params.id);
  return (await query(`NB#${params.id}`, 'MSG#')).map((m) => ({ id: m.sk.slice(4), role: m.role, content: m.content, citations: m.citations, followups: m.followups, passages: m.passages, mode: m.mode, stats: m.stats, at: m.at,
    steps: m.steps, seconds: m.seconds, feedback: m.feedback, shared: m.shared, focus: m.focus }));
});

// A vote on one answer. It stays on the message, and goes to the question log without the voter's name.
route('POST', '/api/notebooks/:id/feedback', async ({ user, params, event }) => {
  await notebook(user, params.id);
  const b = body(event);
  const message = await get(`NB#${params.id}`, `MSG#${b.message}`);
  if (!message || message.role !== 'assistant') throw new HttpError(404, 'No such answer');
  const vote = ['up', 'down'].includes(b.vote) ? b.vote : null;
  const given = vote ? { vote, reason: vote === 'down' && REASONS.includes(b.reason) ? b.reason : undefined, note: vote === 'down' ? String(b.note || '').trim().slice(0, 500) || undefined : undefined } : undefined;
  await put({ ...message, feedback: given });
  await feedback(message.log, given || {});
  return { feedback: given || null };
});

route('DELETE', '/api/notebooks/:id/messages', async ({ user, params }) => {
  await notebook(user, params.id);
  return { deleted: await deleteAll(`NB#${params.id}`, 'MSG#') };
});

route('GET', '/api/notebooks/:id/notes', async ({ user, params }) => {
  await notebook(user, params.id);
  return (await query(`NB#${params.id}`, 'NOTE#', { forward: false })).map((n) => ({ id: n.sk.slice(5), title: n.title, content: n.content, kind: n.kind, passages: n.passages, at: n.at }));
});

route('POST', '/api/notebooks/:id/notes', async ({ user, params, event }) => {
  await notebook(user, params.id);
  const { title = 'Ghi chú', content = '', kind = 'note', passages } = body(event);
  const at = now();
  await put({ pk: `NB#${params.id}`, sk: `NOTE#${at}`, title: String(title).slice(0, 200), content: String(content).slice(0, 100000), kind, passages, at });
  return { id: at, title, content, kind, at };
});

route('DELETE', '/api/notebooks/:id/notes/:note', async ({ user, params }) => {
  await notebook(user, params.id);
  await del(`NB#${params.id}`, `NOTE#${decodeURIComponent(params.note)}`);
  return { deleted: true };
});

// Chat: server-sent events sources, step, delta, reset (agent and research modes), done (or error).
route('POST', '/api/chat', async ({ user, event, stream }) => {
  const b = body(event);
  const question = String(b.question || '').trim().slice(0, 4000);
  if (!question) throw new HttpError(400, 'Ask a question');
  const nb = await notebook(user, b.notebookId);
  const allowed = await scope(user, { notebookId: nb.id, sources: b.sources });
  const history = (await query(`NB#${nb.id}`, 'MSG#', { forward: false, limit: 8 })).reverse().map((m) => ({ role: m.role, content: m.content }));
  const out = sse(stream);
  try {
    const at = now();
    const mode = ['deep', 'agent', 'research'].includes(b.mode) ? b.mode : 'fast';
    const lang = ['vi', 'en', 'ja'].includes(b.lang) ? b.lang : undefined;
    // A question about one document: the source must be one the caller may read, and the document is found by its link.
    const focus = b.focus?.uri ? { source: await readable(user, String(b.focus.source)), uri: String(b.focus.uri), title: String(b.focus.title || '').slice(0, 300) } : undefined;
    if (focus && !(await mayRead(user.email, focus.source, focus.uri))) throw new HttpError(404, MISSING);
    await put({ pk: `NB#${nb.id}`, sk: `MSG#${at}`, role: 'user', content: question, at, mode, focus: focus && { title: focus.title, uri: focus.uri, sourceId: focus.source.id } });
    // The steps go to the browser as they happen and are kept with the answer, so that the trace can be read later.
    const steps = [];
    const emit = (name, data) => {
      if (name === 'step') steps.push({ ...data, text: String(data.text || '').slice(0, 300) });
      if (name === 'stepdone') Object.assign(steps.find((x) => x.id === data.id) || {}, data, { done: true });
      out.emit(name, data);
    };
    const result = await answer({ question, history: focus ? [] : history, allowed, mode, lang, emit, userId: user.email, syncOf: latestSync, focus });
    // Agent mode numbers its passages itself (only the cited ones stay, with gaps); the other modes count from 1.
    const passages = result.passages.map(({ text, ...p }, i) => ({ n: i + 1, ...p, excerpt: text.slice(0, 600) }));
    const doneAt = now();
    const seconds = Math.round((Date.parse(doneAt) - Date.parse(at)) / 100) / 10;
    const log = await logQuestion({ question, mode, lang, citations: result.citations, stats: result.stats, seconds, focus }).catch((error) => {
      console.error('question log', error.name, error.message);
      return undefined;
    });
    await put({ pk: `NB#${nb.id}`, sk: `MSG#${doneAt}`, role: 'assistant', content: result.answer, citations: result.citations, followups: result.followups, passages, at: doneAt, mode,
      stats: result.stats, steps: steps.slice(0, 120), seconds, log });
    await put({ ...nb, updatedAt: doneAt });
    out.emit('done', { id: doneAt, answer: result.answer, citations: result.citations, followups: result.followups, stats: result.stats, passages, seconds });
  } catch (error) {
    console.error('chat', error.name, error.message);
    out.emit('error', { message: friendly(error) });
  }
  out.end();
});

route('GET', '/api/studio/outputs', async () => Object.entries(OUTPUTS).map(([kind, o]) => ({ kind, title: o.title })));

route('POST', '/api/studio', async ({ user, event, stream }) => {
  const b = body(event);
  const nb = await notebook(user, b.notebookId);
  const allowed = await scope(user, { notebookId: nb.id, sources: b.sources });
  const out = sse(stream);
  try {
    const result = await studio({ kind: b.kind, focus: String(b.focus || '').slice(0, 300), allowed, lang: ['vi', 'en', 'ja'].includes(b.lang) ? b.lang : 'vi', emit: out.emit, userId: user.email });
    const at = now();
    const passages = result.passages.map(({ text, ...p }, i) => ({ n: i + 1, ...p, excerpt: text.slice(0, 400) }));
    await put({ pk: `NB#${nb.id}`, sk: `NOTE#${at}`, title: result.title, content: result.content, kind: `studio:${b.kind}`, passages, at });
    out.emit('done', { id: at, title: result.title });
  } catch (error) {
    console.error('studio', error.name, error.message);
    out.emit('error', { message: friendly(error) });
  }
  out.end();
});

// Personal access tokens for MCP clients. The token is shown once; only its hash is kept.
route('GET', '/api/tokens', async ({ user }) => (await query(`USER#${user.email}`, 'TOKEN#')).map((t) => ({ prefix: t.sk.slice(6), name: t.name, createdAt: t.createdAt, expiresAt: t.expiresAt })));

route('POST', '/api/tokens', async ({ user, event }) => {
  if (user.via === 'token') throw new HttpError(403, 'Create tokens from the web app');
  const { name = 'MCP', days = 90 } = body(event);
  const token = newToken();
  const hash = hashToken(token);
  const prefix = token.slice(0, 12);
  const expiresAt = new Date(Date.now() + Math.min(Number(days) || 90, 365) * 86400_000).toISOString();
  await put({ pk: `PAT#${hash}`, sk: 'PAT', email: user.email, prefix, expiresAt });
  await put({ pk: `USER#${user.email}`, sk: `TOKEN#${prefix}`, hash, name: String(name).slice(0, 80), createdAt: now(), expiresAt });
  return { token, prefix, name, expiresAt };
});

route('DELETE', '/api/tokens/:prefix', async ({ user, params }) => {
  const t = await get(`USER#${user.email}`, `TOKEN#${params.prefix}`);
  if (!t) throw new HttpError(404, 'No such token');
  await del(`PAT#${t.hash}`, 'PAT');
  await del(t.pk, t.sk);
  return { deleted: true };
});

// Admin
route('GET', '/api/admin/users', async ({ user }) => {
  requireAdmin(user);
  const users = await query('USERS', '', { index: 'gsi1' });
  return Promise.all(users.map(async (u) => ({
    email: u.email, name: u.name, role: u.role, status: u.status, requested: u.requested || [], note: u.note, createdAt: u.createdAt, approvedBy: u.approvedBy,
    grants: (await query(`USER#${u.email}`, 'GRANT#')).map((g) => ({ sourceId: g.sk.slice(6), origin: g.origin })),
  })));
});

route('PATCH', '/api/admin/users/:email', async ({ user, params, event }) => {
  requireAdmin(user);
  const email = decodeURIComponent(params.email).toLowerCase();
  const target = await get(`USER#${email}`, 'PROFILE');
  if (!target) throw new HttpError(404, 'No such user');
  const b = body(event);
  if (email === user.email && (b.role === 'member' || b.status === 'disabled')) throw new HttpError(400, 'You cannot demote or disable yourself');
  const next = { ...target };
  if (['active', 'pending', 'disabled'].includes(b.status)) next.status = b.status;
  if (['admin', 'member'].includes(b.role)) next.role = b.role;
  next.gsi1sk = `${next.status}#${email}`;
  if (b.status === 'active' && target.status !== 'active') next.approvedBy = user.email;
  if (Array.isArray(b.grants)) {
    const known = new Set((await listSources()).map((s) => s.id));
    const wanted = new Set(b.grants.filter((id) => known.has(id)));
    const current = await query(`USER#${email}`, 'GRANT#');
    for (const g of current) if (!wanted.has(g.sk.slice(6))) await del(g.pk, g.sk);
    for (const id of wanted) if (!current.some((g) => g.sk === `GRANT#${id}`)) await put({ pk: `USER#${email}`, sk: `GRANT#${id}`, origin: 'admin', by: user.email, at: now() });
    next.requested = (next.requested || []).filter((id) => !wanted.has(id));
  }
  await put(next);
  return { email, role: next.role, status: next.status };
});

route('POST', '/api/admin/import-permissions', async ({ user }) => {
  requireAdmin(user);
  return importPermissions();
});

route('GET', '/api/admin/import-permissions', async ({ user }) => {
  requireAdmin(user);
  return (await get('IMPORT', 'LAST'))?.report || null;
});

// What the last reading of the page and issue restrictions found, per source (the monitor reads them every run).
route('GET', '/api/admin/restrictions', async ({ user }) => {
  requireAdmin(user);
  return Promise.all((await listSources()).map(async (s) => ({ id: s.id, name: s.name, title: s.title, type: s.type, ...(await aclStatus(s.id)) })));
});

route('GET', '/api/usage', async ({ user, event }) => {
  requireAdmin(user);
  const month = new URLSearchParams(event.rawQueryString || '').get('month') || undefined;
  return monthUsage(month);
});

// ---------- library and KB quality

route('GET', '/api/library', async ({ user }) => library(user, await grantedSourceIds(user, await listSources())));

route('POST', '/api/library', async ({ user, event }) => {
  const b = body(event);
  const nb = await notebook(user, b.notebookId);
  return share({ user, nbId: nb.id, messageId: String(b.message || '') });
});

route('PATCH', '/api/library/:id', async ({ user, params, event }) => {
  requireAdmin(user);
  return verify(params.id, user, Boolean(body(event).verified));
});

route('DELETE', '/api/library/:id', async ({ user, params }) => remove(params.id, user, isAdmin(user)));

route('GET', '/api/admin/insights', async ({ user, event }) => {
  requireAdmin(user);
  return insights(new URLSearchParams(event.rawQueryString || '').get('month') || undefined);
});

route('PATCH', '/api/admin/insights/:month/:id', async ({ user, params, event }) => {
  requireAdmin(user);
  return resolve(params.month, params.id, Boolean(body(event).resolved));
});

const TEXT_MAX = 200_000;
const MISSING = 'This document is not in the knowledge base (not synced yet, or it failed to index)';

async function readable(user, id) {
  const all = await listSources();
  const s = all.find((x) => x.id === id);
  if (!s) throw new HttpError(404, 'No such source');
  if (!(await grantedSourceIds(user, all)).includes(id)) throw new HttpError(403, 'You may not read this source');
  return s;
}

function friendly(error) {
  const claude = claudeError(error);
  if (claude) return claude;
  if (/ThrottlingException|TooManyRequests/i.test(error.name)) return 'Hệ thống đang bận (Bedrock throttling), thử lại sau vài giây.';
  if (/AccessDenied/i.test(error.name)) return 'AWS từ chối truy cập (AccessDenied). Kiểm tra quyền của Lambda hoặc spend limit của project.';
  return error.message || 'Có lỗi không mong muốn';
}

// ---------- entry

export const handler = awslambda.streamifyResponse(async (event, stream) => {
  const method = event.requestContext?.http?.method || 'GET';
  const path = event.rawPath || '/';
  try {
    if (config.originSecret && event.headers?.['x-origin-verify'] !== config.originSecret) throw new HttpError(403, 'Use the site address');
    if (path === '/mcp') {
      if (method !== 'POST') return json(stream, 405, { error: 'Use POST' });
      const user = await caller(event.headers?.authorization);
      requireActive(user);
      const result = await handleMcp(rawBody(event), {
        user,
        allowed: async () => grantedSourceIds(user, await listSources()),
        scope: (args) => scope(user, args),
        notebooks: async () => (await query(`USER#${user.email}`, 'NB#')).map(notebookView),
        syncOf: latestSync,
      });
      return json(stream, result.status, result.body);
    }
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re);
      if (!m) continue;
      const user = await caller(event.headers?.authorization);
      if (r.auth === 'active') requireActive(user);
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      const result = await r.fn({ user, event, params, stream });
      if (result !== undefined) json(stream, 200, result);
      return;
    }
    json(stream, 404, { error: 'Not found' });
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(method, path, error.name, error.message);
    json(stream, error.status || 500, { error: error instanceof HttpError ? error.message : friendly(error) });
  }
});
