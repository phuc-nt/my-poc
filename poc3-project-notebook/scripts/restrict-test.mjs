#!/usr/bin/env node
// Live test of the page-level permissions: puts a read restriction on one labelled test page of Confluence (only
// the account of the API token may read it), has the monitor read the restrictions, checks that another user of
// the app no longer reaches the page or its files by any road (document list, search, reader, MCP, agent), then
// removes the restriction and checks that everything is back. Only a page carrying the label of
// scripts/attach-fixtures.mjs is touched. Prints titles and counts; never a host, an account or an address.
//
// A Confluence site on the Free plan has no page restrictions (the API answers 403). The test then writes the
// index the monitor would have written for that page, restricted to an address nobody has, and checks the same
// roads: that covers the enforcement, not the reading of the restriction from Confluence.
//
//   AWS_PROFILE=... node scripts/restrict-test.mjs

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atlassian, LABEL, SPACE } from './attach-fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const local = JSON.parse(readFileSync(join(ROOT, 'infra', 'deploy.local.json'), 'utf8'));
const SITE = local.site;
const PAGE = 'Tài liệu cũ và bản scan';
const FILES = ['Quy-trinh-sao-luu', 'Danh-muc-may-chu', 'Bien-ban-ban-giao-scan', 'Lich-bao-tri'];

let failures = 0;
const mask = (s) => String(s).replace(/https?:\/\/[^\s"')]+/g, '<url>').replace(/[0-9]{12}/g, '<acct>').replace(/[\w.+-]+@[\w.-]+/g, '<email>');
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${mask(detail)}` : ''}`);
}

