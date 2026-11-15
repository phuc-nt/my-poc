// Project Notebook: the web UI of PoC 3. A single page without a build step: sign-in against Cognito, then
// notebooks (sources, chat with citations, studio outputs and notes) like NotebookLM, plus the sync monitor,
// MCP access tokens, user administration and the cost of the month.
//
// What the page adds to the knowledge base that an MCP client does not have: the trace of every answer (what was
// searched and read), the evidence pane and the reader (a cited passage marked inside the whole document), chat limited
// to one document, search without a model (Ctrl/Cmd+K), the list of documents that changed last, votes on answers, the
// library of shared and verified answers, and for admins the page of questions the documents could not answer.

/* global marked, DOMPurify, mermaid */

const $ = (sel, root = document) => root.querySelector(sel);
const state = { cfg: null, auth: null, me: null, sources: [], notebooks: [], nb: null, messages: [], notes: [], outputs: [],
  mode: 'fast', lang: '', open: new Set(), docs: {}, busy: false, timer: null,
  // library: the shared answers the user may see; focus: the document the next questions are limited to;
  // recent: the documents that changed last (null until loaded); pane: what the right pane shows;
  // evidence: the answer and passage shown there; pending: a question to ask once a notebook is on screen.
  library: [], focus: null, recent: null, pane: 'studio', evidence: null, pending: null };

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

// Replaces the children of an element with what h takes as children: nodes, text, arrays, and nothing for null or false.
function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false).map((kid) => (kid instanceof Node ? kid : String(kid))));
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

// Text without case or accents, and its distinct words: for matching what is typed against titles and questions.
const foldText = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
const wordsOf = (t) => [...new Set(foldText(t).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))];
// Only a web address becomes a link (a document's uri may be an S3 path, and comes from the knowledge base).
const link = (uri) => /^https?:\/\//.test(uri || '');

