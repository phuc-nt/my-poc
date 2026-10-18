// Orchestrator of the AIPF POC. One function, three kinds of caller:
// - the work item workflow (Step Functions), with { action, ... };
// - the HTTP API: the Jira webhook and the form a person uses to answer the platform;
// - EventBridge: pull request merged or closed in CodeCommit.
// It decides what happened in a session from CodeCommit and the table, not from the agent's word.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { SFNClient, StartExecutionCommand, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { CodeBuildClient, BatchGetBuildsCommand } from '@aws-sdk/client-codebuild';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { PostCommentForPullRequestCommand, GetPullRequestCommand } from '@aws-sdk/client-codecommit';
import { GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  REPO, TABLE, db, codecommit, settings, ISSUE_KEY, issueKeyOfBranch, jiraLink, jiraComment, jiraTransition,
  slack, prLink, openPullRequest,
} from './lib.mjs';

const sfn = new SFNClient({});
const codebuild = new CodeBuildClient({});
const logs = new CloudWatchLogsClient({});
const MAX_FAILURES = Number(process.env.MAX_FAILURES || 3);
const API_URL = process.env.API_URL;
const now = () => new Date().toISOString();

const getItem = async (pk, sk) => (await db.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }))).Item;
const putItem = (item) => db.send(new PutCommand({ TableName: TABLE, Item: item }));

async function updateRun(runId, fields) {
  const names = Object.keys(fields);
  await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `RUN#${runId}`, sk: 'RUN' },
    UpdateExpression: `SET ${names.map((n, i) => `#n${i} = :v${i}`).join(', ')}`,
    ExpressionAttributeNames: Object.fromEntries(names.map((n, i) => [`#n${i}`, n])),
    ExpressionAttributeValues: Object.fromEntries(names.map((n, i) => [`:v${i}`, fields[n]])),
  }));
}

async function prComment(prId, content) {
  if (!prId) return;
  const { pullRequest } = await codecommit.send(new GetPullRequestCommand({ pullRequestId: String(prId) }));
  const t = pullRequest.pullRequestTargets[0];
  await codecommit.send(new PostCommentForPullRequestCommand({
    pullRequestId: String(prId), repositoryName: REPO, beforeCommitId: t.destinationCommit, afterCommitId: t.sourceCommit,
    content: `[AIPF platform] ${content}`, clientRequestToken: randomUUID(),
  }));
}

// --- Workflow actions ---

async function startRun({ runId, issueKey, harness, model }) {
  if (!ISSUE_KEY.test(issueKey)) throw new Error(`not a work item key: ${issueKey}`);
  const run = { runId, issueKey, branch: `agent/${issueKey}`, harness: harness || 'claude-code', model: model || '', attempt: 1, failures: 0, exhausted: false };
  await putItem({ pk: `RUN#${runId}`, sk: 'RUN', ...run, status: 'running', startedAt: now(), attemptStartedAt: now() });
  await putItem({ pk: `ISSUE#${issueKey}`, sk: 'ACTIVE', runId, startedAt: now() });
  await slack(`AIPF started <${await jiraLink(issueKey)}|${issueKey}> with ${run.harness}${run.model ? ` (${run.model})` : ''}.`);
  return run;
}

async function afterDeveloper({ run }) {
  const item = await getItem(`RUN#${run.runId}`, 'RUN');
  const session = await getItem(`RUN#${run.runId}`, `SESSION#developer#${run.attempt}`);
  const { Items: questions = [] } = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: { ':pk': `ISSUE#${run.issueKey}`, ':from': `Q#${item.attemptStartedAt}`, ':to': 'Q#~' },
  }));
  const pr = await openPullRequest(run.branch);
  if (pr) await updateRun(run.runId, { prId: pr.pullRequestId });
  if (questions.length) return { outcome: 'needs_human', prId: pr?.pullRequestId || null, question: questions.map((q) => q.question).join('\n\n') };
  if (pr) return { outcome: 'pr', prId: pr.pullRequestId };
  const detail = !session
    ? 'The session left no record: it did not start or stopped early.'
    : [
      session.error && `Session error: ${session.error}`,
      session.timedOut && 'The session reached its time limit.',
      session.git && !session.git.pushed && `The branch was not pushed (${session.git.commitsAhead} commits ahead of main, ${session.git.uncommitted} files not committed).`,
      'No pull request is open for the branch.',
      session.finalText && `The session ended with:\n${session.finalText.slice(-1500)}`,
    ].filter(Boolean).join('\n');
  return { outcome: 'no_pr', prId: null, detail };
}

function feedbackText(reason, detail) {
  if (reason === 'answer') return `You asked a person:\n${detail.question}\n\nTheir answer:\n${detail.answer}`;
  if (reason === 'ci') return `CI failed on your branch. The end of the CI log:\n\n${detail}`;
  if (reason === 'changes') return `A person reviewed the pull request and asked for changes:\n\n${detail}`;
  return `The previous session did not open a pull request.\n${detail}`;
}

