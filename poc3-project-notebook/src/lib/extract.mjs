// The text of PowerPoint and Word files, read here before a file goes to the knowledge base. The knowledge base's
// own parser leaves out a deck's speaker notes and stores Vietnamese text from these two formats with wrong
// accents (the attachment test measured both), and a managed knowledge base has no parser setting to change that.
// A .pptx or .docx is a zip of XML parts, so the exact text is there to read: slides in order with their titles,
// bullets, tables and notes; a document's headings, paragraphs, lists, tables and footnotes.
//
// No dependency: a zip directory reader over node:zlib and a small XML reader are enough for these parts.
//
//   extract(name, bytes) -> { kind: 'pptx' | 'docx', title, blocks, notes } | null (a format this module does not read)
//   blocks: [{ type: 'heading', level, text } | { type: 'para', text } | { type: 'list', level, text }
//            | { type: 'table', rows } | { type: 'notes', text }]
//   notes:  [{ slide, title, text }]   the speaker notes alone, for a deck
//   toMarkdown(blocks), toHtml(blocks, title), notesMarkdown(extracted, name)

import { inflateRawSync } from 'node:zlib';

const MAX_PART = 30 << 20; // one XML part, unpacked; a larger one is not a document this module should read

// ---------- zip

// The parts of a zip file by name. read(name) gives a part's text, or null when the file has no such part.
export function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error('zip64 files are not read');
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged zip directory');
    const nameLength = buffer.readUInt16LE(at + 28);
    entries.set(buffer.toString('utf8', at + 46, at + 46 + nameLength), {
      method: buffer.readUInt16LE(at + 10), size: buffer.readUInt32LE(at + 20), full: buffer.readUInt32LE(at + 24), local: buffer.readUInt32LE(at + 42) });
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.full > MAX_PART) throw new Error(`${name} is larger than ${MAX_PART >> 20} MB`);
      const start = e.local + 30 + buffer.readUInt16LE(e.local + 26) + buffer.readUInt16LE(e.local + 28);
      const data = buffer.subarray(start, start + e.size);
      if (e.method === 0) return data.toString('utf8');
      if (e.method !== 8) throw new Error(`${name}: compression method ${e.method} is not read`);
      return inflateRawSync(data, { maxOutputLength: MAX_PART }).toString('utf8');
    },
  };
}

// ---------- XML

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (all, e) =>
  (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e] ?? all));

// XML as a tree of { name, attrs, children }, where a child is a node or a string of text.
export function parseXml(xml) {
  const root = { name: '', attrs: {}, children: [] };
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s>/]+)([^>]*?)(\/?)>|([^<]+)/g;
  for (let m; (m = token.exec(xml)); ) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.children.push(m[1]);
    else if (m[2]) {
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {
      const node = { name: m[3], attrs: {}, children: [] };
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[a[1]] = decode(a[2] ?? a[3]);
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.children.push(decode(m[6]));
  }
  return root;
}

const nodes = (node) => node.children.filter((c) => typeof c !== 'string');
const kids = (node, name) => nodes(node).filter((c) => c.name === name);
const kid = (node, name) => node?.children.find((c) => c.name === name);
const path = (node, ...names) => names.reduce((n, name) => kid(n, name), node);
const ownText = (node) => node.children.filter((c) => typeof c === 'string').join('');
function* walk(node) {
  for (const c of nodes(node)) {
    yield c;
    yield* walk(c);
  }
}

// A part's relationships: [{ id, type, target }], the target as a part name.
function relations(zip, part) {
  const cut = part.lastIndexOf('/');
  const xml = zip.read(`${part.slice(0, cut)}/_rels/${part.slice(cut + 1)}.rels`);
  if (!xml) return [];
  const resolve = (target) => {
    if (target.startsWith('/')) return target.slice(1);
    const parts = part.split('/').slice(0, -1);
    for (const p of target.split('/')) {
      if (p === '..') parts.pop();
      else if (p !== '.') parts.push(p);
    }
    return parts.join('/');
  };
  return [...walk(parseXml(xml))].filter((n) => n.name === 'Relationship' && n.attrs.TargetMode !== 'External')
    .map((n) => ({ id: n.attrs.Id, type: n.attrs.Type || '', target: resolve(n.attrs.Target || '') }));
}

// ---------- PowerPoint

const FURNITURE = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']); // placeholders that are not content

// The paragraphs of a text body: [{ text, level }].
function drawingParagraphs(body) {
  if (!body) return [];
  return kids(body, 'a:p').map((p) => {
    let text = '';
    for (const n of walk(p)) {
      if (n.name === 'a:t') text += ownText(n);
      else if (n.name === 'a:br') text += '\n';
    }
    return { text: text.trim(), level: Number(kid(p, 'a:pPr')?.attrs.lvl || 0) };
  }).filter((p) => p.text);
}

