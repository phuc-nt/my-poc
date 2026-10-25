// Project Notebook: the web UI of PoC 3. A single page without a build step: sign-in against Cognito, then
// notebooks (sources, chat with citations, studio outputs and notes) like NotebookLM, plus the sync monitor,
// MCP access tokens, user administration and the cost of the month.

/* global marked, DOMPurify, mermaid */

const $ = (sel, root = document) => root.querySelector(sel);
const state = { cfg: null, auth: null, me: null, sources: [], notebooks: [], nb: null, messages: [], notes: [], outputs: [],
  mode: 'fast', lang: '', open: new Set(), docs: {}, busy: false, timer: null };

// ---------- small DOM helper: h('div.cls', { onclick }, ...children)
function h(spec, attrs = {}, ...kids) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = {};
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

function toast(text, ms = 3000) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '—');
function ago(iso) {
  if (!iso) return 'chưa có';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  if (m < 48 * 60) return `${Math.round(m / 60)} giờ trước`;
  return `${Math.round(m / 1440)} ngày trước`;
}
const usd = (x) => `$${(x || 0).toFixed(x >= 100 ? 0 : x >= 1 ? 2 : 4)}`;

// ---------- Cognito (USER_PASSWORD_AUTH, self sign-up with an email code)
async function cognito(target, body) {
  const response = await fetch(`https://cognito-idp.${state.cfg.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify({ ClientId: state.cfg.clientId, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const type = String(data.__type || '').split('#').pop();
    const messages = {
      NotAuthorizedException: 'Sai email hoặc mật khẩu.', UserNotConfirmedException: 'Tài khoản chưa xác nhận email.',
      UsernameExistsException: 'Email này đã đăng ký.', CodeMismatchException: 'Mã xác nhận không đúng.',
      InvalidPasswordException: 'Mật khẩu cần ít nhất 10 ký tự, có chữ hoa, chữ thường và số.', LimitExceededException: 'Thử quá nhiều lần, đợi một lúc.',
    };
    throw Object.assign(new Error(messages[type] || data.message || type || 'Lỗi đăng nhập'), { type });
  }
  return data;
}

function saveAuth(result, refresh) {
  state.auth = { id: result.IdToken, refresh: result.RefreshToken || refresh, exp: Date.now() + (result.ExpiresIn || 3600) * 1000 - 60_000 };
  try { localStorage.setItem('poc3.auth', JSON.stringify(state.auth)); } catch { /* private mode */ }
}
function signOut() {
  state.auth = null;
  try { localStorage.removeItem('poc3.auth'); } catch { /* ignore */ }
  location.hash = '';
  renderAuth('in');
}
async function idToken() {
  if (!state.auth) throw new Error('signed out');
  if (Date.now() > state.auth.exp) {
    try {
      const r = await cognito('InitiateAuth', { AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: state.auth.refresh } });
      saveAuth(r.AuthenticationResult, state.auth.refresh);
    } catch {
      signOut();
      throw new Error('Phiên đăng nhập đã hết hạn');
    }
  }
  return state.auth.id;
}

// ---------- API
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${await idToken()}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

// POST with a server-sent events reply: calls on[event](data) for every event.
async function stream(path, body, on, signal) {
  const response = await fetch(path, {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${await idToken()}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data && on[event]) on[event](JSON.parse(data));
    }
  }
}

// ---------- Markdown with [n] citations and Mermaid diagrams
const dark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
function markdown(text) {
  const marked1 = String(text || '').replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, g) => g.split(/\s*,\s*/).map((n) => `⟦${n}⟧`).join(''));
  return DOMPurify.sanitize(marked.parse(marked1, { gfm: true, breaks: false })).replace(/⟦(\d+)⟧/g, '<button class="cite" data-n="$1" type="button">$1</button>');
}
let mermaidReady = false;
async function renderMermaid(root) {
  const blocks = [...root.querySelectorAll('pre > code.language-mermaid')];
  if (!blocks.length || typeof mermaid === 'undefined') return;
  if (!mermaidReady) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark() ? 'dark' : 'neutral', fontFamily: 'Be Vietnam Pro, sans-serif' });
    mermaidReady = true;
  }
  const nodes = blocks.map((code) => {
    const div = h('div.mermaid');
    div.textContent = code.textContent;
    code.parentElement.replaceWith(div);
    return div;
  });
  try {
    await mermaid.run({ nodes });
  } catch {
    for (const n of nodes) if (!n.querySelector('svg')) n.replaceWith(h('pre', h('code', n.textContent)));
  }
}
// Fills el with the rendered Markdown; [n] buttons open the passage n of passages.
function fill(el, text, passages, { final = true } = {}) {
  el.innerHTML = markdown(text);
  el.querySelectorAll('.cite').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const p = (passages || []).find((x) => x.n === Number(b.dataset.n));
      if (p) passagePop(b, p);
    };
  });
  if (final) renderMermaid(el);
}

function closePop() { document.querySelectorAll('.pop').forEach((p) => p.remove()); }
document.addEventListener('click', (e) => { if (!e.target.closest('.pop')) closePop(); });
function passagePop(anchor, p) {
  closePop();
  const pop = h('div.pop',
    h('div.row', h(`span.src-ico.${p.sourceType || 'S3'}`, (p.sourceType || '?')[0]), h('strong.grow', p.title || 'Tài liệu')),
    h('div.faint', [p.sourceTitle, p.page ? `trang ${p.page}` : '', p.section].filter(Boolean).join(' · ')),
    h('div.x', p.excerpt || p.text || ''),
    h('div.row',
      p.uri ? h('a.btn.small', { href: p.uri, target: '_blank', rel: 'noopener' }, 'Mở bản gốc ↗') : null,
      p.sourceId ? h('button.btn.small', { onclick: () => { closePop(); openGuide({ sourceId: p.sourceId, uri: p.uri, docId: p.docId, title: p.title }); } }, 'Tóm tắt tài liệu') : null));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(16, Math.min(r.left - 20, innerWidth - w - 16))}px`;
  const below = r.bottom + 8 + pop.offsetHeight < innerHeight;
  pop.style.top = `${below ? r.bottom + 8 : Math.max(16, r.top - pop.offsetHeight - 8)}px`;
}

function modal(title, body, actions = []) {
  const m = $('#modal');
  m.replaceChildren(h('div.box', { onclick: (e) => e.stopPropagation() },
    h('header', h('h2', title), ...actions, h('button.btn.ghost', { onclick: closeModal, 'aria-label': 'Đóng' }, '✕')),
    h('div.body', body)));
  m.hidden = false;
  m.onclick = closeModal;
  return m;
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modal').replaceChildren();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closePop(); } });

// ---------- auth screens
function renderAuth(mode = 'in', email = '') {
  const err = h('div.error');
  const f = { email: h('input', { type: 'email', value: email, autocomplete: 'username', required: true }), password: h('input', { type: 'password', autocomplete: mode === 'up' ? 'new-password' : 'current-password' }), code: h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code' }) };
  const go = async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = e.submitter;
    if (btn) btn.disabled = true;
    const Username = f.email.value.trim().toLowerCase();
    try {
      if (mode === 'in') {
        const r = await cognito('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: Username, PASSWORD: f.password.value } });
        saveAuth(r.AuthenticationResult);
        return start();
      }
      if (mode === 'up') {
        await cognito('SignUp', { Username, Password: f.password.value, UserAttributes: [{ Name: 'email', Value: Username }] });
        return renderAuth('confirm', Username);
      }
      if (mode === 'confirm') {
        await cognito('ConfirmSignUp', { Username, ConfirmationCode: f.code.value.trim() });
        toast('Đã xác nhận email, mời đăng nhập.');
        return renderAuth('in', Username);
      }
      if (mode === 'forgot') {
        await cognito('ForgotPassword', { Username });
        return renderAuth('reset', Username);
      }
      if (mode === 'reset') {
        await cognito('ConfirmForgotPassword', { Username, ConfirmationCode: f.code.value.trim(), Password: f.password.value });
        toast('Đã đổi mật khẩu.');
        return renderAuth('in', Username);
      }
    } catch (error) {
      if (error.type === 'UserNotConfirmedException') return renderAuth('confirm', Username);
      err.textContent = error.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  const titles = { in: 'Đăng nhập', up: 'Đăng ký tài khoản', confirm: 'Xác nhận email', forgot: 'Quên mật khẩu', reset: 'Đặt mật khẩu mới' };
  const link = (text, to) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderAuth(to, f.email.value); } }, text);
  $('#app').replaceChildren(h('div.auth', h('form.card', { onsubmit: go },
    h('div.brand', logo(), 'Project Notebook'),
    h('h1', titles[mode]),
    mode === 'up' ? h('p.muted', { style: 'margin:0' }, 'Sau khi đăng ký, bạn thấy được các tài liệu mà quyền Confluence space hoặc SharePoint folder của bạn cho phép; nếu chưa có, admin sẽ duyệt.') : null,
    h('label.field', 'Email', f.email),
    ['in', 'up', 'reset'].includes(mode) ? h('label.field', mode === 'in' ? 'Mật khẩu' : 'Mật khẩu mới', f.password) : null,
    ['confirm', 'reset'].includes(mode) ? h('label.field', 'Mã gửi qua email', f.code) : null,
    err,
    h('button.btn.primary', { type: 'submit' }, titles[mode]),
    h('div.row.faint',
      mode === 'in' ? [link('Đăng ký', 'up'), '·', link('Quên mật khẩu', 'forgot')] : link('Quay lại đăng nhập', 'in'),
      mode === 'confirm' ? ['·', h('a', { href: '#', onclick: async (e) => { e.preventDefault(); try { await cognito('ResendConfirmationCode', { Username: f.email.value.trim().toLowerCase() }); toast('Đã gửi lại mã.'); } catch (x) { err.textContent = x.message; } } }, 'Gửi lại mã')] : null))));
  (mode === 'confirm' || mode === 'reset' ? f.code : f.email.value ? f.password : f.email).focus();
}

function logo() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 32 32');
  s.innerHTML = '<rect x="5" y="3" width="22" height="26" rx="3" fill="var(--accent)"/><path d="M10 10h12M10 15h12M10 20h8" stroke="var(--accent-fg)" stroke-width="2" stroke-linecap="round"/>';
  return s;
}

// ---------- shell
function shell(content, active) {
  const me = state.me;
  const tab = (href, text, key) => h('a', { href, class: active === key ? 'on' : '' }, text);
  return h('div.shell',
    h('header.top',
      h('div.brand', logo(), 'Project Notebook'),
      h('nav.nav',
        tab('#/', 'Notebook', 'nb'), tab('#/sync', 'Đồng bộ', 'sync'), tab('#/mcp', 'MCP', 'mcp'),
        me.admin ? [tab('#/admin', 'Người dùng', 'admin'), tab('#/cost', 'Chi phí', 'cost')] : null),
      h('div.who', h('span.email.muted', me.email), me.admin ? h('span.badge.accent', 'admin') : null,
        h('button.btn.small', { onclick: signOut }, 'Đăng xuất'))),
    h('main.main', content));
}

// ---------- start and routing
async function start() {
  try {
    state.me = await api('/api/me');
  } catch (error) {
    if (!state.auth) return;
    $('#app').replaceChildren(h('div.auth', h('div.card', h('h1', 'Không tải được'), h('p.error', error.message), h('button.btn', { onclick: signOut }, 'Đăng xuất'))));
    return;
  }
  state.sources = await api('/api/sources');
  if (state.me.status !== 'active') return renderPending();
  [state.notebooks, state.outputs] = await Promise.all([api('/api/notebooks'), api('/api/studio/outputs')]);
  if (!state.notebooks.length) state.notebooks = [await api('/api/notebooks', { method: 'POST', body: { name: 'Notebook đầu tiên', sources: [] } })];
  route();
}

window.addEventListener('hashchange', () => state.me && route());
function route() {
  clearInterval(state.timer);
  closeModal();
  const [, page, id] = location.hash.split('/');
  if (page === 'sync') return renderSync();
  if (page === 'mcp') return renderMcp();
  if (page === 'admin' && state.me.admin) return renderAdmin();
  if (page === 'cost' && state.me.admin) return renderCost();
  const nb = state.notebooks.find((n) => n.id === id) || state.notebooks.find((n) => n.id === localGet('poc3.nb')) || state.notebooks[0];
  return openNotebook(nb.id);
}
function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// ---------- waiting for approval: ask for sources
function renderPending() {
  const me = state.me;
  const picked = new Set(me.requested || []);
  const note = h('textarea', { rows: 3, placeholder: 'Bạn thuộc dự án nào, vai trò gì (BA, BrSE, SA…)' });
  $('#app').replaceChildren(h('div.auth', h('div.card', { style: 'max-width:560px' },
    h('div.brand', logo(), 'Project Notebook'),
    h('h1', me.status === 'disabled' ? 'Tài khoản đã bị khoá' : 'Đang chờ duyệt'),
    me.status === 'disabled' ? h('p.muted', 'Liên hệ admin để mở lại.') : [
      h('p.muted', { style: 'margin:0' }, 'Quyền Confluence/SharePoint của bạn chưa được đồng bộ vào hệ thống. Chọn các nguồn tài liệu bạn cần, admin sẽ duyệt.'),
      h('div', { style: 'display:grid;gap:6px' }, state.sources.map((s) => h('label.row', h('input', { type: 'checkbox', checked: picked.has(s.id), onchange: (e) => (e.target.checked ? picked.add(s.id) : picked.delete(s.id)) }),
        h(`span.src-ico.${s.type}`, s.type[0]), h('span', s.title || s.name), h('span.faint', s.name)))),
      h('label.field', 'Ghi chú cho admin', note),
      h('div.row', h('button.btn.primary', { onclick: async () => { await api('/api/access-request', { method: 'POST', body: { sources: [...picked], note: note.value } }); toast('Đã gửi yêu cầu.'); } }, 'Gửi yêu cầu'),
        h('button.btn', { onclick: () => start() }, 'Kiểm tra lại')),
      me.requested?.length ? h('p.faint', `Đã yêu cầu ${me.requested.length} nguồn.`) : null],
    h('button.btn.ghost.small', { onclick: signOut }, 'Đăng xuất'))));
}

// ---------- notebook
async function openNotebook(id) {
  state.nb = state.notebooks.find((n) => n.id === id);
  localSet('poc3.nb', id);
  if (location.hash !== `#/nb/${id}`) history.replaceState(null, '', `#/nb/${id}`);
  [state.messages, state.notes] = await Promise.all([api(`/api/notebooks/${id}/messages`), api(`/api/notebooks/${id}/notes`)]);
  renderNotebook();
}

const granted = () => state.sources.filter((s) => s.granted);
const inNotebook = (s) => s.granted && (!state.nb.sources.length || state.nb.sources.includes(s.id));

function renderNotebook() {
  const root = h('div.nb');
  root.append(sourcesPane(root), chatPane(root), studioPane(root));
  $('#app').replaceChildren(shell(root, 'nb'));
  scrollChat();
}

function syncBadge(s) {
  const j = s.sync;
  if (!j) return h('span.badge', 'chưa sync');
  if (['STARTING', 'IN_PROGRESS', 'STOPPING'].includes(j.status)) return h('span.badge.warn', 'đang sync');
  if (j.status === 'FAILED') return h('span.badge.bad', 'sync lỗi');
  return h('span.badge.good', { title: `Lần sync gần nhất: ${fmtTime(j.updatedAt)}` }, ago(j.updatedAt));
}

function sourcesPane(root) {
  const list = h('div');
  const select = h('select', { onchange: (e) => { location.hash = `#/nb/${e.target.value}`; } },
    state.notebooks.map((n) => h('option', { value: n.id, selected: n.id === state.nb.id }, n.name)));
  const draw = () => {
    list.replaceChildren(...state.sources.map((s) => {
      const on = inNotebook(s);
      const row = h('div', h(`div.src${s.granted ? '' : '.locked'}`,
        s.granted ? h('input', { type: 'checkbox', checked: on, title: 'Dùng nguồn này trong notebook', onchange: (e) => toggleSource(s, e.target.checked) }) : h('span', { title: 'Chưa có quyền' }, '🔒'),
        h('div',
          h('div.row', h(`span.src-ico.${s.type}`, s.type[0]), h('span.t.grow', { onclick: () => s.granted && toggleDocs(s, row) }, s.title || s.name))),
        h('span'),
        h('div.m', s.granted ? [syncBadge(s), s.documents != null ? h('span.faint.num', `${s.documents} tài liệu`) : null, h('span.faint', s.knowledgeBase)]
          : s.requested ? h('span.badge', 'đã xin quyền') : h('button.btn.small', { onclick: () => requestSource(s) }, 'Xin quyền'))));
      if (state.open.has(s.id)) drawDocs(s, row);
      return row;
    }));
  };
  const toggleSource = async (s, on) => {
    const ids = state.nb.sources.length ? state.nb.sources : granted().map((x) => x.id);
    const next = on ? [...new Set([...ids, s.id])] : ids.filter((x) => x !== s.id);
    const all = granted().every((x) => next.includes(x.id));
    state.nb = await api(`/api/notebooks/${state.nb.id}`, { method: 'PATCH', body: { sources: all ? [] : next } });
    state.notebooks = state.notebooks.map((n) => (n.id === state.nb.id ? state.nb : n));
    draw();
  };
  const toggleDocs = async (s, row) => {
    if (state.open.has(s.id)) {
      state.open.delete(s.id);
      return draw();
    }
    state.open.add(s.id);
    if (!state.docs[s.id]) {
      row.append(h('div.docs.faint', 'Đang tải danh sách…'));
      try { state.docs[s.id] = await api(`/api/sources/${s.id}/documents`); } catch (error) { state.docs[s.id] = { error: error.message }; }
    }
    draw();
  };
  const drawDocs = (s, row) => {
    const docs = state.docs[s.id];
    if (!docs) return;
    if (docs.error) return row.append(h('div.docs.error', docs.error));
    const kinds = docs.reduce((m, d) => ({ ...m, [d.kind]: (m[d.kind] || 0) + 1 }), {});
    row.append(h('div.docs',
      h('div.faint', Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(' · ')),
      docs.map((d) => h(`div.doc${d.status === 'FAILED' ? '.failed' : ''}`, { title: d.status === 'FAILED' ? `Không index được: ${d.reason || ''}` : d.title, onclick: () => d.status === 'FAILED' ? toast(`Không index được: ${d.reason || 'không rõ lý do'}`, 6000) : openGuide({ sourceId: s.id, uri: d.uri, docId: d.docId, title: d.title }) },
        h('span.k', d.kind), h('span.n', d.title)))));
  };
  draw();
  return h('section.pane.sources-pane',
    h('div.nb-switch', select,
      h('button.btn.small', { title: 'Notebook mới', onclick: newNotebook }, '+'),
      h('button.btn.small', { title: 'Đổi tên / xoá', onclick: editNotebook }, '⋯')),
    h('header', h('h2', 'Nguồn tài liệu'), h('span.faint', `${state.sources.filter(inNotebook).length}/${granted().length} đang dùng`)),
    h('div.body', list,
      h('p.faint', 'Bấm tên nguồn để xem tài liệu; bấm tài liệu để xem tóm tắt (source guide). Mỗi nguồn là một Confluence space hoặc một SharePoint folder.')));
}

async function requestSource(s) {
  const requested = [...new Set([...(state.me.requested || []), s.id])];
  await api('/api/access-request', { method: 'POST', body: { sources: requested } });
  state.me.requested = requested;
  s.requested = true;
  toast('Đã gửi yêu cầu cho admin.');
  renderNotebook();
}

async function newNotebook() {
  const name = h('input', { type: 'text', value: 'Notebook mới' });
  const desc = h('input', { type: 'text', placeholder: 'Ví dụ: tìm hiểu nghiệp vụ module thanh toán' });
  modal('Notebook mới', h('div', { style: 'display:grid;gap:10px' }, h('label.field', 'Tên', name), h('label.field', 'Mô tả', desc),
    h('p.faint', 'Notebook mới dùng tất cả nguồn bạn có quyền; bỏ chọn ở cột Nguồn để thu hẹp.'),
    h('button.btn.primary', { onclick: async () => {
      const nb = await api('/api/notebooks', { method: 'POST', body: { name: name.value, description: desc.value, sources: [] } });
      state.notebooks.unshift(nb);
      location.hash = `#/nb/${nb.id}`;
    } }, 'Tạo')));
  name.select();
}

function editNotebook() {
  const name = h('input', { type: 'text', value: state.nb.name });
  const desc = h('input', { type: 'text', value: state.nb.description });
  const confirmDel = h('button.btn.danger', { onclick: async () => {
    if (confirmDel.dataset.sure !== '1') { confirmDel.dataset.sure = '1'; confirmDel.textContent = 'Bấm lần nữa để xoá hẳn'; return; }
    await api(`/api/notebooks/${state.nb.id}`, { method: 'DELETE' });
    state.notebooks = state.notebooks.filter((n) => n.id !== state.nb.id);
    if (!state.notebooks.length) state.notebooks = [await api('/api/notebooks', { method: 'POST', body: { name: 'Notebook đầu tiên' } })];
    location.hash = `#/nb/${state.notebooks[0].id}`;
  } }, 'Xoá notebook');
  modal('Notebook', h('div', { style: 'display:grid;gap:10px' }, h('label.field', 'Tên', name), h('label.field', 'Mô tả', desc),
    h('div.row', h('button.btn.primary', { onclick: async () => {
      state.nb = await api(`/api/notebooks/${state.nb.id}`, { method: 'PATCH', body: { name: name.value, description: desc.value } });
      state.notebooks = state.notebooks.map((n) => (n.id === state.nb.id ? state.nb : n));
      closeModal();
      renderNotebook();
    } }, 'Lưu'), h('span.grow'), confirmDel)));
}

// ---------- chat
const STARTERS = [
  'Tóm tắt mục tiêu, phạm vi và các tính năng chính của dự án',
  'Các luồng nghiệp vụ chính là gì? Vẽ sơ đồ nếu có thể',
  'Kiến trúc hệ thống gồm những thành phần nào và công nghệ gì?',
  'Có những quyết định, rủi ro hoặc vấn đề còn mở nào?',
];

function chatPane(root) {
  const list = h('div.chat');
  const input = h('textarea', { rows: 2, placeholder: 'Hỏi về tài liệu của notebook… (Enter để gửi, Shift+Enter xuống dòng)' });
  const send = h('button.btn.primary', { onclick: () => ask(input.value) }, 'Gửi');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask(input.value);
    }
  });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; });
  const seg = h('div.seg', [['fast', 'Nhanh'], ['deep', 'Chuyên sâu']].map(([k, t]) => h(`button${state.mode === k ? '.on' : ''}`, {
    title: k === 'deep' ? 'Agentic retrieval: tách câu hỏi thành nhiều truy vấn con, chậm hơn, dùng cho câu hỏi rộng' : 'Một lần tìm kiếm, trả lời nhanh',
    onclick: (e) => { state.mode = k; seg.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); } }, t)));
  const lang = h('select', { style: 'width:auto', onchange: (e) => { state.lang = e.target.value; } },
    [['', 'Ngôn ngữ: theo câu hỏi'], ['vi', 'Tiếng Việt'], ['en', 'English'], ['ja', '日本語']].map(([v, t]) => h('option', { value: v, selected: state.lang === v }, t)));

  const draw = () => {
    if (!state.messages.length) {
      list.replaceChildren(h('div.empty',
        h('h3', state.nb.name),
        state.nb.description ? h('p', state.nb.description) : null,
        h('p', `Hỏi đáp trên ${state.sources.filter(inNotebook).length} nguồn tài liệu. Câu trả lời luôn kèm trích dẫn [n] tới đoạn tài liệu gốc.`),
        h('div.followups', { style: 'justify-content:center' }, STARTERS.map((q) => h('button', { onclick: () => ask(q) }, q)))));
      return;
    }
    list.replaceChildren(...state.messages.map(messageView));
  };
  async function ask(text) {
    const question = String(text || '').trim();
    if (!question || state.busy) return;
    if (!state.sources.some(inNotebook)) return toast('Notebook chưa có nguồn nào bạn được đọc.');
    state.busy = true;
    send.disabled = true;
    input.value = '';
    input.style.height = 'auto';
    state.messages.push({ role: 'user', content: question });
    const live = { role: 'assistant', content: '', passages: [], steps: [], live: true, mode: state.mode };
    state.messages.push(live);
    draw();
    const view = list.lastElementChild;
    const bubble = view.querySelector('.bubble');
    const steps = view.querySelector('.steps');
    bubble.classList.add('typing');
    let frame = 0;
    const paint = () => { frame = 0; fill(bubble, live.content, live.passages, { final: false }); scrollChat(); };
    try {
      await stream('/api/chat', { notebookId: state.nb.id, question, mode: state.mode, lang: state.lang || undefined }, {
        sources: (d) => { live.passages = d.passages; },
        step: (d) => { live.steps.push(d.text); steps.append(h('div', d.text)); scrollChat(); },
        delta: (d) => { live.content += d.text; if (!frame) frame = requestAnimationFrame(paint); },
        done: (d) => { Object.assign(live, { content: d.answer, citations: d.citations, followups: d.followups, live: false, id: d.id }); },
        error: (d) => { live.error = d.message; },
      });
    } catch (error) {
      live.error = error.message;
    }
    live.live = false;
    state.busy = false;
    send.disabled = false;
    view.replaceWith(messageView(live));
    scrollChat();
    input.focus();
  }
  chatPane.ask = ask;
  draw();
  return h('section.pane.chat-pane',
    h('header', h('h2', 'Hỏi đáp'),
      h('div.tabs-mobile', h('button.btn.small', { onclick: () => root.classList.toggle('show-sources') }, 'Nguồn')),
      h('button.btn.small.studio-toggle', { onclick: () => root.classList.toggle('show-studio') }, 'Studio'),
      h('button.btn.small.ghost', { title: 'Xoá lịch sử chat của notebook', onclick: async () => {
        await api(`/api/notebooks/${state.nb.id}/messages`, { method: 'DELETE' });
        state.messages = [];
        draw();
      } }, 'Xoá chat')),
    list,
    h('div.composer', input, h('div.row', seg, lang, h('span.grow'), send)));
}

