// Jira Cloud as a source. Bedrock Managed Knowledge Bases have no Jira connector, so a Jira source is a data
// source of the CUSTOM type that this module feeds itself: each issue becomes one text document (fields,
// description, comments) and each file attached to an issue becomes one document of its own, uploaded to the
// data bucket and parsed by the knowledge base like any other file. A document's identifier is its Jira link,
// so a passage links straight back to the issue or the file. A file the knowledge base's parser reads badly
// (pptx, docx, doc, pdf, a scan, a picture) also gets a text document next to it (custom.mjs, prepare.mjs).
//
// The monitor calls syncJira every run. A run reads the issues changed since the last one (once a day every
// issue, which is also how deleted issues are noticed), and sends only what differs from the state it keeps per
// issue in DynamoDB: JIRA#<source id> / ISSUE#<key> = { updated, textHash, attachments by id, prep }.

import { createHash } from 'node:crypto';
import { credentials } from './connectors.mjs';
import { get, put, del, query, now } from './store.mjs';
import { PREP, inlineDocument, fileDocument, upload, ingest, remove, states, withText } from './custom.mjs';

const MAX_BYTES = 50 << 20;
const MAX_TEXT = 200_000;
const FULL_EVERY_HOURS = 24;
const FIELDS = 'summary,description,issuetype,status,priority,assignee,reporter,labels,components,fixVersions,parent,duedate,created,updated,attachment,comment,project';

const pkOf = (source) => `JIRA#${source.id}`;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const day = (iso) => String(iso || '').slice(0, 10);

// The Jira site, its account and this source's projects, from the app's secret (infra/kb.mjs writes them).
export async function settings(source) {
  const { jira: j } = await credentials();
  const projects = j?.sources?.[source.name]?.projects || [];
  if (!j?.hostUrl || !projects.length) throw new Error(`No Jira settings for ${source.name} in the app's secret`);
  return { host: j.hostUrl, authorization: `Basic ${Buffer.from(`${j.username}:${j.password}`).toString('base64')}`, projects };
}

// detail: Jira's own words for a refused request (a JQL error) go into the error, for a caller that shows them.
export async function jira(cfg, path, { bytes = false, detail = false } = {}) {
  const response = await fetch(`${cfg.host}${path}`, { headers: { authorization: cfg.authorization, accept: bytes ? '*/*' : 'application/json' } });
  if (!response.ok && detail && response.status === 400) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error([...(body.errorMessages || []), ...Object.values(body.errors || {})].join(' ').slice(0, 600) || 'Jira refused the query'), { jql: true });
  }
  if (!response.ok) throw new Error(`Jira ${response.status} on ${path.split('?')[0].replace(/\/(issue|content)\/[^/]+/g, '/$1/<id>')}`);
  return bytes ? Buffer.from(await response.arrayBuffer()) : response.json();
}

export async function* search(cfg, jql, { fields = FIELDS, detail = false } = {}) {
  let token;
  do {
    const page = await jira(cfg, `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=${fields}${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`, { detail });
    yield* page.issues || [];
    token = page.nextPageToken;
  } while (token);
}

// Atlassian Document Format to plain text: paragraphs, lists, tables, mentions, links.
export function adfText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const inner = (sep = '') => (node.content || []).map(adfText).join(sep);
  switch (node.type) {
    case 'text': return node.text || '';
    case 'hardBreak': return '\n';
    case 'mention': return node.attrs?.text || '';
    case 'emoji': return node.attrs?.text || node.attrs?.shortName || '';
    case 'inlineCard': case 'blockCard': case 'embedCard': return node.attrs?.url || '';
    case 'status': return `[${node.attrs?.text || ''}]`;
    case 'date': return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : '';
    case 'media': case 'mediaInline': return '';
    case 'mediaSingle': case 'mediaGroup': return '';
    case 'heading': return `${'#'.repeat((node.attrs?.level || 1) + 2)} ${inner()}\n\n`;
    case 'paragraph': return `${inner()}\n\n`;
    case 'codeBlock': return `\`\`\`\n${inner()}\n\`\`\`\n\n`;
    case 'listItem': return `- ${inner().trim()}\n`;
    case 'bulletList': case 'orderedList': return `${inner()}\n`;
    case 'tableCell': case 'tableHeader': return inner().trim().replace(/\n+/g, ' ');
    case 'tableRow': return `| ${inner(' | ')} |\n`;
    case 'table': return `${inner()}\n`;
    case 'rule': return '\n';
    default: return inner();
  }
}

async function commentsOf(cfg, issue) {
  const first = issue.fields.comment || {};
  const out = [...(first.comments || [])];
  while (out.length < (first.total || 0)) {
    const page = await jira(cfg, `/rest/api/3/issue/${issue.key}/comment?startAt=${out.length}&maxResults=100`);
    if (!page.comments?.length) break;
    out.push(...page.comments);
  }
  return out;
}

