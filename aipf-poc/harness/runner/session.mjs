#!/usr/bin/env node
// Session runner of the AIPF proof of concept.
//
//   session.mjs setup   in the environment snapshot build: install the repository's dependencies
//                       and run its unit tests (commands from .aipf/environment.yaml)
//   session.mjs run     in a sandbox: prepare the workspace, run one agent CLI on one role and
//                       work item, and record the transcript and measures in S3 and DynamoDB
//
// `run` reads AIPF_ROLE (developer | reviewer), AIPF_HARNESS (claude-code | opencode),
// AIPF_ISSUE_KEY, AIPF_RUN_ID, AIPF_ATTEMPT, AIPF_PR_ID (reviewer), AIPF_MODEL, AIPF_GATEWAY_URL,
// AIPF_REPO, AIPF_BUCKET, AIPF_TABLE, AIPF_TIMEOUT_MIN and AIPF_MAX_TURNS. Without a gateway
// (a run by hand), AIPF_TASK_TEXT gives the work item and AIPF_GIT_REMOTE another remote.
// It exits 0 whatever the agent did: the workflow decides what happened from what is in
// CodeCommit, Jira and DynamoDB, not from the agent's word.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import YAML from 'yaml';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import * as claudeCode from './adapters/claude-code.mjs';
import * as opencode from './adapters/opencode.mjs';

const ADAPTERS = { [claudeCode.name]: claudeCode, [opencode.name]: opencode };
const env = process.env;
const WORKSPACE = env.AIPF_WORKSPACE || '/workspace';
const REGISTRY = env.AIPF_REGISTRY || path.join(import.meta.dirname, '..', 'registry');
const REGION = env.AWS_REGION || env.AWS_DEFAULT_REGION;
const SNAPSHOT_FILE = path.join(WORKSPACE, '.git', 'aipf-snapshot');
// Files whose change means the snapshot's installed dependencies are stale.
const DEPENDENCY_FILES = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|poetry\.lock|uv\.lock|go\.sum|pom\.xml|build\.gradle(\.kts)?)$/;
// Words of a refused call, in a tool result.
const REFUSED = /policy|not authori[sz]ed|access ?denied|forbidden|permission denied|denied/i;

// The subscription token goes to the Claude Code process only, never to setup, tests or other CLIs.
const secrets = { claudeToken: env.CLAUDE_CODE_OAUTH_TOKEN && env.CLAUDE_CODE_OAUTH_TOKEN !== 'unset' ? env.CLAUDE_CODE_OAUTH_TOKEN : '' };
delete env.CLAUDE_CODE_OAUTH_TOKEN;

const log = (msg) => console.error(`[aipf] ${new Date().toISOString()} ${msg}`);

function required(name) {
  if (!env[name]) throw new Error(`${name} is not set`);
  return env[name];
}

function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: WORKSPACE, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

function loadSpec() {
  const file = path.join(WORKSPACE, '.aipf', 'environment.yaml');
  if (!fs.existsSync(file)) throw new Error('.aipf/environment.yaml is missing: the repository is not AI-ready');
  const spec = YAML.parse(fs.readFileSync(file, 'utf8'));
  return { ...spec, commands: spec.commands || {}, services: spec.services || {}, env: spec.env || {} };
}

const commandEnv = (spec) => ({ ...env, ...Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, String(v)])) });