function messageView(m) {
  if (m.role === 'user') return h('div.msg.user', h('div.bubble', m.content));
  const bubble = h('div.bubble');
  if (m.content) fill(bubble, m.content, m.passages, { final: !m.live });
  const out = h('div.msg.assistant',
    h('div.steps', (m.steps || []).map((s) => h('div', s))),
    bubble);
  if (m.error) out.append(h('p.error', m.error));
  if (!m.live && m.content) {
    out.append(h('div.tools',
      m.mode === 'deep' ? h('span.badge', 'chuyên sâu') : null,
      h('button.btn.small', { onclick: () => copy(m.content) }, 'Sao chép'),
      h('button.btn.small', { onclick: () => saveNote(m) }, 'Lưu vào ghi chú')));
    if (m.followups?.length) out.append(h('div.followups', m.followups.map((q) => h('button', { onclick: () => chatPane.ask(q) }, q))));
    if (m.passages?.length) {
      out.append(h('details.sources', h('summary', `${m.passages.length} đoạn tài liệu đã dùng`),
        m.passages.map((p) => h('div.passage',
          h('div.h', `[${p.n}] `, p.uri ? h('a', { href: p.uri, target: '_blank', rel: 'noopener' }, p.title) : p.title,
            h('span.faint', ` · ${[p.sourceTitle, p.page ? `trang ${p.page}` : ''].filter(Boolean).join(' · ')}`)),
          h('div.x', p.excerpt || '')))));
    }
  }
  return out;
}

