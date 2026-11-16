// Documents the app sends to a knowledge base itself, into a data source of the CUSTOM type: a Jira source
// (jira.mjs) and the text documents of a Confluence source's attachments (confluence-text.mjs). A connector data
// source (Confluence) refuses IngestKnowledgeBaseDocuments, so those are the only places the app can add to.
//
// textDocument is the step before the knowledge base: for a file its parser reads badly (prepare.mjs), the file's
// text as Markdown, stored in the data bucket and sent as a second document next to the file. Its identifier is
// the file's link plus "#text", and kb.mjs shows its passages under the file's own link.

import { BedrockAgentClient, IngestKnowledgeBaseDocumentsCommand, DeleteKnowledgeBaseDocumentsCommand, ListKnowledgeBaseDocumentsCommand } from '@aws-sdk/client-bedrock-agent';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.mjs';
import { prepare, reader, kindOf } from './prepare.mjs';

const agent = new BedrockAgentClient({ region: config.region, maxAttempts: 6 });
const s3 = new S3Client({ region: config.region });
const BATCH = 10; // documents per IngestKnowledgeBaseDocuments or DeleteKnowledgeBaseDocuments call
const MAX_PREPARE_BYTES = 50 << 20; // a file with many pictures in it is large

// The version of the preparation step. A sync keeps it with each file it has prepared; raising it makes every
// sync prepare its files again.
export const PREP = 2;
export const TEXT_MARK = '#text';
// A file gets at most this many tries at its text document; after that it stays as the knowledge base reads it.
export const PREP_TRIES = 3;

export const attributes = (values) => ({
  type: 'IN_LINE_ATTRIBUTE',
  inlineAttributes: Object.entries(values).filter(([, v]) => v).map(([key, v]) => ({ key, value: { type: 'STRING', stringValue: String(v).slice(0, 2000) } })),
});

export const inlineDocument = (id, text, metadata) => ({
  content: { dataSourceType: 'CUSTOM', custom: { customDocumentIdentifier: { id }, sourceType: 'IN_LINE', inlineContent: { type: 'TEXT', textContent: { data: text } } } },
  metadata: attributes(metadata),
});

export const fileDocument = (id, s3Key, metadata) => ({
  content: { dataSourceType: 'CUSTOM', custom: { customDocumentIdentifier: { id }, sourceType: 'S3_LOCATION', s3Location: { uri: `s3://${config.dataBucket}/${s3Key}` } } },
  metadata: attributes(metadata),
});

export async function upload(key, body, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: config.dataBucket, Key: key, Body: body, ContentType: contentType }));
}

// source: { kbId, id } of a custom data source.
export async function ingest(source, documents) {
  for (let i = 0; i < documents.length; i += BATCH) {
    await agent.send(new IngestKnowledgeBaseDocumentsCommand({ knowledgeBaseId: source.kbId, dataSourceId: source.id, documents: documents.slice(i, i + BATCH) }));
  }
}

// Removes documents from the knowledge base and their files from the bucket. docs: [{ docId, s3Key?, skipped? }].
export async function remove(source, docs) {
  const ids = docs.filter((d) => d.docId && !d.skipped).map((d) => ({ dataSourceType: 'CUSTOM', custom: { id: d.docId } }));
  for (let i = 0; i < ids.length; i += BATCH) {
    await agent.send(new DeleteKnowledgeBaseDocumentsCommand({ knowledgeBaseId: source.kbId, dataSourceId: source.id, documentIdentifiers: ids.slice(i, i + BATCH) }));
  }
  for (const d of docs) if (d.s3Key) await s3.send(new DeleteObjectCommand({ Bucket: config.dataBucket, Key: d.s3Key }));
}

// How the knowledge base's document states read in the app: INDEXED, PENDING or FAILED.
// TEXT_INDEXED is what a managed knowledge base reports for a file whose text is indexed (seen on xlsx; not in the SDK's list).
const STATE = { INDEXED: 'INDEXED', TEXT_INDEXED: 'INDEXED', PARTIALLY_INDEXED: 'INDEXED', METADATA_PARTIALLY_INDEXED: 'INDEXED', METADATA_UPDATE_FAILED: 'INDEXED',
  PENDING: 'PENDING', STARTING: 'PENDING', IN_PROGRESS: 'PENDING', FAILED: 'FAILED', IGNORED: 'FAILED', NOT_FOUND: 'FAILED' };

// The state the knowledge base reports for every document of a custom data source: (docId) => { status, kbStatus, reason? }.
export async function states(source) {
  const reported = new Map();
  let nextToken;
  do {
    const page = await agent.send(new ListKnowledgeBaseDocumentsCommand({ knowledgeBaseId: source.kbId, dataSourceId: source.id, maxResults: 100, nextToken }));
    for (const d of page.documentDetails || []) reported.set(d.identifier?.custom?.id, d);
    nextToken = page.nextToken;
  } while (nextToken);
  return (docId) => {
    const d = reported.get(docId);
    const kbStatus = d?.status || 'NOT_FOUND';
    const status = STATE[kbStatus] || 'PENDING';
    return { status, kbStatus, reason: d?.statusReason || (status === 'FAILED' ? `The knowledge base reports ${kbStatus}` : kbStatus === 'PARTIALLY_INDEXED' ? 'Only partly indexed' : undefined) };
  };
}

let read;
// The text document that goes next to a file: { docId, s3Key, how, document } with document ready for ingest, or
// null when the file needs none (a format the knowledge base reads well, a file too large to prepare here).
// link: the file's own link; s3Key: where the Markdown goes; metadata: the file's own attributes.
export async function textDocument({ name, bytes, link, s3Key, metadata }) {
  if (!kindOf(name) || bytes.length > MAX_PREPARE_BYTES) return null;
  if (read === undefined) read = config.readModel ? reader(config.readModel, config.region) : null;
  const made = await prepare(name, bytes, { read: read || undefined });
  if (!made) return null;
  await upload(s3Key, made.text, 'text/markdown; charset=utf-8');
  const docId = `${link}${TEXT_MARK}`;
  return { docId, s3Key, how: made.how, document: fileDocument(docId, s3Key, { ...metadata, kind: 'attachment-text', url: link }) };
}

// One try at a file's text document, kept in the sync's own record of the file (entry). Returns the new entry
// and, when a document was made, the document to ingest. A failure is counted, not thrown: the file itself is
// in the knowledge base either way.
export async function withText(entry, file, warnings) {
  if (entry.skipped || entry.prep === PREP) return { entry };
  try {
    const made = await textDocument({ ...file, bytes: await file.bytes() });
    const { prepTries, textError, ...rest } = entry;
    return { entry: { ...rest, prep: PREP, ...(made ? { text: { docId: made.docId, s3Key: made.s3Key, how: made.how } } : {}) }, document: made?.document };
  } catch (error) {
    const tries = (entry.prepTries || 0) + 1;
    const reason = `${error.name || 'Error'}: ${String(error.message).replace(/\d{12}/g, '<acct>').slice(0, 160)}`;
    warnings.push(`${file.name}: no text document, try ${tries} of ${PREP_TRIES} (${reason})`);
    return { entry: { ...entry, prepTries: tries, ...(tries >= PREP_TRIES ? { prep: PREP, textError: reason } : {}) }, pending: tries < PREP_TRIES };
  }
}
