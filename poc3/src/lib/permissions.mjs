// Reads who may read each source in the source system itself (Confluence space permissions, SharePoint folder
// permissions), as email addresses. The import turns them into grants: a registered user gets the grants at once,
// and an address that has not registered yet keeps them (IMPORT#<email>) until that person signs up.
//
// What it cannot resolve (a Confluence account that hides its email, a group the app may not expand, an
// everyone-style claim) is counted and reported, never guessed.

import { config } from './config.mjs';
import { confluence, confluencePages, sharepointSite, graph } from './connectors.mjs';
import { sharepointRest } from './graph.mjs';
import { listSources, sourceDetail } from './kb.mjs';
import { get, put, query, del, now } from './store.mjs';

const emailCache = new Map();
async function accountEmail(accountId) {
  if (!emailCache.has(accountId)) {
    const user = await confluence(`/wiki/rest/api/user?accountId=${encodeURIComponent(accountId)}`).catch(() => null);
    emailCache.set(accountId, user?.email ? user.email.toLowerCase() : null);
  }
  return emailCache.get(accountId);
}

// The readers of the Confluence spaces of one source.
async function confluenceReaders(spaces, report) {
  const emails = new Set();
  for (const key of spaces) {
    const [space] = await confluencePages(`/wiki/api/v2/spaces?keys=${encodeURIComponent(key)}`);
    if (!space) {
      report.notes.push(`space ${key}: not found`);
      continue;
    }
    const permissions = await confluencePages(`/wiki/api/v2/spaces/${space.id}/permissions?limit=250`);
    for (const p of permissions.filter((x) => x.operation?.key === 'read' && x.operation?.targetType === 'space')) {
      if (p.principal?.type === 'user') {
        const email = await accountEmail(p.principal.id);
        if (email) emails.add(email);
        else report.hidden++;
      } else if (p.principal?.type === 'group') {
        const members = await confluencePages(`/wiki/rest/api/group/${p.principal.id}/membersByGroupId?limit=200`).catch(() => null);
        if (!members) {
          report.groups++;
          continue;
        }
        for (const m of members.filter((x) => x.accountType === 'atlassian')) {
          const email = m.email ? m.email.toLowerCase() : await accountEmail(m.accountId);
          if (email) emails.add(email);
          else report.hidden++;
        }
      }
    }
  }
  return emails;
}

// The readers of the SharePoint folders of one source: users granted on the folder, members of the Microsoft 365
// groups granted on it, and members of the SharePoint site groups (Owners, Members, Visitors) it inherits, which
// only the SharePoint REST API lists.
async function sharepointReaders(folders, report) {
  const { creds, site } = await sharepointSite();
  const emails = new Set();
  const add = (email) => email && emails.add(email.toLowerCase());
  // Graph needs GroupMember.Read.All; with Sites.Read.All alone, SharePoint's directory session still lists the
  // direct members and owners of a Microsoft 365 group.
  const groupMembers = async (groupId, owners = false) => {
    const viaGraph = await graph(creds, `/groups/${groupId}/${owners ? 'owners' : 'transitiveMembers'}?$select=mail,userPrincipalName&$top=999`).catch(() => null);
    const members = viaGraph?.value
      || (await sharepointRest(creds, `/_api/SP.Directory.DirectorySession/Group('${groupId}')/${owners ? 'owners' : 'members'}`).catch(() => null))?.value
        ?.map((m) => ({ mail: m.mail, userPrincipalName: m.principalName }));
    if (!members) report.groups++;
    for (const m of members || []) add(m.mail || m.userPrincipalName);
  };
  for (const folder of folders) {
    const { value = [] } = await graph(creds, `/sites/${site}/drive/root:/${encodeURI(folder)}:/permissions`);
    for (const p of value) {
      const identities = [p.grantedToV2, ...(p.grantedToIdentitiesV2 || [])].filter(Boolean);
      for (const id of identities) {
        const email = id.user?.email || id.user?.userPrincipalName;
        if (email) add(email);
        else if (id.group?.id) await groupMembers(id.group.id);
        else if (id.siteGroup?.id) {
          const users = await sharepointRest(creds, `/_api/web/sitegroups/getbyid(${Number(id.siteGroup.id)})/users`).catch(() => null);
          if (!users) {
            report.siteGroups++;
            continue;
          }
          for (const u of users.value) {
            const m365 = u.LoginName?.match(/federateddirectoryclaimprovider\|([0-9a-f-]{36})(_o)?$/i);
            if (u.PrincipalType === 1) add(u.Email || u.UserPrincipalName);
            else if (m365) await groupMembers(m365[1], !!m365[2]);
            else if (/spo-grid-all-users|c:0\(\.s\|true/.test(u.LoginName || '')) report.everyone++;
            else report.groups++;
          }
        }
      }
    }
  }
  return emails;
}

// Reads the source systems and writes the grants. Returns a report the admin page shows.
export async function importPermissions() {
  const sources = await listSources({ fresh: true });
  const report = { at: now(), sources: [], hidden: 0, groups: 0, siteGroups: 0, everyone: 0, notes: [], granted: 0, waiting: 0 };
  const readers = new Map(); // email -> Set of source ids
  for (const s of sources) {
    const detail = await sourceDetail(s);
    let emails = new Set();
    try {
      if (s.type === 'CONFLUENCE') emails = await confluenceReaders(detail.spaces, report);
      else if (s.type === 'SHAREPOINT') emails = await sharepointReaders(detail.folders, report);
    } catch (error) {
      report.notes.push(`${s.name}: ${error.message}`);
    }
    report.sources.push({ id: s.id, name: s.name, readers: emails.size });
    for (const e of emails) readers.set(e, new Set([...(readers.get(e) || []), s.id]));
  }
  for (const [email, ids] of readers) {
    const user = await get(`USER#${email}`, 'PROFILE');
    if (user) {
      await applyImported(user, [...ids]);
      report.granted++;
    } else {
      await put({ pk: `IMPORT#${email}`, sk: 'GRANTS', sources: [...ids], at: report.at });
      report.waiting++;
    }
  }
  await put({ pk: 'IMPORT', sk: 'LAST', report });
  return report;
}

// Replaces a user's imported grants with the current ones. Grants an admin gave by hand stay.
export async function applyImported(user, ids) {
  const current = await query(`USER#${user.email}`, 'GRANT#');
  for (const g of current) if (g.origin === 'import' && !ids.includes(g.sk.slice(6))) await del(g.pk, g.sk);
  for (const id of ids) {
    const existing = current.find((g) => g.sk === `GRANT#${id}`);
    if (!existing) await put({ pk: `USER#${user.email}`, sk: `GRANT#${id}`, origin: 'import', at: now() });
  }
  // The source system vouches for this person: no admin approval needed.
  if (user.status === 'pending' && ids.length && config.autoApproveImported) {
    await put({ ...user, status: 'active', approvedBy: 'import', gsi1sk: `active#${user.email}` });
  }
}

// At sign-up: grants imported before this person registered.
export async function claimImported(user) {
  const waiting = await get(`IMPORT#${user.email}`, 'GRANTS');
  if (!waiting) return user;
  await applyImported(user, waiting.sources);
  await del(`IMPORT#${user.email}`, 'GRANTS');
  return (await get(`USER#${user.email}`, 'PROFILE')) || user;
}
