// The poc3-kb* knowledge bases: their data sources (the unit a user is granted), search, documents and syncs.
// A knowledge base holds at most 5 data sources, so a search runs on every knowledge base that holds a source
// the user may read, filtered to those sources, and the passages are merged by score.

import { BedrockAgentClient, ListKnowledgeBasesCommand, ListDataSourcesCommand, GetDataSourceCommand, ListIngestionJobsCommand,
  StartIngestionJobCommand, ListKnowledgeBaseDocumentsCommand } from '@aws-sdk/client-bedrock-agent';
import { BedrockAgentRuntimeClient, RetrieveCommand, AgenticRetrieveStreamCommand, GetDocumentContentCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { createHash } from 'node:crypto';
import { config } from './config.mjs';
import { record } from './usage.mjs';
import { get, put } from './store.mjs';
import { catalog } from './connectors.mjs';
import { jiraDocuments, jiraDetail } from './jira.mjs';
import { confluenceTexts } from './confluence-text.mjs';
import { TEXT_MARK } from './custom.mjs';
import { guard } from './acl.mjs';

const agent = new BedrockAgentClient({ region: config.region, maxAttempts: 4 });
const runtime = new BedrockAgentRuntimeClient({ region: config.region, maxAttempts: 4 });
const PREFIX = config.kbPrefix;

let cached = { at: 0, sources: [] };

// Every data source: { id, kbId, kbName, name, title, type, textId? }. Cached for five minutes.
// A data source named "<source>-text" is not a source of its own: it holds the text documents the monitor makes
// for the attachments of <source> (confluence-text.mjs). It is left out of the list and its id is the source's
// textId; a search of the source searches both, and its passages come back as the source's.
export async function listSources({ fresh = false } = {}) {
  if (!fresh && Date.now() - cached.at < 300_000) return cached.sources;
  const kbs = [];
  let nextToken;
  do {
    const page = await agent.send(new ListKnowledgeBasesCommand({ maxResults: 100, nextToken }));
    kbs.push(...page.knowledgeBaseSummaries.filter((k) => k.name === PREFIX || k.name.startsWith(`${PREFIX}-`)));
    nextToken = page.nextToken;
  } while (nextToken);
  let sources = [];
  for (const kb of kbs.sort((a, b) => a.name.localeCompare(b.name))) {
    const { dataSourceSummaries = [] } = await agent.send(new ListDataSourcesCommand({ knowledgeBaseId: kb.knowledgeBaseId, maxResults: 100 }));
    for (const ds of dataSourceSummaries) {
      if (ds.status === 'DELETING') continue;
      sources.push({ id: ds.dataSourceId, kbId: kb.knowledgeBaseId, kbName: kb.name, name: ds.name, title: ds.description || ds.name,
        type: /^confluence/i.test(ds.name) ? 'CONFLUENCE' : /^sp-/i.test(ds.name) ? 'SHAREPOINT' : /^jira/i.test(ds.name) ? 'JIRA' : 'S3', status: ds.status });
    }
  }
  for (const text of sources.filter((s) => s.name.endsWith('-text'))) {
    const parent = sources.find((s) => s.kbId === text.kbId && `${s.name}-text` === text.name);
    if (!parent) continue;
    parent.textId = text.id;
    sources = sources.filter((s) => s !== text);
  }
  cached = { at: Date.now(), sources };
  return sources;
}

export async function sourceDetail(source) {
  // A Jira source is a custom data source the monitor fills (jira.mjs): its projects are in the app's secret.
  if (source.type === 'JIRA') return { spaces: [], folders: [], ...(await jiraDetail(source)), schedule: 'every 15 minutes' };
  const { dataSource } = await agent.send(new GetDataSourceCommand({ knowledgeBaseId: source.kbId, dataSourceId: source.id }));
  // connectorParameters is a document type: the SDK returns it as a JSON string.
  let params = dataSource.dataSourceConfiguration?.managedKnowledgeBaseConnectorConfiguration?.connectorParameters || {};
  if (typeof params === 'string') params = JSON.parse(params);
  return {
    spaces: params.filterConfiguration?.inclusionSpaceKeys || [],
    // Folder paths below the site's document library, without the site address.
    folders: (params.filterConfiguration?.inclusionItemPaths || []).map((p) => p.replace(/^.*?\/Shared Documents\//, '')),
    schedule: dataSource.dataSourceConfiguration?.managedKnowledgeBaseConnectorConfiguration?.syncSchedule ? 'daily' : 'manual',
  };
}

export async function jobs(source, max = 10) {
  const { ingestionJobSummaries = [] } = await agent.send(new ListIngestionJobsCommand({ knowledgeBaseId: source.kbId, dataSourceId: source.id,
    sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' }, maxResults: max }));
  return ingestionJobSummaries.map(jobView);
}

export function jobView(j) {
  const s = j.statistics || {};
  return {
    jobId: j.ingestionJobId, status: j.status, startedAt: j.startedAt?.toISOString?.() || j.startedAt, updatedAt: j.updatedAt?.toISOString?.() || j.updatedAt,
    scanned: s.numberOfDocumentsScanned || 0,
    indexed: (s.numberOfNewDocumentsIndexed || 0) + (s.numberOfModifiedDocumentsIndexed || 0),
    deleted: s.numberOfDocumentsDeleted || 0, failed: s.numberOfDocumentsFailed || 0,
    metadataIndexed: s.numberOfMetadataDocumentsModified || 0,
  };
}

export async function startSync(source) {
  const { ingestionJob } = await agent.send(new StartIngestionJobCommand({ knowledgeBaseId: source.kbId, dataSourceId: source.id }));
  return jobView(ingestionJob);
}

// The documents of one source. ListKnowledgeBaseDocuments only serves S3 and custom data sources, so the list
// comes from Confluence or SharePoint directly (connectors.mjs): { uri, title, kind, modified, docId? }.
// A Jira source lists what its sync sent, with each document's state in the knowledge base (jira.mjs).
export async function documents(source) {
  if (source.type === 'JIRA') return jiraDocuments(source);
  if (source.type === 'S3') {
    const out = [];
    let nextToken;
    do {
      const page = await agent.send(new ListKnowledgeBaseDocumentsCommand({ knowledgeBaseId: source.kbId, dataSourceId: source.id, maxResults: 100, nextToken }));
      for (const d of page.documentDetails || []) {
        const uri = d.identifier?.s3?.uri || '';
        out.push({ uri, title: titleOf(uri), kind: uri.split('.').pop(), status: d.status, reason: d.statusReason, modified: d.updatedAt?.toISOString?.() });
      }
      nextToken = page.nextToken;
    } while (nextToken);
    return out;
  }
  return withTextDocuments(source, await catalog(source, await sourceDetail(source)));
}

// An attachment with a text document next to it says so: how it was made, and its state in the knowledge base
// now. list: the documents of a Confluence source, fresh or as the monitor saved them.
export async function withTextDocuments(source, list) {
  if (!source.textId) return list;
  const texts = await confluenceTexts(source).catch(() => new Map());
  return list.map(({ text, textStatus, ...d }) => (texts.has(d.uri) ? { ...d, text: texts.get(d.uri).how, textStatus: texts.get(d.uri).status } : d));
}

// The knowledge base's own id of a document (what GetDocumentContent takes). Retrieve does not return it, agentic
// retrieval does: one agentic call filtered to the document's link finds it. Cached.
export async function documentId(source, uri) {
  const key = `DOCID#${createHash('sha256').update(`${source.id}|${uri}`).digest('hex').slice(0, 40)}`;
  const cachedId = await get(key, 'ID');
  if (cachedId) return cachedId.docId;
  const response = await runtime.send(new AgenticRetrieveStreamCommand({
    messages: [{ role: 'user', content: { text: `summary of ${titleOf(uri)}` } }],
    retrievers: [{ description: 'one document', configuration: { knowledgeBase: { knowledgeBaseId: source.kbId, retrievalOverrides: {
      filter: { andAll: [{ equals: { key: '_data_source_id', value: source.id } }, { equals: { key: '_source_uri', value: uri } }] }, maxNumberOfResults: 1 } } } }],
    agenticRetrieveConfiguration: { foundationModelType: 'MANAGED', rerankingModelType: 'MANAGED', maxAgentIteration: 1 },
    generateResponse: false,
  }));
  await record({ agentic: 1 });
  let docId = null;
  for await (const event of response.stream) docId = event.result?.results?.[0]?.metadata?._document_id || docId;
  if (docId) await put({ pk: key, sk: 'ID', docId });
  return docId;
}

export { docKey } from './acl.mjs';

export function titleOf(uri = '') {
  const file = uri.match(/[?&]file=([^&]+)/)?.[1];
  if (file) return decodeURIComponent(file);
  // A Confluence attachment: ...viewpageattachments.action?pageId=1&preview=/1/att2/name.pptx
  const preview = uri.match(/[?&]preview=([^&#]+)/)?.[1];
  if (preview) return decodeURIComponent(preview).split('/').pop().replace(/\+/g, ' ');
  const last = decodeURIComponent(uri.split(/[?#]/)[0].split('/').filter(Boolean).pop() || uri);
  return last.replace(/\+/g, ' ');
}

// Data source ids to sources, a source's text data source included.
const index = (sources) => new Map(sources.flatMap((s) => [[s.id, s], ...(s.textId ? [[s.textId, s]] : [])]));
// The data sources to search for a list of sources.
const withTexts = (ids, byId) => ids.flatMap((id) => [id, ...(byId.get(id)?.textId ? [byId.get(id).textId] : [])]);

const locationOf = (loc = {}) =>
  loc.sharePointLocation?.url || loc.confluenceLocation?.url || loc.s3Location?.uri || loc.webLocation?.url || loc.salesforceLocation?.url || loc.customDocumentLocation?.id || '';

// One passage, the same shape whatever the connector.
function passage(r, byId) {
  const m = r.metadata || {};
  // A custom (Jira) document carries its link as its identifier and in the url attribute the sync sets; a file
  // sent from the bucket may come back with its S3 address, so a web link wins when there is one.
  const links = [m._source_uri, locationOf(r.location), m.url].filter(Boolean);
  const link = links.find((x) => /^https?:/i.test(x)) || links[0] || '';
  // A file's text document (custom.mjs) is cited as the file: its identifier is the file's link plus a mark.
  const ofText = link.endsWith(TEXT_MARK);
  const uri = ofText ? link.slice(0, -TEXT_MARK.length) : link;
  const source = byId.get(m._data_source_id);
  return {
    text: r.content?.text || '', score: r.score || 0, uri, title: m._document_title || m.title || titleOf(uri),
    sourceId: source?.id || m._data_source_id, sourceTitle: source?.title, sourceType: source?.type || r.location?.type,
    page: m._excerpt_page_number, section: m._table_section_title, fileType: m._file_type, updatedAt: m._last_updated_at,
    // The knowledge base's id of a document only serves in the data source the document is in.
    space: m._cf_space_name || m.space, docId: source && source.id !== m._data_source_id ? undefined : m._document_id,
  };
}

// The Retrieve filter for a list of data sources. "in" takes them all; one source is a plain equals.
const sourceFilter = (ids) => (ids.length === 1 ? { equals: { key: '_data_source_id', value: ids[0] } } : { in: { key: '_data_source_id', value: ids } });

// More results than asked for, when some may be dropped as restricted (Retrieve gives at most 20 here).
const WIDER = 6;

// Searches the allowed sources. allowed: the data source ids the user may read (already narrowed to a notebook).
// userId is the reader's email: a passage of a document restricted to other people is dropped (acl.mjs), and a
// search without a reader gets no restricted document at all.
export async function search(query, allowed, { n = config.passages, userId } = {}) {
  const all = await listSources();
  const byId = index(all);
  const groups = new Map();
  for (const id of allowed) {
    const s = byId.get(id);
    if (s?.id === id) groups.set(s.kbId, [...(groups.get(s.kbId) || []), id]);
  }
  if (!groups.size) return [];
  const acl = await guard(userId, allowed);
  const per = await Promise.all([...groups].map(async ([kbId, ids]) => {
    const response = await runtime.send(new RetrieveCommand({
      knowledgeBaseId: kbId,
      retrievalQuery: { text: query.slice(0, 9000) },
      retrievalConfiguration: { managedSearchConfiguration: { numberOfResults: acl.any ? Math.min(n + WIDER, Math.max(n, 20)) : n, filter: sourceFilter(withTexts(ids, byId)) } },
      ...(userId ? { userContext: { userId } } : {}),
    }));
    return response.retrievalResults || [];
  }));
  await record({ retrieve: groups.size });
  const allowedSet = new Set(allowed);
  // The filter does the work; this second check keeps a passage from an unexpected source out of the answer.
  return per.flat().map((r) => passage(r, byId)).filter((p) => allowedSet.has(p.sourceId) && !acl.hides(p.sourceId, p.uri))
    .sort((a, b) => b.score - a.score).slice(0, n);
}

// Agentic retrieval: the managed agent splits the question into sub-queries and searches several times.
// onStep gets each sub-query. Returns the passages it kept.
export async function deepSearch(messages, allowed, { onStep, n = 10, userId } = {}) {
  const all = await listSources();
  const byId = index(all);
  const groups = new Map();
  for (const id of allowed) {
    const s = byId.get(id);
    if (s?.id === id) groups.set(s.kbId, { kb: s.kbName, ids: [...(groups.get(s.kbId)?.ids || []), id] });
  }
  if (!groups.size) return [];
  const acl = await guard(userId, allowed);
  const response = await runtime.send(new AgenticRetrieveStreamCommand({
    messages: messages.map((m) => ({ role: m.role, content: { text: m.content.slice(0, 9000) } })),
    retrievers: [...groups].map(([kbId, g]) => ({
      description: `Project documents from ${g.ids.map((id) => byId.get(id).title).join('; ')}`.slice(0, 500),
      configuration: { knowledgeBase: { knowledgeBaseId: kbId, retrievalOverrides: { filter: sourceFilter(withTexts(g.ids, byId)), maxNumberOfResults: acl.any ? n + WIDER : n } } },
    })),
    agenticRetrieveConfiguration: { foundationModelType: 'MANAGED', rerankingModelType: 'MANAGED', maxAgentIteration: 3 },
    generateResponse: false,
    ...(userId ? { userContext: { userId } } : {}),
  }));
  await record({ agentic: 1 });
  let results = [];
  const seen = new Set();
  const step = (text) => {
    if (text && !seen.has(text)) {
      seen.add(text);
      onStep?.(text);
    }
  };
  for await (const event of response.stream) {
    const a = event.traceEvent?.attributes;
    if (a?.status === 'IN_PROGRESS') step(`${a.step}: ${(a.message || '').replace(/^Starting speculative retrieval for query: /, '')}`.slice(0, 300));
    for (const action of a?.actions || []) step(action.retrieve?.inputQuery?.text);
    if (event.result?.results) results = event.result.results;
  }
  const allowedSet = new Set(allowed);
  // Agentic results come ranked, without a score.
  return results.map((r, i) => passage({ ...r, score: r.score ?? 1 - i / 100 }, byId)).filter((p) => allowedSet.has(p.sourceId) && !acl.hides(p.sourceId, p.uri)).slice(0, n);
}

// Whether this reader may open a document of a source they are granted, and the documents of a list they may.
export async function mayRead(userId, source, uri) {
  return !(await guard(userId, [source.id])).hides(source.id, uri);
}
export async function visible(userId, source, list) {
  const acl = await guard(userId, [source.id]);
  return list.filter((d) => !acl.hides(source.id, d.uri)).map((d) => (acl.restricted(source.id, d.uri) ? { ...d, restricted: true } : d));
}

// The document's text as the knowledge base extracted it, for the source guide. Returns a short-lived download link.
export async function documentContent(source, docId, format = 'EXTRACTED') {
  const r = await runtime.send(new GetDocumentContentCommand({ knowledgeBaseId: source.kbId, dataSourceId: source.id, documentId: docId, outputFormat: format }));
  return { mimeType: r.mimeType, url: r.presignedUrl, length: r.documentContentLength };
}

// The formats that get a text document (prepare.mjs kindOf).
const PREPARED = /\.(pptx|docx|xlsx|doc|pdf|png|jpe?g|gif|webp)$/i;

// One element of a parsed document: its text, or a table's rows as lines of cells.
const elementText = (x) => (x.tableRows?.length ? x.tableRows.map((row) => row.join(' | ')).join('\n') : (x.text || '').trim());

// The extracted content of a document, from its link or its knowledge base id: { text } for a text file
// (Markdown, text, CSV), { elements } for a parsed file (Office, PDF, a page), each element a text or a table's
// rows. A file with a text document next to it (custom.mjs) is read from that document: it is the exact text,
// where the knowledge base's own reading of a pptx, docx, doc or pdf loses words.
export async function documentParts(source, { uri, docId }) {
  let from = source;
  let id;
  if (uri && PREPARED.test(titleOf(uri))) {
    from = source.textId ? { ...source, id: source.textId } : source;
    id = await documentId(from, `${uri}${TEXT_MARK}`).catch(() => null);
    if (!id) from = source;
  }
  id ||= docId || (await documentId(source, uri));
  if (!id) throw new Error('This document is not in the knowledge base (not synced yet, or it failed to index)');
  const content = await documentContent(from, id);
  const raw = await (await fetch(content.url)).text();
  if (!/json/.test(content.mimeType || '')) return { text: raw };
  const doc = JSON.parse(raw);
  const plainText = doc.plainTextDocumentContent;
  if (plainText) return { text: typeof plainText === 'string' ? plainText : plainText.text || '' };
  return { elements: doc.nonPlainTextDocumentContent || [] };
}

// The same as one text.
export async function documentText(source, ref) {
  const parts = await documentParts(source, ref);
  return parts.elements ? parts.elements.map(elementText).filter(Boolean).join('\n\n') : parts.text;
}
