// The tool loop the agent mode (answer.mjs) and the research mode (research.mjs) share: a session that runs the
// tools of tools.mjs for one reader and numbers everything they return, and a loop of model turns over it.

import { PRICES } from './config.mjs';
import { listSources, titleOf } from './kb.mjs';
import { READ_TOOLS, readTool, invalid } from './tools.mjs';
import { turn, isParseError, ClaudeRefusal } from './claude.mjs';

export const MARKER = '<<FOLLOWUPS>>';
export const LANGS = { vi: 'Vietnamese', en: 'English', ja: 'Japanese' };

// What a search found, for the trace the web UI draws.
export const foundIn = (passages) => ({ found: passages.length, titles: [...new Set(passages.map((p) => p.title).filter(Boolean))].slice(0, 5) });

// Streams text while holding back anything that might be the start of the follow-up marker.
export function splitter(emit) {
  let all = '';
  let sent = 0;
  let cut = -1;
  return {
    push(piece) {
      all += piece;
      if (cut < 0) cut = all.indexOf(MARKER);
      const limit = cut >= 0 ? cut : Math.max(sent, all.length - MARKER.length);
      if (limit > sent) {
        emit('delta', { text: all.slice(sent, limit) });
        sent = limit;
      }
    },
    finish() {
      if (cut < 0 && all.length > sent) emit('delta', { text: all.slice(sent) });
      const answer = (cut >= 0 ? all.slice(0, cut) : all).trim();
      const followups = cut >= 0 ? all.slice(cut + MARKER.length).split('\n').map((s) => s.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean).slice(0, 3) : [];
      return { answer, followups };
    },
  };
}

// The list price of one answer: the model's tokens and the searches of the knowledge base. An estimate for the
// reader; the cost page counts the same usage per month.
export function cost(model, { input, output, searches }) {
  const price = PRICES.models[model] || PRICES.models[Object.keys(PRICES.models).find((m) => model.startsWith(m))] || { input: 0, output: 0 };
  return Math.round(((input * price.input + output * price.output) / 1e6 + (searches * PRICES.retrievePer1k) / 1000) * 1e4) / 1e4;
}

const KIND = { search: 'search', list_sources: 'list', list_documents: 'list', get_document: 'read', query_jira: 'query', query_table: 'query' };

// One reader's tools for one answer. Everything the tools return gets one number for the whole answer, whichever
// call returned it, so several loops on the same session cite with the same numbers.
export async function session({ allowed, userId, syncOf = async () => null, emit }) {
  const names = new Map((await listSources()).map((s) => [s.id, s.name]));
  // The API does not check an input it streams as it is written, so run() checks it against the schema.
  const tools = READ_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, eager_input_streaming: true }));
  const entries = [];
  const numbers = new Map();
  const counts = { searches: 0, calls: 0 };
  const number = (p) => {
    const key = p.key || (p.whole ? `whole|${p.uri}` : `${p.uri}|${p.page || ''}|${p.text.slice(0, 120)}`);
    if (!numbers.has(key)) {
      const { key: _key, ...rest } = p;
      entries.push({ ...rest, n: entries.length + 1 });
      numbers.set(key, entries.length);
    }
    return numbers.get(key);
  };
  const view = (list) => list.map(({ text, ...p }) => ({ ...p, excerpt: text.slice(0, 600) }));
  const titleFor = (uri) => entries.find((x) => x.uri === uri && !x.computed)?.title || titleOf(uri);

  const label = (name, a) => ({
    search: `Tìm: “${a.query}”${a.sources?.length ? ` trong ${a.sources.join(', ')}` : ''}`,
    list_sources: 'Xem danh sách nguồn',
    list_documents: `Liệt kê tài liệu của ${a.source}${[a.kind, a.title_contains && `tên chứa “${a.title_contains}”`, a.parent && `đính kèm ở “${a.parent}”`].filter(Boolean).map((x) => ` · ${x}`).join('')}`,
    get_document: `Đọc toàn văn: ${titleFor(a.link)}`,
    query_jira: `Truy vấn Jira trực tiếp: ${a.jql || 'mọi issue'}${a.count_by ? ` · đếm theo ${a.count_by}` : ''}`,
    query_table: `Tính trên bảng: ${titleFor(a.link)}${a.table ? ` · bảng ${a.table}` : ''}${a.aggregate ? ` · ${a.aggregate}` : ''}${a.group_by ? ` · nhóm theo ${a.group_by}` : ''}`,
  }[name]);

  let stepNo = 0;
  // Runs one tool call of the model. tag: a short prefix for the step, the section of a report.
  const run = async (block, tag = '') => {
    const wanted = String(block.name).trim().toLowerCase();
    const tool = READ_TOOLS.find((t) => t.name === wanted);
    if (!tool) return { error: `Unknown tool ${block.name}` };
    const why = invalid(tool, block.input);
    if (why) return { error: `INVALID_JSON: ${why}` };
    const id = `s${++stepNo}`;
    const began = Date.now();
    counts.calls++;
    if (tool.name === 'search') counts.searches++;
    emit('step', { id, kind: KIND[tool.name], text: `${tag}${label(tool.name, block.input)}` });
    try {
      const out = await readTool(tool.name, block.input, { ids: allowed, userId, syncOf });
      emit('stepdone', { id, ms: Date.now() - began,
        ...(out.passages ? foundIn(out.passages)
          : out.document ? { found: 1, chars: out.document.total }
            : out.records ? { found: out.records.reduce((sum, r) => sum + (r.total ?? 1), 0) }
              : { found: Array.isArray(out.value) ? out.value.length : out.value?.total ?? 0 }) });
      return out;
    } catch (error) {
      emit('stepdone', { id, ms: Date.now() - began, failed: true });
      console.error('agent tool', tool.name, error.name, error.message);
      // Our own messages go to the model; a service error may name resources, so it does not.
      return { error: error.constructor === Error ? error.message : 'The knowledge base did not answer this call.' };
    }
  };

  // What the model reads for one call. Numbers are given here, in the order of the calls.
  const show = (out) => {
    if (out.error) return { text: out.error, error: true };
    if (out.passages) {
      if (!out.passages.length) return { text: 'No passage matched. Try other words, or check list_sources.' };
      return { text: out.passages.map((p) => `[${number(p)}] ${p.title} — ${p.sourceTitle}${p.page ? `, page ${p.page}` : ''}\nsource: ${names.get(p.sourceId) || p.sourceId} · link: ${p.uri}\n${p.text.trim()}`).join('\n\n---\n\n') };
    }
    if (out.document) {
      const d = out.document;
      const title = titleFor(d.uri);
      const n = number({ whole: true, text: d.text, uri: d.uri, title, sourceId: d.source.id, sourceTitle: d.source.title, sourceType: d.source.type });
      return { text: `[${n}] ${title} — ${d.source.title}, the whole document\nsource: ${d.source.name} · link: ${d.uri}\n\n${d.text}${d.cut ? `\n\n[cut at ${d.cut} of ${d.total} characters]` : ''}` };
    }
    if (out.records) {
      return { text: out.records.map((r) => {
        const n = number({ key: r.key, computed: true, text: r.text, uri: r.uri, title: r.title, sourceId: r.source.id, sourceTitle: r.source.title, sourceType: r.source.type,
          ...(r.live && { live: true }), ...(r.closed && { closed: true }) });
        return `[${n}] ${r.title} — ${r.source.title}${r.live ? ', read from Jira just now' : ''}\nsource: ${r.source.name} · link: ${r.uri}\n\n${r.text}`;
      }).join('\n\n---\n\n') };
    }
    return { text: JSON.stringify(out.value, null, 1).slice(0, 60000) };
  };

  return { tools, entries, counts, view, run, show, emit };
}

