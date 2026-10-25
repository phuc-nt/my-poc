// Amazon Bedrock Converse, streamed. Yields text pieces; the usage counters go to onUsage at the end.

import { BedrockRuntimeClient, ConverseStreamCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from './config.mjs';
import { recordModel } from './usage.mjs';

const client = new BedrockRuntimeClient({ region: config.region, maxAttempts: 3 });

const request = ({ model, system, messages, maxTokens, temperature }) => ({
  modelId: model,
  system: system ? [{ text: system }] : undefined,
  messages: messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
  inferenceConfig: { maxTokens, temperature },
});

export async function* streamChat({ model = config.chatModel, system, messages, maxTokens = 2000, temperature = 0.2, signal }) {
  const response = await client.send(new ConverseStreamCommand(request({ model, system, messages, maxTokens, temperature })), { abortSignal: signal });
  for await (const event of response.stream) {
    if (event.contentBlockDelta?.delta?.text) yield event.contentBlockDelta.delta.text;
    if (event.metadata?.usage) await recordModel(model, event.metadata.usage.inputTokens, event.metadata.usage.outputTokens);
  }
}

export async function chat({ model = config.chatModel, system, messages, maxTokens = 1000, temperature = 0 }) {
  const response = await client.send(new ConverseCommand(request({ model, system, messages, maxTokens, temperature })));
  await recordModel(model, response.usage?.inputTokens, response.usage?.outputTokens);
  return (response.output?.message?.content || []).map((b) => b.text || '').join('');
}