const cfg = await (await fetch(`${SITE}/config.json`)).json();
async function signIn(email) {
  const response = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ ClientId: cfg.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: local.users[email] } }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`sign-in ${email.split('@')[0]}: ${data.__type}`);
  return data.AuthenticationResult.IdToken;
}
function client(token) {
  const call = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${SITE}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  const stream = async (path, body) => {
    const response = await fetch(`${SITE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const events = [];
    for (const chunk of (await response.text()).split('\n\n')) {
      const event = chunk.match(/^event: (.+)$/m)?.[1];
      const data = chunk.match(/^data: (.+)$/m)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) });
    }
    return { events, first: (name) => events.find((e) => e.event === name)?.data };
  };
  return { call, stream };
}
const emails = Object.keys(local.users);
const user = async (name) => client(await signIn(emails.find((e) => e.split('@')[0] === name)));
const admin = await user('admin');
const ba = await user('ba-translator');
const sourceId = (await admin.call('/api/sources')).data.find((s) => s.name === 'confluence-engdocs').id;

const readAcl = () => {
  const out = join(process.env.TMPDIR || '/tmp', `poc3-acl-${process.pid}.json`);
  execFileSync('aws', ['lambda', 'invoke', '--function-name', 'poc3-kb-monitor', '--region', cfg.region, '--cli-binary-format', 'raw-in-base64-out',
    '--payload', '{"acl":true}', '--cli-read-timeout', '600', out], { stdio: 'ignore' });
  return JSON.parse(readFileSync(out, 'utf8'));
};

const aws = (...args) => execFileSync('aws', [...args, '--region', cfg.region], { encoding: 'utf8' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The functions keep an index for a minute.
const CACHE_MS = 65_000;

const mine = (d) => d.title.includes(PAGE) || FILES.some((f) => d.title.includes(f));
// What the reader reaches of the page and its files, by every road.
async function reach(who, label) {
  const docs = ((await who.call(`/api/sources/${sourceId}/documents`)).data || []).filter(mine);
  const found = (await who.call('/api/search', { method: 'POST', body: { query: 'danh mục máy chủ, lịch bảo trì, quy trình sao lưu my-db-mate', limit: 20, sources: [sourceId] } })).data?.passages || [];
  const hits = found.filter(mine);
  console.log(`  ${label}: ${docs.length} documents listed (${docs.filter((d) => d.restricted).length} marked restricted), ${hits.length} of ${found.length} passages`);
  return { docs, hits };
}

const cql = encodeURIComponent(`space="${SPACE}" and type=page and label="${LABEL}" and title ~ "${PAGE}"`);
const page = (await atlassian('GET', `/wiki/rest/api/content/search?cql=${cql}&limit=5`)).results?.find((p) => p.title.includes(PAGE));
if (!page) throw new Error('The test page is missing: run node scripts/attach-fixtures.mjs up');
console.log(`Test page: ${page.title}`);

const before = await reach(ba, 'before, another user');
check('before: the page and its files are listed and found', before.docs.length >= 3 && before.hits.length > 0);
const sample = before.docs.find((d) => !d.title.includes(PAGE)) || before.docs[0];

const me = await atlassian('GET', '/wiki/rest/api/user/current');
let restricted = false;
let simulated = false;
try {
  try {
    await atlassian('PUT', `/wiki/rest/api/content/${page.id}/restriction`, { json: [{ operation: 'read', restrictions: { user: [{ type: 'known', accountId: me.accountId }], group: [] } }] });
    restricted = true;
    console.log('Read restriction set: only the account of the API token.');
    const row = readAcl().find((r) => r.source === 'confluence-engdocs');
    check('the monitor finds the restricted page', row?.restricted >= 1, JSON.stringify(row));
  } catch (error) {
    if (!/-> 403/.test(error.message)) throw error;
    simulated = true;
    console.log('This Confluence site refuses page restrictions (Free plan): writing the index the monitor would write.');
    const table = JSON.parse(aws('lambda', 'get-function-configuration', '--function-name', 'poc3-kb-api', '--query', 'Environment.Variables.TABLE', '--output', 'json'));
    const item = { pk: { S: `ACL#${sourceId}` }, sk: { S: 'INDEX' }, at: { S: new Date().toISOString() }, restricted: { N: '1' }, unresolved: { N: '0' },
      sets: { L: [{ L: [{ S: 'nobody@example.invalid' }] }] }, docs: { M: { [String(page.id)]: { N: '0' } } } };
    aws('dynamodb', 'put-item', '--table-name', table, '--item', JSON.stringify(item));
  }
  await wait(CACHE_MS);
  const status = (await admin.call('/api/admin/restrictions')).data?.find((s) => s.id === sourceId);
  check('the admin page reports the restriction', status?.restricted >= 1, JSON.stringify({ restricted: status?.restricted, unresolved: status?.unresolved }));

  const after = await reach(ba, 'restricted, another user');
  check('restricted: nothing is listed for another user', after.docs.length === 0);
  check('restricted: search returns none of its passages', after.hits.length === 0);
  const text = await ba.call('/api/documents/text', { method: 'POST', body: { source: sourceId, uri: sample.uri } });
  check('restricted: the reader answers as if the file did not exist', text.status === 404, `${text.status}`);
  const guide = await ba.call('/api/documents/guide', { method: 'POST', body: { source: sourceId, uri: sample.uri, title: sample.title, lang: 'vi' } });
  check('restricted: no source guide', guide.status === 404, `${guide.status}`);

  const created = await ba.call('/api/tokens', { method: 'POST', body: { name: 'restrict-test', days: 1 } });
  const pat = client(created.data.token);
  const tool = async (name, args) => {
    const r = await pat.call('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    return { text: r.data?.result?.content?.[0]?.text || '', isError: r.data?.result?.isError || !!r.data?.error };
  };
  const got = await tool('get_document', { source: 'confluence-engdocs', link: sample.uri });
  check('restricted: MCP get_document refuses', got.isError, got.text.slice(0, 90));
  const table = await tool('query_table', { source: 'confluence-engdocs', link: sample.uri });
  check('restricted: MCP query_table refuses', table.isError, table.text.slice(0, 90));
  const listed = await tool('list_documents', { source: 'confluence-engdocs', parent: PAGE });
  check('restricted: MCP list_documents shows no file of the page', !listed.isError && JSON.parse(listed.text).total === 0, listed.text.slice(0, 60).replace(/\s+/g, ' '));
  const mcpSearch = await tool('search', { query: 'danh mục máy chủ my-db-mate', limit: 20, sources: ['confluence-engdocs'] });
  check('restricted: MCP search shows none of its passages', !FILES.some((f) => mcpSearch.text.includes(f)) && !mcpSearch.text.includes(PAGE));
  await ba.call(`/api/tokens/${encodeURIComponent(created.data.prefix)}`, { method: 'DELETE' });

  const nb = (await ba.call('/api/notebooks')).data.find((n) => n.name === 'e2e') || (await ba.call('/api/notebooks', { method: 'POST', body: { name: 'e2e', sources: [] } })).data;
  const asked = await ba.stream('/api/chat', { notebookId: nb.id, question: `Trang "my-db-mate 2.0 — ${PAGE}" có những file đính kèm nào, và danh mục máy chủ gồm những máy nào?`, mode: 'agent', sources: [sourceId] });
  const passages = asked.events.filter((e) => e.event === 'sources').at(-1)?.data.passages || [];
  const answer = asked.first('done')?.answer || '';
  check('restricted: the agent reads none of it', Boolean(answer) && !passages.some(mine) && !FILES.some((f) => answer.includes(f)), `${passages.length} passages; answer: ${answer.slice(0, 160).replace(/\s+/g, ' ')}`);

  const own = await reach(admin, 'restricted, the admin of the app');
  console.log(`  (the admin reaches it only when the app account has the same email as the Atlassian account: ${own.docs.length ? 'it does' : 'it does not'})`);
} finally {
  if (restricted || simulated) {
    if (restricted) await atlassian('DELETE', `/wiki/rest/api/content/${page.id}/restriction`);
    console.log(restricted ? 'Read restriction removed.' : 'The monitor reads the restrictions again and replaces the index.');
    const report = readAcl();
    await wait(CACHE_MS);
    const again = await reach(ba, 'after, another user');
    check('after: the page and its files are back', again.docs.length === before.docs.length && again.hits.length > 0, JSON.stringify(report.find((r) => r.source === 'confluence-engdocs')));
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
