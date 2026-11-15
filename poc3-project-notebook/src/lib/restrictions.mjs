// Reads, in Confluence and Jira themselves, which documents of a source are restricted to some people, and writes
// the index acl.mjs checks. The monitor runs it for every source on each run, after the syncs.
//
// Confluence: a page or blog post can carry a read restriction (users and groups). Someone reads a page only when
// they pass its restriction and the restriction of every page above it, so a page's readers are the intersection
// of those. A file attached to a page follows the page.
// Jira: an issue on a security level is read by the level's members (users, groups, the issue's reporter or
// assignee). A member of another kind (a project role, an application role, a custom field) cannot be turned
// into people here, so it gives nobody access. A file attached to an issue follows the issue.
//
// People are email addresses, as everywhere in this app. An account that hides its email cannot be matched to a
// user of the app: it is counted (unresolved) and gets no access. Nothing is written to Confluence or Jira.

import { credentials, confluence, confluencePages } from './connectors.mjs';
import { accountEmail } from './permissions.mjs';
import { sourceDetail } from './kb.mjs';
import { settings, jira, search } from './jira.mjs';
import { aclRefs } from './acl.mjs';
import { get, put, now } from './store.mjs';

// One index item must stay under DynamoDB's 400 KB.
const MAX_BYTES = 380_000;

class Sets {
  list = [];
  byKey = new Map();
  docs = {};
  add(refs, emails) {
    const sorted = [...emails].sort();
    const key = sorted.join(',');
    if (!this.byKey.has(key)) {
      this.byKey.set(key, this.list.length);
      this.list.push(sorted);
    }
    for (const ref of refs) this.docs[ref] = this.byKey.get(key);
  }
}

const intersect = (a, b) => new Set([...a].filter((x) => b.has(x)));

async function confluenceIndex(spaces, out, counts) {
  const { hostUrl } = (await credentials()).confluence;
  const groups = new Map();
  const groupEmails = async (id) => {
    if (!groups.has(id)) {
      const members = await confluencePages(`/wiki/rest/api/group/${encodeURIComponent(id)}/membersByGroupId?limit=200`).catch(() => null);
      const emails = new Set();
      if (!members) counts.unresolved++;
      for (const m of (members || []).filter((x) => x.accountType === 'atlassian')) {
        const email = m.email ? m.email.toLowerCase() : await accountEmail(m.accountId);
        if (email) emails.add(email);
        else counts.unresolved++;
      }
      groups.set(id, emails);
    }
    return groups.get(id);
  };
  for (const key of spaces) {
    const cql = encodeURIComponent(`space="${key}" and type in (page, blogpost)`);
    const expand = 'restrictions.read.restrictions.user,restrictions.read.restrictions.group,ancestors';
    const pages = await confluencePages(`/wiki/rest/api/content/search?cql=${cql}&limit=100&expand=${expand}`);
    // Each page's own restriction: null when it has none.
    const own = new Map();
    for (const page of pages) {
      const r = page.restrictions?.read?.restrictions || {};
      let users = r.user?.results || [];
      let groupList = r.group?.results || [];
      // The search gives the first 200 of each; a longer list is read from the page.
      if ((r.user?.size || 0) >= 200 || (r.group?.size || 0) >= 200) {
        const full = await confluence(`/wiki/rest/api/content/${page.id}/restriction/byOperation/read?expand=restrictions.user,restrictions.group`).catch(() => null);
        users = full?.restrictions?.user?.results || users;
        groupList = full?.restrictions?.group?.results || groupList;
      }
      if (!users.length && !groupList.length) {
        own.set(page.id, null);
        continue;
      }
      const emails = new Set();
      for (const u of users) {
        const email = u.email ? u.email.toLowerCase() : u.accountId ? await accountEmail(u.accountId) : null;
        if (email) emails.add(email);
        else counts.unresolved++;
      }
      for (const g of groupList) for (const e of await groupEmails(g.id)) emails.add(e);
      own.set(page.id, emails);
    }
    for (const page of pages) {
      let readers = own.get(page.id);
      for (const a of page.ancestors || []) {
        const above = own.get(a.id);
        if (above) readers = readers ? intersect(readers, above) : above;
      }
      if (!readers) continue;
      counts.restricted++;
      out.add(aclRefs(page.id, `${hostUrl}/wiki${page._links?.webui || ''}`), readers);
    }
  }
}