// A command from the specification, its output in the task log.
function sh(spec, label, command, { quiet = false, capture = false } = {}) {
  if (!command) return true;
  if (!quiet) log(`${label}: ${command}`);
  if (capture) {
    const r = spawnSync('bash', ['-c', `(${command}) 2>&1`], { cwd: WORKSPACE, env: commandEnv(spec), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    process.stderr.write(r.stdout || '');
    return { ok: r.status === 0, output: r.stdout || '' };
  }
  const r = spawnSync('bash', ['-c', command], { cwd: WORKSPACE, env: commandEnv(spec), stdio: ['ignore', quiet ? 'ignore' : 2, quiet ? 'ignore' : 2] });
  return r.status === 0;
}

function setup() {
  const spec = loadSpec();
  if (!sh(spec, 'setup', spec.commands.setup)) throw new Error('setup failed');
  if (!sh(spec, 'unit tests', spec.commands.test_unit)) throw new Error('unit tests failed');
  fs.writeFileSync(SNAPSHOT_FILE, git(['rev-parse', 'HEAD']).out);
  log('snapshot ready');
}

function prepareWorkspace({ role, branch, adapter }) {
  const remote = env.AIPF_GIT_REMOTE || `codecommit::${REGION}://${required('AIPF_REPO')}`;
  git(['remote', 'set-url', 'origin', remote]);
  git(['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
  const hasBranch = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { allowFail: true }).ok;
  if (role === 'developer') {
    git(['checkout', '-f', '-B', branch, hasBranch ? `origin/${branch}` : 'origin/main']);
  } else {
    if (!hasBranch) throw new Error(`branch ${branch} is not in the repository`);
    git(['checkout', '-f', '--detach', `origin/${branch}`]);
  }
  git(['config', 'user.name', `AIPF ${role} agent`]);
  git(['config', 'user.email', `aipf-${role}@agents.invalid`]);
  if (adapter.instructionFile) {
    const file = path.join(WORKSPACE, adapter.instructionFile.path);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, adapter.instructionFile.content);
      fs.appendFileSync(path.join(WORKSPACE, '.git', 'info', 'exclude'), `\n${adapter.instructionFile.path}\n`);
    }
  }
  log(`workspace at ${git(['rev-parse', '--short', 'HEAD']).out} on ${role === 'developer' ? branch : `detached ${branch}`}`);
}

function prepareEnvironment() {
  const spec = loadSpec();
  const snapshot = fs.existsSync(SNAPSHOT_FILE) ? fs.readFileSync(SNAPSHOT_FILE, 'utf8').trim() : '';
  const changed = snapshot ? git(['diff', '--name-only', snapshot, 'HEAD'], { allowFail: true }).out.split('\n') : [];
  if (!snapshot || changed.some((f) => DEPENDENCY_FILES.test(f))) {
    if (!sh(spec, 'setup (dependencies changed since the snapshot)', spec.commands.setup)) throw new Error('setup failed');
  }
  for (const [name, service] of Object.entries(spec.services)) {
    if (!service.ready) continue;
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = sh(spec, `wait for ${name}`, service.ready, { quiet: true });
      if (!ready) spawnSync('sleep', ['2']);
    }
    if (!ready) throw new Error(`service ${name} is not ready`);
    log(`service ${name} ready`);
  }
  // A failing prepare on an agent branch is usually the agent's own change (a migration, a seed). The session still
  // runs and the agent gets the output, or every later attempt would stop here without the agent ever seeing why.
  const prepared = sh(spec, 'prepare', spec.commands.prepare, { capture: true });
  if (prepared !== true && !prepared.ok) log('prepare failed: the agent gets its output');
  return { spec, prepareFailure: prepared === true || prepared.ok ? '' : prepared.output.slice(-6000) };
}

function composePrompt({ role, issueKey, branch, prId, attempt, feedback, hasGateway }) {
  const fill = (text) => text.replaceAll('{{ISSUE_KEY}}', issueKey).replaceAll('{{BRANCH}}', branch).replaceAll('{{PR_ID}}', prId || 'unknown');
  const parts = [fill(fs.readFileSync(path.join(REGISTRY, 'roles', `${role}.md`), 'utf8'))];
  parts.push(role === 'developer'
    ? `## Your task\n\nTake Jira work item ${issueKey} to a pull request from \`${branch}\`. This is attempt ${attempt}.`
    : `## Your task\n\nReview pull request ${prId} for Jira work item ${issueKey}.`);
  if (!hasGateway) {
    parts.push('The platform tools are not connected in this session. Work from the repository alone and skip the steps that need them.');
    if (env.AIPF_TASK_TEXT) parts.push(`## The work item\n\n${env.AIPF_TASK_TEXT}`);
  }
  if (feedback) {
    parts.push(`## Feedback on the previous attempt\n\nAddress this first. If a pull request is already open for \`${branch}\`, keep it: push to the same branch.\n\n${feedback.slice(0, 20000)}`);
  }
  return parts.join('\n\n') + '\n';
}

