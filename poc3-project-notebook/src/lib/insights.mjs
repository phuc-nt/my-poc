// What the web UI keeps about questions and answers, beyond the notebooks.
//
// The question log: one item per question asked in the web UI, without the asker's name or email. It says what
// was asked, whether the documents answered it, which documents were cited and how the answer was voted. An admin
// reads it as the list of what the knowledge base lacks. Items expire after 180 days.
//
// The library: answers a team member shared with the team. An entry keeps the cited passages, and is shown only
// to people who may read every source it cites.

import { randomBytes } from 'node:crypto';
import { get, put, del, query, now } from './store.mjs';
import { HttpError } from './auth.mjs';
import { fold } from './answer.mjs';
import { guard } from './acl.mjs';

const KEEP_DAYS = 180;
export const REASONS = ['wrong', 'missing', 'outdated', 'absent'];

// An id that sorts by time and needs no escaping in a path.
const stamp = (at) => `${at.replace(/[-:.]/g, '')}~${randomBytes(4).toString('hex')}`;
const isMonth = (month) => /^\d{4}-\d{2}$/.test(month);

// ---------- question log

export async function logQuestion({ question, mode, lang, citations = [], stats, seconds, focus }) {
  const at = now();
  const id = stamp(at);
  const cited = [...new Map(citations.map((c) => [c.uri, { title: c.title, uri: c.uri, sourceId: c.sourceId }])).values()].slice(0, 12);
  await put({ pk: `QLOG#${at.slice(0, 7)}`, sk: id, at, question: question.slice(0, 1000), mode, lang, answered: cited.length > 0, cited,
    seconds, calls: stats?.calls, focus: focus?.title, ttl: Math.floor(Date.now() / 1000) + KEEP_DAYS * 86400 });
  return { month: at.slice(0, 7), id };
}

// ref is what logQuestion returned. Returns false when the log entry is gone (older than 180 days).
export async function feedback(ref, { vote, reason, note }) {
  if (!ref || !isMonth(ref.month)) return false;
  const item = await get(`QLOG#${ref.month}`, ref.id);
  if (!item) return false;
  const down = vote === 'down';
  await put({ ...item, vote: vote || undefined, reason: down ? reason : undefined, note: down ? note : undefined });
  return true;
}

export async function resolve(month, id, resolved) {
  if (!isMonth(month)) throw new HttpError(400, 'month is yyyy-mm');
  const item = await get(`QLOG#${month}`, id);
  if (!item) throw new HttpError(404, 'No such question');
  await put({ ...item, resolved: resolved ? now() : undefined });
  return { id, resolved: Boolean(resolved) };
}

const words = (text) => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');

