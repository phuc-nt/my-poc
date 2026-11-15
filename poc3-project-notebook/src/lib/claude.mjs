// Claude through the Claude API (the Anthropic SDK), for the models named claude-*. The API key is in the secret
// poc3-kb/anthropic ({ "apiKey": "..." }), read once per function instance and never logged; a local run may set
// ANTHROPIC_API_KEY instead.
//
// Claude Sonnet 5.5 rules that shape the requests here: thinking is adaptive (never disabled, no budget), there is
// no temperature, tool_choice is auto or none (a forced call is refused), and thinking counts toward max_tokens.

import Anthropic from '@anthropic-ai/sdk';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { config } from './config.mjs';
import { recordModel } from './usage.mjs';

export const isClaude = (model) => /^claude-/.test(model || '');

// A policy decline of Claude Sonnet 5.5 (cyber, frontier_llm) is retried by the API on Claude Sonnet 5 inside the
// same call; message.model then names the model that answered.
const FALLBACK = { 'claude-sonnet-5-5': { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } };
// Room for thinking on top of what the caller wants for the reply.
const THINKING_ROOM = 6000;

export class ClaudeKeyMissing extends Error {
  constructor() {
    super('The Claude API key is not set: run node infra/deploy.mjs claude-key');
    this.name = 'ClaudeKeyMissing';
  }
}

let client;
async function api() {
  if (client) return client;
  let apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    try {
      const sm = new SecretsManagerClient({ region: config.region });
      const value = (await sm.send(new GetSecretValueCommand({ SecretId: config.anthropicSecret }))).SecretString || '';
      apiKey = value.trim().startsWith('{') ? JSON.parse(value).apiKey : value.trim();
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') throw new ClaudeKeyMissing();
      throw error;
    }
  }
  if (!apiKey) throw new ClaudeKeyMissing();
  client = new Anthropic({ apiKey, maxRetries: 3 });
  return client;
}

// The API wants a user message first, roles that alternate and no empty text.
export function turns(messages) {
  const out = [];
  for (const m of messages) {
    if (typeof m.content === 'string' && !m.content.trim()) continue;
    const last = out.at(-1);
    if (!last && m.role !== 'user') continue;
    if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string') last.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

// Cache writes cost 1.25 times an input token and cache reads 0.05 times: counted as that many input tokens, so the
// cost page stays one price per model.
function tokens(usage) {
  const input = (usage.input_tokens || 0) + 1.25 * (usage.cache_creation_input_tokens || 0) + 0.05 * (usage.cache_read_input_tokens || 0);
  return { input: Math.round(input), output: usage.output_tokens || 0, cached: usage.cache_read_input_tokens || 0 };
}

function request({ model, system, messages, tools, toolChoice, maxTokens, effort }) {
  return {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    ...(tools && { tools, tool_choice: toolChoice || { type: 'auto' } }),
    output_config: { effort },
    // Caches the prefix up to the last block: each round of a tool loop re-reads the earlier rounds at a twentieth of the price.
    cache_control: { type: 'ephemeral' },
    ...FALLBACK[model],
  };
}

export class ClaudeRefusal extends Error {
  constructor(message) {
    super(`Claude declined to answer (${message.stop_details?.category || 'refusal'})`);
    this.name = 'ClaudeRefusal';
  }
}

// One model turn of a tool loop, streamed. onText gets the text as it is written; the complete message comes back
// with its content blocks (thinking included) to be sent back unchanged on the next turn.
export async function turn({ model, system, messages, tools, toolChoice, maxTokens = 16000, effort = 'medium', onText, signal }) {
  const stream = (await api()).beta.messages.stream(request({ model, system, messages, tools, toolChoice, maxTokens, effort }), { signal });
  if (onText) stream.on('text', onText);
  const message = await stream.finalMessage();
  const used = tokens(message.usage);
  await recordModel(model, used.input, used.output);
  return { message, used };
}

// Plain text in, text out, for the calls that llm.mjs routes here.
export async function* claudeStream({ model, system, messages, maxTokens = 2000, effort = 'low', signal }) {
  const stream = (await api()).beta.messages.stream(
    request({ model, system, messages: turns(messages), maxTokens: maxTokens + THINKING_ROOM, effort }), { signal });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
  }
  const message = await stream.finalMessage();
  const used = tokens(message.usage);
  await recordModel(model, used.input, used.output);
  if (message.stop_reason === 'refusal') throw new ClaudeRefusal(message);
}

// What the user sees for a Claude API failure; null when the error is not one.
export function claudeError(error) {
  if (error instanceof ClaudeKeyMissing) return 'Chưa cấu hình Claude API key cho ứng dụng (secret poc3-kb/anthropic).';
  if (error instanceof ClaudeRefusal) return 'Claude từ chối trả lời câu hỏi này theo chính sách an toàn của model.';
  if (error instanceof Anthropic.AuthenticationError) return 'Claude API key không hợp lệ hoặc đã bị thu hồi.';
  if (error instanceof Anthropic.PermissionDeniedError) return 'Claude API key không có quyền dùng model này.';
  if (error instanceof Anthropic.RateLimitError) return 'Claude API đang giới hạn tốc độ (rate limit), thử lại sau vài giây.';
  if (error instanceof Anthropic.APIUserAbortError) return 'Câu hỏi cần nhiều thời gian hơn giới hạn của một lượt trả lời. Hãy chia nhỏ câu hỏi.';
  if (error instanceof Anthropic.BadRequestError) return `Claude API từ chối yêu cầu: ${error.message}`;
  if (error instanceof Anthropic.APIError) return error.status >= 500 ? 'Claude API đang quá tải, thử lại sau ít phút.' : `Claude API lỗi ${error.status || ''}`.trim();
  return null;
}

// The SDK could not parse a tool input it streamed (the API does not check a streamed input): worth the same request
// again. An API error is not: the SDK already retried what can be retried.
export const isParseError = (error) => error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError);