// ---------- icons: line icons drawn in the colour of the text around them
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  read: '<path d="M12 7v13"/><path d="M3 5h6a3 3 0 0 1 3 3v12a2.5 2.5 0 0 0-2.5-2.5H3z"/><path d="M21 5h-6a3 3 0 0 0-3 3v12a2.5 2.5 0 0 1 2.5-2.5H21z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  note: '<path d="M4 5h16v11H9l-5 4z"/>',
  plan: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10"/><path d="M18 10a6 6 0 0 1-6 6H6"/>',
  up: '<path d="M7 11v9H4v-9z"/><path d="M7 11l4-7a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 17 20H7"/>',
  down: '<g transform="rotate(180 12 12)"><path d="M7 11v9H4v-9z"/><path d="M7 11l4-7a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 17 20H7"/></g>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  verified: '<path d="M12 3l7 3v5c0 4.500-3 8-7 10-4-2-7-5.500-7-10V6z"/><path d="m9 12 2.200 2.200L15 10.500"/>',
  share: '<circle cx="18" cy="5" r="2.500"/><circle cx="6" cy="12" r="2.500"/><circle cx="18" cy="19" r="2.500"/><path d="m8.200 10.800 7.600-4.500M8.200 13.200l7.600 4.500"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400"/>',
  moon: '<path d="M20 14.500A8 8 0 0 1 9.500 4a8 8 0 1 0 10.500 10.500z"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.300 6.300"/><path d="M20 4v7h-7"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  clock: '<circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  bookmark: '<path d="M7 4h10v16l-5-4-5 4z"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  warn: '<path d="M12 4 2.500 20h19z"/><path d="M12 10v4.500M12 17.500h.01"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8M11 6H6v12h12v-5"/>',
  library: '<path d="M4 5v14M8.500 5v14M13 6l4.500 13"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
};
function icon(name, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const attrs = { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'ico', 'aria-hidden': 'true' };
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  s.innerHTML = ICONS[name] || '';
  return s;
}

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
async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, {
    method, signal,
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
// The theme the user picked ('dark' or 'light'); without one the page follows the system.
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localSet('poc3.theme', theme);
  mermaidReady = false;
}
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
// Fills el with the rendered Markdown; an [n] button opens the passage n of passages: with onCite when given, else in a popover.
function fill(el, text, passages, { final = true, onCite } = {}) {
  el.innerHTML = markdown(text);
  el.querySelectorAll('.cite').forEach((b) => {
    const p = (passages || []).find((x) => x.n === Number(b.dataset.n));
    if (p) b.title = p.title || 'Tài liệu';
    b.onclick = (e) => {
      e.stopPropagation();
      if (!p) return;
      if (onCite) onCite(p, b);
      else passagePop(b, p);
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
      p.sourceId && p.uri && !p.live ? h('button.btn.small', { onclick: () => { closePop(); openReader(p); } }, icon('read', 13), 'Xem trong tài liệu') : null,
      link(p.uri) ? h('a.btn.small', { href: p.uri, target: '_blank', rel: 'noopener' }, 'Mở bản gốc', icon('external', 12)) : null,
      p.sourceId ? h('button.btn.small', { onclick: () => { closePop(); openGuide(docOf(p)); } }, 'Tóm tắt') : null));
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
    h('header', h('h2', title), ...actions, h('button.btn.ghost.icon-btn', { onclick: closeModal, 'aria-label': 'Đóng', title: 'Đóng (Esc)' }, icon('x', 15))),
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
    mode === 'up' ? h('p.muted', { style: 'margin:0' }, 'Sau khi đăng ký, bạn thấy được các tài liệu mà quyền Confluence space của bạn cho phép; nếu chưa có, admin sẽ duyệt.') : null,
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
  const theme = h('button.btn.small.icon-btn', { title: 'Đổi giao diện sáng / tối', 'aria-label': 'Đổi giao diện sáng / tối', onclick: () => {
    setTheme(dark() ? 'light' : 'dark');
    theme.replaceChildren(icon(dark() ? 'sun' : 'moon', 14));
  } }, icon(dark() ? 'sun' : 'moon', 14));
  return h('div.shell',
    h('header.top',
      h('div.brand', logo(), 'Project Notebook'),
      h('nav.nav',
        tab('#/', 'Notebook', 'nb'), tab('#/library', 'Thư viện', 'library'), tab('#/sync', 'Đồng bộ', 'sync'), tab('#/mcp', 'MCP', 'mcp'),
        me.admin ? [tab('#/admin', 'Người dùng', 'admin'), tab('#/insights', 'Chất lượng KB', 'insights'), tab('#/cost', 'Chi phí', 'cost')] : null),
      h('button.search-btn', { type: 'button', title: 'Tìm thẳng trong tài liệu, không qua model', onclick: () => openSearch() },
        icon('search', 14), h('span', 'Tìm trong tài liệu'), h('kbd', /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K')),
      h('div.who', h('span.email.muted', me.email), me.admin ? h('span.badge.accent', 'admin') : null, theme,
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
  [state.notebooks, state.outputs, state.library] = await Promise.all([api('/api/notebooks'), api('/api/studio/outputs'), api('/api/library').catch(() => [])]);
  if (!state.notebooks.length) state.notebooks = [await api('/api/notebooks', { method: 'POST', body: { name: 'Notebook đầu tiên', sources: [] } })];
  route();
}

window.addEventListener('hashchange', () => state.me && route());
function route() {
  clearInterval(state.timer);
  closeModal();
  const [, page, id] = location.hash.split('/');
  renderLibrary.draw = null;
  if (page === 'library') return renderLibrary();
  if (page === 'insights' && state.me.admin) return renderInsights();
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
      h('p.muted', { style: 'margin:0' }, 'Quyền Confluence của bạn chưa được đồng bộ vào hệ thống. Chọn các nguồn tài liệu bạn cần, admin sẽ duyệt.'),
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
  // Another notebook: what was shown for the last one goes. The same one again (coming back from another page) keeps its focus.
  if (state.nb?.id !== id) state.focus = null;
  state.recent = null;
  state.evidence = null;
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
  root.append(sourcesPane(root), chatPane(root), sidePane(root));
  $('#app').replaceChildren(shell(root, 'nb'));
  scrollChat(true);
  // A question asked from another page (search, library, KB quality) waits until the notebook is on screen.
  const pending = state.pending;
  state.pending = null;
  if (pending) chatPane.ask(pending.question, { mode: pending.mode });
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
        s.granted ? h('input', { type: 'checkbox', checked: on, title: 'Dùng nguồn này trong notebook', onchange: (e) => toggleSource(s, e.target.checked) }) : h('span.faint', { title: 'Chưa có quyền' }, icon('lock', 15)),
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
    state.recent = null;
    drawRecent();
  };
  // The documents that changed last in the sources of the notebook.
  const recent = h('div.recent');
  const drawRecent = async () => {
    const nb = state.nb.id;
    if (!state.recent) {
      recent.replaceChildren(h('div.label', 'Mới cập nhật'), h('p.faint', 'Đang tải…'));
      let rows = [];
      try { rows = await api(`/api/recent?notebookId=${encodeURIComponent(nb)}`); } catch { /* the list is an extra: without it the pane still works */ }
      if (state.nb.id !== nb || !recent.isConnected) return;
      state.recent = rows;
    }
    const rows = state.recent.slice(0, 8);
    recent.hidden = !rows.length;
    recent.replaceChildren(h('div.label', 'Mới cập nhật'),
      ...rows.map((d) => h('button.recent-row', { type: 'button', title: `${d.title} · ${d.sourceTitle || ''} · ${fmtTime(d.modified)}`, onclick: () => openGuide({ sourceId: d.sourceId, uri: d.uri, title: d.title }) },
        h('span.k', d.kind), h('span.n', d.title), h('span.faint', ago(d.modified)))),
      h('button.btn.small', { title: 'Hỏi notebook về các tài liệu vừa thay đổi', onclick: () => chatPane.ask(`Tóm tắt nội dung chính và các điểm đáng chú ý của những tài liệu mới cập nhật gần đây: ${rows.slice(0, 5).map((d) => `“${d.title}”`).join(', ')}`) },
        icon('clock', 13), 'Tóm tắt các thay đổi gần đây'));
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
        h('span.k', d.kind), h('span.n', d.title), d.restricted ? h('span.faint', { title: 'Tài liệu bị giới hạn người xem ở Confluence/Jira; bạn nằm trong số người được xem' }, icon('lock', 12)) : null))));
  };
  draw();
  queueMicrotask(drawRecent);
  return h('section.pane.sources-pane',
    h('div.nb-switch', select,
      h('button.btn.small', { title: 'Notebook mới', onclick: newNotebook }, '+'),
      h('button.btn.small', { title: 'Đổi tên / xoá', onclick: editNotebook }, '⋯')),
    h('header', h('h2', 'Nguồn tài liệu'), h('span.faint', `${state.sources.filter(inNotebook).length}/${granted().length} đang dùng`)),
    h('div.body', list, recent,
      h('p.faint', 'Bấm tên nguồn để xem tài liệu; bấm tài liệu để xem tóm tắt (source guide), đọc toàn văn hoặc hỏi riêng trong tài liệu đó. Mỗi nguồn là một Confluence space hoặc một nhóm Jira project.')));
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
const MODE_NAME = { fast: 'nhanh', deep: 'chuyên sâu', agent: 'agent', research: 'research' };
const REASONS = [['wrong', 'Sai'], ['missing', 'Thiếu'], ['outdated', 'Lỗi thời'], ['absent', 'Không có trong tài liệu']];
const REASON_NAME = Object.fromEntries(REASONS);

const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);
// The numbers an answer cites, from its [n] marks.
const citedIn = (text) => new Set([...String(text || '').matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((x) => x[1].split(/\s*,\s*/).map(Number)));
// The question an answer replies to.
function askedBy(m) {
  for (let i = state.messages.indexOf(m) - 1; i >= 0; i -= 1) if (state.messages[i].role === 'user') return state.messages[i];
  return null;
}

function chatPane(root) {
  const list = h('div.chat');
  const input = h('textarea', { rows: 2, placeholder: 'Hỏi về tài liệu của notebook… (Enter để gửi, Shift+Enter xuống dòng)' });
  const send = h('button.btn.primary', { onclick: () => ask(input.value) }, 'Gửi');
  const focusBar = h('div.focus-bar', { hidden: true });
  const suggest = h('div.suggest', { hidden: true });
  let suggestTimer = 0;

  // The document the next questions are limited to.
  const drawFocus = () => {
    focusBar.hidden = !state.focus;
    if (!state.focus) return;
    focusBar.replaceChildren(icon('target', 14), h('span.grow', 'Chỉ hỏi trong: ', h('strong', state.focus.title)),
      h('button.btn.ghost.small.icon-btn', { title: 'Bỏ giới hạn, hỏi trên mọi nguồn của notebook', 'aria-label': 'Bỏ giới hạn tài liệu', onclick: () => { state.focus = null; drawFocus(); } }, icon('x', 13)));
  };
  chatPane.drawFocus = drawFocus;

  // While typing: answers the team already shared for a question like this one.
  const drawSuggest = () => {
    const words = wordsOf(input.value);
    const hits = words.length < 2 ? [] : state.library.map((e) => {
      const have = new Set(wordsOf(e.question));
      const common = words.filter((w) => have.has(w)).length;
      return { e, common, score: common / words.length };
    }).filter((x) => x.common >= 2 && x.score >= 0.6).sort((a, b) => Number(b.e.verified) - Number(a.e.verified) || b.score - a.score).slice(0, 2);
    suggest.hidden = !hits.length;
    suggest.replaceChildren(h('span.faint', 'Đã có trong thư viện:'),
      ...hits.map(({ e }) => h('button.sug', { type: 'button', onclick: () => openEntry(e) }, icon(e.verified ? 'verified' : 'library', 13), h('span', clip(e.question, 90)))));
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask(input.value);
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(drawSuggest, 200);
  });
  const MODES = [
    ['fast', 'Nhanh', 'Một lần tìm kiếm, trả lời nhanh'],
    ['deep', 'Chuyên sâu', 'Agentic retrieval: tách câu hỏi thành nhiều truy vấn con, chậm hơn, dùng cho câu hỏi rộng'],
    ['agent', 'Agent', 'Model tự tìm kiếm và đọc tài liệu qua nhiều bước như một coding agent dùng MCP; chậm nhất, dùng cho câu hỏi cần tổng hợp từ nhiều tài liệu'],
    ['research', 'Research', 'Báo cáo nghiên cứu: lập dàn ý, tra cứu từng phần song song rồi viết báo cáo có trích dẫn, tải về được dạng Markdown; mất 2–4 phút và tốn hơn một câu hỏi Agent, chi phí ước tính hiện sau khi xong'],
  ];
  const seg = h('div.seg', MODES.map(([k, t, title]) => h(`button${state.mode === k ? '.on' : ''}`, {
    title,
    onclick: (e) => { state.mode = k; seg.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); } }, t)));
  const lang = h('select', { style: 'width:auto', onchange: (e) => { state.lang = e.target.value; } },
    [['', 'Ngôn ngữ: theo câu hỏi'], ['vi', 'Tiếng Việt'], ['en', 'English'], ['ja', '日本語']].map(([v, t]) => h('option', { value: v, selected: state.lang === v }, t)));

  const draw = () => {
    if (!state.messages.length) {
      const mine = new Set(state.sources.filter(inNotebook).map((s) => s.id));
      const known = state.library.filter((e) => e.verified && e.sourceIds.every((id) => mine.has(id))).slice(0, 3);
      list.replaceChildren(h('div.empty',
        h('h3', state.nb.name),
        state.nb.description ? h('p', state.nb.description) : null,
        h('p', `Hỏi đáp trên ${state.sources.filter(inNotebook).length} nguồn tài liệu. Câu trả lời luôn kèm trích dẫn [n] tới đoạn tài liệu gốc.`),
        h('div.followups', { style: 'justify-content:center' }, STARTERS.map((q) => h('button', { onclick: () => ask(q) }, q))),
        known.length ? [h('div.label', { style: 'margin-top:8px' }, 'Câu trả lời đã xác minh của nhóm'),
          h('div.followups', { style: 'justify-content:center' }, known.map((e) => h('button', { onclick: () => openEntry(e) }, icon('verified', 13), ' ', clip(e.question, 80))))] : null));
      return;
    }
    list.replaceChildren(...state.messages.map(messageView));
  };

  // opts.mode asks in another mode than the selected one; opts.focus (null for none) replaces the document in the composer.
  async function ask(text, opts = {}) {
    const question = String(text || '').trim();
    if (!question || state.busy) return;
    if (!state.sources.some(inNotebook)) return toast('Notebook chưa có nguồn nào bạn được đọc.');
    const mode = opts.mode || state.mode;
    const focus = opts.focus === undefined ? state.focus : opts.focus;
    state.busy = true;
    send.disabled = true;
    if (input.value.trim() === question) {
      input.value = '';
      input.style.height = 'auto';
    }
    suggest.hidden = true;
    state.messages.push({ role: 'user', content: question, focus: focus ? { title: focus.title, uri: focus.uri, sourceId: focus.source } : undefined });
    const live = { role: 'assistant', content: '', passages: [], steps: [], live: true, mode };
    state.messages.push(live);
    draw();
    const view = list.lastElementChild;
    view.bubble.classList.add('typing');
    scrollChat(true);
    let frame = 0;
    const paint = () => { frame = 0; keepBottom(() => fill(view.bubble, live.content, live.passages, { final: false, onCite: view.cite })); };
    try {
      await stream('/api/chat', { notebookId: state.nb.id, question, mode, lang: state.lang || undefined, focus: focus || undefined }, {
        sources: (d) => { live.passages = d.passages; },
        step: (d) => { live.steps.push({ ...d }); keepBottom(() => view.trace.update()); },
        stepdone: (d) => {
          const step = live.steps.find((s) => s.id === d.id);
          if (step) Object.assign(step, d, { done: true });
          keepBottom(() => view.trace.update());
        },
        delta: (d) => { live.content += d.text; if (!frame) frame = requestAnimationFrame(paint); },
        // Agent mode: what was written so far was a note before a tool call (it comes back as a step), not the answer. Research mode: the report so far is sent again with one more section.
        reset: () => { live.content = ''; view.bubble.replaceChildren(); },
        done: (d) => {
          Object.assign(live, { content: d.answer, citations: d.citations, followups: d.followups, stats: d.stats, id: d.id, seconds: d.seconds });
          if (d.passages) live.passages = d.passages;
        },
        error: (d) => { live.error = d.message; },
      });
    } catch (error) {
      live.error = error.message;
    }
    if (frame) cancelAnimationFrame(frame);
    live.live = false;
    state.busy = false;
    send.disabled = false;
    if (view.isConnected) keepBottom(() => view.replaceWith(messageView(live)));
    if (state.evidence?.m === live) sidePane.draw?.();
    if ($('#modal').hidden) input.focus();
  }
  chatPane.ask = ask;
  draw();
  drawFocus();
  return h('section.pane.chat-pane',
    h('header', h('h2', 'Hỏi đáp'),
      h('div.tabs-mobile', h('button.btn.small', { onclick: () => root.classList.toggle('show-sources') }, 'Nguồn')),
      h('button.btn.small.studio-toggle', { onclick: () => root.classList.toggle('show-studio') }, 'Studio'),
      h('button.btn.small.ghost', { title: 'Tải cuộc hỏi đáp về dạng Markdown, kèm danh sách tài liệu được trích', onclick: exportChat }, icon('download', 13), 'Xuất'),
      h('button.btn.small.ghost', { title: 'Xoá lịch sử chat của notebook', onclick: async () => {
        await api(`/api/notebooks/${state.nb.id}/messages`, { method: 'DELETE' });
        state.messages = [];
        state.evidence = null;
        draw();
        sidePane.draw?.();
      } }, 'Xoá chat')),
    list,
    h('div.composer', focusBar, suggest, input,
      h('div.row', seg, lang, h('span.grow'),
        h('span.faint.log-note', { title: 'Câu hỏi trên web được ghi lại, không kèm tên hay email, để admin biết tài liệu còn thiếu gì. Bản ghi tự xoá sau 180 ngày.' }, 'Câu hỏi được ghi ẩn danh'),
        send)));
}

