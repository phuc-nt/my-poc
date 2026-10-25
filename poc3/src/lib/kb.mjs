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

const agent = new BedrockAgentClient({ region: config.region, maxAttempts: 4 });
const runtime = new BedrockAgentRuntimeClient({ region: config.region, maxAttempts: 4 });
const PREFIX = config.kbPrefix;

let cached = { at: 0, sources: [] };

// Every data source: { id, kbId, kbName, name, title, type }. Cached for five minutes.
export async function listSources({ fresh = false } = {}) {
  if (!fresh && Date.now() - cached.at < 300_000) return cached.sources;
  const kbs = [];
  let nextToken;
  do {
    const page = await agent.send(new ListKnowledgeBasesCommand({ maxResults: 100, nextToken }));
    kbs.push(...page.knowledgeBaseSummaries.filter((k) => k.name === PREFIX || k.name.startsWith(`${PREFIX}-`)));
    nextToken = page.nextToken;
  } while (nextToken);
  const sources = [];
  for (const kb of kbs.sort((a, b) => a.name.localeCompare(b.name))) {
    const { dataSourceSummaries = [] } = await agent.send(new ListDataSourcesCommand({ knowledgeBaseId: kb.knowledgeBaseId, maxResults: 100 }));
    for (const ds of dataSourceSummaries) {
      if (ds.status === 'DELETING') continue;
      sources.push({ id: ds.dataSourceId, kbId: kb.knowledgeBaseId, kbName: kb.name, name: ds.name, title: ds.description || ds.name,
        type: /^confluence/i.test(ds.name) ? 'CONFLUENCE' : /^sp-/i.test(ds.name) ? 'SHAREPOINT' : 'S3', status: ds.status });
    }
  }
  cached = { at: Date.now(), sources };
  return sources;
}

export async function sourceDetail(source) {
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
export async function documents(source) {
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
  return catalog(source, await sourceDetail(source));
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

// One key per document whatever form its link takes: SharePoint gives Office files a Doc.aspx link whose action
// differs between Graph and the connector, so those match on the file's GUID.
export function docKey(uri = '') {
  const guid = uri.match(/[?&]sourcedoc=(?:%7B|\{)?([0-9a-fA-F-]{36})/)?.[1];
  if (guid) return guid.toLowerCase();
  try {
    return decodeURI(uri).replace(/\/+$/, '').toLowerCase();
  } catch {
    return uri.toLowerCase();
  }
}

export function titleOf(uri = '') {
  const file = uri.match(/[?&]file=([^&]+)/)?.[1];
  if (file) return decodeURIComponent(file);
  const last = decodeURIComponent(uri.split(/[?#]/)[0].split('/').filter(Boolean).pop() || uri);
  return last.replace(/\+/g, ' ');
}

const locationOf = (loc = {}) =>
  loc.sharePointLocation?.url || loc.confluenceLocation?.url || loc.s3Location?.uri || loc.webLocation?.url || loc.salesforceLocation?.url || loc.customDocumentLocation?.id || '';

// One passage, the same shape whatever the connector.
function passage(r, byId) {
  const m = r.metadata || {};
  const uri = m._source_uri || locationOf(r.location);
  const source = byId.get(m._data_source_id);
  return {
    text: r.content?.text || '', score: r.score || 0, uri, title: m._document_title || titleOf(uri),
    sourceId: m._data_source_id, sourceTitle: source?.title, sourceType: source?.type || r.location?.type,
    page: m._excerpt_page_number, section: m._table_section_title, fileType: m._file_type, updatedAt: m._last_updated_at,
    space: m._cf_space_name, docId: m._document_id,
  };
}

// The Retrieve filter for a list of data sources. "in" takes them all; one source is a plain equals.
const sourceFilter = (ids) => (ids.length === 1 ? { equals: { key: '_data_source_id', value: ids[0] } } : { in: { key: '_data_source_id', value: ids } });

// Searches the allowed sources. allowed: the data source ids the user may read (already narrowed to a notebook).
export async function search(query, allowed, { n = config.passages, userId } = {}) {
  const all = await listSources();
  const byId = new Map(all.map((s) => [s.id, s]));
  const groups = new Map();
  for (const id of allowed) {
    const s = byId.get(id);
    if (s) groups.set(s.kbId, [...(groups.get(s.kbId) || []), id]);
  }
  if (!groups.size) return [];
  const per = await Promise.all([...groups].map(async ([kbId, ids]) => {
    const response = await runtime.send(new RetrieveCommand({
      knowledgeBaseId: kbId,
      retrievalQuery: { text: query.slice(0, 9000) },
      retrievalConfiguration: { managedSearchConfiguration: { numberOfResults: n, filter: sourceFilter(ids) } },
      ...(userId ? { userContext: { userId } } : {}),
    }));
    return response.retrievalResults || [];
  }));
  await record({ retrieve: groups.size });
  const allowedSet = new Set(allowed);
  // The filter does the work; this second check keeps a passage from an unexpected source out of the answer.
  return per.flat().map((r) => passage(r, byId)).filter((p) => allowedSet.has(p.sourceId))
    .sort((a, b) => b.score - a.score).slice(0, n);
}

// Agentic retrieval: the managed agent splits the question into sub-queries and searches several times.
// onStep gets each sub-query. Returns the passages it kept.
export async function deepSearch(messages, allowed, { onStep, n = 10, userId } = {}) {
  const all = await listSources();
  const byId = new Map(all.map((s) => [s.id, s]));
  const groups = new Map();
  for (const id of allowed) {
    const s = byId.get(id);
    if (s) groups.set(s.kbId, { kb: s.kbName, ids: [...(groups.get(s.kbId)?.ids || []), id] });
  }
  if (!groups.size) return [];
  const response = await runtime.send(new AgenticRetrieveStreamCommand({
    messages: messages.map((m) => ({ role: m.role, content: { text: m.content.slice(0, 9000) } })),
    retrievers: [...groups].map(([kbId, g]) => ({
      description: `Project documents from ${g.ids.map((id) => byId.get(id).title).join('; ')}`.slice(0, 500),
      configuration: { knowledgeBase: { knowledgeBaseId: kbId, retrievalOverrides: { filter: sourceFilter(g.ids), maxNumberOfResults: n } } },
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
  return results.map((r, i) => passage({ ...r, score: r.score ?? 1 - i / 100 }, byId)).filter((p) => allowedSet.has(p.sourceId)).slice(0, n);
}

// The document's text as the knowledge base extracted it, for the source guide. Returns a short-lived download link.
export async function documentContent(source, docId, format = 'EXTRACTED') {
  const r = await runtime.send(new GetDocumentContentCommand({ knowledgeBaseId: source.kbId, dataSourceId: source.id, documentId: docId, outputFormat: format }));
  return { mimeType: r.mimeType, url: r.presignedUrl, length: r.documentContentLength };
}

// The extracted text of a document, from its link or its knowledge base id.
export async function documentText(source, { uri, docId }) {
  const id = docId || (await documentId(source, uri));
  if (!id) throw new Error('This document is not in the knowledge base (not synced yet, or it failed to index)');
  const content = await documentContent(source, id);
  const raw = await (await fetch(content.url)).text();
  if (!/json/.test(content.mimeType || '')) return raw;
  const doc = JSON.parse(raw);
  return doc.plainTextDocumentContent?.text || (doc.nonPlainTextDocumentContent || []).map((x) => x.text).join('\n\n');
}
