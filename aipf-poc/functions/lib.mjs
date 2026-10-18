// Shared by the tools and orchestrator functions: settings, Jira, Slack, CodeCommit and the table.
// Jira and Slack credentials are read here, in Lambda, and never reach the sandbox.
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CodeCommitClient, ListPullRequestsCommand, GetPullRequestCommand } from '@aws-sdk/client-codecommit';

export const REGION = process.env.AWS_REGION;
export const TABLE = process.env.TABLE;
export const REPO = process.env.REPO_NAME;
export const BUCKET = process.env.BUCKET;

export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
export const codecommit = new CodeCommitClient({});
const secrets = new SecretsManagerClient({});

let cached;
export async function settings() {
  if (!cached) {
    const r = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ID }));
    cached = JSON.parse(r.SecretString);
  }
  return cached;
}

export const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
export const issueKeyOfBranch = (ref) => (String(ref).replace(/^refs\/heads\//, '').match(/^agent\/([A-Z][A-Z0-9_]+-\d+)$/) || [])[1] || null;

export async function checkIssueKey(key) {
  if (!ISSUE_KEY.test(String(key || ''))) throw new Error(`not a work item key: ${key}`);
  const project = (await settings()).JIRA_PROJECT_KEY;
  if (project && !key.startsWith(`${project}-`)) throw new Error(`work item ${key} is outside project ${project}`);
  return key;
}

// --- Jira ---

export async function jira(method, path, body) {
  const s = await settings();
  const res = await fetch(`${s.JIRA_BASE_URL.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${s.JIRA_EMAIL}:${s.JIRA_API_TOKEN}`).toString('base64')}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira ${method} ${path.split('?')[0]}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

export const jiraLink = async (key) => `${(await settings()).JIRA_BASE_URL.replace(/\/$/, '')}/browse/${key}`;

// Plain text to Atlassian Document Format: paragraphs on blank lines, line breaks kept.
export function adf(text) {
  const paragraphs = String(text).split(/\n{2,}/).map((block) => ({
    type: 'paragraph',
    content: block.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
  }));
  return { type: 'doc', version: 1, content: paragraphs };
}

// Atlassian Document Format to plain text.
export function adfText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (['mention', 'emoji'].includes(node.type)) return node.attrs?.text || '';
  if (node.type === 'inlineCard') return node.attrs?.url || '';
  const inner = (node.content || []).map(adfText).join('');
  if (node.type === 'listItem') return `- ${inner.trim()}\n`;
  if (['paragraph', 'heading', 'codeBlock', 'blockquote'].includes(node.type)) return `${inner}\n\n`;
  return inner;
}

export async function jiraComment(key, text) {
  await jira('POST', `/rest/api/3/issue/${key}/comment`, { body: adf(text) });
}

export async function jiraTransition(key, to) {
  const { transitions = [] } = await jira('GET', `/rest/api/3/issue/${key}/transitions`);
  const match = transitions.find((t) => t.to?.name?.toLowerCase() === String(to).toLowerCase() || t.name.toLowerCase() === String(to).toLowerCase());
  if (!match) return { moved: false, available: transitions.map((t) => t.to?.name || t.name) };
  await jira('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: match.id } });
  return { moved: true, status: match.to?.name || match.name };
}

// --- Slack ---

export async function slack(text) {
  const s = await settings();
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: s.SLACK_CHANNEL, text, unfurl_links: false, unfurl_media: false }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Slack chat.postMessage: ${body.error}`);
  return body.ts;
}

// --- CodeCommit ---

export const prLink = (id) =>
  `https://${REGION}.console.aws.amazon.com/codesuite/codecommit/repositories/${REPO}/pull-requests/${id}/details?region=${REGION}`;

export async function openPullRequest(branch) {
  let nextToken;
  do {
    const page = await codecommit.send(new ListPullRequestsCommand({ repositoryName: REPO, pullRequestStatus: 'OPEN', nextToken }));
    for (const id of page.pullRequestIds || []) {
      const { pullRequest } = await codecommit.send(new GetPullRequestCommand({ pullRequestId: id }));
      if (pullRequest.pullRequestTargets?.some((t) => t.sourceReference === `refs/heads/${branch}`)) return pullRequest;
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return null;
}