async function jiraIndex(source, out, counts) {
  const cfg = await settings(source);
  const emailOf = new Map();
  const userEmail = async (accountId) => {
    if (!accountId) return null;
    if (!emailOf.has(accountId)) {
      const user = await jira(cfg, `/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`).catch(() => null);
      emailOf.set(accountId, user?.emailAddress ? user.emailAddress.toLowerCase() : null);
    }
    return emailOf.get(accountId);
  };
  const groups = new Map();
  const groupEmails = async (holder) => {
    const key = holder.value || holder.parameter;
    if (!groups.has(key)) {
      const emails = new Set();
      let startAt = 0;
      let page;
      do {
        const by = holder.value ? `groupId=${encodeURIComponent(holder.value)}` : `groupname=${encodeURIComponent(holder.parameter)}`;
        page = await jira(cfg, `/rest/api/3/group/member?${by}&startAt=${startAt}&maxResults=50`).catch(() => null);
        if (!page) {
          counts.unresolved++;
          break;
        }
        for (const m of page.values || []) {
          const email = m.emailAddress ? m.emailAddress.toLowerCase() : await userEmail(m.accountId);
          if (email) emails.add(email);
          else if (m.accountType === 'atlassian') counts.unresolved++;
        }
        startAt += (page.values || []).length;
      } while (page && !page.isLast && page.values?.length);
      groups.set(key, emails);
    }
    return groups.get(key);
  };
  // The members of a level: the people it names, and whether it lets the reporter or the assignee in.
  const levels = new Map();
  const level = async (id) => {
    if (!levels.has(id)) {
      const members = { emails: new Set(), reporter: false, assignee: false };
      let startAt = 0;
      let page;
      do {
        page = await jira(cfg, `/rest/api/3/issuesecurityschemes/level/member?levelId=${encodeURIComponent(id)}&startAt=${startAt}&maxResults=50`);
        for (const m of page.values || []) {
          const h = m.holder || {};
          if (h.type === 'reporter') members.reporter = true;
          else if (h.type === 'assignee') members.assignee = true;
          else if (h.type === 'user') {
            const email = await userEmail(h.parameter || h.value);
            if (email) members.emails.add(email);
            else counts.unresolved++;
          } else if (h.type === 'group') for (const e of await groupEmails(h)) members.emails.add(e);
          else counts.unresolved++; // a role, the project lead, a custom field: nobody gets in through it
        }
        startAt += (page.values || []).length;
      } while (!page.isLast && page.values?.length);
      levels.set(id, members);
    }
    return levels.get(id);
  };
  const jql = `project in (${cfg.projects.map((p) => `"${p}"`).join(', ')}) AND level is not EMPTY`;
  for await (const issue of search(cfg, jql, { fields: 'security,reporter,assignee' })) {
    const f = issue.fields || {};
    if (!f.security?.id) continue;
    const members = await level(f.security.id);
    const readers = new Set(members.emails);
    for (const [on, person] of [[members.reporter, f.reporter], [members.assignee, f.assignee]]) {
      if (!on || !person) continue;
      const email = person.emailAddress ? person.emailAddress.toLowerCase() : await userEmail(person.accountId);
      if (email) readers.add(email);
      else counts.unresolved++;
    }
    counts.restricted++;
    const state = await get(`JIRA#${source.id}`, `ISSUE#${issue.key}`);
    out.add([issue.key.toUpperCase(), ...Object.keys(state?.attachments || {}).map((id) => `a${id}`)], readers);
  }
}

// Builds and saves the index of one source. Returns { restricted, unresolved, note? }. When the source system
// cannot be read the previous index stays, with a note; a source that never had one stays closed.
export async function buildAcl(source) {
  const pk = `ACL#${source.id}`;
  const out = new Sets();
  const counts = { restricted: 0, unresolved: 0 };
  try {
    if (source.type === 'CONFLUENCE') await confluenceIndex((await sourceDetail(source)).spaces, out, counts);
    else if (source.type === 'JIRA') await jiraIndex(source, out, counts);
    const item = { pk, sk: 'INDEX', at: now(), sets: out.list, docs: out.docs, ...counts };
    if (Buffer.byteLength(JSON.stringify(item)) > MAX_BYTES) throw new Error(`the index of ${counts.restricted} restricted documents is too large to store`);
    await put(item);
    return counts;
  } catch (error) {
    const note = `${now()} ${String(error.message).slice(0, 200)}`;
    const previous = await get(pk, 'INDEX');
    if (previous) await put({ ...previous, note });
    return { restricted: previous?.restricted ?? null, unresolved: previous?.unresolved ?? null, note };
  }
}