// The shapes of a slide, in the order they are drawn. Returns the slide's title; the rest goes to blocks.
function slideShapes(tree, blocks) {
  let title = '';
  for (const shape of nodes(tree)) {
    if (shape.name === 'p:grpSp') title = slideShapes(shape, blocks) || title;
    else if (shape.name === 'p:sp') {
      const placeholder = path(shape, 'p:nvSpPr', 'p:nvPr', 'p:ph');
      const type = placeholder?.attrs.type;
      if (FURNITURE.has(type)) continue;
      const paragraphs = drawingParagraphs(kid(shape, 'p:txBody'));
      if (type === 'title' || type === 'ctrTitle') title = paragraphs.map((p) => p.text).join(' ') || title;
      else if (placeholder && type !== 'subTitle') blocks.push(...paragraphs.map((p) => ({ type: 'list', level: p.level, text: p.text })));
      else blocks.push(...paragraphs.map((p) => ({ type: 'para', text: p.text })));
    } else if (shape.name === 'p:graphicFrame') {
      for (const table of walk(shape)) {
        if (table.name !== 'a:tbl') continue;
        const rows = kids(table, 'a:tr').map((row) => kids(row, 'a:tc').map((c) => drawingParagraphs(kid(c, 'a:txBody')).map((p) => p.text).join(' / ')));
        if (rows.length) blocks.push({ type: 'table', rows });
      }
    } else if (shape.name === 'p:pic') {
      const described = path(shape, 'p:nvPicPr', 'p:cNvPr')?.attrs.descr;
      if (described) blocks.push({ type: 'para', text: `Picture: ${described}` });
    }
  }
  return title;
}

function pptx(zip, name) {
  const main = 'ppt/presentation.xml';
  const xml = zip.read(main);
  if (!xml) throw new Error('no presentation part');
  const byId = new Map(relations(zip, main).map((r) => [r.id, r.target]));
  const order = [...walk(parseXml(xml))].filter((n) => n.name === 'p:sldId').map((n) => byId.get(n.attrs['r:id'])).filter(Boolean);
  const title = name.replace(/\.[^.]+$/, '');
  const blocks = [{ type: 'heading', level: 1, text: title }];
  const notes = [];
  order.forEach((part, i) => {
    const slide = zip.read(part);
    if (!slide) return;
    const content = [];
    const tree = path(parseXml(slide), 'p:sld', 'p:cSld', 'p:spTree');
    const slideTitle = tree ? slideShapes(tree, content) : '';
    blocks.push({ type: 'heading', level: 2, text: `Slide ${i + 1}${slideTitle ? `: ${slideTitle}` : ''}` }, ...content);
    const notesPart = relations(zip, part).find((r) => r.type.endsWith('/notesSlide'))?.target;
    const notesXml = notesPart && zip.read(notesPart);
    if (!notesXml) return;
    const said = [];
    for (const shape of walk(parseXml(notesXml))) {
      if (shape.name !== 'p:sp' || FURNITURE.has(path(shape, 'p:nvSpPr', 'p:nvPr', 'p:ph')?.attrs.type)) continue;
      said.push(...drawingParagraphs(kid(shape, 'p:txBody')).map((p) => p.text));
    }
    if (!said.length) return;
    blocks.push({ type: 'notes', text: said.join('\n') });
    notes.push({ slide: i + 1, title: slideTitle, text: said.join('\n') });
  });
  return { kind: 'pptx', title, blocks, notes };
}

// ---------- Word

const SKIPPED = new Set(['w:del', 'w:instrText', 'w:pPr', 'w:rPr', 'mc:Fallback', 'w:footnoteReference', 'w:endnoteReference']);

// The text of a paragraph: its runs, with tabs and line breaks; deleted (tracked) text is left out.
function wordText(node) {
  let text = '';
  const visit = (n) => {
    for (const c of nodes(n)) {
      if (c.name === 'w:t') text += ownText(c);
      else if (c.name === 'w:tab') text += '\t';
      else if (c.name === 'w:br' || c.name === 'w:cr') text += '\n';
      else if (!SKIPPED.has(c.name)) visit(c);
    }
  };
  visit(node);
  return text.trim();
}

// Style id -> heading level, from the names Word gives its built-in styles ("heading 2", "Title").
function headingStyles(zip) {
  const levels = new Map();
  const xml = zip.read('word/styles.xml');
  if (!xml) return levels;
  for (const style of walk(parseXml(xml))) {
    if (style.name !== 'w:style') continue;
    const name = kid(style, 'w:name')?.attrs['w:val'] || '';
    const heading = name.match(/^heading (\d)$/i)?.[1];
    if (heading) levels.set(style.attrs['w:styleId'], Math.min(Number(heading) + 1, 6));
    else if (/^title$/i.test(name)) levels.set(style.attrs['w:styleId'], 1);
  }
  return levels;
}