// One issue as the text the knowledge base indexes. Field labels are in English; the content keeps its language.
export function issueText(issue, comments, url) {
  const f = issue.fields;
  const names = (list) => (list || []).map((x) => x.name || x).join(', ');
  const lines = [
    `# ${issue.key}: ${f.summary}`,
    '',
    `Jira issue ${issue.key} in project ${f.project?.name || ''} (${f.project?.key || issue.key.split('-')[0]})`,
    `Type: ${f.issuetype?.name || ''} | Status: ${f.status?.name || ''}${f.priority?.name ? ` | Priority: ${f.priority.name}` : ''}`,
    `Reporter: ${f.reporter?.displayName || '-'} | Assignee: ${f.assignee?.displayName || '-'}`,
    `Created: ${day(f.created)} | Updated: ${day(f.updated)}${f.duedate ? ` | Due: ${f.duedate}` : ''}`,
    f.parent ? `Parent: ${f.parent.key} ${f.parent.fields?.summary || ''}` : null,
    f.labels?.length ? `Labels: ${f.labels.join(', ')}` : null,
    f.components?.length ? `Components: ${names(f.components)}` : null,
    f.fixVersions?.length ? `Fix versions: ${names(f.fixVersions)}` : null,
    `Link: ${url}`,
    '',
    '## Description',
    '',
    adfText(f.description).trim() || '(none)',
  ];
  if (f.attachment?.length) lines.push('', '## Attachments', '', ...f.attachment.map((a) => `- ${a.filename} (added ${day(a.created)} by ${a.author?.displayName || '-'})`));
  if (comments.length) {
    lines.push('', '## Comments');
    for (const c of comments) lines.push('', `### ${c.author?.displayName || '-'}, ${day(c.created)}`, '', adfText(c.body).trim());
  }
  return lines.filter((x) => x !== null).join('\n').slice(0, MAX_TEXT);
}

// An attachment in the sync's record, and the text document next to it when it has one.
const documentsOf = (attachments) => Object.values(attachments || {}).flatMap((a) => [a, a.text].filter(Boolean));

async function syncIssue(source, cfg, issue, before, stats, warnings) {
  const f = issue.fields;
  const docId = `${cfg.host}/browse/${issue.key}`;
  const title = `${issue.key} ${f.summary}`;
  const text = issueText(issue, await commentsOf(cfg, issue), docId);
  const item = { pk: pkOf(source), sk: `ISSUE#${issue.key}`, key: issue.key, title, docId, updated: f.updated, textHash: sha(text), attachments: {} };
  const common = { issue_key: issue.key, project: f.project?.key, issue_type: f.issuetype?.name };
  const batch = [];
  if (before?.textHash !== item.textHash) batch.push(inlineDocument(docId, text, { ...common, kind: 'issue', url: docId, title }));
  const current = new Map((f.attachment || []).map((a) => [String(a.id), a]));
  let prepared = true;
  for (const [id, a] of current) {
    const link = `${cfg.host}/secure/attachment/${id}/${encodeURIComponent(a.filename)}`;
    const metadata = { ...common, url: link, title: `${a.filename} (${title})`, file_name: a.filename, issue_url: docId };
    let bytes;
    const content = async () => (bytes ||= await jira(cfg, `/rest/api/3/attachment/content/${id}`, { bytes: true }));
    // An attachment never changes under its id: a new version of a file is a new attachment.
    let entry = before?.attachments?.[id];
    if (!entry && a.size > MAX_BYTES) entry = { name: a.filename, size: a.size, docId: link, skipped: `larger than ${MAX_BYTES >> 20} MB, not sent to the knowledge base` };
    if (!entry) {
      const s3Key = `jira/${source.name}/${issue.key}/${id}/${a.filename}`;
      await upload(s3Key, await content(), a.mimeType);
      batch.push(fileDocument(link, s3Key, { ...metadata, kind: 'attachment' }));
      entry = { name: a.filename, size: a.size, docId: link, s3Key };
    }
    // The text document next to the file. An attachment sent before this step existed gets its own now.
    const made = await withText(entry, { name: a.filename, bytes: content, link, s3Key: `${entry.s3Key}.text.md`, metadata }, warnings);
    if (made.document) batch.push(made.document);
    if (made.pending) prepared = false;
    item.attachments[id] = made.entry;
  }
  if (prepared) item.prep = PREP;
  const gone = Object.entries(before?.attachments || {}).filter(([id]) => !current.has(id)).flatMap(([, a]) => [a, a.text].filter(Boolean));
  await ingest(source, batch);
  await remove(source, gone);
  await put(item);
  stats.indexed += batch.length;
  stats.deleted += gone.filter((a) => !a.skipped).length;
}