function scrollChat() {
  const c = $('.chat');
  if (c) c.scrollTop = c.scrollHeight;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Đã sao chép.');
  } catch {
    toast('Trình duyệt chặn sao chép.');
  }
}

async function saveNote(m) {
  const question = state.messages[state.messages.indexOf(m) - 1]?.content || 'Ghi chú';
  await api(`/api/notebooks/${state.nb.id}/notes`, { method: 'POST', body: { title: question.slice(0, 120), content: m.content, kind: 'answer', passages: m.passages } });
  state.notes = await api(`/api/notebooks/${state.nb.id}/notes`);
  studioPane.draw?.();
  toast('Đã lưu vào ghi chú.');
}

// ---------- source guide
async function openGuide({ sourceId, uri, docId, title }) {
  const body = h('div', h('p.muted', 'Đang đọc tài liệu và tóm tắt… (lần đầu mất vài giây, sau đó được cache)'));
  modal(title || 'Tài liệu', body, uri ? [h('a.btn.small', { href: uri, target: '_blank', rel: 'noopener' }, 'Mở bản gốc ↗')] : []);
  try {
    const g = await api('/api/documents/guide', { method: 'POST', body: { source: sourceId, uri, docId, title, lang: state.lang || 'vi' } });
    body.replaceChildren(
      h('div.label', 'Tóm tắt'), h('p', g.summary),
      g.topics?.length ? [h('div.label', 'Chủ đề chính'), h('div.row', { style: 'margin:6px 0 14px' }, g.topics.map((t) => h('span.badge.accent', t)))] : null,
      g.questions?.length ? [h('div.label', 'Câu hỏi tài liệu này trả lời'), h('div.followups', g.questions.map((q) => h('button', { onclick: () => { closeModal(); chatPane.ask?.(q); } }, q)))] : null,
      h('p.faint', { style: 'margin-top:14px' }, `${(g.characters || 0).toLocaleString('vi-VN')} ký tự đã trích xuất bởi Knowledge Base.`));
  } catch (error) {
    body.replaceChildren(h('p.error', error.message));
  }
}