async function runAgent({ adapter, prompt, sessionDir, spec }) {
  const gatewayUrl = env.AIPF_GATEWAY_URL;
  const mcpServer = gatewayUrl
    ? { command: 'mcp-proxy-for-aws', args: [gatewayUrl, '--service', 'bedrock-agentcore', '--region', REGION, '--disable-telemetry'] }
    : null;
  const cli = adapter.command({
    prompt, sessionDir, mcpServer, region: REGION, secrets,
    model: env.AIPF_MODEL || '',
    maxTurns: Number(env.AIPF_MAX_TURNS || 80),
  });
  const files = {
    raw: fs.createWriteStream(path.join(sessionDir, 'raw.jsonl')),
    events: fs.createWriteStream(path.join(sessionDir, 'events.jsonl')),
    stderr: fs.createWriteStream(path.join(sessionDir, 'stderr.log')),
  };
  const s = {
    exitCode: null, timedOut: false, stopped: false, mcpTools: [], toolCalls: {}, toolCallCount: 0, toolErrors: 0,
    refusals: [], deniedCommands: [], errors: [], turns: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null,
    finalText: '', finalOk: null,
  };
  const calls = new Map();
  let lastText = '';
  const started = Date.now();
  log(`agent: ${adapter.name}${env.AIPF_MODEL ? ` (${env.AIPF_MODEL})` : ''}, gateway ${gatewayUrl ? 'on' : 'off'}`);

  // The agent's shell gets the specification's variables, so the repository's commands work as documented.
  const child = spawn(cli.cmd, cli.args, { cwd: WORKSPACE, env: { ...commandEnv(spec), ...cli.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const limitMin = Number(env.AIPF_TIMEOUT_MIN || 40);
  const timer = setTimeout(() => {
    s.timedOut = true;
    log(`time limit of ${limitMin} min reached: stopping the agent`);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 15000).unref();
  }, limitMin * 60000);
  // ECS sends SIGTERM when the workflow is stopped; node as PID 1 would ignore it. Stop the agent and still record
  // the session within the 30 s before SIGKILL.
  process.once('SIGTERM', () => {
    s.stopped = true;
    log('stopped from outside: stopping the agent');
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10000).unref();
  });
  child.stderr.on('data', (chunk) => { files.stderr.write(chunk); });

  const lines = readline.createInterface({ input: child.stdout });
  for await (const line of lines) {
    if (!line.trim()) continue;
    files.raw.write(line + '\n');
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    for (const e of adapter.normalize(obj)) {
      e.t = Date.now() - started;
      files.events.write(JSON.stringify(e) + '\n');
      if (e.type === 'init') s.mcpTools = e.tools || [];
      if (e.type === 'text') lastText = e.text;
      if (e.type === 'tool_call') {
        calls.set(e.id, e);
        s.toolCalls[e.tool] = (s.toolCalls[e.tool] || 0) + 1;
        s.toolCallCount++;
        log(`tool ${e.tool}`);
      }
      if (e.type === 'tool_result') {
        const call = calls.get(e.id) || {};
        const tool = call.tool || 'unknown';
        if (e.isError) s.toolErrors++;
        const output = String(e.output || '').slice(0, 500);
        if (tool.startsWith('aipf:') && e.isError && REFUSED.test(output)) {
          s.refusals.push({ tool, output });
          log(`refused ${tool}`);
        } else if (!tool.startsWith('aipf:') && /git\s+push|merge/.test(JSON.stringify(call.input || '')) && /denied|not authori[sz]ed|403|rejected/i.test(output)) {
          s.deniedCommands.push({ tool, input: JSON.stringify(call.input).slice(0, 300), output });
          log(`denied command in ${tool}`);
        }
      }
      if (e.type === 'usage') {
        for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) s[k] += e[k] || 0;
        if (e.costUsd != null) s.costUsd = (s.costUsd || 0) + e.costUsd;
        s.turns += e.turns || 0;
      }
      if (e.type === 'final') { s.finalText = e.text; s.finalOk = e.ok; }
      if (e.type === 'error') s.errors.push(String(e.text).slice(0, 500));
    }
  }
  s.exitCode = await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.on('close', (code, signal) => resolve(code ?? signal));
  });
  clearTimeout(timer);
  await Promise.all(Object.values(files).map((f) => new Promise((r) => f.end(r))));
  if (!s.finalText) s.finalText = lastText;
  s.finalText = s.finalText.slice(0, 4000);
  s.verdict = (s.finalText.match(/Verdict:\s*\**\s*(approve|changes)/i) || [])[1]?.toLowerCase() || null;
  s.agentSec = Math.round((Date.now() - started) / 1000);
  s.refusals = s.refusals.slice(0, 20);
  s.deniedCommands = s.deniedCommands.slice(0, 20);
  s.refusalCount = s.refusals.length;
  log(`agent ended: exit ${s.exitCode}, ${s.agentSec}s, ${s.toolCallCount} tool calls, ${s.refusalCount} refused`);
  return s;
}