function wordBlocks(container, levels, blocks) {
  for (const n of nodes(container)) {
    if (n.name === 'w:p') {
      const text = wordText(n);
      if (!text) continue;
      const properties = kid(n, 'w:pPr');
      const style = kid(properties, 'w:pStyle')?.attrs['w:val'] || '';
      const numbered = kid(properties, 'w:numPr');
      if (levels.has(style)) blocks.push({ type: 'heading', level: levels.get(style), text });
      else if (numbered || /^List/i.test(style)) blocks.push({ type: 'list', level: Number(kid(numbered, 'w:ilvl')?.attrs['w:val'] || 0), text });
      else blocks.push({ type: 'para', text });
    } else if (n.name === 'w:tbl') {
      const rows = kids(n, 'w:tr').map((row) => kids(row, 'w:tc').map((c) => [...walk(c)].filter((x) => x.name === 'w:p').map(wordText).filter(Boolean).join(' / ')));
      if (rows.length) blocks.push({ type: 'table', rows });
    } else if (n.name === 'w:sdt') {
      const content = kid(n, 'w:sdtContent');
      if (content) wordBlocks(content, levels, blocks);
    }
  }
}

function docx(zip, name) {
  const xml = zip.read('word/document.xml');
  if (!xml) throw new Error('no document part');
  const body = path(parseXml(xml), 'w:document', 'w:body');
  const levels = headingStyles(zip);
  const blocks = [];
  if (body) wordBlocks(body, levels, blocks);
  for (const [part, label] of [['word/footnotes.xml', 'Footnotes'], ['word/endnotes.xml', 'Endnotes']]) {
    const notesXml = zip.read(part);
    if (!notesXml) continue;
    const said = [];
    // Word keeps two separator entries (ids -1 and 0) that are not notes.
    for (const note of walk(parseXml(notesXml))) if (/^w:(foot|end)note$/.test(note.name) && Number(note.attrs['w:id']) > 0) wordBlocks(note, levels, said);
    if (said.length) blocks.push({ type: 'heading', level: 2, text: label }, ...said);
  }
  const title = blocks.find((b) => b.type === 'heading' && b.level === 1)?.text || name.replace(/\.[^.]+$/, '');
  return { kind: 'docx', title, blocks, notes: [] };
}

// ---------- the module's own entry points

export const readable = (name) => /\.(pptx|docx)$/i.test(name);

export function extract(name, bytes) {
  if (!readable(name)) return null;
  const zip = unzip(bytes);
  return /\.pptx$/i.test(name) ? pptx(zip, name) : docx(zip, name);
}

const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ');
const markdownCell = (s) => oneLine(s).replace(/\|/g, '\\|');

export function toMarkdown(blocks) {
  const parts = [];
  let inList = false;
  for (const b of blocks) {
    if (b.type === 'list') {
      const line = `${'  '.repeat(b.level)}- ${oneLine(b.text)}`;
      if (inList) parts[parts.length - 1] += `\n${line}`;
      else parts.push(line);
      inList = true;
      continue;
    }
    inList = false;
    if (b.type === 'heading') parts.push(`${'#'.repeat(b.level)} ${oneLine(b.text)}`);
    else if (b.type === 'notes') parts.push(`Speaker notes: ${b.text}`);
    else if (b.type === 'table') {
      const width = Math.max(...b.rows.map((r) => r.length));
      const line = (row) => `| ${Array.from({ length: width }, (_, i) => markdownCell(row[i] || '')).join(' | ')} |`;
      parts.push([line(b.rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...b.rows.slice(1).map(line)].join('\n'));
    } else parts.push(b.text);
  }
  return `${parts.join('\n\n')}\n`;
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = (s) => escapeHtml(s).replace(/\n/g, '<br>');

export function toHtml(blocks, title) {
  const out = [];
  let depth = -1; // the open list level, -1 for none
  const closeLists = (to = -1) => {
    for (; depth > to; depth--) out.push('</ul>');
  };
  for (const b of blocks) {
    if (b.type === 'list') {
      for (; depth < b.level; depth++) out.push('<ul>');
      closeLists(b.level);
      out.push(`<li>${html(b.text)}</li>`);
      continue;
    }
    closeLists();
    if (b.type === 'heading') out.push(`<h${b.level}>${html(b.text)}</h${b.level}>`);
    else if (b.type === 'notes') out.push(`<p><b>Speaker notes:</b> ${html(b.text)}</p>`);
    else if (b.type === 'table') {
      const row = (cells, tag) => `<tr>${cells.map((c) => `<${tag}>${html(c)}</${tag}>`).join('')}</tr>`;
      out.push(`<table>\n${row(b.rows[0], 'th')}\n${b.rows.slice(1).map((r) => row(r, 'td')).join('\n')}\n</table>`);
    } else out.push(`<p>${html(b.text)}</p>`);
  }
  closeLists();
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>\n<body>\n${out.join('\n')}\n</body></html>\n`;
}

// A deck's speaker notes alone, as the text of a document that goes next to the deck itself.
export function notesMarkdown(extracted, name) {
  if (!extracted.notes.length) return '';
  return `# Speaker notes of ${name}\n\n${extracted.notes.map((n) => `## Slide ${n.slide}${n.title ? `: ${n.title}` : ''}\n\nSpeaker notes: ${n.text}`).join('\n\n')}\n`;
}