// One month of the log, as the admin page shows it.
export async function insights(month = now().slice(0, 7)) {
  if (!isMonth(month)) throw new HttpError(400, 'month is yyyy-mm');
  const items = await query(`QLOG#${month}`);
  const totals = { questions: items.length, answered: 0, declined: 0, up: 0, down: 0, voted: 0, seconds: 0, modes: { fast: 0, deep: 0, agent: 0, research: 0 } };
  const today = now().slice(0, 10);
  const last = month === today.slice(0, 7) ? Number(today.slice(8)) : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const days = new Map(Array.from({ length: last }, (_, i) => [`${month}-${String(i + 1).padStart(2, '0')}`, { answered: 0, declined: 0, down: 0 }]));
  const docs = new Map();
  const asked = new Map();
  let timed = 0;
  for (const item of items) {
    totals[item.answered ? 'answered' : 'declined'] += 1;
    if (item.vote) totals[item.vote] += 1;
    if (item.mode in totals.modes) totals.modes[item.mode] += 1;
    if (item.seconds) {
      totals.seconds += item.seconds;
      timed += 1;
    }
    const day = days.get(item.at.slice(0, 10));
    if (day) {
      day[item.answered ? 'answered' : 'declined'] += 1;
      if (item.vote === 'down') day.down += 1;
    }
    for (const c of item.cited || []) {
      const doc = docs.get(c.uri) || { title: c.title, uri: c.uri, sourceId: c.sourceId, count: 0 };
      doc.count += 1;
      docs.set(c.uri, doc);
    }
    const key = words(item.question);
    const same = asked.get(key) || { question: item.question, count: 0, answered: 0, last: item.at };
    same.count += 1;
    same.answered += item.answered ? 1 : 0;
    same.last = item.at;
    asked.set(key, same);
  }
  totals.voted = totals.up + totals.down;
  totals.seconds = timed ? Math.round((totals.seconds / timed) * 10) / 10 : 0;
  const gaps = items.filter((i) => !i.answered || i.vote === 'down').reverse().slice(0, 200)
    .map((i) => ({ id: i.sk, at: i.at, question: i.question, mode: i.mode, answered: i.answered, vote: i.vote, reason: i.reason, note: i.note, focus: i.focus,
      cited: (i.cited || []).slice(0, 4), resolved: Boolean(i.resolved) }));
  const top = (map) => [...map.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  return { month, totals, days: [...days].map(([day, d]) => ({ day, ...d })), gaps, documents: top(docs), repeated: top(asked).filter((q) => q.count > 1) };
}

// ---------- library

const entryView = (item, user) => ({ id: item.id, question: item.question, answer: item.answer, passages: item.passages, sourceIds: item.sourceIds, by: item.byName,
  mine: item.by === user.email, at: item.at, mode: item.mode, verified: Boolean(item.verified), verifiedBy: item.verifiedBy, verifiedAt: item.verifiedAt });

// Shares one answer of the caller's notebook. Only the passages the answer cites go with it.
export async function share({ user, nbId, messageId }) {
  const messages = await query(`NB#${nbId}`, 'MSG#');
  const at = messages.findIndex((m) => m.sk === `MSG#${messageId}`);
  const message = messages[at];
  if (!message || message.role !== 'assistant') throw new HttpError(404, 'No such answer');
  const existing = message.shared && (await get('LIB', `ANS#${message.shared}`));
  if (existing) return entryView(existing, user);
  const cited = new Set((message.citations || []).map((c) => c.n));
  const passages = (message.passages || []).filter((p) => cited.has(p.n));
  if (!passages.length) throw new HttpError(400, 'Only an answer with citations can be shared');
  // Without its source an entry could not be hidden from people who may not read that source.
  if (passages.some((p) => !p.sourceId)) throw new HttpError(400, 'This answer cites a passage without a source');
  // A live Jira result that listed an issue restricted to some people cannot be checked again for another reader.
  if (passages.some((p) => p.closed)) throw new HttpError(400, 'Câu trả lời này dùng kết quả Jira có issue bị giới hạn người xem nên không chia sẻ được');
  const asked = messages.slice(0, at).reverse().find((m) => m.role === 'user');
  const time = now();
  const id = stamp(time);
  const item = { pk: 'LIB', sk: `ANS#${id}`, id, question: asked?.content || '', answer: message.content, passages, sourceIds: [...new Set(passages.map((p) => p.sourceId))],
    by: user.email, byName: user.name, at: time, mode: message.mode, verified: false, from: { nb: nbId, msg: messageId } };
  await put(item);
  await put({ ...message, shared: id });
  return entryView(item, user);
}

// The entries the caller may read: every source an entry cites must be one of theirs, and so must every document
// it cites (a page restricted to other people hides the entry).
export async function library(user, granted) {
  const mine = new Set(granted);
  const acl = await guard(user.email, granted);
  return (await query('LIB', 'ANS#', { forward: false }))
    .filter((item) => item.sourceIds.every((id) => mine.has(id)) && !(item.passages || []).some((p) => !p.live && acl.hides(p.sourceId, p.uri)))
    .map((item) => entryView(item, user));
}

export async function verify(id, user, verified) {
  const item = await get('LIB', `ANS#${id}`);
  if (!item) throw new HttpError(404, 'No such entry');
  const next = { ...item, verified: Boolean(verified), verifiedBy: verified ? user.name : undefined, verifiedAt: verified ? now() : undefined };
  await put(next);
  return entryView(next, user);
}

export async function remove(id, user, admin) {
  const item = await get('LIB', `ANS#${id}`);
  if (!item) throw new HttpError(404, 'No such entry');
  if (!admin && item.by !== user.email) throw new HttpError(403, 'Only the person who shared it or an admin may remove it');
  await del('LIB', `ANS#${id}`);
  const message = item.from && (await get(`NB#${item.from.nb}`, `MSG#${item.from.msg}`));
  if (message?.shared === id) await put({ ...message, shared: undefined });
  return { deleted: true };
}
