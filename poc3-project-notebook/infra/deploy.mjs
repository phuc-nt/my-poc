#!/usr/bin/env node
// Deploys the PoC 3 app (infra/stack.yaml) around the knowledge bases that infra/kb.mjs made.
//
//   node infra/deploy.mjs up               build, upload the code, deploy the stack, publish the web UI
//   node infra/deploy.mjs web              publish the web UI only
//   node infra/deploy.mjs users            create the test accounts (emails under .invalid, no email is sent)
//   node infra/deploy.mjs make-admin EMAIL make a signed-up person an active admin
//   node infra/deploy.mjs monitor          run the sync monitor once now
//   node infra/deploy.mjs down             delete the stack, the web files and the code zips
//
// Local state (the origin secret, the site address, the test passwords) goes to infra/deploy.local.json, which
// git ignores. Nothing here prints a secret, an account number or an address.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aws, env, file, dataBucket, PREFIX, LOG_GROUP } from './kb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STACK = `${PREFIX}-app`;
const STATE = join(ROOT, 'infra', 'deploy.local.json');

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

// The test accounts: one admin and members with different grants, to check that each sees only its sources.
const TEST_USERS = [
  { email: `admin@${PREFIX}.invalid`, role: 'admin' },
  { email: `ba-translator@${PREFIX}.invalid`, grants: ['confluence-engdocs', 'sp-my-translator', 'sp-my-translator-mobile'] },
  { email: `sa-dbmate@${PREFIX}.invalid`, grants: ['sp-my-db-mate'] },
  { email: `brse-company@${PREFIX}.invalid`, grants: ['confluence-company', 'sp-company'] },
  { email: `pending@${PREFIX}.invalid` },
];