async function nextAttempt({ run, reason, detail }) {
  const failures = run.failures + (reason === 'answer' ? 0 : 1);
  const next = { ...run, attempt: run.attempt + 1, failures, exhausted: failures >= MAX_FAILURES, lastReason: reason };
  await updateRun(run.runId, { attempt: next.attempt, failures, feedback: feedbackText(reason, detail), attemptStartedAt: now(), lastReason: reason });
  return next;
}

async function ciFailed({ run, prId, error }) {
  const cause = typeof error?.Cause === 'string' ? error.Cause : JSON.stringify(error || {});
  const buildId = (cause.match(/[\w-]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0];
  let tail = `CI did not run to the end: ${error?.Error || 'unknown error'}`;
  if (buildId) {
    const { builds = [] } = await codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const b = builds[0];
    if (b?.logs?.groupName && b.logs.streamName) {
      const { events = [] } = await logs.send(new GetLogEventsCommand({ logGroupName: b.logs.groupName, logStreamName: b.logs.streamName, limit: 80, startFromHead: false }));
      const failed = (b.phases || []).filter((p) => p.phaseStatus === 'FAILED').map((p) => p.phaseType).join(', ');
      tail = `Failed phase: ${failed || 'unknown'}\n\n${events.map((e) => e.message.trimEnd()).join('\n').slice(-6000)}`;
    }
  }
  await prComment(prId, `CI failed. The developer agent restarts with this log.\n\n\`\`\`\n${tail.slice(-3000)}\n\`\`\``);
  return nextAttempt({ run, reason: 'ci', detail: tail });
}

async function askHuman({ token, run, question }) {
  const id = randomUUID();
  await putItem({ pk: `HUMAN#${id}`, sk: 'HUMAN', kind: 'question', token, runId: run.runId, issueKey: run.issueKey, question, createdAt: now() });
  await slack(`AIPF needs an answer on <${await jiraLink(run.issueKey)}|${run.issueKey}>. The developer agent asks:\n>${question.replaceAll('\n', '\n>')}\nAnswer here: ${API_URL}/human/${id}`);
}

async function requestApproval({ token, run, prId }) {
  const id = randomUUID();
  const review = await getItem(`RUN#${run.runId}`, `SESSION#reviewer#${run.attempt}`);
  await putItem({ pk: `HUMAN#${id}`, sk: 'HUMAN', kind: 'approval', token, runId: run.runId, issueKey: run.issueKey, prId, createdAt: now() });
  await putItem({ pk: `ISSUE#${run.issueKey}`, sk: 'APPROVAL', humanId: id, prId, token });
  await prComment(prId, 'CI passed. Waiting for a person to review.');
  const verdict = review?.verdict ? `The reviewer agent says: *${review.verdict}*.` : 'The reviewer agent gave no verdict.';
  await slack([
    `AIPF: pull request ${prId} for <${await jiraLink(run.issueKey)}|${run.issueKey}> passed CI and is ready for your review. ${verdict}`,
    `Review it: ${prLink(prId)}`,
    'To accept it, approve and merge it in CodeCommit. To ask for changes, write them here:',
    `${API_URL}/human/${id}`,
  ].join('\n'));
}

async function finish(run, status) {
  await updateRun(run.runId, { status, endedAt: now() });
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `ISSUE#${run.issueKey}`, sk: 'ACTIVE' } }));
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `ISSUE#${run.issueKey}`, sk: 'APPROVAL' } }));
}

async function done({ run, prId }) {
  await jiraComment(run.issueKey, `[AIPF platform] Pull request ${prId} was merged. ${prLink(prId)}`);
  const moved = await jiraTransition(run.issueKey, 'Done');
  await finish(run, 'done');
  await slack(`AIPF finished <${await jiraLink(run.issueKey)}|${run.issueKey}>: pull request ${prId} merged${moved.moved ? ', work item moved to Done' : ''}.`);
  return { moved };
}

async function escalate({ run, reason }) {
  await finish(run, 'escalated');
  const text = `AIPF stopped work on ${run.issueKey} and needs a person: ${reason}.`;
  await jiraComment(run.issueKey, `[AIPF platform] ${text}`).catch((e) => console.error(e.message));
  await slack(`${text} <${await jiraLink(run.issueKey)}|Work item>`);
}

const ACTIONS = { startRun, afterDeveloper, nextAttempt, ciFailed, askHuman, requestApproval, done, escalate };

// --- HTTP API ---

