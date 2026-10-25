// Settings of the Lambda functions, from the environment the CloudFormation stack sets.

const e = process.env;

export const config = {
  region: e.AWS_REGION || 'ap-southeast-2',
  kbPrefix: e.KB_PREFIX || 'poc3-kb',
  table: e.TABLE,
  userPoolId: e.USER_POOL_ID,
  clientId: e.USER_POOL_CLIENT_ID,
  graphSecret: e.GRAPH_SECRET || 'poc3-kb/graph',
  // GLM 5 for chat as well: in the benchmark it answered as well as DeepSeek V3.2, never wrongly, in a third of the time. Both run in the Region itself;
  // the Claude models (au. profiles) need the account's Anthropic use case form on Amazon Bedrock first.
  chatModel: e.CHAT_MODEL || 'zai.glm-5',
  studioModel: e.STUDIO_MODEL || 'zai.glm-5',
  passages: Number(e.PASSAGES || 8),
  metricNamespace: e.METRIC_NAMESPACE || 'Poc3Kb',
  staleHours: Number(e.STALE_HOURS || 30),
  // The knowledge bases' application logs (one log line per document of every sync job).
  kbLogGroup: e.KB_LOG_GROUP || '/aws/vendedlogs/bedrock/poc3-kb',
  // A person the Confluence or SharePoint permissions name is activated without waiting for an admin.
  autoApproveImported: (e.AUTO_APPROVE_IMPORTED || 'true') === 'true',
  originSecret: e.ORIGIN_SECRET,
  adminEmails: String(e.ADMIN_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean),
};

// List prices in USD (ap-southeast-2, read 2026-10-25). The cost page multiplies the usage counters by these.
export const PRICES = {
  models: {
    'au.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1.1, output: 5.5 },
    'au.anthropic.claude-sonnet-4-6': { input: 3.3, output: 16.5 },
    'deepseek.v3.2': { input: 0.64, output: 1.91 },
    'zai.glm-5': { input: 1.03, output: 3.3 },
  },
  retrievePer1k: 1,
  agenticPer1k: 4,
  storagePerGbMonth: 5,
};
