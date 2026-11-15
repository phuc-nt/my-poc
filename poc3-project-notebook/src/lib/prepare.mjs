// The step between a source system and the knowledge base. A managed knowledge base has no parser setting, and its
// parser loses part of some formats: measured in scripts/preprocess-lab.mjs, it keeps about half the words of a
// Vietnamese pptx, docx, doc or pdf (the accents come out wrong), reads a scanned pdf the same way, and never
// reads a deck's speaker notes. So for those formats the sync sends a second document next to the file: the
// file's text as Markdown, made here.
//
//   pptx, docx   the text in the file's own XML (extract.mjs): exact, with the tables and the speaker notes
//   pdf          the text layer, page by page (pdfjs-dist); a page that is only a picture (a scan) is read by a model
//   doc          the text of the binary Word file (word-extractor)
//   png, jpg...  the picture read by a model: its text, then what it shows
//
// The model is one with image input that runs in the app's own Region (config.readModel). Without one, pictures
// and scanned pages get no text document and the knowledge base's own reading of the file is all there is.

import { deflateSync } from 'node:zlib';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { extract, toMarkdown } from './extract.mjs';

const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const MAX_READ_PAGES = 30; // scanned pages read by the model per file
const MAX_PICTURE_BYTES = 3_500_000; // an image block of Converse takes 3.75 MB
const MAX_PIXELS = 6_000_000;
const SCAN_TEXT = 30; // a page with fewer characters than this in its text layer, and a picture, is a scan

export const READ_PICTURE = 'Transcribe every piece of text in this picture exactly as written, keeping its language and its accents, one line per line of text. '
  + 'Then, under the heading "Description", describe in two or three sentences what the picture shows (a screen, a diagram, its parts and how they connect). '
  + 'Write nothing that is not in the picture.';
export const READ_PAGE = 'This is one scanned page of a document. Transcribe all of its text exactly as written, keeping its language and its accents, '
  + 'one line per line of text, a table as a Markdown table. Write only the transcription, nothing that is not on the page.';

// What kind of text document a file gets: 'pptx', 'docx', 'pdf', 'doc', 'picture', or null for a file the
// knowledge base reads well as it is (xlsx, xls, csv, md, txt, html).
export function kindOf(name) {
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (['pptx', 'docx', 'pdf', 'doc'].includes(ext)) return ext;
  return PICTURE.test(name) ? 'picture' : null;
}

// A reader of pictures: (bytes, format, prompt) => text, on a model with image input.
export function reader(model, region) {
  const client = new BedrockRuntimeClient({ region, maxAttempts: 4 });
  return async (bytes, format, prompt) => {
    const response = await client.send(new ConverseCommand({ modelId: model,
      messages: [{ role: 'user', content: [{ image: { format, source: { bytes } } }, { text: prompt }] }],
      inferenceConfig: { maxTokens: 4000, temperature: 0 } }));
    return (response.output?.message?.content || []).map((b) => b.text || '').join('').trim();
  };
}

// ---------- pdf

let pdfjs;
async function pdfLibrary() {
  if (!pdfjs) {
    // Outside a browser pdfjs runs its worker in the same thread, and takes it from this global.
    globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjs;
}

// The text items of a page as lines, top to bottom. Items on one line that stand apart are cells of a table row.
function pageText(items) {
  const rows = [];
  for (const item of items) {
    if (!item.str?.trim()) continue;
    const [, , , d, x, y] = item.transform;
    const h = item.height || Math.abs(d) || 10;
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.min(r.h, h) * 0.5);
    if (!row) rows.push(row = { y, h, cells: [] });
    row.cells.push({ x, end: x + (item.width || 0), str: item.str });
  }
  rows.sort((a, b) => b.y - a.y);
  const out = [];
  let previous;
  for (const row of rows) {
    row.cells.sort((a, b) => a.x - b.x);
    let line = '';
    let last;
    for (const cell of row.cells) {
      if (last) {
        const gap = cell.x - last.end;
        line += gap > row.h * 0.9 ? ' | ' : gap > row.h * 0.15 && !/\s$/.test(line) && !/^\s/.test(cell.str) ? ' ' : '';
      }
      line += cell.str;
      last = cell;
    }
    if (previous && previous.y - row.y > Math.max(previous.h, row.h) * 1.9) out.push('');
    out.push(line.trim());
    previous = row;
  }
  return out.join('\n');
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  let c = 0xffffffff;
  for (const b of [...head.subarray(4), ...body]) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

// A decoded picture of a pdf page ({ width, height, kind, data }: 1 bit, RGB or RGBA) as a grey png small enough
// for the model.
function pagePicture(image) {
  let { width: w, height: h } = image;
  const { kind, data } = image;
  let grey = Buffer.alloc(w * h);
  if (kind === 1) {
    const stride = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grey[y * w + x] = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
  } else {
    const n = kind === 3 ? 4 : 3;
    for (let i = 0; i < w * h; i++) grey[i] = (data[i * n] * 77 + data[i * n + 1] * 150 + data[i * n + 2] * 29) >> 8;
  }
  for (;;) {
    if (w * h <= MAX_PIXELS) {
      const raw = Buffer.alloc((w + 1) * h);
      for (let y = 0; y < h; y++) grey.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w);
      const header = Buffer.alloc(13);
      header.writeUInt32BE(w, 0);
      header.writeUInt32BE(h, 4);
      header[8] = 8; // bits per sample; colour type 0 (grey), no interlace
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
      if (png.length <= MAX_PICTURE_BYTES || w < 400) return png;
    }
    // Half the size: each pixel the mean of four.
    const w2 = w >> 1;
    const h2 = h >> 1;
    const half = Buffer.alloc(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) half[y * w2 + x] = (grey[2 * y * w + 2 * x] + grey[2 * y * w + 2 * x + 1] + grey[(2 * y + 1) * w + 2 * x] + grey[(2 * y + 1) * w + 2 * x + 1]) >> 2;
    [grey, w, h] = [half, w2, h2];
  }
}

