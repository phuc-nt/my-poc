// The text documents of a Confluence source's attachments. The Confluence connector sends every attached file
// to the knowledge base as it is, and takes no document from anyone else, so the step before the knowledge base
// (prepare.mjs) cannot sit inside it. Instead a Confluence source can have a second data source next to it, of
// the CUSTOM type and named "<source>-text" (infra/sources.json: "text": true), which this module fills: for
// every attachment the parser reads badly (pptx, docx, doc, pdf, a scan, a picture), the file's text as Markdown.
// The app treats the two data sources as one source (kb.mjs), and a text document carries its file's link, so
// its passages cite the file. Nothing is written to Confluence.
//
// The monitor calls syncConfluenceText every run. It lists the spaces' attachments and prepares only the ones
// that are new or have a new version, from the state it keeps in DynamoDB:
// CFTEXT#<text data source id> / ATT#<attachment id> = { version, docId, s3Key, text, prep }.

import { credentials, confluencePages, confluenceBytes } from './connectors.mjs';
import { PREP, ingest, remove, withText, states } from './custom.mjs';
import { kindOf } from './prepare.mjs';
import { put, del, query, now } from './store.mjs';

const pkOf = (source) => `CFTEXT#${source.textId}`;
const target = (source) => ({ kbId: source.kbId, id: source.textId });

// source: a Confluence source with textId (kb.mjs listSources); spaces: its space keys.
// Returns { at, scanned, indexed, deleted, failed, partial, warnings }: attachments that get a text document,
// documents sent, documents removed, attachments that could not be read from Confluence.
export async function syncConfluenceText(source, spaces, { deadline = Date.now() + 240_000 } = {}) {
  const pk = pkOf(source);
  const { confluence: c } = await credentials();
  const known = new Map((await query(pk, 'ATT#')).map((x) => [x.id, x]));
  const stats = { scanned: 0, indexed: 0, deleted: 0, failed: 0 };
  const warnings = [];
  const seen = new Set();
  let complete = true;
  for (const key of spaces) {
    const cql = encodeURIComponent(`space="${key}" and type=attachment`);
    for (const item of await confluencePages(`/wiki/rest/api/content/search?cql=${cql}&limit=100&expand=version,container`)) {
      seen.add(item.id);
      if (!kindOf(item.title)) continue;
      stats.scanned++;
      const version = item.version?.number || 1;
      const before = known.get(item.id);
      if (before && before.version === version && before.prep === PREP) continue;
      if (Date.now() > deadline) {
        complete = false;
        break;
      }
      // The link the connector gives the same file, so the passages of both documents cite one address.
      const link = `${c.hostUrl}/wiki${item._links?.webui || ''}`;
      // A new version of the file starts its tries again.
      const entry = before?.version === version ? before
        : { pk, sk: `ATT#${item.id}`, id: item.id, name: item.title, version, ...(before?.text ? { text: before.text } : {}) };
      const file = { name: item.title, link, s3Key: `text/${source.name}/${item.id}/${item.title}.text.md`,
        bytes: () => confluenceBytes(`/wiki${item._links.download}`),
        metadata: { title: item.title, file_name: item.title, space: key, page_title: item.container?.title } };
      try {
        const made = await withText(entry, file, warnings);
        if (made.document) {
          await ingest(target(source), [made.document]);
          stats.indexed++;
        } else if (!made.pending && before?.text && before.version !== version) {
          // No text could be made of the new version: the old version's document must not speak for it.
          await remove(target(source), [before.text]);
          delete made.entry.text;
          stats.deleted++;
        }
        await put({ ...made.entry, at: now() });
      } catch (error) {
        stats.failed++;
        warnings.push(`${item.title}: ${error.name || ''} ${String(error.message).slice(0, 160)}`);
      }
    }
  }
  // An attachment the spaces no longer hold: its text document goes too.
  if (complete) {
    for (const [id, entry] of known) {
      if (seen.has(id)) continue;
      if (entry.text) {
        await remove(target(source), [entry.text]);
        stats.deleted++;
      }
      await del(pk, entry.sk);
    }
  }
  return { at: now(), ...stats, partial: !complete, warnings: warnings.slice(0, 20) };
}

// The text documents of a Confluence source, by the link of their file: Map(link => { how, status }).
export async function confluenceTexts(source) {
  const stateOf = await states(target(source));
  const out = new Map();
  for (const entry of await query(pkOf(source), 'ATT#')) {
    if (entry.text) out.set(entry.text.docId.replace(/#text$/, ''), { how: entry.text.how, status: stateOf(entry.text.docId).status });
  }
  return out;
}