// ---------- the trace of one answer: what was searched and read, with what result
const STEP_ICON = { search: 'search', read: 'read', list: 'list', query: 'list', note: 'note', plan: 'plan' };
function stepResult(s) {
  if (s.failed) return 'lỗi';
  const parts = [];
  if (s.chars != null) parts.push(`${s.chars.toLocaleString('vi-VN')} ký tự`);
  if (s.found != null) parts.push(`${s.found} ${s.kind === 'list' || s.kind === 'plan' ? 'mục' : s.kind === 'query' ? 'kết quả' : s.kind === 'read' ? 'phần' : 'đoạn'}`);
  return parts.join(' · ');
}

function traceView(m) {
  const sum = h('summary');
  const rows = h('div.trace-rows');
  const el = h('details.trace', sum, rows);
  el.open = Boolean(m.live);
  el.update = () => {
    const steps = (m.steps || []).map((s) => (typeof s === 'string' ? { kind: 'search', text: s, done: true } : s));
    el.hidden = !steps.length && !m.live;
    if (m.live) {
      sum.replaceChildren(h('span.spin'), h('span.grow', steps.length ? clip(steps[steps.length - 1].text || '', 120) : 'Đang tìm trong tài liệu…'));
    } else {
      const work = steps.filter((s) => ['search', 'read', 'list', 'query'].includes(s.kind || 'search')).length;
      const found = steps.reduce((n, s) => n + ((s.kind || 'search') === 'search' ? s.found || 0 : 0), 0);
      const seconds = m.seconds ?? m.stats?.seconds;
      sum.replaceChildren(icon('search', 13), h('span.grow', [`${work} bước tra cứu`, found ? `${found} đoạn tìm được` : '', seconds ? `${seconds} giây` : '',
        m.stats?.input ? `${(m.stats.input + m.stats.output).toLocaleString('vi-VN')} token` : '', m.stats?.usd ? `${usd(m.stats.usd)} (giá niêm yết)` : ''].filter(Boolean).join(' · ')));
    }
    rows.replaceChildren(...steps.map((s) => h(`div.step.${STEP_ICON[s.kind] ? s.kind : 'search'}${s.failed ? '.failed' : ''}`,
      s.id && !s.done && m.live ? h('span.spin') : icon(STEP_ICON[s.kind] || 'search', 14),
      h('div.grow', h('div.step-t', s.text || ''), s.titles?.length ? h('div.faint', s.titles.join(' · ')) : null),
      h('span.faint.num', [stepResult(s), s.ms != null ? `${(s.ms / 1000).toFixed(1)} s` : ''].filter(Boolean).join(' · ')))));
  };
  el.update();
  return el;
}

function messageView(m) {
  if (m.role === 'user') {
    return h('div.msg.user', h('div.bubble', m.content),
      m.focus ? h('div.focus-tag', icon('target', 12), `Chỉ trong: ${m.focus.title}`) : null);
  }
  const bubble = h('div.bubble');
  const cite = (p) => showEvidence(m, p.n);
  if (m.content) fill(bubble, m.content, m.passages, { final: !m.live, onCite: cite });
  const trace = traceView(m);
  const out = h('div.msg.assistant', trace, bubble);
  Object.assign(out, { bubble, trace, cite });
  if (m.error) out.append(h('p.error', m.error));
  if (m.live || !m.content) return out;

  // The documents the answer stands on.
  const cited = citedIn(m.content);
  const used = (m.passages || []).filter((p) => cited.has(p.n));
  const docs = [...new Map(used.map((p) => [p.uri || p.title, p])).values()];
  if (docs.length) {
    out.append(h('div.doc-chips',
      docs.slice(0, 6).map((p) => h('button.doc-chip', { type: 'button', title: 'Xem đoạn được trích', onclick: () => showEvidence(m, p.n) },
        h(`span.src-ico.${p.sourceType || 'S3'}`, (p.sourceType || '?')[0]), h('span', p.title || 'Tài liệu'))),
      h('button.doc-chip.more', { type: 'button', onclick: () => showEvidence(m, null, true) }, `Xem tất cả ${m.passages.length} đoạn`)));
  } else {
    out.append(h('div.declined', icon('warn', 14), h('span', 'Câu trả lời này không trích dẫn tài liệu nào: có thể tài liệu chưa có nội dung này.')));
  }

  const asked = askedBy(m);
  const again = (mode) => chatPane.ask(asked.content, { mode, focus: asked.focus ? { source: asked.focus.sourceId, uri: asked.focus.uri, title: asked.focus.title } : null });
  const tools = h('div.tools');
  const panel = h('div.fb', { hidden: true });
  const vote = async (value, patch = {}) => {
    const next = value ? { ...(m.feedback?.vote === value ? m.feedback : {}), vote: value, ...patch } : { vote: null };
    try {
      m.feedback = (await api(`/api/notebooks/${state.nb.id}/feedback`, { method: 'POST', body: { message: m.id, ...next } })).feedback || undefined;
    } catch (error) {
      toast(error.message);
    }
    drawTools();
  };
  const shareIt = async () => {
    try {
      const entry = await api('/api/library', { method: 'POST', body: { notebookId: state.nb.id, message: m.id } });
      m.shared = entry.id;
      state.library = [entry, ...state.library.filter((e) => e.id !== entry.id)];
      toast('Đã chia sẻ vào thư viện của nhóm.');
    } catch (error) {
      toast(error.message);
    }
    drawTools();
  };
  const drawTools = () => {
    const given = m.feedback?.vote;
    tools.replaceChildren(...[
      h(`span.badge${m.mode === 'agent' || m.mode === 'research' ? '.accent' : ''}`, { title: m.stats?.model ? `${m.stats.model} · ${m.stats.calls} lần tra cứu${m.stats.sections ? ` · ${m.stats.sections} phần` : ''}${m.stats.usd ? ` · ${usd(m.stats.usd)}` : ''}` : '' }, MODE_NAME[m.mode] || 'nhanh'),
      m.mode === 'research' ? h('button.btn.small', { title: 'Tải báo cáo về dạng Markdown, kèm danh sách tài liệu được trích', onclick: () => exportReport(m) }, icon('download', 13), 'Tải báo cáo') : null,
      m.id ? h(`button.btn.small.icon-btn${given === 'up' ? '.on' : ''}`, { title: 'Câu trả lời tốt', 'aria-label': 'Câu trả lời tốt', 'aria-pressed': String(given === 'up'), onclick: () => vote(given === 'up' ? null : 'up') }, icon('up', 14)) : null,
      m.id ? h(`button.btn.small.icon-btn${given === 'down' ? '.on' : ''}`, { title: 'Câu trả lời chưa tốt', 'aria-label': 'Câu trả lời chưa tốt', 'aria-pressed': String(given === 'down'), onclick: () => vote(given === 'down' ? null : 'down') }, icon('down', 14)) : null,
      h('button.btn.small', { onclick: () => copy(m.content) }, icon('copy', 13), 'Sao chép'),
      h('button.btn.small', { onclick: () => saveNote(m) }, icon('bookmark', 13), 'Lưu ghi chú'),
      m.id && used.length ? h('button.btn.small', { disabled: Boolean(m.shared), title: 'Đưa câu trả lời này cùng các đoạn được trích vào thư viện chung; chỉ người đọc được các nguồn đó mới thấy', onclick: shareIt },
        icon(m.shared ? 'check' : 'share', 13), m.shared ? 'Đã chia sẻ' : 'Chia sẻ vào thư viện') : null,
      asked && m.mode !== 'agent' ? h('button.btn.small', { title: 'Hỏi lại câu này ở chế độ Agent: model tự tìm và đọc tài liệu qua nhiều bước', onclick: () => again('agent') }, icon('retry', 13), 'Agent') : null,
      asked && (m.mode || 'fast') === 'fast' ? h('button.btn.small', { title: 'Hỏi lại câu này ở chế độ Chuyên sâu', onclick: () => again('deep') }, icon('retry', 13), 'Chuyên sâu') : null,
    ].filter(Boolean));
    panel.hidden = given !== 'down';
    if (given !== 'down') return;
    const note = h('input', { type: 'text', placeholder: 'Ghi chú cho người quản lý tài liệu (tuỳ chọn)', value: m.feedback.note || '', maxlength: 500 });
    note.addEventListener('change', () => vote('down', { note: note.value }));
    panel.replaceChildren(h('span.faint', 'Vấn đề là gì?'),
      ...REASONS.map(([k, t]) => h(`button.chip${m.feedback.reason === k ? '.on' : ''}`, { type: 'button', onclick: () => vote('down', { reason: k }) }, t)), note);
  };
  drawTools();
  out.append(tools, panel);
  if (m.followups?.length) out.append(h('div.followups', m.followups.map((q) => h('button', { onclick: () => chatPane.ask(q) }, q))));
  return out;
}

