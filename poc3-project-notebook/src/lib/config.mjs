// Settings of the Lambda functions, from the environment the CloudFormation stack sets.

const e = process.env;

export const config = {
  region: e.AWS_REGION || 'ap-southeast-2',
  kbPrefix: e.KB_PREFIX || 'poc3-kb',
  table: e.TABLE,
  userPoolId: e.USER_POOL_ID,
  clientId: e.USER_POOL_CLIENT_ID,
  graphSecret: e.GRAPH_SECRET || 'poc3-kb/graph',
  // The Claude API key of the claude-* models: { "apiKey": "..." }, set with node infra/deploy.mjs claude-key.
  anthropicSecret: e.ANTHROPIC_SECRET || 'poc3-kb/anthropic',
  // Claude Sonnet 5.5 on the Claude API since 2026-11-14: a model named claude-* goes there (claude.mjs), so the
  // question and the passages it answers from leave the Region. Any other name is an Amazon Bedrock model that
  // runs in the Region itself; zai.glm-5 was the default before (as good as DeepSeek V3.2 in the benchmark, in a
  // third of the time).
  chatModel: e.CHAT_MODEL || 'claude-sonnet-5-5',
  studioModel: e.STUDIO_MODEL || 'claude-sonnet-5-5',
  // The model of the chat's agent mode, which searches and reads in several steps. A Claude model only.
  agentModel: e.AGENT_MODEL || 'claude-sonnet-5-5',
  // Reads pictures and scanned pages for the text documents the sync adds next to attachments (prepare.mjs). It
  // runs in the Region itself and, in the lab (scripts/preprocess-lab.mjs), read Vietnamese without a mistake;
  // the Amazon Nova models and Amazon Textract did not. Empty: pictures and scans get no text document.
  readModel: e.READ_MODEL ?? 'qwen.qwen3-vl-235b-a22b',
  passages: Number(e.PASSAGES || 8),
  metricNamespace: e.METRIC_NAMESPACE || 'Poc3Kb',
  staleHours: Number(e.STALE_HOURS || 30),
  // The knowledge bases' application logs (one log line per document of every sync job).
  kbLogGroup: e.KB_LOG_GROUP || '/aws/vendedlogs/bedrock/poc3-kb',
  // A person the Confluence or SharePoint permissions name is activated without waiting for an admin.
  autoApproveImported: (e.AUTO_APPROVE_IMPORTED || 'true') === 'true',
  originSecret: e.ORIGIN_SECRET,
  // A Jira source's attachments go through this bucket (jira/...), the text documents of a Confluence source's
  // attachments too (text/...); both syncs run in the monitor function.
  dataBucket: e.DATA_BUCKET,
  monitorFunction: e.MONITOR_FUNCTION || 'poc3-kb-monitor',
  adminEmails: String(e.ADMIN_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean),
};

// List prices in USD (ap-southeast-2, read 2026-10-25; the Claude API's, read 2026-11-14). The cost page multiplies
// the usage counters by these.
export const PRICES = {
  models: {
    'claude-sonnet-5-5': { input: 2, output: 10 },
    'au.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1.1, output: 5.5 },
    'au.anthropic.claude-sonnet-4-6': { input: 3.3, output: 16.5 },
    'deepseek.v3.2': { input: 0.64, output: 1.91 },
    'zai.glm-5': { input: 1.03, output: 3.3 },
  },
  retrievePer1k: 1,
  agenticPer1k: 4,
  storagePerGbMonth: 5,
};