// ---------- studio and notes
const STUDIO_HINT = {
  briefing: 'Tổng quan cho người mới', faq: 'Câu hỏi thường gặp', glossary: 'Thuật ngữ VI / EN / JA', mindmap: 'Sơ đồ tư duy Mermaid',
  timeline: 'Mốc thời gian, phiên bản', onboarding: 'Lộ trình tuần đầu',
};

function studioPane() {
  const focus = h('input', { type: 'text', placeholder: 'Chủ đề tập trung (tuỳ chọn), ví dụ: đăng nhập, TTS' });
  const notes = h('div.notes');
  const draw = () => {
    notes.replaceChildren(...(state.notes.length ? state.notes.map((n) => h('div.note', { onclick: () => openNote(n) },
      h('div.t', n.title), h('div.faint', `${n.kind === 'note' ? 'Ghi chú' : n.kind === 'answer' ? 'Câu trả lời đã lưu' : 'Studio'} · ${fmtTime(n.at)}`)))
      : [h('p.faint', 'Chưa có ghi chú. Lưu câu trả lời hay tạo tài liệu từ Studio để giữ lại ở đây.')]));
  };
  studioPane.draw = draw;
  draw();
  return h('section.pane.studio-pane',
    h('header', h('h2', 'Studio'), h('button.btn.small.ghost.studio-toggle', { onclick: (e) => e.target.closest('.nb').classList.remove('show-studio') }, '✕')),
    h('div.body',
      h('div.studio-grid', state.outputs.map((o) => h('button', { onclick: () => runStudio(o, focus.value) }, o.title, h('span', STUDIO_HINT[o.kind] || '')))),
      h('div', { style: 'margin-top:8px' }, focus),
      h('div.row', { style: 'margin-top:16px' }, h('div.label.grow', 'Ghi chú'),
        h('button.btn.small', { onclick: newNote }, '+ Ghi chú')),
      notes));
}

