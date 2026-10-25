// Microsoft Graph with the SharePoint connector's own Entra app (app-only, certificate sign-in).
// The same app and certificate the knowledge base uses; the private key comes from Secrets Manager on AWS,
// from infra/kb-cert/ on a laptop. Nothing here logs a token.

import { createHash, createPrivateKey, createSign, X509Certificate } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const cache = new Map(); // scope -> { token, expires }

// A client assertion (RFC 7523) signed with the certificate's private key, swapped for an access token of scope
// (Microsoft Graph by default, or a SharePoint host for its own REST API).
export async function graphToken({ tenantId, clientId, certificatePem, privateKeyPem }, scope = 'https://graph.microsoft.com/.default') {
  const cached = cache.get(scope);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const der = new X509Certificate(certificatePem).raw;
  const header = { alg: 'RS256', typ: 'JWT', x5t: b64url(createHash('sha1').update(der).digest()) };
  const now = Math.floor(Date.now() / 1000);
  const audience = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const claims = { aud: audience, iss: clientId, sub: clientId, jti: crypto.randomUUID(), nbf: now, exp: now + 600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(createPrivateKey(privateKeyPem));
  const body = new URLSearchParams({
    client_id: clientId,
    scope,
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: `${unsigned}.${b64url(signature)}`,
  });
  const response = await fetch(audience, { method: 'POST', body });
  const json = await response.json();
  if (!response.ok) throw new Error(`Graph sign-in failed: ${json.error || response.status}`);
  cache.set(scope, { token: json.access_token, expires: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

// The SharePoint REST API of the site (what Graph cannot do, such as the members of a SharePoint site group).
export async function sharepointRest(credentials, path) {
  const { origin } = new URL(credentials.siteUrl);
  const response = await fetch(`${credentials.siteUrl.replace(/\/$/, '')}${path}`, {
    headers: { authorization: `Bearer ${await graphToken(credentials, `${origin}/.default`)}`, accept: 'application/json;odata=nometadata' },
  });
  if (!response.ok) throw new Error(`SharePoint ${response.status} on ${path.split('(')[0]}`);
  return response.json();
}

export async function graph(credentials, path, { raw = false } = {}) {
  const url = path.startsWith('https://') ? path : `https://graph.microsoft.com/v1.0${path}`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${await graphToken(credentials)}` } });
  if (!response.ok) throw new Error(`Graph ${response.status} on ${path.split('?')[0].replace(/\/sites\/[^/]+/, '/sites/<site>')}`);
  return raw ? response : response.json();
}

// "https://host/sites/name" -> the Graph site id.
export async function siteId(credentials, siteUrl) {
  const { host, pathname } = new URL(siteUrl);
  return (await graph(credentials, `/sites/${host}:${pathname.replace(/\/$/, '')}`)).id;
}

// Every item under a folder of the site's default library, depth first.
export async function listFolder(credentials, site, folderPath) {
  const out = [];
  let next = `/sites/${site}/drive/root:/${encodeURI(folderPath)}:/children?$top=200`;
  while (next) {
    const page = await graph(credentials, next);
    for (const item of page.value) {
      const path = `${folderPath}/${item.name}`;
      if (item.folder) out.push(...(await listFolder(credentials, site, path)));
      else out.push({ id: item.id, name: item.name, path, size: item.size, modified: item.lastModifiedDateTime, webUrl: item.webUrl });
    }
    next = page['@odata.nextLink'];
  }
  return out;
}