const nearBottom = () => {
  const c = $('.chat');
  return !c || c.scrollHeight - c.scrollTop - c.clientHeight < 140;
};
function scrollChat(force) {
  const c = $('.chat');
  if (c && (force || nearBottom())) c.scrollTop = c.scrollHeight;
}
// Runs a change of the chat and stays at the bottom when the reader was there; someone reading above is left alone.
function keepBottom(change) {
  const stick = nearBottom();
  change();
  if (stick) scrollChat(true);
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
  const question = askedBy(m)?.content || 'Ghi chú';
  await api(`/api/notebooks/${state.nb.id}/notes`, { method: 'POST', body: { title: question.slice(0, 120), content: m.content, kind: 'answer', passages: m.passages } });
  state.notes = await api(`/api/notebooks/${state.nb.id}/notes`);
  studioPane.draw?.();
  toast('Đã lưu vào ghi chú.');
}

function download(name, text, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// One research report as a Markdown file, with the documents it cites.
function exportReport(m) {
  const cited = citedIn(m.content);
  const used = (m.passages || []).filter((p) => cited.has(p.n));
  const title = (m.content.match(/^#\s+(.+)$/m) || [])[1] || askedBy(m)?.content || 'bao-cao';
  const lines = [m.content, '', '---', '', '## Nguồn', '',
    ...used.map((p) => `- [${p.n}] ${p.title || 'Tài liệu'}${p.page ? `, trang ${p.page}` : ''}${p.sourceTitle ? ` (${p.sourceTitle})` : ''}${link(p.uri) ? ` — ${p.uri}` : ''}`), '',
    `_Project Notebook, chế độ Research, ${fmtTime(m.at || m.id || new Date().toISOString())}${m.stats ? `: ${m.stats.sections || 0} phần, ${m.stats.calls} lần tra cứu, ${(m.stats.input + m.stats.output).toLocaleString('vi-VN')} token${m.stats.usd ? `, ${usd(m.stats.usd)} theo giá niêm yết` : ''}` : ''}._`];
  download(`${foldText(title).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'bao-cao'}.md`, lines.join('\n'));
}

// The chat as a Markdown file: every answer with the documents it cites.
function exportChat() {
  if (!state.messages.length) return toast('Chưa có gì để xuất.');
  const lines = [`# ${state.nb.name}`, '', `Xuất từ Project Notebook lúc ${fmtTime(new Date().toISOString())}.`, ''];
  for (const m of state.messages) {
    if (m.role === 'user') {
      lines.push(`## ${m.content.replace(/\s+/g, ' ')}`, '');
      if (m.focus) lines.push(`_Chỉ hỏi trong tài liệu: ${m.focus.title}_`, '');
      continue;
    }
    lines.push(m.content || '', '');
    const cited = citedIn(m.content);
    const used = (m.passages || []).filter((p) => cited.has(p.n));
    if (used.length) lines.push('**Nguồn**', '', ...used.map((p) => `- [${p.n}] ${p.title || 'Tài liệu'}${p.page ? `, trang ${p.page}` : ''}${link(p.uri) ? ` — ${p.uri}` : ''}`), '');
  }
  download(`${foldText(state.nb.name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'notebook'}.md`, lines.join('\n'));
}

// ---------- source guide
const docOf = (p) => ({ sourceId: p.sourceId, uri: p.uri, docId: p.docId, title: p.title });

async function openGuide({ sourceId, uri, docId, title }) {
  const body = h('div', h('p.muted', 'Đang đọc tài liệu và tóm tắt… (lần đầu mất vài giây, sau đó được cache)'));
  modal(title || 'Tài liệu', body, [
    uri ? h('button.btn.small', { title: 'Các câu hỏi tiếp theo chỉ dùng tài liệu này', onclick: () => setFocus({ sourceId, uri, title }) }, icon('target', 13), 'Hỏi trong tài liệu này') : null,
    uri ? h('button.btn.small', { onclick: () => openReader({ sourceId, uri, title }) }, icon('read', 13), 'Xem toàn văn') : null,
    link(uri) ? h('a.btn.small', { href: uri, target: '_blank', rel: 'noopener' }, 'Mở bản gốc', icon('external', 12)) : null]);
  try {
    const g = await api('/api/documents/guide', { method: 'POST', body: { source: sourceId, uri, docId, title, lang: state.lang || 'vi' } });
    put(body, 
      h('div.label', 'Tóm tắt'), h('p', g.summary),
      g.topics?.length ? [h('div.label', 'Chủ đề chính'), h('div.row', { style: 'margin:6px 0 14px' }, g.topics.map((t) => h('span.badge.accent', t)))] : null,
      g.questions?.length ? [h('div.label', 'Câu hỏi tài liệu này trả lời'), h('div.followups', g.questions.map((q) => h('button', { onclick: () => askInNotebook(q) }, q)))] : null,
      h('p.faint', { style: 'margin-top:14px' }, `${(g.characters || 0).toLocaleString('vi-VN')} ký tự đã trích xuất bởi Knowledge Base.`));
  } catch (error) {
    body.replaceChildren(h('p.error', error.message));
  }
}

// Limits the next questions to one document (null lifts the limit).
function setFocus(doc) {
  state.focus = doc ? { source: doc.sourceId, uri: doc.uri, title: doc.title || 'Tài liệu' } : null;
  closeModal();
  closePop();
  if (!location.hash.startsWith('#/nb/')) {
    location.hash = '#/';
    return;
  }
  $('.nb')?.classList.remove('show-studio');
  chatPane.drawFocus?.();
  $('.composer textarea')?.focus();
}

// Asks in the open notebook, from any page.
function askInNotebook(question, mode) {
  closeModal();
  if (location.hash.startsWith('#/nb/') && $('.chat')) return chatPane.ask(question, { mode });
  state.pending = { question, mode };
  location.hash = '#/';
}

// ---------- reader: the whole extracted text of a document, with the cited passage marked in its place
// Where the passage sits in the text, whatever the whitespace: [start, end], or null.
function locate(text, passage) {
  const want = String(passage || '').replace(/…$/, '').replace(/\s+/g, ' ').trim();
  if (want.length < 20) return null;
  let flat = '';
  const map = [];
  let gap = true;
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i])) {
      if (!gap) {
        flat += ' ';
        map.push(i);
        gap = true;
      }
    } else {
      flat += text[i];
      map.push(i);
      gap = false;
    }
  }
  const span = (from, length) => {
    const a = Math.max(0, from);
    const b = Math.min(flat.length, a + length) - 1;
    return [map[a], map[b] + 1];
  };
  let at = flat.indexOf(want);
  if (at >= 0) return span(at, want.length);
  // The passage and the document may differ somewhere (a table, a heading): a part of the passage still finds the place.
  for (const size of [200, 120, 60]) {
    if (want.length <= size) continue;
    for (const offset of [0, Math.floor((want.length - size) / 2), want.length - size]) {
      at = flat.indexOf(want.slice(offset, offset + size));
      if (at >= 0) return span(at - offset, want.length);
    }
  }
  return null;
}