async function runStudio(o, focus) {
  const bubble = h('div.bubble.typing');
  const status = h('p.faint', 'Đang tìm các đoạn tài liệu liên quan…');
  let passages = [];
  let content = '';
  const controller = new AbortController();
  modal(focus ? `${o.title} — ${focus}` : o.title, h('div', status, bubble));
  $('#modal').addEventListener('click', () => controller.abort(), { once: true });
  let frame = 0;
  try {
    await stream('/api/studio', { notebookId: state.nb.id, kind: o.kind, focus, lang: state.lang || 'vi' }, {
      sources: (d) => { passages = d.passages; status.textContent = `Đang viết từ ${passages.length} đoạn tài liệu…`; },
      delta: (d) => { content += d.text; if (!frame) frame = requestAnimationFrame(() => { frame = 0; fill(bubble, content, passages, { final: false }); }); },
      done: () => { status.textContent = 'Đã lưu vào ghi chú của notebook.'; },
      error: (d) => { status.textContent = d.message; status.className = 'error'; },
    }, controller.signal);
  } catch (error) {
    if (error.name !== 'AbortError') { status.textContent = error.message; status.className = 'error'; }
  }
  bubble.classList.remove('typing');
  fill(bubble, content, passages);
  state.notes = await api(`/api/notebooks/${state.nb.id}/notes`);
  studioPane.draw?.();
}

