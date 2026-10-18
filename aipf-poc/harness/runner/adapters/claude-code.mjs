// Adapter for Claude Code: non-interactive run, stream-json output, the platform MCP server only.
import fs from 'node:fs';
import path from 'node:path';

export const name = 'claude-code';

// The CLI reads AGENTS.md through CLAUDE.md; the runner writes that file and keeps it out of git.
export const instructionFile = { path: 'CLAUDE.md', content: '@AGENTS.md\n' };

export function command({ prompt, sessionDir, mcpServer, model, maxTurns, secrets }) {
  // Only the platform MCP server: --strict-mcp-config ignores any other MCP configuration.
  const mcpConfig = path.join(sessionDir, 'mcp.json');
  const servers = mcpServer ? { aipf: { type: 'stdio', ...mcpServer } } : {};
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: servers }, null, 2));
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--dangerously-skip-permissions',
    '--max-turns', String(maxTurns),
  ];
  if (model) args.push('--model', model);
  if (!secrets.claudeToken) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is not set; store it with infra/aipf.sh token');
  return {
    cmd: 'claude',
    args,
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: secrets.claudeToken,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
    },
  };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content ?? '');
}

// One line of stream-json output to platform events.
export function normalize(obj) {
  const events = [];
  if (obj.type === 'system' && obj.subtype === 'init') {
    events.push({
      type: 'init',
      model: obj.model,
      tools: (obj.tools || []).filter((t) => t.startsWith('mcp__')),
      mcp: obj.mcp_servers,
    });
  } else if (obj.type === 'assistant') {
    for (const c of obj.message?.content || []) {
      if (c.type === 'text' && c.text.trim()) events.push({ type: 'text', text: c.text });
      if (c.type === 'tool_use') events.push({ type: 'tool_call', id: c.id, tool: c.name.replace(/^mcp__aipf__/, 'aipf:'), input: c.input });
    }
  } else if (obj.type === 'user') {
    for (const c of obj.message?.content || []) {
      if (c.type === 'tool_result') events.push({ type: 'tool_result', id: c.tool_use_id, isError: Boolean(c.is_error), output: resultText(c.content) });
    }
  } else if (obj.type === 'result') {
    const u = obj.usage || {};
    events.push({
      type: 'usage',
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      cacheWriteTokens: u.cache_creation_input_tokens || 0,
      costUsd: obj.total_cost_usd ?? null,
      turns: obj.num_turns,
      models: Object.keys(obj.modelUsage || {}),
    });
    events.push({ type: 'final', ok: !obj.is_error && obj.subtype === 'success', subtype: obj.subtype, text: obj.result || '' });
  }
  return events;
}