// Model turns over a session until one answers without calling a tool.
//   limits: { rounds, calls, softAt }: tool rounds and tool calls of this loop, and the time after which the next
//   turn has to answer.
//   sink: { push(text), restart(note) }: gets the text as it is written; restart() says the text so far was not
//   the answer (note: it was a note before a tool call).
//   stats: { model, rounds, calls, input, output } accumulates over the loops of one answer.
export async function loop({ ses, model, system, messages, limits, signal, stats, sink, tag = '', effort = 'medium', maxTokens }) {
  let rounds = 0;
  let calls = 0;
  let retries = 0;
  for (;;) {
    const closing = rounds >= limits.rounds || calls >= limits.calls || Date.now() > limits.softAt;
    let message;
    try {
      const out = await turn({ model, system, messages, tools: ses.tools, toolChoice: closing ? { type: 'none' } : undefined, effort, ...(maxTokens && { maxTokens }), onText: (t) => sink.push(t), signal });
      message = out.message;
      stats.input += out.used.input;
      stats.output += out.used.output;
    } catch (error) {
      if (!isParseError(error) || ++retries > 2) throw error;
      sink.restart(false);
      continue;
    }
    rounds++;
    stats.rounds++;
    stats.model = message.model || model;
    if (message.stop_reason === 'refusal') throw new ClaudeRefusal(message);
    const uses = message.content.filter((b) => b.type === 'tool_use');
    // A cut-off turn may hold a cut-off call: nothing of it is run.
    if (message.stop_reason === 'max_tokens' && uses.length) throw new Error('Câu trả lời bị cắt giữa chừng vì quá dài. Hãy hỏi lại với phạm vi hẹp hơn.');
    if (message.stop_reason !== 'tool_use' || !uses.length || closing) return;

    // The text of a turn that goes on to call tools is a note on the way, not the answer.
    sink.restart(true);
    // The whole content goes back unchanged, thinking blocks included, then every result in one user message.
    messages.push({ role: 'assistant', content: message.content });
    const room = limits.calls - calls;
    const outs = await Promise.all(uses.map((b, i) => (i < room ? ses.run(b, tag) : { error: 'Not run: this answer has used all its tool calls.' })));
    calls += Math.min(uses.length, room);
    stats.calls += Math.min(uses.length, room);
    messages.push({ role: 'user', content: uses.map((b, i) => {
      const shown = ses.show(outs[i]);
      return { type: 'tool_result', tool_use_id: b.id, content: shown.text, ...(shown.error && { is_error: true }) };
    }) });
    ses.emit('sources', { passages: ses.view(ses.entries) });
  }
}

// The numbers a text cites, among the session's entries.
export const citedIn = (text, entries) => [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= entries.length).sort((a, b) => a - b);
