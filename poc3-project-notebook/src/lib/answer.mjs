// One chat turn: make the question stand alone, search the sources the user may read, then stream an answer
// grounded in the numbered passages, with [n] citations and three follow-up questions.
//
// emit(event, data) sends server-sent events: sources (the numbered passages), step (deep mode's sub-queries),
// delta (answer text), done ({ answer, citations, followups }).

import { config } from './config.mjs';
import { chat, streamChat } from './llm.mjs';
import { search, deepSearch } from './kb.mjs';
import { record } from './usage.mjs';

const MARKER = '<<FOLLOWUPS>>';
const LANGS = { vi: 'Vietnamese', en: 'English', ja: 'Japanese' };

const SYSTEM = (lang) => `You are Project Notebook, the assistant of a software project team: business analysts, bridge system engineers
and solution architects who need to understand the project's business and design from its documents.

Rules:
- Answer only from the numbered passages. Each passage comes from the team's Confluence or SharePoint.
- Speak of them to the user as "the documents", never as passages or excerpts.
- Put the passage number in square brackets after each fact you take from it, like [2] or [1][3]. Never cite a number that is not listed.
- If the passages do not answer the question, say in one sentence that the documents do not cover it and say which document or topic might hold it. Do not guess.
- Keep exact names, numbers, dates, versions, codes and quoted terms as the documents write them.
- Prefer short paragraphs and lists. Use a table when comparing items. Use a Mermaid code block only when a flow or sequence is asked for.
- ${lang ? `Write the answer in ${LANGS[lang]}.` : "Write the answer in the language of the user's question."} Keep document titles and technical terms in their original form.
- After the answer, write a line with only ${MARKER}, then three short follow-up questions the user may ask next, one per line, in the same language, without numbering.`;

function numbered(passages) {
  return passages.map((p, i) => {
    const where = [p.sourceTitle, p.title, p.page ? `page ${p.page}` : '', p.section].filter(Boolean).join(' · ');
    return `[${i + 1}] ${where}\n${p.text.trim()}`;
  }).join('\n\n');
}

// Rewrites a follow-up like "and on mobile?" into a question that stands alone.
async function standalone(question, history) {
  if (!history.length) return question;
  const recent = history.slice(-6).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1200)}`).join('\n');
  const out = await chat({
    system: 'Rewrite the last user question so that it stands alone, using the conversation for missing context. Keep its language. Reply with the question only.',
    messages: [{ role: 'user', content: `Conversation:\n${recent}\n\nLast question: ${question}` }],
    maxTokens: 200,
  });
  return out.trim() || question;
}

// Streams text while holding back anything that might be the start of the follow-up marker.
function splitter(emit) {
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

export async function answer({ question, history = [], allowed, mode = 'fast', lang, emit, userId, signal }) {
  await record({ questions: 1 });
  if (!allowed.length) {
    const text = 'Bạn chưa được cấp quyền đọc nguồn tài liệu nào. Hãy gửi yêu cầu truy cập ở trang Sources để admin duyệt.';
    emit('delta', { text });
    return { answer: text, citations: [], followups: [], passages: [] };
  }
  let passages;
  let model = config.chatModel;
  if (mode === 'deep') {
    emit('step', { text: 'Agentic retrieval: tách câu hỏi thành các truy vấn con' });
    passages = await deepSearch([...history.slice(-6), { role: 'user', content: question }], allowed, { onStep: (q) => emit('step', { text: q }), userId });
    model = config.studioModel;
  } else {
    const query = await standalone(question, history);
    if (query !== question) emit('step', { text: query });
    passages = await search(query, allowed, { userId });
  }
  emit('sources', { passages: passages.map(({ text, ...p }, i) => ({ n: i + 1, ...p, excerpt: text.slice(0, 600) })) });

  const s = splitter(emit);
  const messages = [
    ...history.slice(-6),
    { role: 'user', content: `Passages:\n\n${passages.length ? numbered(passages) : '(no passage matched)'}\n\nQuestion: ${question}` },
  ];
  for await (const piece of streamChat({ model, system: SYSTEM(lang), messages, maxTokens: mode === 'deep' ? 3000 : 2000, signal })) s.push(piece);
  const { answer: text, followups } = s.finish();
  const used = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= passages.length);
  const citations = used.map((n) => ({ n, title: passages[n - 1].title, uri: passages[n - 1].uri, sourceId: passages[n - 1].sourceId, page: passages[n - 1].page }));
  return { answer: text, citations, followups, passages };
}