const html = (statusCode, title, body) => ({
  statusCode,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f}textarea{width:100%;min-height:9rem;font:inherit}
blockquote{border-left:3px solid #999;margin:0;padding-left:1rem;white-space:pre-wrap}button{font:inherit;padding:.5rem 1.2rem}</style></head>
<body><h1>${title}</h1>${body}</body></html>`,
});
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function sameSecret(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function jiraWebhook(event) {
  const s = await settings();
  if (!sameSecret(event.pathParameters?.secret, s.WEBHOOK_SECRET)) return { statusCode: 404, body: '' };
  const body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body || '{}');
  const issue = body.issue || {};
  const labels = issue.fields?.labels || [];
  const labelChange = (body.changelog?.items || []).find((i) => i.field === 'labels');
  const justLabelled = body.webhookEvent === 'jira:issue_created' || (labelChange && /\baipf\b/.test(labelChange.toString || '') && !/\baipf\b/.test(labelChange.fromString || ''));
  if (!issue.key || !labels.includes('aipf') || !justLabelled) return { statusCode: 204, body: '' };
  if (s.JIRA_PROJECT_KEY && !issue.key.startsWith(`${s.JIRA_PROJECT_KEY}-`)) return { statusCode: 204, body: '' };
  const runId = `${issue.key}-${Date.now()}`;
  try {
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `ISSUE#${issue.key}`, sk: 'ACTIVE', runId, startedAt: now() }, ConditionExpression: 'attribute_not_exists(pk)' }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return { statusCode: 202, body: 'already running' };
    throw err;
  }
  const harness = labels.includes('aipf-opencode') ? 'opencode' : 'claude-code';
  await sfn.send(new StartExecutionCommand({ stateMachineArn: process.env.STATE_MACHINE_ARN, name: runId, input: JSON.stringify({ issueKey: issue.key, harness }) }));
  return { statusCode: 202, body: 'started' };
}

async function humanPage(event) {
  const id = event.pathParameters?.id || '';
  const item = /^[0-9a-f-]{36}$/.test(id) ? await getItem(`HUMAN#${id}`, 'HUMAN') : null;
  if (!item) return html(404, 'Not found', '<p>This link is not valid.</p>');
  if (item.answeredAt) return html(200, 'Already answered', `<p>This was answered at ${escape(item.answeredAt)}.</p>`);
  const issue = `<a href="${escape(await jiraLink(item.issueKey))}">${escape(item.issueKey)}</a>`;
  if (event.requestContext.http.method === 'GET') {
    const intro = item.kind === 'question'
      ? `<p>The developer agent working on ${issue} asks:</p><blockquote>${escape(item.question)}</blockquote>`
      : `<p>Pull request <a href="${escape(prLink(item.prId))}">${escape(item.prId)}</a> for ${issue} is waiting for you. To accept it, approve and merge it in CodeCommit; nothing is needed here. To ask for changes, describe them below and the developer agent will make them.</p>`;
    const label = item.kind === 'question' ? 'Your answer' : 'Changes you want';
    return html(200, 'AIPF', `${intro}<form method="post"><p><label>${label}<br><textarea name="text" required></textarea></label></p><button>Send</button></form>`);
  }
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '';
  const text = (new URLSearchParams(raw).get('text') || '').trim().slice(0, 8000);
  if (!text) return html(400, 'Empty', '<p>Write something first.</p>');
  await db.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: `HUMAN#${id}`, sk: 'HUMAN' },
    UpdateExpression: 'SET answeredAt = :t, answer = :a', ConditionExpression: 'attribute_not_exists(answeredAt)',
    ExpressionAttributeValues: { ':t': now(), ':a': text },
  }));
  const output = item.kind === 'question' ? { answer: text } : { decision: 'changes', feedback: text };
  if (item.kind === 'approval') await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `ISSUE#${item.issueKey}`, sk: 'APPROVAL' } }));
  await sfn.send(new SendTaskSuccessCommand({ taskToken: item.token, output: JSON.stringify(output) }));
  return html(200, 'Thank you', `<p>Sent. The developer agent continues on ${issue}.</p>`);
}

// --- EventBridge: pull request merged or closed ---

async function pullRequestEvent(detail) {
  const key = issueKeyOfBranch(detail.sourceReference);
  if (!key) return;
  const approval = await getItem(`ISSUE#${key}`, 'APPROVAL');
  if (!approval || String(approval.prId) !== String(detail.pullRequestId)) return;
  let output;
  if (detail.event === 'pullRequestMergeStatusUpdated' && String(detail.isMerged) === 'True') output = { decision: 'merged' };
  else if (detail.event === 'pullRequestStatusChanged' && detail.pullRequestStatus === 'Closed' && String(detail.isMerged) !== 'True') output = { decision: 'closed' };
  if (!output) return;
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `ISSUE#${key}`, sk: 'APPROVAL' } }));
  await sfn.send(new SendTaskSuccessCommand({ taskToken: approval.token, output: JSON.stringify(output) }));
}

export async function handler(event) {
  if (event.action) {
    const action = ACTIONS[event.action];
    if (!action) throw new Error(`unknown action ${event.action}`);
    return action(event);
  }
  if (event.routeKey) {
    try {
      if (event.routeKey === 'POST /jira/{secret}') return await jiraWebhook(event);
      return await humanPage(event);
    } catch (err) {
      console.error(err);
      return html(500, 'Error', '<p>Something went wrong. Check the orchestrator logs.</p>');
    }
  }
  if (event.source === 'aws.codecommit') return pullRequestEvent(event.detail || {});
  throw new Error('unknown event');
}