function openNote(n) {
  const bubble = h('div.bubble');
  fill(bubble, n.content, n.passages);
  const del = h('button.btn.small.danger', { onclick: async () => {
    if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Bấm lần nữa để xoá'; return; }
    await api(`/api/notebooks/${state.nb.id}/notes/${encodeURIComponent(n.id)}`, { method: 'DELETE' });
    state.notes = state.notes.filter((x) => x.id !== n.id);
    studioPane.draw?.();
    closeModal();
  } }, 'Xoá');
  modal(n.title, bubble, [h('button.btn.small', { onclick: () => copy(n.content) }, 'Sao chép'), del]);
}

function newNote() {
  const title = h('input', { type: 'text', placeholder: 'Tiêu đề' });
  const content = h('textarea', { rows: 10, placeholder: 'Nội dung (Markdown)' });
  modal('Ghi chú mới', h('div', { style: 'display:grid;gap:10px' }, title, content, h('button.btn.primary', { onclick: async () => {
    await api(`/api/notebooks/${state.nb.id}/notes`, { method: 'POST', body: { title: title.value || 'Ghi chú', content: content.value, kind: 'note' } });
    state.notes = await api(`/api/notebooks/${state.nb.id}/notes`);
    studioPane.draw?.();
    closeModal();
  } }, 'Lưu')));
  title.focus();
}

