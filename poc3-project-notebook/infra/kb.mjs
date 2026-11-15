#!/usr/bin/env node
// PoC 3 knowledge bases: Amazon Bedrock Managed Knowledge Bases with one data source per Confluence space and per
// group of Jira projects (infra/sources.json). There is no Jira connector: a Jira source is a custom data source
// that the app's monitor function fills (src/lib/jira.mjs), so it has no sync job here. A Confluence source with
// "text": true gets a second custom data source, "<name>-text", for the text documents the monitor makes of its
// attachments (src/lib/confluence-text.mjs). A knowledge base holds at
// most 5 data sources, so the sources are spread over poc3-kb, poc3-kb-company and so on. Every resource is named poc3-kb... and tagged Project=poc3-kb,
// separate from the AIPF and the earlier chatbot. Nothing here prints a secret, an account number or a host.
//
//   node infra/kb.mjs up [name...]       role, bucket, secrets, knowledge bases, data sources; removes data sources
//                                        that infra/sources.json no longer names
//   node infra/kb.mjs sync [name...]     start a sync of every (or the named) data source
//   node infra/kb.mjs status             data sources and their last sync
//   node infra/kb.mjs wait               wait until no sync is running, then print the status
//   node infra/kb.mjs bucket             the data bucket only (infra/redeploy.mjs makes it before the rest)
//   node infra/kb.mjs down               delete everything above
//
// PoC 3 reuses PoC 1's Atlassian test settings. It reads ../poc1-slack-platform/infra/local.env (Region,
// Confluence space keys, Jira project key) and ../poc1-slack-platform/.env (Confluence and Jira site, account and
// API token). SharePoint sources are no longer in infra/sources.json; if a "sharepoint" list is put back, the
// SharePoint tenant, client, site and the certificate in ../poc1-slack-platform/infra/kb-cert/ are read as before.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const POC1 = join(HERE, '..', '..', 'poc1-slack-platform');
export const PREFIX = 'poc3-kb';
export const TAG = [{ Key: 'Project', Value: PREFIX }];

function loadEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
export const env = { ...loadEnv(join(POC1, '.env')), ...loadEnv(join(POC1, 'infra', 'local.env')), ...process.env };
process.env.AWS_REGION = env.AWS_REGION;
if (env.AWS_PROFILE) process.env.AWS_PROFILE = env.AWS_PROFILE;
process.env.AWS_PAGER = '';
export const REGION = env.AWS_REGION;

