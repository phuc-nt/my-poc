// Usage counters per day (USAGE#<month> / <day>), and the month's cost at list prices.

import { add, query } from './store.mjs';
import { PRICES } from './config.mjs';

const day = () => new Date().toISOString().slice(0, 10);
const safe = (model) => model.replace(/[^a-zA-Z0-9]/g, '_');

export const record = (counters) => add(`USAGE#${day().slice(0, 7)}`, day(), counters).catch(() => {});

export const recordModel = (model, input = 0, output = 0) =>
  record({ [`in_${safe(model)}`]: input, [`out_${safe(model)}`]: output, llmCalls: 1 });

export async function monthUsage(month = day().slice(0, 7)) {
  const days = await query(`USAGE#${month}`);
  const total = {};
  for (const d of days) for (const [k, v] of Object.entries(d)) if (typeof v === 'number') total[k] = (total[k] || 0) + v;
  const models = Object.entries(PRICES.models).map(([model, price]) => {
    const input = total[`in_${safe(model)}`] || 0;
    const output = total[`out_${safe(model)}`] || 0;
    return { model, input, output, usd: (input * price.input + output * price.output) / 1e6 };
  });
  const retrieveUsd = ((total.retrieve || 0) * PRICES.retrievePer1k) / 1000;
  const agenticUsd = ((total.agentic || 0) * PRICES.agenticPer1k) / 1000;
  return {
    month,
    days: days.map((d) => ({ day: d.sk, retrieve: d.retrieve || 0, agentic: d.agentic || 0, llmCalls: d.llmCalls || 0, questions: d.questions || 0 })),
    total: { retrieve: total.retrieve || 0, agentic: total.agentic || 0, questions: total.questions || 0, mcpCalls: total.mcpCalls || 0, studio: total.studio || 0 },
    models,
    usd: { models: models.reduce((s, m) => s + m.usd, 0), retrieve: retrieveUsd, agentic: agenticUsd },
  };
}