// ---------- sync monitor
async function renderSync() {
  const body = h('div.page', h('h1', 'Trạng thái đồng bộ'), h('p.muted', 'Đang tải…'));
  $('#app').replaceChildren(shell(body, 'sync'));
  const draw = async () => {
    let data;
    try { data = await api('/api/sync'); } catch (error) { body.replaceChildren(h('h1', 'Trạng thái đồng bộ'), h('p.error', error.message)); return; }
    const sources = data.sources;
    const docs = sources.reduce((n, s) => n + (s.documents || 0), 0);
    const failed = sources.reduce((n, s) => n + (s.latest?.failed || 0), 0);
    const ages = sources.map((s) => (s.lastSuccessAt ? (Date.now() - new Date(s.lastSuccessAt)) / 3600_000 : Infinity));
    const worst = Math.max(0, ...ages);
    const stale = ages.filter((a) => a > data.staleHours).length;
    const running = sources.filter((s) => ['STARTING', 'IN_PROGRESS'].includes(s.latest?.status)).length;
    body.replaceChildren(
      h('div.row', h('h1.grow', 'Trạng thái đồng bộ'), h('span.faint', `Monitor kiểm tra lần cuối ${ago(data.checkedAt)} · tự làm mới mỗi 30 giây`)),
      h('div.stats',
        stat('Nguồn', sources.length, `${running} đang sync`),
        stat('Tài liệu đã index', docs.toLocaleString('vi-VN'), 'theo job thành công gần nhất'),
        stat('Tài liệu lỗi', failed, failed ? 'xem chi tiết bên dưới' : 'không có', failed ? 'bad' : ''),
        stat('Sync cũ nhất', Number.isFinite(worst) ? `${Math.round(worst)} giờ` : 'chưa sync', stale ? `${stale} nguồn quá ${data.staleHours} giờ` : `ngưỡng cảnh báo ${data.staleHours} giờ`, stale ? 'warn' : '')),
      h('div.card', h('div.tbl-wrap', h('table.tbl',
        h('thead', h('tr', ['Nguồn', 'Knowledge Base', 'Trạng thái', 'Lần chạy gần nhất', 'Quét / mới / lỗi', 'Tài liệu', '20 lần gần nhất', ''].map((t) => h('th', t)))),
        h('tbody', sources.map((s) => {
          const j = s.latest;
          const badge = !j ? h('span.badge', 'chưa sync') : j.status === 'COMPLETE' ? h('span.badge.good', 'hoàn tất') : j.status === 'FAILED' ? h('span.badge.bad', 'lỗi')
            : h('span.badge.warn', j.status.toLowerCase());
          return [
            h('tr',
              h('td', h('div.row', h(`span.src-ico.${s.type}`, s.type[0]), h('strong', s.title || s.name)), h('div.faint', s.name)),
              h('td.faint', s.knowledgeBase),
              h('td', badge),
              h('td.num', fmtTime(j?.updatedAt), h('div.faint', `thành công ${ago(s.lastSuccessAt)}`)),
              h('td.num', j ? `${j.scanned} / ${j.indexed} / ${j.failed}` : '—'),
              h('td.num', s.documents ?? '—'),
              h('td', h('div.runs', [...s.history].reverse().map((r) => h(`i.${r.status}`, { style: `height:${6 + Math.min(16, Math.log2(1 + r.scanned) * 2)}px`, title: `${fmtTime(r.startedAt)} · ${r.status} · quét ${r.scanned}, mới ${r.indexed}, lỗi ${r.failed}` })))),
              h('td', state.me.admin ? h('button.btn.small', { disabled: ['STARTING', 'IN_PROGRESS'].includes(j?.status), onclick: async (e) => {
                e.target.disabled = true;
                try { await api(`/api/sources/${s.id}/sync`, { method: 'POST' }); toast('Đã bắt đầu sync; monitor cập nhật trong 15 phút, hoặc bấm làm mới.'); } catch (error) { toast(error.message); e.target.disabled = false; }
              } }, 'Sync ngay') : null)),
            s.failedDocuments?.length ? h('tr', h('td', { colspan: 8 }, h('div.faint', 'Tài liệu không index được:'),
              h('ul.fail-list', s.failedDocuments.map((f) => h('li', f.title, h('span', ` — ${f.reason || 'không rõ lý do'}`)))))) : null,
          ];
        }))))),
      h('p.faint', `Lịch sync: ${data.schedule}. Cảnh báo (CloudWatch alarm) khi một nguồn quá ${data.staleHours} giờ chưa sync thành công hoặc job lỗi.`));
  };
  await draw();
  state.timer = setInterval(draw, 30_000);
}

function stat(label, value, hint, tone = '') {
  return h('div.stat', h('div.label', label), h(`div.v${tone ? `.${tone}` : ''}`, { style: tone ? `color:var(--${tone})` : '' }, value), h('div.faint', hint));
}

// ---------- MCP
async function renderMcp() {
  const body = h('div.page');
  $('#app').replaceChildren(shell(body, 'mcp'));
  const endpoint = `${location.origin}/mcp`;
  const draw = async (fresh) => {
    const tokens = await api('/api/tokens');
    const name = h('input', { type: 'text', value: 'Claude Code', style: 'max-width:240px' });
    const days = h('select', { style: 'width:auto' }, [30, 90, 180, 365].map((d) => h('option', { value: d, selected: d === 90 }, `${d} ngày`)));
    const t = fresh?.token || '<token>';
    body.replaceChildren(
      h('h1', 'MCP server cho local agent'),
      h('p.muted', 'Nối Claude Code, Kiro hay agent khác vào tài liệu dự án. Agent chỉ thấy các nguồn bạn có quyền đọc. Các tool: search, ask, list_sources, list_documents, get_document, list_notebooks.'),
      fresh ? h('div.card', { style: 'border-color:var(--accent)' }, h('h2', 'Token mới (chỉ hiện một lần)'), h('pre.snippet', fresh.token),
        h('button.btn.small', { onclick: () => copy(fresh.token) }, 'Sao chép token')) : null,
      h('div.card', h('h2', 'Claude Code'),
        h('pre.snippet', `claude mcp add --transport http project-notebook ${endpoint} \\\n  --header "Authorization: Bearer ${t}"`),
        h('h2', { style: 'margin-top:14px' }, 'Kiro (.kiro/settings/mcp.json)'),
        h('pre.snippet', JSON.stringify({ mcpServers: { 'project-notebook': { url: endpoint, headers: { Authorization: `Bearer ${t}` } } } }, null, 2)),
        h('p.faint', 'Gợi ý prompt: "Dùng project-notebook để tìm business rule của màn hình đăng ký rồi viết test case".')),
      h('div.card', h('h2', 'Access token của bạn'),
        h('div.row', name, days, h('button.btn.primary', { onclick: async () => draw(await api('/api/tokens', { method: 'POST', body: { name: name.value, days: Number(days.value) } })) }, 'Tạo token')),
        h('div.tbl-wrap', { style: 'margin-top:12px' }, h('table.tbl', h('thead', h('tr', ['Tên', 'Prefix', 'Tạo lúc', 'Hết hạn', ''].map((x) => h('th', x)))),
          h('tbody', tokens.length ? tokens.map((k) => h('tr', h('td', k.name), h('td', h('code', `${k.prefix}…`)), h('td.num', fmtTime(k.createdAt)), h('td.num', fmtTime(k.expiresAt)),
            h('td', h('button.btn.small.danger', { onclick: async () => { await api(`/api/tokens/${encodeURIComponent(k.prefix)}`, { method: 'DELETE' }); draw(); } }, 'Thu hồi'))))
            : h('tr', h('td.faint', { colspan: 5 }, 'Chưa có token.')))))));
  };
  await draw();
}