// The aws CLI with JSON output. Errors carry the CLI's message, which never holds a secret value.
export function aws(args, { json = true, quiet = false } = {}) {
  try {
    const out = execFileSync('aws', [...args, ...(json ? ['--output', 'json'] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
    return json ? (out.trim() ? JSON.parse(out) : {}) : out;
  } catch (error) {
    if (quiet) return null;
    throw new Error(String(error.stderr || error.message).trim().replace(/\d{12}/g, '<acct>'));
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'poc3-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
export function file(name, value) {
  const path = join(tmp, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return `file://${path}`;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let accountId;
export const account = () => (accountId ||= aws(['sts', 'get-caller-identity']).Account);
export const dataBucket = () => `${PREFIX}-data-${account()}-${REGION}`;
const ROLE = `${PREFIX}-role`;
const CERT_KEY = 'cert/certificate.p12';

// The poc3-kb* knowledge bases, as { name, id }.
export function knowledgeBases() {
  const list = aws(['bedrock-agent', 'list-knowledge-bases', '--max-results', '100']).knowledgeBaseSummaries || [];
  return list.filter((k) => k.name === PREFIX || k.name.startsWith(`${PREFIX}-`)).map((k) => ({ name: k.name, id: k.knowledgeBaseId }));
}
export const kbId = (name = PREFIX) => knowledgeBases().find((k) => k.name === name)?.id || null;
export function dataSources(kb) {
  return aws(['bedrock-agent', 'list-data-sources', '--knowledge-base-id', kb]).dataSourceSummaries || [];
}

export function sourcesConfig() {
  const raw = JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8'));
  const expand = (v) => v.flatMap((x) => (x.startsWith('$') ? String(env[x.slice(1)] || '').split(',').map((s) => s.trim()).filter(Boolean) : [x]));
  return {
    confluence: raw.confluence.map((s) => ({ ...s, kind: 'confluence', spaces: expand(s.spaces) })),
    sharepoint: (raw.sharepoint || []).map((s) => ({ ...s, kind: 'sharepoint' })),
    jira: (raw.jira || []).map((s) => ({ ...s, kind: 'jira', projects: expand(s.projects) })),
    // The text documents of a Confluence source's attachments: a custom data source next to it, in its knowledge base.
    text: raw.confluence.filter((s) => s.text).map((s) => ({ name: `${s.name}-text`, kb: s.kb, kind: 'text', title: `${s.title} — văn bản của file đính kèm` })),
  };
}

function putRole(acct) {
  const trust = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'bedrock.amazonaws.com' }, Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'aws:SourceAccount': acct }, ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${REGION}:${acct}:knowledge-base/*` } } }],
  };
  const policy = {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: `arn:aws:secretsmanager:${REGION}:${acct}:secret:${PREFIX}/*` },
      { Effect: 'Allow', Action: 's3:ListBucket', Resource: `arn:aws:s3:::${dataBucket()}` },
      { Effect: 'Allow', Action: 's3:GetObject', Resource: `arn:aws:s3:::${dataBucket()}/*` },
    ],
  };
  if (aws(['iam', 'get-role', '--role-name', ROLE], { quiet: true })) {
    aws(['iam', 'update-assume-role-policy', '--role-name', ROLE, '--policy-document', file('trust.json', trust)], { json: false });
  } else {
    aws(['iam', 'create-role', '--role-name', ROLE, '--assume-role-policy-document', file('trust.json', trust), '--tags', JSON.stringify(TAG)]);
  }
  aws(['iam', 'put-role-policy', '--role-name', ROLE, '--policy-name', 'access', '--policy-document', file('policy.json', policy)], { json: false });
  console.log(`role ${ROLE}`);
  return `arn:aws:iam::${acct}:role/${ROLE}`;
}

function putBucket() {
  const bucket = dataBucket();
  if (!aws(['s3api', 'head-bucket', '--bucket', bucket], { quiet: true })) {
    aws(['s3api', 'create-bucket', '--bucket', bucket, '--create-bucket-configuration', `LocationConstraint=${REGION}`]);
    aws(['s3api', 'put-public-access-block', '--bucket', bucket, '--public-access-block-configuration',
      'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'], { json: false });
    aws(['s3api', 'put-bucket-tagging', '--bucket', bucket, '--tagging', JSON.stringify({ TagSet: TAG })], { json: false });
  }
  console.log('data bucket ready');
  return bucket;
}

export function putSecret(name, value) {
  const exists = aws(['secretsmanager', 'describe-secret', '--secret-id', name], { quiet: true });
  if (exists) aws(['secretsmanager', 'put-secret-value', '--secret-id', name, '--secret-string', file('secret.json', value)]);
  else aws(['secretsmanager', 'create-secret', '--name', name, '--secret-string', file('secret.json', value), '--tags', JSON.stringify(TAG)]);
  return aws(['secretsmanager', 'describe-secret', '--secret-id', name]).ARN;
}

const certDir = join(POC1, 'infra', 'kb-cert');
// A data source the monitor function fills, not a connector: no ingestion job to start or to wait for.
const isCustom = (ds) => /^jira|-text$/i.test(ds.name);

function secrets(bucket) {
  const host = String(env.CONFLUENCE_BASE_URL || env.JIRA_BASE_URL || '').replace(/\/+$/, '').replace(/\/wiki$/, '');
  const username = env.CONFLUENCE_EMAIL || env.JIRA_EMAIL;
  const password = env.CONFLUENCE_API_TOKEN || env.JIRA_API_TOKEN;
  if (!host || !username || !password) throw new Error('The Confluence site, account or API token is missing from .env');
  const confluence = putSecret(`${PREFIX}/confluence`, { username, password, hostUrl: host });
  // SharePoint is set up only while infra/sources.json names a SharePoint source; without one, what an earlier
  // deployment left (the connector's secret, the certificate in the bucket) is removed.
  const { sharepoint: sharepointSources, jira: jiraSources } = sourcesConfig();
  let sharepoint = null;
  let graph = {};
  if (sharepointSources.length) {
    if (!existsSync(join(certDir, 'certificate.p12'))) throw new Error('poc1-slack-platform/infra/kb-cert/certificate.p12 is missing');
    const certificatePassword = readFileSync(join(certDir, 'p12-password'), 'utf8').trim();
    sharepoint = putSecret(`${PREFIX}/sharepoint`, { clientId: env.SHAREPOINT_CLIENT_ID, certificatePassword });
    // The app's own copy for Microsoft Graph (folder permissions, the converted mirror): the PEM key and certificate.
    graph = { tenantId: env.SHAREPOINT_TENANT_ID, clientId: env.SHAREPOINT_CLIENT_ID, siteUrl: String(env.SHAREPOINT_SITE_URLS || '').split(',')[0].trim(),
      certificatePem: readFileSync(join(certDir, 'certificate.cer'), 'utf8'), privateKeyPem: readFileSync(join(certDir, 'private_key.pem'), 'utf8') };
    aws(['s3', 'cp', join(certDir, 'certificate.p12'), `s3://${bucket}/${CERT_KEY}`, '--sse', 'AES256', '--only-show-errors'], { json: false });
  } else {
    aws(['secretsmanager', 'delete-secret', '--secret-id', `${PREFIX}/sharepoint`, '--force-delete-without-recovery'], { quiet: true });
    aws(['s3', 'rm', `s3://${bucket}/${CERT_KEY}`, '--only-show-errors'], { json: false, quiet: true });
  }
  // Jira can be on another site than Confluence. Each Jira source's projects go with the account.
  const jiraHost = String(env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  if (jiraSources.length && !(jiraHost && env.JIRA_EMAIL && env.JIRA_API_TOKEN)) throw new Error('The Jira site, account or API token is missing from .env');
  // The app's own copy of the source systems' sign-ins (the name graph is from the SharePoint days).
  putSecret(`${PREFIX}/graph`, {
    ...graph,
    confluence: { hostUrl: host, username, password },
    ...(jiraSources.length ? { jira: { hostUrl: jiraHost, username: env.JIRA_EMAIL, password: env.JIRA_API_TOKEN,
      sources: Object.fromEntries(jiraSources.map((s) => [s.name, { projects: s.projects }])) } } : {}),
  });
  console.log(sharepointSources.length ? 'secrets and certificate ready' : 'secrets ready');
  return { host, confluence, sharepoint };
}

function putKb(name, roleArn) {
  let id = kbId(name);
  if (!id) {
    for (let attempt = 0; ; attempt++) {
      try {
        id = aws(['bedrock-agent', 'create-knowledge-base', '--name', name, '--role-arn', roleArn,
          '--description', 'PoC 3 project notebook: Confluence spaces and Jira projects',
          '--knowledge-base-configuration', JSON.stringify({ type: 'MANAGED', managedKnowledgeBaseConfiguration: { embeddingModelType: 'MANAGED' } }),
          '--tags', JSON.stringify({ Project: PREFIX })]).knowledgeBase.knowledgeBaseId;
        break;
      } catch (error) {
        if (attempt > 5 || !/assume|role/i.test(error.message)) throw error;
        execFileSync('sleep', ['10']); // a new role is not assumable straight away
      }
    }
  }
  return id;
}

async function waitFor(what, read, wanted) {
  for (let i = 0; i < 90; i++) {
    const status = read();
    if (status === wanted) return console.log(`${what}: ${status}`);
    if (/FAILED/.test(status)) throw new Error(`${what}: ${status}`);
    await sleep(5000);
  }
  throw new Error(`${what}: still waiting after 7 minutes`);
}

export function sourceConfiguration(source, { host, confluence, sharepoint, bucket }) {
  let parameters;
  if (source.kind === 'jira' || source.kind === 'text') {
    // Documents arrive through IngestKnowledgeBaseDocuments; nothing is crawled, so there is no schedule.
    return { type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
      managedKnowledgeBaseConnectorConfiguration: { connectorParameters: { type: 'CUSTOM', version: '1', aclEnabled: false } } };
  }
  if (source.kind === 'confluence') {
    parameters = {
      type: 'CONFLUENCE', version: '1', aclEnabled: false,
      connectionConfiguration: { secretArn: confluence, type: 'SAAS', authType: 'BASIC', hostUrl: host },
      dataEntityConfiguration: { crawlPage: true, crawlBlog: true, crawlPageAttachment: true, crawlBlogAttachment: true,
        crawlArchivedSpace: false, crawlArchivedPage: false, crawlPersonalSpace: false },
      filterConfiguration: { inclusionSpaceKeys: source.spaces },
    };
  } else {
    const site = String(env.SHAREPOINT_SITE_URLS || '').split(',')[0].trim().replace(/\/$/, '');
    parameters = {
      type: 'SHAREPOINT', version: '1', aclEnabled: false,
      connectionConfiguration: { secretArn: sharepoint, tenantId: env.SHAREPOINT_TENANT_ID, authType: 'ENTRA_ID_APP_ONLY',
        certificateS3Path: { s3BucketName: bucket, s3KeyName: CERT_KEY } },
      dataEntityConfiguration: { crawlFiles: true, crawlPages: false, siteUrls: [site] },
      filterConfiguration: { inclusionItemPaths: source.folders.map((f) => `${site}/Shared Documents/${f}`) },
    };
  }
  return {
    type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
    managedKnowledgeBaseConnectorConfiguration: { connectorParameters: parameters, syncSchedule: { daily: {} } },
  };
}

async function putSource(kb, source, context) {
  const config = sourceConfiguration(source, context);
  const existing = dataSources(kb).find((d) => d.name === source.name);
  let id = existing?.dataSourceId;
  if (!id) {
    id = aws(['bedrock-agent', 'create-data-source', '--knowledge-base-id', kb, '--name', source.name,
      '--description', source.title, '--data-source-configuration', file('ds.json', config)]).dataSource.dataSourceId;
  } else {
    aws(['bedrock-agent', 'update-data-source', '--knowledge-base-id', kb, '--data-source-id', id, '--name', source.name,
      '--description', source.title, '--data-source-configuration', file('ds.json', config)]);
  }
  await waitFor(`data source ${source.name}`, () => aws(['bedrock-agent', 'get-data-source', '--knowledge-base-id', kb, '--data-source-id', id]).dataSource.status, 'AVAILABLE');
  return id;
}

async function up(only) {
  const acct = account();
  const bucket = putBucket();
  const roleArn = putRole(acct);
  const context = { ...secrets(bucket), bucket };
  const { confluence, sharepoint, jira, text } = sourcesConfig();
  const sources = [...confluence, ...sharepoint, ...jira, ...text].filter((s) => !only.length || only.includes(s.name));
  for (const name of [...new Set(sources.map((s) => s.kb))]) {
    const kb = putKb(name, roleArn);
    await waitFor(`knowledge base ${name}`, () => aws(['bedrock-agent', 'get-knowledge-base', '--knowledge-base-id', kb]).knowledgeBase.status, 'ACTIVE');
    for (const source of sources.filter((s) => s.kb === name)) await putSource(kb, source, context);
  }
  // A source moved to another knowledge base leaves its old data source behind: remove it.
  const wanted = new Map([...confluence, ...sharepoint, ...jira, ...text].map((s) => [s.name, s.kb]));
  for (const kb of knowledgeBases()) {
    for (const ds of dataSources(kb.id)) if (wanted.get(ds.name) !== kb.name) await removeSource(kb.id, ds);
  }
  putLogDelivery(acct);
}

// Each knowledge base sends its application logs (one event per document and sync) to one log group, where the
// monitor reads why a document failed. Vended log delivery: a source per knowledge base, one destination.
export const LOG_GROUP = `/aws/vendedlogs/bedrock/${PREFIX}`;
function putLogDelivery(acct) {
  if (!aws(['logs', 'describe-log-groups', '--log-group-name-prefix', LOG_GROUP]).logGroups?.some((g) => g.logGroupName === LOG_GROUP)) {
    aws(['logs', 'create-log-group', '--log-group-name', LOG_GROUP, '--tags', `Project=${PREFIX}`], { json: false });
  }
  aws(['logs', 'put-retention-policy', '--log-group-name', LOG_GROUP, '--retention-in-days', '30'], { json: false });
  // Tags are accepted only when a delivery destination or source is created, so an existing one is left as it is.
  const destination = (aws(['logs', 'describe-delivery-destinations']).deliveryDestinations || []).find((d) => d.name === `${PREFIX}-logs`)?.arn
    || aws(['logs', 'put-delivery-destination', '--name', `${PREFIX}-logs`,
      '--delivery-destination-configuration', `destinationResourceArn=arn:aws:logs:${REGION}:${acct}:log-group:${LOG_GROUP}`, '--tags', `Project=${PREFIX}`]).deliveryDestination.arn;
  const deliveries = aws(['logs', 'describe-deliveries']).deliveries || [];
  const have = new Set((aws(['logs', 'describe-delivery-sources']).deliverySources || []).map((d) => d.name));
  for (const kb of knowledgeBases()) {
    const source = `${kb.name}-logs`;
    if (!have.has(source)) {
      aws(['logs', 'put-delivery-source', '--name', source, '--resource-arn', `arn:aws:bedrock:${REGION}:${acct}:knowledge-base/${kb.id}`,
        '--log-type', 'APPLICATION_LOGS', '--tags', `Project=${PREFIX}`]);
    }
    if (!deliveries.some((d) => d.deliverySourceName === source)) {
      aws(['logs', 'create-delivery', '--delivery-source-name', source, '--delivery-destination-arn', destination, '--tags', `Project=${PREFIX}`]);
    }
  }
  console.log(`log delivery to ${LOG_GROUP}`);
}

function removeLogDelivery() {
  for (const d of aws(['logs', 'describe-deliveries']).deliveries || []) {
    if (d.deliverySourceName?.startsWith(PREFIX)) aws(['logs', 'delete-delivery', '--id', d.id], { quiet: true });
  }
  for (const kb of knowledgeBases()) aws(['logs', 'delete-delivery-source', '--name', `${kb.name}-logs`], { quiet: true });
  aws(['logs', 'delete-delivery-destination', '--name', `${PREFIX}-logs`], { quiet: true });
  aws(['logs', 'delete-log-group', '--log-group-name', LOG_GROUP], { quiet: true });
}

async function removeSource(kb, ds) {
  aws(['bedrock-agent', 'update-data-source', '--knowledge-base-id', kb, '--data-source-id', ds.dataSourceId, '--name', ds.name,
    '--data-deletion-policy', 'DELETE', '--data-source-configuration',
    file('ds.json', aws(['bedrock-agent', 'get-data-source', '--knowledge-base-id', kb, '--data-source-id', ds.dataSourceId]).dataSource.dataSourceConfiguration)], { quiet: true });
  aws(['bedrock-agent', 'delete-data-source', '--knowledge-base-id', kb, '--data-source-id', ds.dataSourceId], { quiet: true });
  console.log(`data source ${ds.name}: removed`);
}

function sync(only) {
  for (const kb of knowledgeBases()) {
    for (const ds of dataSources(kb.id)) {
      if (only.length && !only.includes(ds.name)) continue;
      if (isCustom(ds)) {
        console.log(`${ds.name}: synced by the monitor function (node infra/deploy.mjs monitor)`);
        continue;
      }
      const job = aws(['bedrock-agent', 'start-ingestion-job', '--knowledge-base-id', kb.id, '--data-source-id', ds.dataSourceId], { quiet: true });
      console.log(`${ds.name}: ${job ? job.ingestionJob.status : 'not started (a sync is probably running)'}`);
    }
  }
}

function status() {
  const kbs = knowledgeBases();
  if (!kbs.length) return console.log('no knowledge base');
  for (const { id: kb, name } of kbs) {
  console.log(name);
  for (const ds of dataSources(kb)) {
    if (isCustom(ds)) {
      console.log(`  ${ds.name.padEnd(26)} ${ds.status.padEnd(10)} synced by the monitor function; its runs are on the app's sync page`);
      continue;
    }
    const jobs = aws(['bedrock-agent', 'list-ingestion-jobs', '--knowledge-base-id', kb, '--data-source-id', ds.dataSourceId,
      '--sort-by', 'attribute=STARTED_AT,order=DESCENDING', '--max-results', '1']).ingestionJobSummaries || [];
    const j = jobs[0];
    const s = j?.statistics || {};
    console.log(`  ${ds.name.padEnd(26)} ${ds.status.padEnd(10)} ${j ? `${j.status} ${j.startedAt} scanned=${s.numberOfDocumentsScanned} indexed=${(s.numberOfNewDocumentsIndexed || 0) + (s.numberOfModifiedDocumentsIndexed || 0)} failed=${s.numberOfDocumentsFailed} deleted=${s.numberOfDocumentsDeleted}` : 'never synced'}`);
  }
  }
}

// Waits until every data source's latest sync has ended (the first sync of a new knowledge base takes a while).
async function wait() {
  for (let i = 0; i < 120; i++) {
    const running = [];
    for (const kb of knowledgeBases()) {
      for (const ds of dataSources(kb.id)) {
        if (isCustom(ds)) continue;
        const job = aws(['bedrock-agent', 'list-ingestion-jobs', '--knowledge-base-id', kb.id, '--data-source-id', ds.dataSourceId,
          '--sort-by', 'attribute=STARTED_AT,order=DESCENDING', '--max-results', '1']).ingestionJobSummaries?.[0];
        if (['STARTING', 'IN_PROGRESS', 'STOPPING'].includes(job?.status)) running.push(ds.name);
      }
    }
    if (!running.length) return status();
    console.log(`syncing: ${running.join(', ')}`);
    await sleep(30000);
  }
  throw new Error('syncs still running after an hour');
}

async function down() {
  removeLogDelivery();
  for (const { id: kb, name } of knowledgeBases()) {
    for (const ds of dataSources(kb)) await removeSource(kb, ds);
    for (let i = 0; i < 60 && dataSources(kb).length; i++) await sleep(5000);
    aws(['bedrock-agent', 'delete-knowledge-base', '--knowledge-base-id', kb]);
    console.log(`knowledge base ${name} deleted`);
  }
  for (const name of ['confluence', 'sharepoint', 'graph', 'anthropic']) {
    aws(['secretsmanager', 'delete-secret', '--secret-id', `${PREFIX}/${name}`, '--force-delete-without-recovery'], { quiet: true });
  }
  if (aws(['s3api', 'head-bucket', '--bucket', dataBucket()], { quiet: true })) aws(['s3', 'rb', `s3://${dataBucket()}`, '--force'], { json: false });
  aws(['iam', 'delete-role-policy', '--role-name', ROLE, '--policy-name', 'access'], { quiet: true });
  aws(['iam', 'delete-role', '--role-name', ROLE], { quiet: true });
  console.log('secrets, bucket and role deleted');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const run = { up: () => up(rest), sync: () => sync(rest), status, wait, bucket: putBucket, down, logs: () => putLogDelivery(account()) }[command];
  if (!run) {
    console.error('usage: node infra/kb.mjs up|sync|status|wait|bucket|down [data source name...]');
    process.exit(2);
  }
  Promise.resolve(run()).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
