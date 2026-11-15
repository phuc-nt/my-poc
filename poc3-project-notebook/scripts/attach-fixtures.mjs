#!/usr/bin/env node
// The attachment test's data on the Atlassian test site: the Jira issues and Confluence pages of
// eval/attachments/cases.json, each with its files from eval/attachments/files/ (built by make.py).
// Everything it creates carries the label poc3-attach, and only labelled items are ever changed or deleted.
// It prints titles, keys and file names; never the host, the account or the token.
//
//   node scripts/attach-fixtures.mjs up       create what is missing, attach the missing files
//   node scripts/attach-fixtures.mjs status   what exists, with each container's attachments
//   node scripts/attach-fixtures.mjs down     delete the labelled issues and pages
//
// Settings come from ../poc1-slack-platform/.env and infra/local.env, like infra/kb.mjs:
// JIRA_PROJECT_KEY for the issues, the first space of infra/sources.json's confluence-engdocs for the pages.

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, sourcesConfig } from '../infra/kb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'eval', 'attachments');
export const manifest = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8'));
export const LABEL = manifest.label;
export const PROJECT = env.JIRA_PROJECT_KEY;
export const SPACE = sourcesConfig().confluence.find((s) => s.name === 'confluence-engdocs').spaces[0];

// Jira and Confluence can be on two sites; a /wiki path goes to the Confluence one.
const site = (url) => String(url || '').replace(/\/+$/, '').replace(/\/wiki$/, '');
const hosts = { jira: site(env.JIRA_BASE_URL || env.CONFLUENCE_BASE_URL), confluence: site(env.CONFLUENCE_BASE_URL || env.JIRA_BASE_URL) };
const basic = (user, token) => 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
const auth = { jira: basic(env.JIRA_EMAIL || env.CONFLUENCE_EMAIL, env.JIRA_API_TOKEN || env.CONFLUENCE_API_TOKEN),
  confluence: basic(env.CONFLUENCE_EMAIL || env.JIRA_EMAIL, env.CONFLUENCE_API_TOKEN || env.JIRA_API_TOKEN) };

