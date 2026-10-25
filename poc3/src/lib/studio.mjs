// Studio: documents generated from a notebook's sources (briefing, FAQ, glossary, mind map, timeline, onboarding
// guide), and the source guide of one document. Each studio output searches the sources with a few queries of its
// own, then a stronger model writes the output from those passages with [n] citations.

import { createHash } from 'node:crypto';
import { config } from './config.mjs';
import { chat, streamChat } from './llm.mjs';
import { search, documentText } from './kb.mjs';
import { get, put, now } from './store.mjs';
import { record } from './usage.mjs';

const LANGS = { vi: 'Vietnamese', en: 'English', ja: 'Japanese' };

export const OUTPUTS = {
  briefing: {
    title: 'Briefing doc',
    queries: ['project overview purpose and scope', 'main features and business flows', 'architecture components and technology stack', 'risks open issues and decisions'],
    prompt: 'Write a briefing document for a team member joining the project: purpose and scope, users and main business flows, main features, architecture and technology, key decisions, open issues and risks. Use headings and short lists.',
  },
  faq: {
    title: 'FAQ',
    queries: ['how does the system work', 'requirements and business rules', 'configuration deployment and release', 'limitations known issues'],
    prompt: 'Write 10 to 15 frequently asked questions with answers that a business analyst or bridge system engineer would ask about this project. Format each as a level-3 heading with the question, followed by the answer.',
  },
  glossary: {
    title: 'Glossary VI / EN / JA',
    queries: ['terms definitions glossary', 'business entities and data model', 'screens features and modules names', 'abbreviations acronyms'],
    prompt: 'Write a glossary of the project\'s business and technical terms as one Markdown table with the columns: Term, Vietnamese, English, Japanese, Meaning in this project, Source. Give 15 to 30 terms. Translate terms into Vietnamese, English and Japanese (the BrSE uses the Japanese column with the customer); keep code names untranslated. The Meaning column is in the output language.',
  },
  mindmap: {
    title: 'Mind map',
    queries: ['project overview modules', 'features and functions', 'architecture components integrations', 'users roles and data'],
    prompt: 'Draw a mind map of the project as a single Mermaid "mindmap" code block: the project at the root, then 4 to 7 branches (for example users, features, data, architecture, integrations, operations), each with 2 to 6 leaves. Node text is short and must not contain brackets, parentheses or quotes. After the diagram, add a short list that names the source of each branch with [n].',
  },
  timeline: {
    title: 'Timeline',
    queries: ['release history versions dates', 'milestones schedule plan phases', 'changelog updates decisions dates', 'deadlines roadmap'],
    prompt: 'Build a timeline of the project\'s dated events (releases, versions, milestones, decisions, plans) as a Markdown table with the columns: Date, Event, Details, Source, sorted by date. Then list the people or teams involved if the documents name them. Only include dates the passages state.',
  },
  onboarding: {
    title: 'Onboarding guide',
    queries: ['getting started setup environment', 'how to run build test and deploy', 'where to find documents and who to ask', 'business domain overview'],
    prompt: 'Write a step-by-step onboarding guide for a new BA, BrSE or SA on this project: what to read first (name the documents), the business domain in brief, how the system is built and released, the conventions to follow, and a first-week checklist.',
  },
};

function numbered(passages) {
  return passages.map((p, i) => `[${i + 1}] ${[p.sourceTitle, p.title, p.page ? `page ${p.page}` : ''].filter(Boolean).join(' · ')}\n${p.text.trim()}`).join('\n\n');
}

// Streams one studio output. focus: an optional topic the user typed.
export async function studio({ kind, focus = '', allowed, lang = 'vi', emit, userId, signal }) {
  const spec = OUTPUTS[kind];
  if (!spec) throw new Error(`Unknown studio output ${kind}`);
  await record({ studio: 1 });
  const queries = focus ? [focus, ...spec.queries.slice(0, 3).map((q) => `${focus} ${q}`)] : spec.queries;
  const found = await Promise.all(queries.map((q) => search(q, allowed, { n: 8, userId })));
  const seen = new Set();
  const passages = found.flat().sort((a, b) => b.score - a.score).filter((p) => {
    const key = `${p.uri}#${p.text.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
  emit('sources', { passages: passages.map(({ text, ...p }, i) => ({ n: i + 1, ...p, excerpt: text.slice(0, 400) })) });
  if (!passages.length) {
    const text = 'Không tìm thấy đoạn tài liệu nào trong các nguồn của notebook này.';
    emit('delta', { text });
    return { title: spec.title, content: text, passages };
  }
  const system = `You write project documents for a software project team, only from the numbered passages, citing them with [n] after each fact. Never invent facts, names, dates or numbers. Write in ${LANGS[lang] || 'Vietnamese'}. Output Markdown only, without an introduction.`;
  let content = '';
  for await (const piece of streamChat({ model: config.studioModel, system, maxTokens: 4000, signal,
    messages: [{ role: 'user', content: `Passages:\n\n${numbered(passages)}\n\nTask: ${spec.prompt}${focus ? `\nFocus on: ${focus}` : ''}` }] })) {
    content += piece;
    emit('delta', { text: piece });
  }
  return { title: focus ? `${spec.title} — ${focus}` : spec.title, content, passages };
}

// The source guide of one document: a summary, its key topics and questions to ask. Cached per document.
export async function sourceGuide(source, { uri, docId, title }, { lang = 'vi' } = {}) {
  const key = `DOC#${createHash('sha256').update(`${source.id}|${uri || docId}|${lang}`).digest('hex').slice(0, 40)}`;
  const cached = await get(key, 'GUIDE');
  if (cached) return cached.guide;
  const full = await documentText(source, { uri, docId });
  const text = full.slice(0, 40000);
  const raw = await chat({
    model: config.chatModel, maxTokens: 1200,
    system: `You summarise one project document for a team member. Reply with JSON only: {"summary": "3 to 5 sentences", "topics": ["4 to 8 key topics"], "questions": ["3 questions this document answers"]}. Write in ${LANGS[lang] || 'Vietnamese'}; keep names and technical terms as written.`,
    messages: [{ role: 'user', content: `Document: ${title || uri || docId}\n\n${text}` }],
  });
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  let guide;
  try {
    guide = JSON.parse(json);
  } catch {
    guide = { summary: raw.trim(), topics: [], questions: [] };
  }
  guide.characters = full.length;
  await put({ pk: key, sk: 'GUIDE', guide, createdAt: now() });
  return guide;
}
