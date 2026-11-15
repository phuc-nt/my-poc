// Who may read one document, below the grant of its source. A grant opens a Confluence space or a Jira project;
// inside it Confluence can restrict a page (and with it the pages below and their attachments) to some people, and
// Jira can put an issue on a security level. The monitor reads those restrictions (restrictions.mjs) and keeps, per
// source, an index of the restricted documents only:
//
//   ACL#<source id> / INDEX = { at, sets: [[email, ...]], docs: { <ref>: <index in sets> }, restricted, unresolved }
//
// Every reading path asks guard() before it shows a document or a passage of it: search, agentic retrieval, the
// document text, the lists, the library, the Jira query. A source without an index hides everything (the monitor
// writes one, empty or not, for every source on each run), and an admin is checked like anyone else: being an admin
// of this app does not make someone a reader of a restricted page.

import { createHash } from 'node:crypto';
import { get } from './store.mjs';

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

const hashRef = (uri) => `u:${createHash('sha256').update(docKey(uri)).digest('base64url').slice(0, 16)}`;

// What a link is restricted by. A Confluence attachment's link names its page, so it follows the page; a link
// changes when a page is renamed, its id does not, so the id is the key wherever the link carries one.
//   Jira issue: its key. Jira attachment: a<attachment id>. Confluence page, blog post, attachment: the page id.
export function aclRef(uri = '') {
  let u = String(uri);
  try {
    u = decodeURIComponent(u);
  } catch { /* keeps the raw link */ }
  const issue = u.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/);
  if (issue) return issue[1].toUpperCase();
  const file = u.match(/\/secure\/attachment\/(\d+)\//);
  if (file) return `a${file[1]}`;
  const page = u.match(/[?&]preview=\/(\d+)\//) || u.match(/[?&]pageId=(\d+)/) || u.match(/\/pages\/(\d+)(?:[/?#]|$)/) || u.match(/\/blog\/\d+\/\d+\/\d+\/(\d+)(?:[/?#]|$)/);
  if (page) return page[1];
  return hashRef(uri);
}

// The refs a restricted document is filed under: its id, and its link when the link does not carry the id (a
// space's home page is /spaces/KEY/overview).
export const aclRefs = (id, uri) => [...new Set([id && String(id), uri && aclRef(uri)].filter(Boolean))];

const cache = new Map(); // source id -> { at, index }
const FRESH_MS = 60_000;

async function indexOf(sourceId) {
  const hit = cache.get(sourceId);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.index;
  const index = await get(`ACL#${sourceId}`, 'INDEX');
  cache.set(sourceId, { at: Date.now(), index });
  return index;
}

// The check for one person over some sources.
//   hides(sourceId, uri): this person may not see the document.
//   restricted(sourceId, uri): the document is restricted to some people (this person may be one of them).
//   any: at least one of the sources has a restricted document.
export async function guard(email, sourceIds) {
  const who = String(email || '').toLowerCase();
  const indexes = new Map(await Promise.all([...new Set(sourceIds)].map(async (id) => [id, await indexOf(id)])));
  const setOf = (sourceId, uri) => {
    const index = indexes.get(sourceId);
    if (!index) return null;
    const at = index.docs?.[aclRef(uri)];
    return at === undefined ? undefined : index.sets[at] || [];
  };
  return {
    any: [...indexes.values()].some((index) => !index || index.restricted > 0),
    restricted: (sourceId, uri) => Boolean(setOf(sourceId, uri)),
    hides(sourceId, uri) {
      const readers = setOf(sourceId, uri);
      if (readers === null) return true; // no index for this source: closed
      if (readers === undefined) return false; // not restricted
      return !who || !readers.includes(who);
    },
  };
}

export async function aclStatus(sourceId) {
  const index = await get(`ACL#${sourceId}`, 'INDEX');
  return index ? { at: index.at, restricted: index.restricted || 0, unresolved: index.unresolved || 0, note: index.note } : null;
}
