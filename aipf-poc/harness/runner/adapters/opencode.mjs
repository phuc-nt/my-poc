// Adapter for OpenCode: non-interactive run, JSON events, a Bedrock model, the platform MCP server only.
import fs from 'node:fs';
import path from 'node:path';

export const name = 'opencode';

// OpenCode reads AGENTS.md itself.
export const instructionFile = null;

export const defaultModel = 'amazon-bedrock/zai.glm-5';

export function command({ prompt, sessionDir, mcpServer, model, region }) {
  const config = path.join(sessionDir, 'opencode.json');
  const chosen = model || defaultModel;
  const [, modelId] = chosen.split('/');
  fs.writeFileSync(config, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: chosen,
    provider: { 'amazon-bedrock': { options: { region }, models: { [modelId]: { name: modelId, tool_call: true } } } },
    mcp: mcpServer ? { aipf: { type: 'local', command: [mcpServer.command, ...mcpServer.args], enabled: true } } : {},
    permission: { edit: 'allow', bash: 'allow', webfetch: 'deny' },
    autoupdate: false,
    share: 'disabled',
  }, null, 2));
  return {
    cmd: 'opencode',
    // --auto approves what the configuration does not deny; --pure skips external plugins.
    args: ['run', '--format', 'json', '--auto', '--pure', prompt],
    env: { OPENCODE_CONFIG: config, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: 'true' },
  };
}

const toolName = (name) => String(name || '').replace(/^aipf_/, 'aipf:');

// One line of `opencode run --format json` output to platform events.
export function normalize(obj) {
  const part = obj.part || {};
  if (obj.type === 'text' && part.text?.trim()) return [{ type: 'text', text: part.text }];
  if (obj.type === 'tool_use') {
    const state = part.state || {};
    const events = [{ type: 'tool_call', id: part.callID, tool: toolName(part.tool), input: state.input }];
    if (state.status === 'completed' || state.status === 'error') {
      const output = state.status === 'error' ? state.error : state.output;
      events.push({ type: 'tool_result', id: part.callID, isError: state.status === 'error', output: typeof output === 'string' ? output : JSON.stringify(output ?? '') });
    }
    return events;
  }
  if (obj.type === 'step_finish') {
    const t = part.tokens || {};
    return [{
      type: 'usage',
      inputTokens: t.input || 0,
      outputTokens: (t.output || 0) + (t.reasoning || 0),
      cacheReadTokens: t.cache?.read || 0,
      cacheWriteTokens: t.cache?.write || 0,
      costUsd: part.cost ?? null,
      turns: 1,
    }];
  }
  if (obj.type === 'error') return [{ type: 'error', text: obj.error?.data?.message || obj.error?.name || JSON.stringify(obj.error) }];
  return [];
}
