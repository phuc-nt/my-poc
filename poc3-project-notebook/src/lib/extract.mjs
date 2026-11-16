// The text of PowerPoint, Word and Excel files, read here before a file goes to the knowledge base. The knowledge
// base's own parser leaves out a deck's speaker notes, stores Vietnamese text from pptx and docx with wrong accents
// (the attachment test measured both) and does not read the pictures inside a file, and a managed knowledge base has
// no parser setting to change that. A .pptx, .docx or .xlsx is a zip of XML parts, so the exact text is there to
// read: slides in order with their titles, bullets, tables and notes; a document's headings, paragraphs, lists,
// tables and footnotes; a workbook's sheets row by row with their text boxes. Each picture in the file is marked
// where it stands, so that prepare.mjs can have it read by a model and put its text at that place.
//
// No dependency: a zip directory reader over node:zlib and a small XML reader are enough for these parts.
//
//   extract(name, bytes) -> { kind: 'pptx' | 'docx' | 'xlsx', title, blocks, notes, media } | null (a format this module does not read)
//   blocks: [{ type: 'heading', level, text } | { type: 'para', text } | { type: 'list', level, text }
//            | { type: 'table', rows } | { type: 'notes', text } | { type: 'picture', part, alt, text? }]
//   notes:  [{ slide, title, text }]   the speaker notes alone, for a deck
//   media(part) -> the bytes of a picture part (a picture block's part)
//   toMarkdown(blocks), toHtml(blocks, title), notesMarkdown(extracted, name)

import { inflateRawSync } from 'node:zlib';

const MAX_PART = 30 << 20; // one XML part, unpacked; a larger one is not a document this module should read

// ---------- zip

// The parts of a zip file by name. read(name) gives a part's text and bytes(name) its bytes, or null when the file
// has no such part.
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
  const bytes = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.full > MAX_PART) throw new Error(`${name} is larger than ${MAX_PART >> 20} MB`);
    const start = e.local + 30 + buffer.readUInt16LE(e.local + 26) + buffer.readUInt16LE(e.local + 28);
    const data = buffer.subarray(start, start + e.size);
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error(`${name}: compression method ${e.method} is not read`);
    return inflateRawSync(data, { maxOutputLength: MAX_PART });
  };
  return { names: [...entries.keys()], bytes, read: (name) => bytes(name)?.toString('utf8') ?? null };
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
const first = (node, name) => {
  for (const n of walk(node)) if (n.name === name) return n;
  return undefined;
};
function* walk(node) {
  for (const c of nodes(node)) {
    yield c;
    yield* walk(c);
  }
}

// A part's relationships by id: id -> target part name.
const relationMap = (zip, part) => new Map(relations(zip, part).map((r) => [r.id, r.target]));

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

// A picture block: the part an image's r:embed (or a VML r:id) points to, and the picture's alt text. A name the
// tool gave the picture by itself ("Picture 3", "図 2") is no alt text.
const NO_ALT = /^(picture|image|graphic|図|画像|図形|グラフィックス|hình|ảnh)?\s*\d*$/i;
const picture = (rels, id, alt) => ({ type: 'picture', part: (id && rels?.get(id)) || null, alt: NO_ALT.test((alt || '').trim()) ? '' : alt.trim() });