function outputs() {
  const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', STACK], { quiet: true })?.Stacks?.[0];
  return Object.fromEntries((stack?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
}

function managedPolicyId(kind, name) {
  const list = aws(['cloudfront', `list-${kind}-policies`, '--type', 'managed']);
  const items = list[`${kind.replace(/-(.)/g, (_, c) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase())}PolicyList`]?.Items || [];
  const key = kind === 'cache' ? 'CachePolicy' : kind === 'origin-request' ? 'OriginRequestPolicy' : 'ResponseHeadersPolicy';
  const hit = items.find((i) => i[key][`${key}Config`].Name === name);
  if (!hit) throw new Error(`No managed ${kind} policy ${name}`);
  return hit[key].Id;
}

function upload(name) {
  const zip = join(ROOT, 'dist', `${name}.zip`);
  const hash = createHash('sha256').update(readFileSync(zip)).digest('hex').slice(0, 16);
  const key = `code/${name}-${hash}.zip`;
  aws(['s3', 'cp', zip, `s3://${dataBucket()}/${key}`, '--only-show-errors'], { json: false });
  return key;
}

function up() {
  execFileSync('node', [join(ROOT, 'scripts', 'build.mjs')], { stdio: 'inherit' });
  state.originSecret ||= randomBytes(32).toString('hex');
  save();
  const admins = [TEST_USERS[0].email, ...String(env.POC3_ADMIN_EMAILS || '').split(',')].map((x) => x.trim().toLowerCase()).filter(Boolean);
  const params = {
    CodeBucket: dataBucket(),
    ApiCodeKey: upload('api'),
    MonitorCodeKey: upload('monitor'),
    OriginSecret: state.originSecret,
    AdminEmails: admins.join(','),
    AlertEmail: env.POC3_ALERT_EMAIL || '',
    KbLogGroup: LOG_GROUP,
    // Passed every time: deploy would otherwise keep the previous values.
    ChatModel: env.POC3_CHAT_MODEL || 'zai.glm-5',
    StudioModel: env.POC3_STUDIO_MODEL || 'zai.glm-5',
    CachingDisabledPolicyId: managedPolicyId('cache', 'Managed-CachingDisabled'),
    CachingOptimizedPolicyId: managedPolicyId('cache', 'Managed-CachingOptimized'),
    AllViewerExceptHostPolicyId: managedPolicyId('origin-request', 'Managed-AllViewerExceptHostHeader'),
    SecurityHeadersPolicyId: managedPolicyId('response-headers', 'Managed-SecurityHeadersPolicy'),
  };
  console.log(`deploying ${STACK} (CloudFront can take a few minutes)`);
  try {
    execFileSync('aws', ['cloudformation', 'deploy', '--stack-name', STACK, '--template-file', join(ROOT, 'infra', 'stack.yaml'),
      '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset', '--tags', `Project=${PREFIX}`,
      '--parameter-overrides', ...Object.entries(params).map(([k, v]) => `${k}=${v}`)], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  } catch (error) {
    const events = aws(['cloudformation', 'describe-stack-events', '--stack-name', STACK], { quiet: true })?.StackEvents || [];
    for (const e of events.filter((x) => /FAILED/.test(x.ResourceStatus)).slice(0, 8)) {
      console.error(`${e.LogicalResourceId} ${e.ResourceStatus} ${String(e.ResourceStatusReason || '').replace(/\d{12}/g, '<acct>').replace(/arn:aws:[^ "]+/g, '<arn>')}`);
    }
    throw new Error(`deploy failed: ${String(error.stderr || '').trim().split('\n').pop()}`);
  }
  console.log('stack ready');
  web();
}

function web() {
  const out = outputs();
  state.site = `https://${out.SiteDomain}`;
  save();
  const config = { region: env.AWS_REGION, userPoolId: out.UserPoolId, clientId: out.UserPoolClientId };
  aws(['s3', 'sync', join(ROOT, 'web'), `s3://${out.WebBucket}`, '--delete', '--only-show-errors', '--exclude', 'config.json',
    '--cache-control', 'no-cache'], { json: false });
  aws(['s3', 'cp', file('config.json', config).replace('file://', ''), `s3://${out.WebBucket}/config.json`, '--content-type', 'application/json',
    '--cache-control', 'no-cache', '--only-show-errors'], { json: false });
  aws(['cloudfront', 'create-invalidation', '--distribution-id', out.DistributionId, '--paths', '/*']);
  console.log('web UI published; the address is in infra/deploy.local.json (site)');
}

function users() {
  const out = outputs();
  state.users ||= {};
  for (const u of TEST_USERS) {
    const password = state.users[u.email] || `Poc3-${randomBytes(9).toString('base64url')}9a`;
    const exists = aws(['cognito-idp', 'admin-get-user', '--user-pool-id', out.UserPoolId, '--username', u.email], { quiet: true });
    if (!exists) {
      aws(['cognito-idp', 'admin-create-user', '--user-pool-id', out.UserPoolId, '--username', u.email, '--message-action', 'SUPPRESS',
        '--user-attributes', `Name=email,Value=${u.email}`, 'Name=email_verified,Value=true']);
    }
    aws(['cognito-idp', 'admin-set-user-password', '--user-pool-id', out.UserPoolId, '--username', u.email, '--password', password, '--permanent'], { json: false });
    state.users[u.email] = password;
    console.log(`${u.email.split('@')[0]}: ready`);
  }
  save();
  console.log('passwords are in infra/deploy.local.json (users); grants are given through the admin API by the e2e test');
}

// Puts an item through the CLI (the table is the stack's), as DynamoDB JSON.
function makeAdmin(email) {
  if (!email) throw new Error('make-admin needs an email');
  const e = email.trim().toLowerCase();
  const table = outputs().Table;
  const item = aws(['dynamodb', 'get-item', '--table-name', table, '--key', JSON.stringify({ pk: { S: `USER#${e}` }, sk: { S: 'PROFILE' } })]).Item;
  if (!item) throw new Error('That person has not signed in yet: sign in once, then run make-admin');
  aws(['dynamodb', 'update-item', '--table-name', table, '--key', JSON.stringify({ pk: { S: `USER#${e}` }, sk: { S: 'PROFILE' } }),
    '--update-expression', 'SET #r = :r, #s = :s, gsi1sk = :g', '--expression-attribute-names', JSON.stringify({ '#r': 'role', '#s': 'status' }),
    '--expression-attribute-values', JSON.stringify({ ':r': { S: 'admin' }, ':s': { S: 'active' }, ':g': { S: `active#${e}` } })]);
  console.log('admin: done');
}

function monitor() {
  const path = file('monitor-out.json', '').replace('file://', '');
  const meta = aws(['lambda', 'invoke', '--function-name', `${PREFIX}-monitor`, '--cli-read-timeout', '0', path]);
  if (meta.FunctionError) console.error(`monitor failed: ${readFileSync(path, 'utf8').slice(0, 500)}`);
  else console.log(JSON.stringify(JSON.parse(readFileSync(path, 'utf8')), null, 1));
}

function down() {
  const out = outputs();
  if (out.WebBucket) aws(['s3', 'rm', `s3://${out.WebBucket}`, '--recursive', '--only-show-errors'], { json: false, quiet: true });
  aws(['cloudformation', 'delete-stack', '--stack-name', STACK], { json: false });
  console.log(`deleting ${STACK} (CloudFront takes a while)`);
  aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', STACK], { json: false });
  aws(['s3', 'rm', `s3://${dataBucket()}/code/`, '--recursive', '--only-show-errors'], { json: false, quiet: true });
  delete state.site;
  save();
  console.log('app removed; the knowledge bases stay (node infra/kb.mjs down removes them)');
}

const [command, ...rest] = process.argv.slice(2);
const commands = { up, web, users, 'make-admin': () => makeAdmin(rest[0]), monitor, down };
if (!commands[command]) {
  console.error(`usage: node infra/deploy.mjs ${Object.keys(commands).join('|')}`);
  process.exit(1);
}
await commands[command]();
