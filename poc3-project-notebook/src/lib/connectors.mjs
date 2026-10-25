// The source systems themselves: Confluence Cloud (REST, the connector's own account) and SharePoint (Microsoft
// Graph, the connector's own Entra app). The knowledge base cannot list the documents of a connector data source,
// so the document lists come from here, and so do the permissions the import reads.

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { config } from './config.mjs';
import { graph, siteId, listFolder } from './graph.mjs';

let secret;
export async function credentials() {
  if (secret) return secret;
  const sm = new SecretsManagerClient({ region: config.region });
  secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: config.graphSecret }))).SecretString);
  return secret;
}

export async function confluence(path) {
  const { confluence: c } = await credentials();
  const url = path.startsWith('http') ? path : `${c.hostUrl}${path}`;
  const response = await fetch(url, { headers: { authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`, accept: 'application/json' } });
  if (!response.ok) throw new Error(`Confluence ${response.status} on ${path.split('?')[0].replace(/\/(spaces|group|pages)\/[^/]+/g, '/$1/<id>')}`);
  return response.json();
}

// Every result of a paged Confluence call (v1 and v2 both give _links.next).
export async function confluencePages(path) {
  const out = [];
  let next = path;
  while (next) {
    const page = await confluence(next);
    out.push(...(page.results || []));
    next = page._links?.next ? (page._links.next.startsWith('/wiki') ? page._links.next : `/wiki${page._links.next}`) : null;
  }
  return out;
}

let site;
export async function sharepointSite() {
  const creds = await credentials();
  site ||= await siteId(creds, creds.siteUrl);
  return { creds, site };
}

// The documents of a source as the connector crawls them: { uri, title, kind, modified, size, docId? }.
// uri is the link the knowledge base reports as _source_uri; docId is set when the knowledge base id is known.
export async function catalog(source, detail) {
  if (source.type === 'CONFLUENCE') {
    const { confluence: c } = await credentials();
    const out = [];
    for (const key of detail.spaces) {
      const cql = encodeURIComponent(`space="${key}" and type in (page, blogpost, attachment)`);
      for (const item of await confluencePages(`/wiki/rest/api/content/search?cql=${cql}&limit=100&expand=version`)) {
        out.push({
          uri: `${c.hostUrl}/wiki${item._links?.webui || ''}`, title: item.title, kind: item.type,
          modified: item.version?.when, docId: item.type === 'attachment' ? undefined : item.id, space: key,
        });
      }
    }
    return out;
  }
  if (source.type === 'SHAREPOINT') {
    const { creds, site: id } = await sharepointSite();
    const out = [];
    for (const folder of detail.folders) {
      for (const f of await listFolder(creds, id, folder)) {
        if (f.name.startsWith('.')) continue;
        out.push({ uri: f.webUrl, title: f.name, kind: f.name.split('.').pop().toLowerCase(), modified: f.modified, size: f.size, folder });
      }
    }
    return out;
  }
  return [];
}

export { graph };