async function openReader(p, { back } = {}) {
  const body = h('div', h('p.muted', 'Đang tải toàn văn tài liệu…'));
  modal(p.title || 'Tài liệu', body, [
    back ? h('button.btn.small', { onclick: back }, '← Kết quả tìm kiếm') : null,
    h('button.btn.small', { title: 'Các câu hỏi tiếp theo chỉ dùng tài liệu này', onclick: () => setFocus(p) }, icon('target', 13), 'Hỏi trong tài liệu này'),
    link(p.uri) ? h('a.btn.small', { href: p.uri, target: '_blank', rel: 'noopener' }, 'Mở bản gốc', icon('external', 12)) : null]);
  try {
    const d = await api('/api/documents/text', { method: 'POST', body: { source: p.sourceId, uri: p.uri } });
    const want = p.computed ? null : p.text || p.excerpt;
    const at = want ? locate(d.text, want) : null;
    const text = h('div.reader');
    if (at) text.append(d.text.slice(0, at[0]), h('mark', d.text.slice(at[0], at[1])), d.text.slice(at[1]));
    else text.textContent = d.text;
    body.replaceChildren(
      h('div.row.faint', h('span', `${d.total.toLocaleString('vi-VN')} ký tự, là phần chữ Knowledge Base đã trích xuất từ tài liệu`),
        d.cut ? h('span.badge.warn', `chỉ hiện ${d.text.length.toLocaleString('vi-VN')} ký tự đầu`) : null,
        at ? h('span.badge.accent', 'đoạn được trích đang tô sáng') : want ? h('span.badge.warn', 'không định vị được đoạn trích trong toàn văn') : null),
      text);
    text.querySelector('mark')?.scrollIntoView({ block: 'center' });
  } catch (error) {
    body.replaceChildren(h('p.error', error.message));
  }
}

// ---------- evidence: the passages behind one answer, in the right pane
function showEvidence(m, n, all = false) {
  state.evidence = { m, n, all };
  sidePane.show?.('evidence');
}