const MIME = {
  pdf: 'application/pdf', png: 'image/png', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const mimeOf = (name) => MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';

export async function atlassian(method, path, { json, form, raw } = {}) {
  const product = path.startsWith('/wiki/') ? 'confluence' : 'jira';
  const host = hosts[product];
  const headers = { authorization: auth[product], accept: 'application/json' };
  if (json) headers['content-type'] = 'application/json';
  if (form) headers['x-atlassian-token'] = 'no-check';
  const res = await fetch(host + path, { method, headers, body: json ? JSON.stringify(json) : form });
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${(await res.text()).slice(0, 300).replaceAll(host, '<host>')}`);
  if (raw) return res;
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function upload(file, name = basename(file)) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(file)], { type: mimeOf(name) }), name);
  return form;
}
const adf = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

// ---------- Jira

export async function jiraIssues() {
  const jql = encodeURIComponent(`project = "${PROJECT}" AND labels = "${LABEL}" ORDER BY key ASC`);
  const r = await atlassian('GET', `/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=summary,labels,attachment,comment`);
  return r.issues.map((i) => ({ key: i.key, title: i.fields.summary, comments: i.fields.comment?.total ?? 0,
    attachments: (i.fields.attachment || []).map((a) => ({ id: a.id, name: a.filename })) }));
}
export const jiraAttach = async (key, file, name) => (await atlassian('POST', `/rest/api/3/issue/${key}/attachments`, { form: upload(file, name) }))[0];
export const jiraDetach = (id) => atlassian('DELETE', `/rest/api/3/attachment/${id}`);

async function jiraUp(container, existing) {
  let issue = existing.find((i) => i.title === container.title);
  if (!issue) {
    const created = await atlassian('POST', '/rest/api/3/issue', { json: { fields: {
      project: { key: PROJECT }, issuetype: { name: container.type }, summary: container.title, description: adf(container.body), labels: [LABEL] } } });
    issue = { key: created.key, title: container.title, comments: 0, attachments: [] };
    console.log(`jira ${issue.key} created: ${container.title}`);
  }
  if (!issue.comments) for (const comment of container.comments) await atlassian('POST', `/rest/api/3/issue/${issue.key}/comment`, { json: { body: adf(comment) } });
  for (const name of container.files) {
    if (issue.attachments.some((a) => a.name === name)) continue;
    await jiraAttach(issue.key, join(DIR, 'files', name));
    console.log(`  ${issue.key} + ${name}`);
  }
  return issue.key;
}

// ---------- Confluence

// The labelled pages and blog posts of the space. Read from the content list, not from a CQL search: the search
// index is minutes behind, and a page made a moment ago must be found.
export async function confluencePages() {
  const out = [];
  for (const type of ['page', 'blogpost']) {
    for (let start = 0; ; start += 100) {
      const r = await atlassian('GET', `/wiki/rest/api/content?spaceKey=${SPACE}&type=${type}&limit=100&start=${start}&expand=metadata.labels,children.attachment`);
      out.push(...r.results);
      if (r.results.length < 100) break;
    }
  }
  return out.filter((p) => (p.metadata?.labels?.results || []).some((l) => l.name === LABEL)).map((p) => ({ id: p.id, type: p.type, title: p.title,
    attachments: (p.children?.attachment?.results || []).map((a) => ({ id: a.id, name: a.title })) }));
}
export const confluenceAttach = async (id, file, name) => (await atlassian('PUT', `/wiki/rest/api/content/${id}/child/attachment`, { form: upload(file, name) })).results[0];
export const confluenceDetach = (id) => atlassian('DELETE', `/wiki/rest/api/content/${id}`);

async function confluenceUp(container, existing) {
  let page = existing.find((p) => p.title === container.title && p.type === container.type);
  if (!page) {
    const created = await atlassian('POST', '/wiki/rest/api/content', { json: {
      type: container.type, title: container.title, space: { key: SPACE },
      body: { storage: { value: `<p>${container.body}</p>`, representation: 'storage' } },
      metadata: { labels: [{ prefix: 'global', name: LABEL }] } } });
    page = { id: created.id, type: container.type, title: container.title, attachments: [] };
    console.log(`confluence ${container.type} created: ${container.title}`);
  }
  for (const name of container.files) {
    if (page.attachments.some((a) => a.name === name)) continue;
    await confluenceAttach(page.id, join(DIR, 'files', name));
    console.log(`  ${container.id} + ${name}`);
  }
  return page.id;
}

// ---------- commands

// Where each container of the manifest lives: { A: { system, key | id, attachments: [{ id, name }] }, ... }.
export async function located() {
  const [issues, pages] = [await jiraIssues(), await confluencePages()];
  const out = {};
  for (const c of manifest.containers) {
    const found = c.system === 'jira' ? issues.find((i) => i.title === c.title) : pages.find((p) => p.title === c.title && p.type === c.type);
    if (found) out[c.id] = { system: c.system, ...found };
  }
  return out;
}

async function up() {
  const [issues, pages] = [await jiraIssues(), await confluencePages()];
  for (const c of manifest.containers) await (c.system === 'jira' ? jiraUp(c, issues) : confluenceUp(c, pages));
  await status();
}

async function status() {
  const where = await located();
  for (const c of manifest.containers) {
    const at = where[c.id];
    const names = new Set((at?.attachments || []).map((a) => a.name));
    const missing = c.files.filter((f) => !names.has(f));
    console.log(`${c.id} ${c.system.padEnd(10)} ${(at ? at.key || c.type : 'MISSING').padEnd(9)} ${names.size}/${c.files.length} files${missing.length ? ` (missing: ${missing.join(', ')})` : ''}  ${c.title}`);
  }
}

async function down() {
  for (const issue of await jiraIssues()) {
    await atlassian('DELETE', `/rest/api/3/issue/${issue.key}`);
    console.log(`jira ${issue.key} deleted`);
  }
  for (const page of await confluencePages()) {
    await atlassian('DELETE', `/wiki/rest/api/content/${page.id}`);
    console.log(`confluence ${page.type} moved to the trash: ${page.title}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = { up, status, down }[process.argv[2]];
  if (!run) {
    console.error('usage: node scripts/attach-fixtures.mjs up|status|down');
    process.exit(2);
  }
  run().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