// The shapes of a slide, in the order they are drawn. Returns the slide's title; the rest goes to blocks.
// rels: the slide's relationships, for its pictures.
function slideShapes(tree, blocks, rels) {
  let title = '';
  for (const shape of nodes(tree)) {
    if (shape.name === 'p:grpSp') title = slideShapes(shape, blocks, rels) || title;
    else if (shape.name === 'p:sp') {
      // A shape filled with a picture (a picture placeholder).
      const fill = path(shape, 'p:spPr', 'a:blipFill', 'a:blip');
      if (fill) blocks.push(picture(rels, fill.attrs['r:embed'], path(shape, 'p:nvSpPr', 'p:cNvPr')?.attrs.descr));
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
      blocks.push(picture(rels, first(shape, 'a:blip')?.attrs['r:embed'], path(shape, 'p:nvPicPr', 'p:cNvPr')?.attrs.descr));
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
    const slideTitle = tree ? slideShapes(tree, content, relationMap(zip, part)) : '';
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
  return { kind: 'pptx', title, blocks, notes, media: zip.bytes };
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

// The pictures in a part of a Word document: DrawingML pictures (w:drawing) and the older VML ones (w:pict, w:object).
function wordPictures(node, rels) {
  const found = [];
  for (const n of walk(node)) {
    if (n.name === 'w:drawing') {
      const blip = first(n, 'a:blip');
      if (blip) found.push(picture(rels, blip.attrs['r:embed'], first(n, 'wp:docPr')?.attrs.descr));
    } else if (n.name === 'w:pict' || n.name === 'w:object') {
      const image = first(n, 'v:imagedata');
      if (image) found.push(picture(rels, image.attrs['r:id'], first(n, 'v:shape')?.attrs.alt || image.attrs['o:title']));
    }
  }
  return found;
}

// rels: the relationships of the part the container is in, for its pictures.
function wordBlocks(container, levels, blocks, rels) {
  for (const n of nodes(container)) {
    if (n.name === 'w:p') {
      const text = wordText(n);
      const pictures = wordPictures(n, rels);
      if (text) {
        const properties = kid(n, 'w:pPr');
        const style = kid(properties, 'w:pStyle')?.attrs['w:val'] || '';
        const numbered = kid(properties, 'w:numPr');
        if (levels.has(style)) blocks.push({ type: 'heading', level: levels.get(style), text });
        else if (numbered || /^List/i.test(style)) blocks.push({ type: 'list', level: Number(kid(numbered, 'w:ilvl')?.attrs['w:val'] || 0), text });
        else blocks.push({ type: 'para', text });
      }
      blocks.push(...pictures);
    } else if (n.name === 'w:tbl') {
      const rows = kids(n, 'w:tr').map((row) => kids(row, 'w:tc').map((c) => [...walk(c)].filter((x) => x.name === 'w:p').map(wordText).filter(Boolean).join(' / ')));
      if (rows.length) blocks.push({ type: 'table', rows });
      blocks.push(...wordPictures(n, rels));
    } else if (n.name === 'w:sdt') {
      const content = kid(n, 'w:sdtContent');
      if (content) wordBlocks(content, levels, blocks, rels);
    }
  }
}

function docx(zip, name) {
  const xml = zip.read('word/document.xml');
  if (!xml) throw new Error('no document part');
  const body = path(parseXml(xml), 'w:document', 'w:body');
  const levels = headingStyles(zip);
  const blocks = [];
  if (body) wordBlocks(body, levels, blocks, relationMap(zip, 'word/document.xml'));
  for (const [part, label] of [['word/footnotes.xml', 'Footnotes'], ['word/endnotes.xml', 'Endnotes']]) {
    const notesXml = zip.read(part);
    if (!notesXml) continue;
    const said = [];
    const rels = relationMap(zip, part);
    // Word keeps two separator entries (ids -1 and 0) that are not notes.
    for (const note of walk(parseXml(notesXml))) if (/^w:(foot|end)note$/.test(note.name) && Number(note.attrs['w:id']) > 0) wordBlocks(note, levels, said, rels);
    if (said.length) blocks.push({ type: 'heading', level: 2, text: label }, ...said);
  }
  const title = blocks.find((b) => b.type === 'heading' && b.level === 1)?.text || name.replace(/\.[^.]+$/, '');
  return { kind: 'docx', title, blocks, notes: [], media: zip.bytes };
}

// ---------- Excel

const MAX_SHEET_TEXT = 1_000_000; // characters of cell text per workbook; the knowledge base reads the file's cells itself

// The parts of a workbook are written with different namespace prefixes by different tools (Excel writes xdr:pic,
// others a default namespace and pic), so the Excel reader reads element names without their prefix.
const bareXml = (xml) => {
  const tree = parseXml(xml);
  for (const n of walk(tree)) n.name = n.name.replace(/^[^:]*:/, '');
  return tree;
};

// The text of a node, leaving out the phonetic guides (furigana, rPh) that Japanese workbooks keep next to a string.
function cellString(node) {
  let text = '';
  const visit = (n) => {
    for (const c of nodes(n)) {
      if (c.name === 't') text += ownText(c);
      else if (c.name !== 'rPh' && c.name !== 'phoneticPr') visit(c);
    }
  };
  visit(node);
  return text;
}

// The cell styles (by index) whose number format is a date or a time, so that a date shows as one and not as a serial number.
function dateStyles(zip) {
  const xml = zip.read('xl/styles.xml');
  const dated = new Set();
  if (!xml) return dated;
  const tree = bareXml(xml);
  // Built-in formats 14-22 and 45-47 are dates and times; 27-36 and 50-58 are the East Asian date formats.
  const ids = new Set([...Array(9)].map((_, i) => 14 + i).concat([45, 46, 47], [...Array(10)].map((_, i) => 27 + i), [...Array(9)].map((_, i) => 50 + i)));
  for (const f of walk(tree)) {
    if (f.name !== 'numFmt') continue;
    const code = (f.attrs.formatCode || '').replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
    if (/[ydhs]/i.test(code)) ids.add(Number(f.attrs.numFmtId));
  }
  const xfs = first(tree, 'cellXfs');
  if (xfs) kids(xfs, 'xf').forEach((xf, i) => ids.has(Number(xf.attrs.numFmtId)) && dated.add(i));
  return dated;
}

// A date serial (days since 1899-12-30) as 2026-11-16, with the time when it has one.
function serialDate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const iso = new Date(Math.round((n - 25569) * 86400000)).toISOString();
  return Number.isInteger(n) ? iso.slice(0, 10) : n < 1 ? iso.slice(11, 16) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

// The column of a cell reference, 0 for A.
const column = (ref) => [...String(ref).replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// What a sheet's drawing puts on the sheet: pictures and text boxes, each with the row (1-based) its top is anchored to.
function sheetDrawing(zip, sheetPart, sheetTree) {
  const id = first(sheetTree, 'drawing')?.attrs['r:id'];
  const part = id && relationMap(zip, sheetPart).get(id);
  const xml = part && zip.read(part);
  if (!xml) return [];
  const rels = relationMap(zip, part);
  const items = [];
  const paragraphs = (body) => kids(body || { children: [] }, 'p').map((p) => [...walk(p)].map((n) => (n.name === 't' ? ownText(n) : n.name === 'br' ? '\n' : '')).join('').trim()).filter(Boolean);
  for (const anchor of nodes(first(bareXml(xml), 'wsDr') || { children: [] })) {
    if (!/Anchor$/.test(anchor.name)) continue;
    const row = Number(ownText(path(anchor, 'from', 'row') || { children: ['0'] })) + 1;
    for (const n of walk(anchor)) {
      if (n.name === 'pic') items.push({ row, block: picture(rels, first(n, 'blip')?.attrs['r:embed'], path(n, 'nvPicPr', 'cNvPr')?.attrs.descr) });
      else if (n.name === 'sp') {
        const text = paragraphs(kid(n, 'txBody')).join('\n');
        if (text) items.push({ row, block: { type: 'para', text: `Text box: ${text}` } });
      }
    }
  }
  return items.sort((a, b) => a.row - b.row);
}

// A workbook: per sheet, its non-empty rows (cells joined by " | ") with its pictures and text boxes at the rows
// they are anchored to.
function xlsx(zip, name) {
  const main = 'xl/workbook.xml';
  const xml = zip.read(main);
  if (!xml) throw new Error('no workbook part');
  const rels = relations(zip, main);
  const stringsXml = zip.read(rels.find((r) => r.type.endsWith('/sharedStrings'))?.target || 'xl/sharedStrings.xml');
  const strings = stringsXml ? [...walk(bareXml(stringsXml))].filter((n) => n.name === 'si').map(cellString) : [];
  const dated = dateStyles(zip);
  const byId = new Map(rels.map((r) => [r.id, r.target]));
  const title = name.replace(/\.[^.]+$/, '');
  const blocks = [{ type: 'heading', level: 1, text: title }];
  let budget = MAX_SHEET_TEXT;
  for (const sheet of [...walk(bareXml(xml))].filter((n) => n.name === 'sheet')) {
    const part = byId.get(sheet.attrs['r:id']);
    const sheetXml = part && zip.read(part);
    if (!sheetXml) continue;
    const tree = bareXml(sheetXml);
    const hidden = sheet.attrs.state && sheet.attrs.state !== 'visible';
    blocks.push({ type: 'heading', level: 2, text: `Sheet: ${sheet.attrs.name}${hidden ? ' (hidden)' : ''}` });
    const drawn = sheetDrawing(zip, part, tree);
    let lines = [];
    const flush = () => {
      if (lines.length) blocks.push({ type: 'para', text: lines.join('\n') });
      lines = [];
    };
    const place = (upTo) => {
      while (drawn.length && drawn[0].row <= upTo) {
        flush();
        blocks.push(drawn.shift().block);
      }
    };
    let cut = false;
    for (const row of [...walk(first(tree, 'sheetData') || { children: [] })].filter((n) => n.name === 'row')) {
      const r = Number(row.attrs.r);
      place(r - 1);
      if (cut) continue;
      const cells = [];
      for (const c of kids(row, 'c')) {
        const t = c.attrs.t;
        let value;
        if (t === 'inlineStr') value = cellString(kid(c, 'is') || { children: [] });
        else {
          const v = kid(c, 'v') && ownText(kid(c, 'v'));
          if (v === undefined || v === '') continue;
          value = t === 's' ? strings[Number(v)] ?? '' : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : (!t || t === 'n') && dated.has(Number(c.attrs.s)) ? serialDate(v) : v;
        }
        value = String(value).replace(/\s*\n\s*/g, ' / ').trim();
        if (value) cells[column(c.attrs.r)] = value;
      }
      const line = cells.filter(Boolean).join(' | ');
      if (!line) continue;
      if (line.length > budget) {
        flush();
        blocks.push({ type: 'para', text: '(The rest of the cells are left out here; the workbook itself holds them.)' });
        cut = true;
        continue;
      }
      budget -= line.length;
      lines.push(line);
      place(r);
    }
    place(Infinity);
    flush();
  }
  return { kind: 'xlsx', title, blocks, notes: [], media: zip.bytes };
}

// ---------- the module's own entry points

export const readable = (name) => /\.(pptx|docx|xlsx)$/i.test(name);

export function extract(name, bytes) {
  if (!readable(name)) return null;
  const zip = unzip(bytes);
  const kind = name.toLowerCase().split('.').pop();
  return kind === 'pptx' ? pptx(zip, name) : kind === 'xlsx' ? xlsx(zip, name) : docx(zip, name);
}

// A picture block as Markdown: the text a model read from it, or its alt text alone, or nothing. A picture that
// stands a second time in the file (same) is not repeated.
function pictureMarkdown(b) {
  const alt = b.alt ? oneLine(b.alt) : '';
  if (b.text && !b.same) return `Picture${alt ? ` (alt text: ${alt})` : ''}, read by a model:\n\n${b.text.trim()}\n\n(End of picture)`;
  return alt ? `Picture: ${alt}` : '';
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
    else if (b.type === 'picture') {
      const text = pictureMarkdown(b);
      if (text) parts.push(text);
    } else if (b.type === 'table') {
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
    else if (b.type === 'picture') {
      const text = pictureMarkdown(b);
      if (text) out.push(`<p>${html(text)}</p>`);
    } else if (b.type === 'table') {
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
