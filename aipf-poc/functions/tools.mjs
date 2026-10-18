// Lambda target of the AgentCore Gateway: the platform tools of the agents (Jira, pull requests,
// project memory, asking a person). The gateway checks the caller's role against the policy first;
// this function trusts that check and keeps only the limits of the POC project (one Jira project,
// one repository, pull requests into main).
import { randomUUID } from 'node:crypto';
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  CreatePullRequestCommand, GetPullRequestCommand, PostCommentForPullRequestCommand,
  GetDifferencesCommand, GetCommentsForPullRequestCommand, GetBranchCommand,
} from '@aws-sdk/client-codecommit';
import {
  BUCKET, REPO, TABLE, db, codecommit, checkIssueKey, issueKeyOfBranch, jira, jiraLink, adfText,
  jiraComment, jiraTransition, prLink, openPullRequest,
} from './lib.mjs';

const s3 = new S3Client({});
const SIGNATURE = '[AIPF agent]';
const MEMORY_PATH = /^[A-Za-z0-9_-][A-Za-z0-9_./-]{0,120}$/;

function memoryPath(path) {
  if (!MEMORY_PATH.test(String(path || '')) || path.includes('..')) throw new Error(`not a memory note path: ${path}`);
  return path;
}

const TOOLS = {
  async jira___get_issue({ issue_key }) {
    const key = await checkIssueKey(issue_key);
    const issue = await jira('GET', `/rest/api/3/issue/${key}?fields=summary,description,status,labels,issuetype,priority,comment`);
    const f = issue.fields;
    return {
      key,
      link: await jiraLink(key),
      summary: f.summary,
      type: f.issuetype?.name,
      status: f.status?.name,
      priority: f.priority?.name,
      labels: f.labels,
      description: adfText(f.description).trim(),
      comments: (f.comment?.comments || []).slice(-10).map((c) => ({ author: c.author?.displayName, created: c.created, body: adfText(c.body).trim() })),
    };
  },

  async jira___add_comment({ issue_key, body }) {
    const key = await checkIssueKey(issue_key);
    if (!String(body || '').trim()) throw new Error('body is empty');
    await jiraComment(key, `${SIGNATURE} ${body}`);
    return { commented: true, issue: key };
  },

  async jira___transition({ issue_key, to }) {
    const key = await checkIssueKey(issue_key);
    return jiraTransition(key, to);
  },

  async codecommit___create_pull_request({ title, description, source_branch }) {
    const branch = String(source_branch || '').replace(/^refs\/heads\//, '');
    if (!branch || branch === 'main') throw new Error('source_branch must be a branch other than main');
    await codecommit.send(new GetBranchCommand({ repositoryName: REPO, branchName: branch })).catch(() => {
      throw new Error(`branch ${branch} is not in the repository; push it first`);
    });
    const existing = await openPullRequest(branch);
    if (existing) return { pull_request_id: existing.pullRequestId, link: prLink(existing.pullRequestId), note: 'A pull request is already open for this branch; pushing updates it.' };
    const { pullRequest } = await codecommit.send(new CreatePullRequestCommand({
      title: String(title).slice(0, 150),
      description: String(description || '').slice(0, 10000),
      targets: [{ repositoryName: REPO, sourceReference: branch, destinationReference: 'main' }],
      clientRequestToken: randomUUID(),
    }));
    const key = issueKeyOfBranch(branch);
    if (key) {
      await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `ISSUE#${key}`, sk: 'PR', pullRequestId: pullRequest.pullRequestId, branch, createdAt: new Date().toISOString() } }));
    }
    return { pull_request_id: pullRequest.pullRequestId, link: prLink(pullRequest.pullRequestId) };
  },

  async codecommit___get_pull_request({ pull_request_id }) {
    const { pullRequest: pr } = await codecommit.send(new GetPullRequestCommand({ pullRequestId: String(pull_request_id) }));
    const target = pr.pullRequestTargets[0];
    if (target.repositoryName !== REPO) throw new Error('pull request is outside the project repository');
    const diff = await codecommit.send(new GetDifferencesCommand({
      repositoryName: REPO, beforeCommitSpecifier: target.mergeBase || target.destinationCommit, afterCommitSpecifier: target.sourceCommit,
    }));
    const comments = await codecommit.send(new GetCommentsForPullRequestCommand({ pullRequestId: pr.pullRequestId, maxResults: 50 }));
    return {
      pull_request_id: pr.pullRequestId,
      link: prLink(pr.pullRequestId),
      title: pr.title,
      description: pr.description,
      status: pr.pullRequestStatus,
      source: target.sourceReference,
      destination: target.destinationReference,
      merged: target.mergeMetadata?.isMerged,
      files: (diff.differences || []).map((d) => ({ change: d.changeType, path: d.afterBlob?.path || d.beforeBlob?.path })),
      comments: (comments.commentsForPullRequestData || []).flatMap((c) => c.comments.map((x) => ({
        file: c.location?.filePath, line: c.location?.filePosition, content: x.content, created: x.creationDate,
      }))),
    };
  },

  async codecommit___post_comment({ pull_request_id, content, file_path, line }) {
    const { pullRequest: pr } = await codecommit.send(new GetPullRequestCommand({ pullRequestId: String(pull_request_id) }));
    const target = pr.pullRequestTargets[0];
    if (target.repositoryName !== REPO) throw new Error('pull request is outside the project repository');
    const location = file_path ? { filePath: String(file_path), filePosition: Number(line) || 1, relativeFileVersion: 'AFTER' } : undefined;
    const r = await codecommit.send(new PostCommentForPullRequestCommand({
      pullRequestId: pr.pullRequestId, repositoryName: REPO,
      beforeCommitId: target.destinationCommit, afterCommitId: target.sourceCommit,
      location, content: `${SIGNATURE} ${content}`, clientRequestToken: randomUUID(),
    }));
    return { commented: true, comment_id: r.comment?.commentId };
  },

  async memory___read({ path }) {
    if (!path) {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'memory/' }));
      return { notes: (r.Contents || []).map((o) => o.Key.slice('memory/'.length)).filter(Boolean) };
    }
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `memory/${memoryPath(path)}` })).catch(() => null);
    if (!r) return { error: `no memory note ${path}` };
    return { path, content: await r.Body.transformToString() };
  },

  async memory___propose({ path, content, reason }) {
    const note = memoryPath(path);
    const key = `memory-proposals/${new Date().toISOString().replace(/[:.]/g, '-')}-${note.replaceAll('/', '_')}.json`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'application/json', Body: JSON.stringify({ path: note, content, reason, proposedAt: new Date().toISOString() }, null, 2) }));
    return { proposed: true, note: 'A person reviews the proposal before it becomes memory.' };
  },

  async slack___ask_human({ issue_key, question }) {
    const key = await checkIssueKey(issue_key);
    if (!String(question || '').trim()) throw new Error('question is empty');
    const askedAt = new Date().toISOString();
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `ISSUE#${key}`, sk: `Q#${askedAt}`, question: String(question).slice(0, 4000), askedAt } }));
    return {
      recorded: true,
      next: 'The platform posts your question to a person in Slack and restarts the work with the answer. Stop working now: do not change more code, and end with a short summary saying you are waiting for an answer.',
    };
  },
};

export async function handler(event, context) {
  const name = context.clientContext?.custom?.bedrockAgentCoreToolName || '';
  const tool = TOOLS[name];
  console.log(JSON.stringify({ tool: name, arguments: Object.keys(event || {}) }));
  if (!tool) return { error: `unknown tool ${name}` };
  try {
    return await tool(event || {});
  } catch (err) {
    console.error(`${name}: ${err.message}`);
    return { error: err.message };
  }
}