function gitFacts(branch) {
  git(['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], { allowFail: true });
  const head = git(['rev-parse', 'HEAD'], { allowFail: true }).out;
  const remote = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { allowFail: true }).out;
  return {
    head,
    pushed: Boolean(remote) && remote === head,
    commitsAhead: Number(git(['rev-list', '--count', 'origin/main..HEAD'], { allowFail: true }).out || 0),
    changedFiles: git(['diff', '--name-only', 'origin/main...HEAD'], { allowFail: true }).out.split('\n').filter(Boolean).slice(0, 50),
    uncommitted: git(['status', '--porcelain'], { allowFail: true }).out.split('\n').filter(Boolean).length,
    mainHead: git(['rev-parse', 'origin/main'], { allowFail: true }).out,
  };
}

async function getRun(runId) {
  if (!env.AIPF_TABLE) return null;
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const r = await db.send(new GetCommand({ TableName: env.AIPF_TABLE, Key: { pk: `RUN#${runId}`, sk: 'RUN' } }));
  return r.Item || null;
}

async function record({ summary, sessionDir, prompt }) {
  fs.writeFileSync(path.join(sessionDir, 'prompt.md'), prompt || '');
  fs.writeFileSync(path.join(sessionDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const prefix = `transcripts/${summary.runId}/${summary.role}-${summary.attempt}`;
  if (env.AIPF_BUCKET) {
    const s3 = new S3Client({ region: REGION });
    for (const name of ['raw.jsonl', 'events.jsonl', 'stderr.log', 'summary.json', 'prompt.md']) {
      const file = path.join(sessionDir, name);
      if (!fs.existsSync(file)) continue;
      await s3.send(new PutObjectCommand({ Bucket: env.AIPF_BUCKET, Key: `${prefix}/${name}`, Body: fs.readFileSync(file) }));
    }
    summary.transcript = `s3://${env.AIPF_BUCKET}/${prefix}/`;
  }
  if (env.AIPF_TABLE) {
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
    await db.send(new PutCommand({
      TableName: env.AIPF_TABLE,
      Item: { pk: `RUN#${summary.runId}`, sk: `SESSION#${summary.role}#${summary.attempt}`, ...summary },
    }));
  }
  console.log(JSON.stringify({ aipfSession: { ...summary, finalText: summary.finalText?.slice(0, 500) } }));
}

async function run() {
  const role = required('AIPF_ROLE');
  if (!['developer', 'reviewer'].includes(role)) throw new Error(`unknown role ${role}`);
  const harness = env.AIPF_HARNESS || claudeCode.name;
  const adapter = ADAPTERS[harness];
  if (!adapter) throw new Error(`unknown harness ${harness}; known: ${Object.keys(ADAPTERS).join(', ')}`);
  const issueKey = required('AIPF_ISSUE_KEY');
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(issueKey)) throw new Error(`not a work item key: ${issueKey}`);
  const runId = required('AIPF_RUN_ID');
  const attempt = Number(env.AIPF_ATTEMPT || 1);
  const branch = `agent/${issueKey}`;
  const prId = env.AIPF_PR_ID || '';
  const sessionDir = fs.mkdtempSync('/tmp/aipf-session-');
  const startedAt = Date.now();
  const summary = {
    runId, role, harness, issueKey, attempt, branch, prId,
    model: env.AIPF_MODEL || adapter.defaultModel || 'subscription default',
    startedAt: new Date(startedAt).toISOString(),
    task: env.ECS_CONTAINER_METADATA_URI_V4 ? path.basename(env.ECS_CONTAINER_METADATA_URI_V4) : 'local',
  };
  let phase = 'start';
  let prompt = '';
  try {
    phase = 'run record';
    const item = await getRun(runId);
    let feedback = item?.feedback || env.AIPF_FEEDBACK || '';
    phase = 'workspace';
    prepareWorkspace({ role, branch, adapter });
    phase = 'environment';
    const envStarted = Date.now();
    const { spec, prepareFailure } = prepareEnvironment();
    summary.environmentSec = Math.round((Date.now() - envStarted) / 1000);
    if (prepareFailure) {
      summary.prepareFailed = true;
      feedback = `The environment's prepare command (\`${spec.commands.prepare}\`) failed on this branch before your session started, `
        + `so the database is not fully set up. CI runs the same command on an empty database. Fix the cause first, then run the command again. `
        + `Its output:\n\n\`\`\`\n${prepareFailure}\n\`\`\`\n\n${feedback}`;
    }
    phase = 'agent';
    prompt = composePrompt({ role, issueKey, branch, prId, attempt, feedback, hasGateway: Boolean(env.AIPF_GATEWAY_URL) });
    Object.assign(summary, await runAgent({ adapter, prompt, sessionDir, spec }));
    phase = 'git';
    if (role === 'developer') summary.git = gitFacts(branch);
  } catch (err) {
    summary.error = `${phase}: ${err.message}`;
    log(`session error in ${summary.error}`);
  }
  summary.endedAt = new Date().toISOString();
  summary.durationSec = Math.round((Date.now() - startedAt) / 1000);
  await record({ summary, sessionDir, prompt });
}

const command = process.argv[2] || 'run';
try {
  if (command === 'setup') setup();
  else if (command === 'run') await run();
  else throw new Error(`unknown command ${command}; use setup or run`);
} catch (err) {
  log(err.message);
  process.exit(1);
}