// One sync run. Returns a job in the shape of the knowledge base's own ingestion jobs (kb.mjs jobView), plus
// mode ('full' or 'changes'), partial (the time ran out; the next run goes on), errors, and warnings (files whose
// text document could not be made; the files themselves are in).
export async function syncJira(source, { deadline = Date.now() + 480_000, full = false } = {}) {
  const startedAt = now();
  const cfg = await settings(source);
  const pk = pkOf(source);
  const state = (await get(pk, 'STATE')) || {};
  const all = full || !state.scanAt || !state.fullAt || Date.now() - Date.parse(state.fullAt) > FULL_EVERY_HOURS * 3600_000;
  const known = new Map((await query(pk, 'ISSUE#')).map((x) => [x.key, x]));
  const stats = { scanned: 0, indexed: 0, deleted: 0, failed: 0 };
  const errors = [];
  const warnings = [];
  const seen = new Set();
  let complete = true;
  // A relative time needs no time zone: the minutes since the last run, plus a margin.
  const since = all ? '' : ` AND updated >= "-${Math.ceil((Date.now() - Date.parse(state.scanAt)) / 60_000) + 10}m"`;
  for await (const issue of search(cfg, `project in (${cfg.projects.map((p) => `"${p}"`).join(', ')})${since} ORDER BY updated ASC`)) {
    seen.add(issue.key);
    stats.scanned++;
    const before = known.get(issue.key);
    // Unchanged, and its attachments went through the current preparation step.
    if (before && before.updated === issue.fields.updated && before.prep === PREP) continue;
    if (Date.now() > deadline) {
      complete = false;
      break;
    }
    try {
      await syncIssue(source, cfg, issue, before, stats, warnings);
    } catch (error) {
      stats.failed++;
      errors.push(`${issue.key}: ${error.name || ''} ${error.message}`.slice(0, 300));
    }
  }
  // An issue the full scan no longer returns was deleted, or moved out of the source's projects.
  if (all && complete) {
    for (const [key, item] of known) {
      if (seen.has(key)) continue;
      const docs = [{ docId: item.docId }, ...documentsOf(item.attachments)];
      await remove(source, docs);
      await del(pk, item.sk);
      stats.deleted += docs.filter((d) => !d.skipped).length;
    }
  }
  if (complete && !errors.length) await put({ pk, sk: 'STATE', scanAt: startedAt, fullAt: all ? startedAt : state.fullAt });
  return { jobId: `jira-${startedAt}`, status: errors.length && !stats.indexed ? 'FAILED' : 'COMPLETE', startedAt, updatedAt: now(), ...stats, metadataIndexed: 0,
    mode: all ? 'full' : 'changes', partial: !complete, errors: errors.slice(0, 20), warnings: warnings.slice(0, 20) };
}

// The documents of a Jira source: every issue and every attachment the sync sent, with the state the knowledge
// base reports for it. { uri, title, kind, modified, size?, issue, status, kbStatus, reason?, text?, textStatus? }
// text says how the attachment's text document was made; while that document is being indexed the attachment
// reads PENDING.
export async function jiraDocuments(source) {
  const stateOf = await states(source);
  const out = [];
  for (const item of await query(pkOf(source), 'ISSUE#')) {
    out.push({ uri: item.docId, title: item.title, kind: 'issue', modified: item.updated, issue: item.key, ...stateOf(item.docId) });
    for (const a of Object.values(item.attachments || {})) {
      const state = a.skipped ? { status: 'FAILED', kbStatus: 'SKIPPED', reason: a.skipped } : stateOf(a.docId);
      const text = a.text ? stateOf(a.text.docId) : null;
      out.push({ uri: a.docId, title: a.name, kind: a.name.includes('.') ? a.name.split('.').pop().toLowerCase() : 'file', size: a.size, modified: item.updated, issue: item.key, parent: item.title,
        ...state, ...(text ? { text: a.text.how, textStatus: text.status, ...(state.status === 'INDEXED' && text.status === 'PENDING' ? { status: 'PENDING' } : {}) } : {}),
        ...(a.textError ? { textError: a.textError } : {}) });
    }
  }
  return out;
}

// ---------- a live query, for exact counts and complete lists
//
// The knowledge base answers with the passages closest to a question, never with "all of them": how many issues
// are open, who holds the most, every issue of a version. Those are asked of Jira itself, in JQL, when the
// question is asked. The query only reads, only inside the source's projects, and an issue on a security level
// the reader is not a member of is dropped (acl.mjs).