// A date from an ISO string or from epoch seconds or milliseconds.
function stamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  const d = new Date(Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// How fresh a passage is: when its document changed and when its source was last synced.
function freshness(p) {
  const sync = state.sources.find((s) => s.id === p.sourceId)?.sync;
  const edited = stamp(p.updatedAt);
  const old = sync?.updatedAt && Date.now() - new Date(sync.updatedAt).getTime() > 48 * 3600_000;
  return h('div.fresh',
    edited ? h('span', { title: fmtTime(edited) }, icon('clock', 13), `Tài liệu sửa ${ago(edited)}`) : null,
    h('span', { title: sync?.updatedAt ? `Lần đồng bộ gần nhất: ${fmtTime(sync.updatedAt)}` : '' }, sync?.updatedAt ? `Nguồn đồng bộ ${ago(sync.updatedAt)}` : 'Nguồn chưa đồng bộ'),
    sync?.status === 'FAILED' ? h('span.badge.bad', icon('warn', 12), 'lần đồng bộ gần nhất lỗi') : old ? h('span.badge.warn', icon('warn', 12), 'có thể đã cũ') : null);
}

function passageCard(p, open, toggle) {
  return h(`div.ev${open ? '.on' : ''}`,
    h('button.ev-h', { type: 'button', onclick: toggle, 'aria-expanded': String(open) },
      h('span.cite', p.n), h('span.ev-t', p.title || 'Tài liệu'), h(`span.src-ico.${p.sourceType || 'S3'}`, (p.sourceType || '?')[0])),
    h('div.faint', [p.sourceTitle, p.page ? `trang ${p.page}` : '', p.section].filter(Boolean).join(' · ')),
    p.live ? h('div.faint', icon('clock', 12), ' Kết quả đọc trực tiếp từ Jira lúc trả lời, không phải từ bản đã index') : p.computed ? h('div.faint', 'Kết quả tính trên bảng của tài liệu') : null,
    h(`div.ev-x${open ? '' : '.clip'}`, p.excerpt || p.text || ''),
    open ? [freshness(p), h('div.row',
      p.sourceId && p.uri && !p.live ? h('button.btn.small', { onclick: () => openReader(p) }, icon('read', 13), 'Xem trong tài liệu') : null,
      link(p.uri) ? h('a.btn.small', { href: p.uri, target: '_blank', rel: 'noopener' }, p.live ? 'Mở truy vấn trong Jira' : 'Mở bản gốc', icon('external', 12)) : null,
      p.sourceId && !p.live ? h('button.btn.small', { onclick: () => openGuide(docOf(p)) }, 'Tóm tắt') : null,
      p.sourceId && p.uri && !p.live ? h('button.btn.small', { onclick: () => setFocus(p) }, icon('target', 13), 'Hỏi trong tài liệu này') : null)] : null);
}

function evidenceView() {
  const ev = state.evidence;
  if (!ev || !state.messages.includes(ev.m)) {
    return h('div.hint', icon('doc', 26),
      h('p', 'Bấm một số trích dẫn trong câu trả lời để xem đoạn tài liệu gốc ở đây: nguyên văn, vị trí trong tài liệu và độ mới của nguồn.'));
  }
  const all = ev.m.passages || [];
  const cited = citedIn(ev.m.content);
  const shown = ev.all || !cited.size ? all : all.filter((p) => cited.has(p.n));
  const question = askedBy(ev.m)?.content;
  return h('div.evidence',
    h('div.faint', question ? `Bằng chứng cho: “${clip(question, 90)}”` : 'Bằng chứng'),
    shown.map((p) => passageCard(p, p.n === ev.n, () => showEvidence(ev.m, p.n === ev.n ? null : p.n, ev.all))),
    all.length > shown.length ? h('button.btn.small', { onclick: () => showEvidence(ev.m, ev.n, true) }, `Hiện cả ${all.length - shown.length} đoạn đã đọc nhưng không trích`) : null);
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
  return h('div',
    h('div.studio-grid', state.outputs.map((o) => h('button', { onclick: () => runStudio(o, focus.value) }, o.title, h('span', STUDIO_HINT[o.kind] || '')))),
    h('div', { style: 'margin-top:8px' }, focus),
    h('div.row', { style: 'margin-top:16px' }, h('div.label.grow', 'Ghi chú'),
      h('button.btn.small', { onclick: newNote }, '+ Ghi chú')),
    notes);
}

// The right pane: the studio, or the evidence behind the answer whose citation was clicked.
function sidePane(root) {
  const studio = studioPane();
  const evidence = h('div');
  const seg = h('div.seg');
  const draw = () => {
    seg.replaceChildren(...[['studio', 'Studio'], ['evidence', 'Bằng chứng']].map(([k, t]) => h(`button${state.pane === k ? '.on' : ''}`, { type: 'button', onclick: () => show(k) }, t)));
    studio.hidden = state.pane !== 'studio';
    evidence.hidden = state.pane !== 'evidence';
    if (state.pane === 'evidence') evidence.replaceChildren(evidenceView());
  };
  // Shows a pane; on a narrow screen, where the pane is an overlay, it opens too.
  const show = (pane) => {
    state.pane = pane;
    root.classList.add('show-studio');
    draw();
    if (pane === 'evidence') evidence.querySelector('.ev.on')?.scrollIntoView({ block: 'nearest' });
  };
  sidePane.show = show;
  sidePane.draw = draw;
  draw();
  return h('section.pane.studio-pane',
    h('header', seg, h('span.grow'),
      h('button.btn.small.ghost.icon-btn.studio-toggle', { 'aria-label': 'Đóng', onclick: () => root.classList.remove('show-studio') }, icon('x', 14))),
    h('div.body', studio, evidence));
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
  modal(n.title, bubble, [h('button.btn.small', { onclick: () => copy(n.content) }, icon('copy', 13), 'Sao chép'), del]);
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
    put(body, 
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
    const [users, report, acl] = await Promise.all([api('/api/admin/users'), api('/api/admin/import-permissions'), api('/api/admin/restrictions').catch(() => [])]);
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
      h('div.card', h('div.row', h('h2.grow', { style: 'margin:0' }, 'Đồng bộ quyền từ Confluence'), importBtn),
        h('p.muted', 'Ai đọc được Confluence space nào thì được quyền nguồn tương ứng; quyền nguồn Jira do admin cấp. Chạy tự động mỗi ngày; người chưa đăng ký sẽ nhận quyền khi đăng ký.'),
        report ? h('p.faint', `Lần cuối ${fmtTime(report.at)}: ${report.granted} người đã có tài khoản được cập nhật, ${report.waiting} email chờ đăng ký, ${report.hidden} tài khoản ẩn email, ${report.groups} group không mở rộng được, ${report.siteGroups} SharePoint site group không đọc được${report.everyone ? `, ${report.everyone} quyền kiểu "mọi người trong tổ chức" (không cấp tự động)` : ''}.`,
          report.sources?.length ? h('span', ' Theo nguồn: ', report.sources.map((s) => `${s.name} ${s.readers}`).join(', '), '.') : null,
          report.notes?.length ? h('ul.fail-list', report.notes.map((n) => h('li', n))) : null) : h('p.faint', 'Chưa chạy lần nào.')),
      h('div.card', h('h2', 'Giới hạn theo từng page và issue'),
        h('p.muted', 'Page có restriction ở Confluence và issue có security level ở Jira chỉ hiện với đúng những người được xem ở đó, kể cả file đính kèm. Monitor đọc lại mỗi 15 phút; nguồn chưa đọc được lần nào thì tạm đóng với mọi người.'),
        h('div.tbl-wrap', h('table.tbl',
          h('thead', h('tr', ['Nguồn', 'Tài liệu bị giới hạn', 'Người/nhóm không quy ra được email', 'Đọc lúc', 'Ghi chú'].map((x) => h('th', x)))),
          h('tbody', acl.map((a) => h('tr', h('td', a.title || a.name), h('td.num', a.at ? String(a.restricted) : '—'), h('td.num', a.at ? String(a.unresolved) : '—'),
            h('td', a.at ? fmtTime(a.at) : h('span.badge.bad', 'chưa đọc: nguồn đang đóng')), h('td.faint', a.note || ''))))))),
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

// ---------- search palette: straight into the knowledge base, with no model in between
// The text without accents, with the place of every character in the original.
function foldMap(text) {
  let flat = '';
  const map = [];
  for (let i = 0; i < text.length; i += 1) {
    for (const c of foldText(text[i])) {
      flat += c;
      map.push(i);
    }
  }
  return { flat, map };
}

// Where the words of the query stand in the text, as merged [start, end] pairs.
function ranges(text, query) {
  const { flat, map } = foldMap(text);
  const letter = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  const out = [];
  for (const w of wordsOf(query)) {
    for (let at = flat.indexOf(w); at >= 0; at = flat.indexOf(w, at + w.length)) {
      if (!letter(flat[at - 1]) && !letter(flat[at + w.length])) out.push([map[at], map[at + w.length - 1] + 1]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

// About max characters of the text around the first word of the query, with the words marked.
function highlight(text, query, max = 260) {
  const all = ranges(text, query);
  let from = 0;
  let to = text.length;
  if (text.length > max) {
    from = Math.max(0, (all[0]?.[0] ?? 0) - 70);
    to = Math.min(text.length, from + max);
  }
  const out = [from > 0 ? '…' : ''];
  let at = from;
  for (const [a, b] of all) {
    if (b <= from || a >= to) continue;
    const s = Math.max(a, from);
    const e = Math.min(b, to);
    if (s > at) out.push(text.slice(at, s));
    out.push(h('mark', text.slice(s, e)));
    at = e;
  }
  out.push(text.slice(at, to), to < text.length ? '…' : '');
  return out.filter(Boolean);
}

// The last search, kept so that coming back from the reader does not search again.
let searchCache = null;

function openSearch(initial = '') {
  if (state.me?.status !== 'active') return;
  closePop();
  const picked = new Set();
  const input = h('input.pal-input', { type: 'search', placeholder: 'Tìm trong tài liệu: từ khoá, mã lỗi, tên người, con số…', value: initial, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Tìm trong tài liệu' });
  const filters = h('div.pal-filters');
  const results = h('div.pal-results');
  const status = h('span');
  let controller = null;
  let timer = 0;
  let found = null;
  let failed = '';

  const key = () => `${input.value.trim()}|${[...picked].sort().join(',')}`;
  const rows = () => [...results.querySelectorAll('.pal-row')];
  const activate = (row) => {
    rows().forEach((r) => r.classList.toggle('active', r === row));
    row?.scrollIntoView({ block: 'nearest' });
  };

  const drawFilters = () => {
    filters.replaceChildren(h('span.faint', 'Nguồn:'),
      h(`button.chip${picked.size ? '' : '.on'}`, { type: 'button', onclick: () => { picked.clear(); drawFilters(); run(0); } }, 'Tất cả'),
      ...granted().map((s) => h(`button.chip${picked.has(s.id) ? '.on' : ''}`, { type: 'button', onclick: () => { if (picked.has(s.id)) picked.delete(s.id); else picked.add(s.id); drawFilters(); run(0); } },
        h(`span.src-ico.${s.type}`, s.type[0]), s.title || s.name)));
  };

  const draw = () => {
    if (!results.isConnected) return;
    const q = input.value.trim();
    const out = [];
    if (q.length >= 3) {
      out.push(h('button.pal-row', { type: 'button', onclick: () => askInNotebook(q) }, icon('note', 15), h('span.grow', 'Hỏi notebook: ', h('strong', `“${clip(q, 90)}”`)), h('span.faint', 'có model trả lời')));
      const words = wordsOf(q);
      const shared = state.library.map((e) => {
        const have = new Set(wordsOf(`${e.question} ${e.answer.slice(0, 400)}`));
        return { e, score: words.filter((w) => have.has(w)).length / (words.length || 1) };
      }).filter((x) => x.score >= 0.6).sort((a, b) => Number(b.e.verified) - Number(a.e.verified) || b.score - a.score).slice(0, 3);
      if (shared.length) {
        out.push(h('div.pal-group', 'Thư viện câu trả lời của nhóm'),
          ...shared.map(({ e }) => h('button.pal-row', { type: 'button', onclick: () => openEntry(e) }, icon(e.verified ? 'verified' : 'library', 15),
            h('span.grow', clip(e.question, 110)), e.verified ? h('span.badge.good', 'đã xác minh') : null)));
      }
    }
    if (failed) out.push(h('p.error', failed));
    if (found) {
      const groups = new Map();
      for (const p of found.passages) {
        const k = p.uri || p.title;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p);
      }
      for (const group of groups.values()) {
        const p = group[0];
        out.push(h('div.pal-doc',
          h(`span.src-ico.${p.sourceType || 'S3'}`, (p.sourceType || '?')[0]),
          h('div.grow', h('strong', p.title || 'Tài liệu'), h('div.faint', [p.sourceTitle, p.fileType, stamp(p.updatedAt) ? `sửa ${ago(stamp(p.updatedAt))}` : ''].filter(Boolean).join(' · '))),
          p.sourceId && p.uri ? h('button.btn.small', { title: 'Các câu hỏi tiếp theo chỉ dùng tài liệu này', onclick: () => setFocus(p) }, icon('target', 13), 'Hỏi trong tài liệu') : null,
          p.sourceId ? h('button.btn.small', { onclick: () => openGuide(docOf(p)) }, 'Tóm tắt') : null),
        ...group.slice(0, 3).map((x) => h('button.pal-row.snip', { type: 'button', title: 'Xem đoạn này trong toàn văn tài liệu', onclick: () => (x.sourceId && x.uri ? openReader(x, { back: () => openSearch(q) }) : null) },
          h('span.grow', highlight(x.excerpt.replace(/\s+/g, ' '), q)),
          h('span.faint', [x.page ? `trang ${x.page}` : '', x.section ? clip(x.section, 40) : ''].filter(Boolean).join(' · ')))),
        group.length > 3 ? h('div.faint.pal-more', `và ${group.length - 3} đoạn khác trong tài liệu này`) : null);
      }
      if (!found.passages.length) out.push(h('p.muted.pal-none', 'Không có đoạn tài liệu nào khớp. Thử từ khoá khác, hoặc hỏi notebook ở dòng trên.'));
    } else if (q.length < 3 && !failed) {
      out.push(h('div.hint', icon('search', 26),
        h('p', 'Gõ từ 3 ký tự. Kết quả là chính các đoạn tài liệu bạn có quyền đọc, nhóm theo tài liệu: không qua model nên có ngay và không tốn token.'),
        h('p.faint', '↑ ↓ để chọn · Enter để mở · Esc để đóng')));
    }
    results.replaceChildren(...out.flat().filter(Boolean));
    activate(rows()[0]);
  };

  const run = (wait = 350) => {
    clearTimeout(timer);
    controller?.abort();
    const q = input.value.trim();
    failed = '';
    if (q.length < 3) {
      found = null;
      status.textContent = '';
      return draw();
    }
    if (searchCache?.key === key()) {
      found = searchCache.data;
      status.textContent = `${found.passages.length} đoạn · ${found.ms} ms`;
      return draw();
    }
    status.textContent = 'Đang tìm…';
    timer = setTimeout(async () => {
      controller = new AbortController();
      const asked = key();
      try {
        const data = await api('/api/search', { method: 'POST', body: { query: q, sources: picked.size ? [...picked] : undefined, limit: 16 }, signal: controller.signal });
        if (asked !== key()) return;
        searchCache = { key: asked, data };
        found = data;
        status.textContent = `${data.passages.length} đoạn trong ${new Set(data.passages.map((p) => p.uri || p.title)).size} tài liệu · ${data.ms} ms`;
      } catch (error) {
        if (error.name === 'AbortError') return;
        found = null;
        failed = error.message;
        status.textContent = '';
      }
      draw();
    }, wait);
  };

  input.addEventListener('input', () => { draw(); run(); });
  input.addEventListener('keydown', (e) => {
    const all = rows();
    const at = all.findIndex((r) => r.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (all.length) activate(all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]);
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      (all[at] || all[0])?.click();
    }
  });

  const m = $('#modal');
  m.replaceChildren(h('div.box.palette', { onclick: (e) => e.stopPropagation(), role: 'dialog', 'aria-label': 'Tìm trong tài liệu' },
    h('div.pal-head', icon('search', 18), input, h('kbd', 'Esc')),
    filters, results,
    h('div.pal-foot.faint', status, h('span.grow'), 'Tìm thẳng trong Knowledge Base, không qua model')));
  m.hidden = false;
  m.onclick = closeModal;
  drawFilters();
  draw();
  run(0);
  input.focus();
  input.select();
}

document.addEventListener('keydown', (e) => {
  if (state.me?.status !== 'active') return;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    return openSearch();
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && $('#modal').hidden) {
    const box = $('.composer textarea');
    if (box) {
      e.preventDefault();
      box.focus();
    }
  }
});

// ---------- library: answers the team shared, shown to whoever may read every source they cite
async function renderLibrary() {
  const body = h('div.page');
  $('#app').replaceChildren(shell(body, 'library'));
  const filter = h('input', { type: 'search', placeholder: 'Lọc theo câu hỏi hoặc nội dung…', style: 'max-width:320px', 'aria-label': 'Lọc thư viện' });
  const only = h('input', { type: 'checkbox' });
  const grid = h('div.lib-grid');
  const draw = () => {
    const words = wordsOf(filter.value);
    const shown = state.library.filter((e) => (!only.checked || e.verified) && (!words.length || words.every((w) => foldText(`${e.question} ${e.answer}`).includes(w))));
    grid.replaceChildren(...(shown.length ? shown.map((e) => h('button.lib-card', { type: 'button', onclick: () => openEntry(e) },
      h('div.q', e.question || 'Câu hỏi'),
      h('div.a', clip(e.answer.replace(/[#*`>|]/g, '').replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '').replace(/\s+/g, ' ').trim(), 220)),
      h('div.row.faint', e.verified ? h('span.badge.good', { title: e.verifiedBy ? `Xác minh bởi ${e.verifiedBy}` : '' }, icon('verified', 12), 'đã xác minh') : null,
        h('span', `${e.by || 'Thành viên'} · ${fmtTime(e.at)}`), h('span.grow'),
        h('span', `${new Set(e.passages.map((p) => p.uri || p.title)).size} tài liệu`))))
      : [h('div.hint', icon('library', 26), h('p', state.library.length ? 'Không có câu trả lời nào khớp bộ lọc.'
        : 'Chưa có câu trả lời nào được chia sẻ. Trong notebook, bấm “Chia sẻ vào thư viện” dưới một câu trả lời có trích dẫn để cả nhóm dùng lại.'))]));
  };
  renderLibrary.draw = draw;
  filter.addEventListener('input', draw);
  only.addEventListener('change', draw);
  body.append(
    h('div.row', h('h1.grow', 'Thư viện câu trả lời'), filter, h('label.row', only, 'Chỉ câu đã xác minh')),
    h('p.muted', { style: 'margin:0' }, 'Các câu trả lời có trích dẫn mà thành viên đã chia sẻ. Bạn chỉ thấy câu trả lời nào mà mọi nguồn nó trích bạn đều được đọc. Admin đánh dấu “đã xác minh” cho câu trả lời đã được người phụ trách tài liệu kiểm tra.'),
    grid);
  draw();
  try {
    state.library = await api('/api/library');
    draw();
  } catch (error) {
    toast(error.message);
  }
}

function openEntry(e) {
  const bubble = h('div.bubble');
  fill(bubble, e.answer, e.passages);
  const put = (next) => {
    state.library = next ? state.library.map((x) => (x.id === next.id ? next : x)) : state.library.filter((x) => x.id !== e.id);
    renderLibrary.draw?.();
  };
  const del = h('button.btn.small.danger', { onclick: async () => {
    if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Bấm lần nữa để gỡ'; return; }
    try {
      await api(`/api/library/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
      for (const m of state.messages) if (m.shared === e.id) m.shared = undefined;
      put(null);
      closeModal();
      toast('Đã gỡ khỏi thư viện.');
    } catch (error) {
      toast(error.message);
    }
  } }, 'Gỡ khỏi thư viện');
  const docs = [...new Map(e.passages.map((p) => [p.uri || p.title, p])).values()];
  modal('Câu trả lời trong thư viện', h('div.entry',
    h('h3', e.question),
    h('div.row.faint', e.verified ? h('span.badge.good', icon('verified', 12), `đã xác minh${e.verifiedBy ? ` bởi ${e.verifiedBy}` : ''}`) : h('span.badge', 'chưa xác minh'),
      h('span', `${e.by || 'Thành viên'} chia sẻ lúc ${fmtTime(e.at)}`), h('span.badge', MODE_NAME[e.mode] || 'nhanh')),
    bubble,
    h('div.doc-chips', docs.map((p) => h('button.doc-chip', { type: 'button', title: 'Xem đoạn được trích trong toàn văn', onclick: () => openReader(p) },
      h(`span.src-ico.${p.sourceType || 'S3'}`, (p.sourceType || '?')[0]), h('span', p.title || 'Tài liệu'))))), [
    h('button.btn.small', { title: 'Hỏi lại để có câu trả lời theo tài liệu hiện tại', onclick: () => askInNotebook(e.question) }, icon('retry', 13), 'Hỏi lại'),
    h('button.btn.small', { onclick: () => copy(e.answer) }, icon('copy', 13), 'Sao chép'),
    state.me.admin ? h('button.btn.small', { onclick: async () => {
      try {
        const next = await api(`/api/library/${encodeURIComponent(e.id)}`, { method: 'PATCH', body: { verified: !e.verified } });
        put(next);
        openEntry(next);
      } catch (error) {
        toast(error.message);
      }
    } }, icon('verified', 13), e.verified ? 'Bỏ xác minh' : 'Xác minh') : null,
    state.me.admin || e.mine ? del : null]);
}

// ---------- KB quality (admin): what people ask, and what the documents do not answer
const SERIES = [['answered', 's1', 'Có trả lời (có trích dẫn)'], ['declined', 's2', 'Không trả lời được']];

function dayChart(days) {
  const top = Math.max(4, ...days.map((d) => d.answered + d.declined));
  const pow = 10 ** Math.floor(Math.log10(top));
  const max = [1, 2, 4, 6, 8, 10].map((x) => x * pow).find((v) => v >= top && v % 2 === 0);
  const tip = h('div.tip', { hidden: true });
  const plot = h('div.plot');
  const date = (day) => `${day.slice(8)}/${day.slice(5, 7)}`;
  const show = (col, d) => {
    tip.replaceChildren(h('strong', date(d.day)),
      ...SERIES.map(([k, cls, label]) => h('div.row', h(`i.${cls}`), h('span.grow', label), h('span.num', d[k]))),
      ...(d.down ? [h('div.row', h('span.grow.faint', 'Bị đánh giá chưa tốt'), h('span.num', d.down))] : []));
    tip.hidden = false;
    const x = col.offsetLeft + col.offsetWidth / 2 - tip.offsetWidth / 2;
    tip.style.left = `${Math.max(0, Math.min(x, plot.clientWidth - tip.offsetWidth))}px`;
  };
  plot.append(...days.map((d) => {
    const col = h('div.col', { tabindex: 0, role: 'img', 'aria-label': `${date(d.day)}: ${d.answered} câu có trả lời, ${d.declined} câu không trả lời được` },
      h('div.stack', SERIES.slice().reverse().map(([k, cls]) => (d[k] ? h(`i.${cls}`, { style: `height:${(d[k] / max) * 100}%` }) : null))));
    col.addEventListener('mouseenter', () => show(col, d));
    col.addEventListener('focus', () => show(col, d));
    col.addEventListener('mouseleave', () => { tip.hidden = true; });
    col.addEventListener('blur', () => { tip.hidden = true; });
    return col;
  }), tip);
  const every = days.length > 16 ? 5 : days.length > 8 ? 2 : 1;
  return h('div.chart',
    h('div.y', [max, max / 2, 0].map((v) => h('span.num', v))),
    plot,
    h('div.x', days.map((d, i) => h('span.num', i % every === 0 ? Number(d.day.slice(8)) : ''))));
}

async function renderInsights() {
  const body = h('div.page');
  $('#app').replaceChildren(shell(body, 'insights'));
  const month = h('input', { type: 'month', value: new Date().toISOString().slice(0, 7), style: 'width:auto', 'aria-label': 'Tháng', onchange: () => load() });
  const view = { table: false, resolved: false };
  let data = null;
  const head = () => h('div.row', h('h1.grow', 'Chất lượng Knowledge Base'), month);
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

  const paint = () => {
    const d = data;
    const t = d.totals;
    const open = d.gaps.filter((g) => !g.resolved).length;
    const gaps = d.gaps.filter((g) => view.resolved || !g.resolved);
    const most = Math.max(1, ...d.documents.map((x) => x.count));
    body.replaceChildren(head(),
      h('p.muted', { style: 'margin:0' }, 'Mỗi câu hỏi trên web được ghi lại, không kèm tên người hỏi. Câu nào tài liệu không trả lời được, hoặc bị đánh giá chưa tốt, là một chỗ tài liệu cần bổ sung.'),
      h('div.stats',
        stat('Câu hỏi', t.questions, `nhanh ${t.modes.fast} · chuyên sâu ${t.modes.deep} · agent ${t.modes.agent}`),
        stat('Có trả lời', pct(t.answered, t.questions), `${t.answered} câu có trích dẫn tài liệu`),
        stat('Không trả lời được', t.declined, t.declined ? 'tài liệu chưa có nội dung này' : 'không có', t.declined ? 'warn' : ''),
        stat('Đánh giá', t.voted ? `${t.up} tốt · ${t.down} chưa tốt` : '—', t.voted ? `${pct(t.voted, t.questions)} số câu được đánh giá` : 'chưa có đánh giá'),
        stat('Thời gian trả lời', t.seconds ? `${t.seconds} giây` : '—', 'trung bình mỗi câu')),
      h('div.card',
        h('div.row', h('h2.grow', { style: 'margin:0' }, 'Câu hỏi theo ngày'),
          h('div.legend', SERIES.map(([, cls, label]) => h('span', h(`i.${cls}`), label))),
          h('button.btn.small', { onclick: () => { view.table = !view.table; paint(); } }, view.table ? 'Xem biểu đồ' : 'Xem bảng')),
        !t.questions ? h('p.faint', 'Chưa có câu hỏi nào trong tháng này.')
          : view.table ? h('div.tbl-wrap', h('table.tbl',
            h('thead', h('tr', ['Ngày', 'Có trả lời', 'Không trả lời được', 'Bị đánh giá chưa tốt'].map((x) => h('th', x)))),
            h('tbody', d.days.filter((x) => x.answered + x.declined).map((x) => h('tr', h('td.num', x.day), h('td.num', x.answered), h('td.num', x.declined), h('td.num', x.down))))))
            : dayChart(d.days)),
      h('div.card',
        h('div.row', h('h2.grow', { style: 'margin:0' }, `Chỗ tài liệu còn thiếu (${open} chưa xử lý)`),
          h('label.row.faint', h('input', { type: 'checkbox', checked: view.resolved, onchange: (e) => { view.resolved = e.target.checked; paint(); } }), 'Hiện cả câu đã xử lý')),
        gaps.length ? h('div.tbl-wrap', h('table.tbl',
          h('thead', h('tr', ['Lúc', 'Câu hỏi', 'Vấn đề', 'Tài liệu đã trích', ''].map((x) => h('th', x)))),
          h('tbody', gaps.map((g) => h(`tr${g.resolved ? '.done' : ''}`,
            h('td.num.faint', fmtTime(g.at)),
            h('td', h('div', g.question), g.focus ? h('div.focus-tag', icon('target', 12), `Chỉ trong: ${g.focus}`) : null, g.note ? h('div.faint', `Ghi chú: “${g.note}”`) : null),
            h('td', h('div.row', !g.answered ? h('span.badge.warn', 'không trả lời được') : null,
              g.vote === 'down' ? h('span.badge.bad', REASON_NAME[g.reason] ? `chưa tốt: ${REASON_NAME[g.reason].toLowerCase()}` : 'bị đánh giá chưa tốt') : null,
              h('span.badge', MODE_NAME[g.mode] || 'nhanh'))),
            h('td.faint', g.cited.length ? g.cited.map((c) => c.title).join(' · ') : '—'),
            h('td', h('div.row',
              h('button.btn.small', { title: 'Hỏi lại câu này ở chế độ Agent để xem tài liệu có thật sự thiếu không', onclick: () => askInNotebook(g.question, 'agent') }, icon('retry', 13), 'Agent'),
              h('button.btn.small', { onclick: async () => {
                try {
                  await api(`/api/admin/insights/${d.month}/${encodeURIComponent(g.id)}`, { method: 'PATCH', body: { resolved: !g.resolved } });
                  g.resolved = !g.resolved;
                  paint();
                } catch (error) {
                  toast(error.message);
                }
              } }, g.resolved ? 'Mở lại' : [icon('check', 13), 'Đã xử lý']))))))))
          : h('p.faint', d.gaps.length ? 'Mọi câu đều đã xử lý.' : 'Không có câu nào tài liệu không trả lời được hoặc bị đánh giá chưa tốt.')),
      h('div.two',
        h('div.card', h('h2', 'Tài liệu được trích nhiều nhất'),
          d.documents.length ? h('div.rank', d.documents.map((x) => h('button.rank-row', { type: 'button', title: 'Xem tóm tắt tài liệu', onclick: () => openGuide({ sourceId: x.sourceId, uri: x.uri, title: x.title }) },
            h('span.n', x.title || 'Tài liệu'), h('span.num', x.count), h('span.bar', h('i', { style: `width:${(x.count / most) * 100}%` })))))
            : h('p.faint', 'Chưa có.')),
        h('div.card', h('h2', 'Câu hỏi lặp lại'),
          d.repeated.length ? h('div.tbl-wrap', h('table.tbl',
            h('thead', h('tr', ['Câu hỏi', 'Số lần', 'Có trả lời', ''].map((x) => h('th', x)))),
            h('tbody', d.repeated.map((q) => h('tr', h('td', q.question), h('td.num', q.count), h('td.num', `${q.answered}/${q.count}`),
              h('td', h('button.btn.small', { onclick: () => askInNotebook(q.question) }, 'Hỏi')))))))
            : h('p.faint', 'Chưa có câu nào được hỏi từ hai lần. Câu lặp lại nhiều nên có sẵn trong thư viện.'))),
      h('p.faint', 'Bản ghi câu hỏi không lưu tên hay email người hỏi và tự xoá sau 180 ngày. Câu hỏi qua MCP không nằm trong bản ghi này.'));
  };

  const load = async () => {
    body.replaceChildren(head(), h('p.muted', 'Đang tải…'));
    try {
      data = await api(`/api/admin/insights?month=${month.value}`);
    } catch (error) {
      body.replaceChildren(head(), h('p.error', error.message));
      return;
    }
    paint();
  };
  await load();
}

// ---------- boot
(async () => {
  try {
    state.cfg = await (await fetch('config.json', { cache: 'no-store' })).json();
  } catch {
    $('#app').replaceChildren(h('div.boot', 'Thiếu config.json'));
    return;
  }
  const theme = localGet('poc3.theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  try { state.auth = JSON.parse(localGet('poc3.auth') || 'null'); } catch { state.auth = null; }
  if (state.auth) start();
  else renderAuth('in');
})();