// ---------- admin: users, grants and the permission import
async function renderAdmin() {
  const body = h('div.page');
  $('#app').replaceChildren(shell(body, 'admin'));
  const draw = async () => {
    const [users, report] = await Promise.all([api('/api/admin/users'), api('/api/admin/import-permissions')]);
    const order = { pending: 0, active: 1, disabled: 2 };
    users.sort((a, b) => order[a.status] - order[b.status] || a.email.localeCompare(b.email));
    const importBtn = h('button.btn.primary', { onclick: async () => {
      importBtn.disabled = true;
      importBtn.textContent = 'Đang đọc quyền…';
      try { await api('/api/admin/import-permissions', { method: 'POST' }); toast('Đã đồng bộ quyền.'); } catch (error) { toast(error.message); }
      draw();
    } }, 'Đồng bộ quyền ngay');
    body.replaceChildren(
      h('h1', 'Người dùng và phân quyền'),
      h('div.card', h('div.row', h('h2.grow', { style: 'margin:0' }, 'Đồng bộ quyền từ Confluence và SharePoint'), importBtn),
        h('p.muted', 'Ai đọc được Confluence space hoặc SharePoint folder nào thì được quyền nguồn tương ứng. Chạy tự động mỗi ngày; người chưa đăng ký sẽ nhận quyền khi đăng ký.'),
        report ? h('p.faint', `Lần cuối ${fmtTime(report.at)}: ${report.granted} người đã có tài khoản được cập nhật, ${report.waiting} email chờ đăng ký, ${report.hidden} tài khoản ẩn email, ${report.groups} group không mở rộng được, ${report.siteGroups} SharePoint site group không đọc được${report.everyone ? `, ${report.everyone} quyền kiểu "mọi người trong tổ chức" (không cấp tự động)` : ''}.`,
          report.sources?.length ? h('span', ' Theo nguồn: ', report.sources.map((s) => `${s.name} ${s.readers}`).join(', '), '.') : null,
          report.notes?.length ? h('ul.fail-list', report.notes.map((n) => h('li', n))) : null) : h('p.faint', 'Chưa chạy lần nào.')),
      h('div.card', h('div.tbl-wrap', h('table.tbl',
        h('thead', h('tr', ['Người dùng', 'Trạng thái', 'Vai trò', 'Quyền theo nguồn', ''].map((x) => h('th', x)))),
        h('tbody', users.map((u) => {
          const status = h('select', { style: 'width:auto' }, ['pending', 'active', 'disabled'].map((s) => h('option', { value: s, selected: u.status === s }, { pending: 'chờ duyệt', active: 'hoạt động', disabled: 'khoá' }[s])));
          const role = h('select', { style: 'width:auto' }, ['member', 'admin'].map((r) => h('option', { value: r, selected: u.role === r }, r)));
          const boxes = state.sources.map((s) => {
            const g = u.grants.find((x) => x.sourceId === s.id);
            const asked = u.requested.includes(s.id);
            return h('label', { title: g ? `cấp bởi ${g.origin}` : asked ? 'người dùng xin quyền' : '' },
              h('input', { type: 'checkbox', value: s.id, checked: !!g }), s.name, g?.origin === 'import' ? h('span.badge', 'import') : null, asked ? h('span.badge.warn', 'xin') : null);
          });
          return h('tr',
            h('td', h('strong', u.name), h('div.faint', u.email), u.note ? h('div.faint', `“${u.note}”`) : null),
            h('td', status), h('td', role),
            h('td', h('div.grants', boxes)),
            h('td', h('button.btn.small', { onclick: async () => {
              const grants = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
              try { await api(`/api/admin/users/${encodeURIComponent(u.email)}`, { method: 'PATCH', body: { status: status.value, role: role.value, grants } }); toast('Đã lưu.'); draw(); } catch (error) { toast(error.message); }
            } }, 'Lưu')));
        }))))));
  };
  await draw();
}

// ---------- cost of the month
async function renderCost() {
  const body = h('div.page');
  $('#app').replaceChildren(shell(body, 'cost'));
  const month = h('input', { type: 'month', value: new Date().toISOString().slice(0, 7), style: 'width:auto', onchange: () => draw() });
  const draw = async () => {
    const u = await api(`/api/usage?month=${month.value}`);
    const total = u.usd.models + u.usd.retrieve + u.usd.agentic;
    body.replaceChildren(
      h('div.row', h('h1.grow', 'Chi phí theo lượng dùng'), month),
      h('div.stats',
        stat('Tổng (biến đổi)', usd(total), 'model + Retrieve + agentic'),
        stat('Câu hỏi', u.total.questions, `${u.total.studio} lần Studio, ${u.total.mcpCalls} lời gọi MCP`),
        stat('Retrieve', u.total.retrieve, usd(u.usd.retrieve)),
        stat('Agentic retrieval', u.total.agentic, usd(u.usd.agentic))),
      h('div.card', h('h2', 'Model (Amazon Bedrock)'), h('div.tbl-wrap', h('table.tbl',
        h('thead', h('tr', ['Model', 'Input tokens', 'Output tokens', 'USD'].map((x) => h('th', x)))),
        h('tbody', u.models.map((m) => h('tr', h('td', h('code', m.model)), h('td.num', m.input.toLocaleString('vi-VN')), h('td.num', m.output.toLocaleString('vi-VN')), h('td.num', usd(m.usd)))))))),
      h('div.card', h('h2', 'Theo ngày'), h('div.tbl-wrap', h('table.tbl',
        h('thead', h('tr', ['Ngày', 'Câu hỏi', 'Retrieve', 'Agentic', 'Lời gọi LLM'].map((x) => h('th', x)))),
        h('tbody', u.days.map((d) => h('tr', h('td.num', d.day), h('td.num', d.questions), h('td.num', d.retrieve), h('td.num', d.agentic), h('td.num', d.llmCalls))))))),
      h('p.faint', 'Chỉ gồm phần tính theo lượt dùng, theo giá niêm yết ap-southeast-2. Phần cố định (lưu trữ Knowledge Base, CloudFront, Lambda, DynamoDB, Cognito) xem tài liệu ước tính chi phí của PoC.'));
  };
  await draw();
}

// ---------- boot
(async () => {
  try {
    state.cfg = await (await fetch('config.json', { cache: 'no-store' })).json();
  } catch {
    $('#app').replaceChildren(h('div.boot', 'Thiếu config.json'));
    return;
  }
  try { state.auth = JSON.parse(localGet('poc3.auth') || 'null'); } catch { state.auth = null; }
  if (state.auth) start();
  else renderAuth('in');
})();