const QUERY_FIELDS = 'summary,status,issuetype,priority,assignee,reporter,labels,components,fixVersions,project,updated,created,duedate,parent,resolution';
const QUERY_MAX = 2000;
const names = (list) => (list?.length ? list.map((x) => x.name || x) : ['(none)']);
export const COUNT_BY = {
  status: (f) => [f.status?.name || '(none)'],
  assignee: (f) => [f.assignee?.displayName || '(unassigned)'],
  reporter: (f) => [f.reporter?.displayName || '(none)'],
  type: (f) => [f.issuetype?.name || '(none)'],
  priority: (f) => [f.priority?.name || '(none)'],
  project: (f) => [f.project?.key || '(none)'],
  label: (f) => names(f.labels),
  component: (f) => names(f.components),
  fixVersion: (f) => names(f.fixVersions),
};

// Splits a JQL into its condition and its ORDER BY, and refuses one whose quotes or parentheses do not close:
// the condition is put inside parentheses next to the project filter, and must not be able to leave them.
export function splitJql(jql) {
  const s = String(jql || '').trim();
  let quote = '';
  let depth = 0;
  let orderAt = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') {
      if (--depth < 0) throw Object.assign(new Error('The JQL closes a parenthesis it did not open.'), { jql: true });
    } else if (depth === 0 && orderAt < 0 && /^order\s+by\b/i.test(s.slice(i)) && (i === 0 || /\s/.test(s[i - 1]))) orderAt = i;
  }
  if (quote || depth) throw Object.assign(new Error('The JQL has a quote or a parenthesis that does not close.'), { jql: true });
  return { where: (orderAt < 0 ? s : s.slice(0, orderAt)).trim(), order: orderAt < 0 ? '' : s.slice(orderAt).trim() };
}

const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

// Runs one query on one Jira source. hides(uri): the reader may not see that issue; restricted(uri): the issue
// is on a security level. Returns { title, uri, text, total, closed }: text is what the model reads (the exact
// total, the counts per group when asked, and the first rows), uri opens the same query in Jira.
export async function queryJira(source, { jql, countBy, limit, hides = () => false, restricted = () => false }) {
  const cfg = await settings(source);
  const { where, order } = splitJql(jql);
  if (countBy && !COUNT_BY[countBy]) throw Object.assign(new Error(`count_by is one of: ${Object.keys(COUNT_BY).join(', ')}`), { jql: true });
  const scope = `project in (${cfg.projects.map((p) => `"${p}"`).join(', ')})`;
  const full = `${scope}${where ? ` AND (${where})` : ''} ${order || 'ORDER BY updated DESC'}`;
  const allowedProjects = new Set(cfg.projects.map((p) => p.toUpperCase()));
  const rows = [];
  let capped = false;
  let closed = false;
  for await (const issue of search(cfg, full, { fields: QUERY_FIELDS, detail: true })) {
    const f = issue.fields || {};
    const link = `${cfg.host}/browse/${issue.key}`;
    if (!allowedProjects.has(String(f.project?.key || issue.key.split('-')[0]).toUpperCase()) || hides(link)) continue;
    if (restricted(link)) closed = true;
    if (rows.length >= QUERY_MAX) {
      capped = true;
      break;
    }
    rows.push({ key: issue.key, f });
  }
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const lines = [`${capped ? `More than ${QUERY_MAX}` : rows.length} issues match in ${source.title || source.name}, read from Jira now.`, `JQL: ${full}`];
  if (capped) lines.push(`Only the first ${QUERY_MAX} were read: the counts below cover those. Narrow the query for exact numbers.`);
  if (countBy) {
    const groups = new Map();
    for (const r of rows) for (const g of COUNT_BY[countBy](r.f)) groups.set(g, (groups.get(g) || 0) + 1);
    lines.push('', `Count by ${countBy}:`, `| ${countBy} | issues |`, '| --- | --- |', ...[...groups].sort((a, b) => b[1] - a[1]).map(([g, n]) => `| ${cell(g)} | ${n} |`));
  }
  if (rows.length) {
    lines.push('', rows.length > max ? `The first ${max} of ${rows.length} (raise limit, 200 at most, or narrow the query for the rest):` : 'All of them:',
      '| key | type | status | priority | assignee | updated | due | fix version | summary |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows.slice(0, max).map(({ key, f }) => `| ${[key, f.issuetype?.name, f.status?.name, f.priority?.name, f.assignee?.displayName || '-', day(f.updated), f.duedate || '-',
        (f.fixVersions || []).map((v) => v.name).join(', ') || '-', f.summary].map(cell).join(' | ')} |`));
  }
  return { title: `Jira: ${where || 'all issues'}`.slice(0, 160), uri: `${cfg.host}/issues/?jql=${encodeURIComponent(full)}`, text: lines.join('\n'), total: rows.length, closed };
}

export async function jiraDetail(source) {
  const { jira: j } = await credentials();
  return { projects: j?.sources?.[source.name]?.projects || [] };
}