// The pages of a pdf: [{ text, pictures }] where pictures (png buffers) are given only for a page without a
// text layer, a scan, and only for the first maxScans of those (a picture of a page takes memory).
export async function pdfPages(bytes, { maxScans = MAX_READ_PAGES } = {}) {
  const lib = await pdfLibrary();
  const task = lib.getDocument({ data: new Uint8Array(bytes), isOffscreenCanvasSupported: false, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  let scans = 0;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const text = pageText((await page.getTextContent()).items);
      const pictures = [];
      if (text.replace(/\s/g, '').length < SCAN_TEXT && scans < maxScans) {
        const ops = await page.getOperatorList();
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] !== lib.OPS.paintImageXObject && ops.fnArray[i] !== lib.OPS.paintInlineImageXObject) continue;
          const arg = ops.argsArray[i][0];
          const image = typeof arg === 'string' ? await new Promise((resolve) => (arg.startsWith('g_') ? page.commonObjs : page.objs).get(arg, resolve)) : arg;
          if (image?.data && image.width >= 200 && image.height >= 200) pictures.push(pagePicture(image));
        }
      }
      if (pictures.length) scans++;
      pages.push({ text, pictures: pictures.slice(0, 4) });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

async function pdfText(name, bytes, read) {
  const pages = await pdfPages(bytes, { maxScans: read ? MAX_READ_PAGES : 0 });
  const scans = pages.filter((page) => page.pictures.length);
  // Four scanned pages at a time.
  for (let i = 0; i < scans.length; i += 4) {
    await Promise.all(scans.slice(i, i + 4).map(async (page) => {
      const texts = [];
      for (const picture of page.pictures) texts.push(await read(picture, 'png', READ_PAGE));
      page.text = texts.join('\n\n');
    }));
  }
  const scanned = scans.length;
  const parts = [];
  for (const [i, page] of pages.entries()) {
    if (page.text.trim()) parts.push(pages.length > 1 ? `## Page ${i + 1}\n\n${page.text.trim()}` : page.text.trim());
  }
  if (!parts.length) return null;
  return { text: `# ${name}\n\n${parts.join('\n\n')}\n`, how: scanned ? `text of ${pages.length} page(s), ${scanned} read from the scan by a model` : `text layer of ${pages.length} page(s)` };
}

// ---------- doc

async function docText(name, bytes) {
  const { default: WordExtractor } = await import('word-extractor');
  const doc = await new WordExtractor().extract(Buffer.from(bytes));
  const parts = [doc.getBody(), doc.getTextboxes?.({ includeHeadersAndFooters: false }), doc.getFootnotes(), doc.getEndnotes()]
    .map((s) => String(s || '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').trim()).filter(Boolean);
  if (!parts.length) return null;
  // One line of a Word file is one paragraph, a table row comes with tabs between its cells.
  const body = parts.join('\n\n').split('\n').map((line) => (line.includes('\t') ? line.split('\t').map((c) => c.trim()).join(' | ') : line.trim())).join('\n\n').replace(/\n{3,}/g, '\n\n');
  return { text: `# ${name}\n\n${body}\n`, how: 'text of the Word file' };
}

// ---------- the text document of a file

// { text, how } — the Markdown to send next to the file — or null when there is nothing to add (a format the
// knowledge base reads well, an empty file, a picture and no model). read: see reader().
export async function prepare(name, bytes, { read } = {}) {
  const kind = kindOf(name);
  if (kind === 'pptx' || kind === 'docx') {
    const extracted = extract(name, bytes);
    const text = extracted && toMarkdown(extracted.blocks);
    return text?.trim() ? { text, how: `text of the ${kind} file${extracted.notes?.length ? ', with its speaker notes' : ''}` } : null;
  }
  if (kind === 'pdf') return pdfText(name, bytes, read);
  if (kind === 'doc') return docText(name, bytes);
  if (kind === 'picture' && read) {
    if (bytes.length > MAX_PICTURE_BYTES) return null;
    const format = /\.jpe?g$/i.test(name) ? 'jpeg' : name.toLowerCase().split('.').pop();
    const text = await read(bytes, format, READ_PICTURE);
    return text ? { text: `# ${name}\n\nText and description of the picture ${name}, read by a model.\n\n${text}\n`, how: 'picture read by a model' } : null;
  }
  return null;
}
