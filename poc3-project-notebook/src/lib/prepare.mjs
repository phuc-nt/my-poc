// The step between a source system and the knowledge base. A managed knowledge base has no parser setting, and its
// parser loses part of some formats: measured in scripts/preprocess-lab.mjs, it keeps about half the words of a
// Vietnamese pptx, docx, doc or pdf (the accents come out wrong), reads a scanned pdf the same way, never reads a
// deck's speaker notes, and does not read the pictures inside a file (a screenshot pasted into a sheet, a diagram on
// a slide). So for those formats the sync sends a second document next to the file: the file's text as Markdown,
// made here.
//
//   pptx, docx   the text in the file's own XML (extract.mjs): exact, with the tables and the speaker notes
//   xlsx         each sheet's cells row by row and its text boxes (extract.mjs)
//   pdf          the text layer, page by page (pdfjs-dist); a page that is only a picture (a scan) is read by a model
//   doc          the text of the binary Word file (word-extractor)
//   png, jpg...  the picture read by a model: its text, then what it shows
//
// The pictures inside a pptx, docx, xlsx or pdf are read by the model too, and their text goes where the picture
// stands: on its slide, after its paragraph, at its row, on its page. Icons and other small pictures are left out,
// a picture that stands twice is read once, and formats the model does not take (emf, wmf, tiff, svg) are skipped.
//
// The model is one with image input that runs in the app's own Region (config.readModel). Without one, pictures
// and scanned pages get no text and the knowledge base's own reading of the file is all there is.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { extract, toMarkdown } from './extract.mjs';

const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const MAX_READ_PAGES = 30; // scanned pages read by the model per file
const MAX_READ_PICTURES = 40; // pictures inside a file read by the model per file (scanned pages not counted)
const MAX_PICTURE_BYTES = 3_500_000; // an image block of Converse takes 3.75 MB
const MAX_PIXELS = 6_000_000;
const MAX_SIDE = 8000; // the longest side an image block takes
const SCAN_TEXT = 30; // a page with fewer characters than this in its text layer, and a picture, is a scan
const READ_AT_ONCE = 4; // model calls in flight per file
// A picture smaller than this (an icon, a bullet, a small logo) holds nothing worth a model call.
const small = (w, h) => Math.min(w, h) < 48 || w * h < 40_000;

export const READ_PICTURE = 'Transcribe every piece of text in this picture exactly as written, keeping its language and its accents, one line per line of text, a table as a Markdown table. '
  + 'Then, under the heading "Description", describe in two or three sentences what the picture shows (a screen, a diagram, its parts and how they connect). '
  + 'Write nothing that is not in the picture.';
export const READ_PAGE = 'This is one scanned page of a document. Transcribe all of its text exactly as written, keeping its language and its accents, '
  + 'one line per line of text, a table as a Markdown table. Write only the transcription, nothing that is not on the page.';

// What kind of text document a file gets: 'pptx', 'docx', 'xlsx', 'pdf', 'doc', 'picture', or null for a file the
// knowledge base reads well as it is (xls, csv, md, txt, html).
export function kindOf(name) {
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (['pptx', 'docx', 'xlsx', 'pdf', 'doc'].includes(ext)) return ext;
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

// The format and size of a picture, from its first bytes: { format, width, height } for png, jpeg, gif and webp,
// the formats an image block takes, or null for any other.
export function pictureInfo(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (b.length < 30) return null;
  if (b.readUInt32BE(0) === 0x89504e47) return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.toString('latin1', 0, 4) === 'GIF8') return { format: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return { format: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { format: 'webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // The size is in the first start-of-frame marker (C0-CF, except C4, C8 and CC).
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) i++; // fill byte
      else if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) i += 2; // markers without a length
      else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { format: 'jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      else i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// Reads many pictures, READ_AT_ONCE at a time. jobs: [{ bytes, format, prompt }]; returns their texts in order.
async function readAll(jobs, read) {
  const texts = [];
  for (let i = 0; i < jobs.length; i += READ_AT_ONCE) {
    texts.push(...await Promise.all(jobs.slice(i, i + READ_AT_ONCE).map((j) => read(j.bytes, j.format, j.prompt))));
  }
  return texts;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The pictures of an extracted pptx, docx or xlsx, read by the model: each picture block gets its text. Returns
// { read, skipped } counts for the "how" of the text document; small pictures are left out without a count.
async function readPictures(extracted, read) {
  const firstOf = new Map(); // a picture part -> its first block
  const jobs = [];
  let skipped = 0;
  for (const block of extracted.blocks) {
    if (block.type !== 'picture' || !block.part) continue;
    if (firstOf.has(block.part)) {
      block.same = true;
      continue;
    }
    firstOf.set(block.part, block);
    const bytes = extracted.media(block.part);
    const info = bytes && pictureInfo(bytes);
    if (info && small(info.width, info.height)) continue;
    if (!info || bytes.length > MAX_PICTURE_BYTES || Math.max(info.width, info.height) > MAX_SIDE || jobs.length >= MAX_READ_PICTURES) {
      skipped++;
      continue;
    }
    jobs.push({ block, bytes, format: info.format, prompt: READ_PICTURE });
  }
  const texts = await readAll(jobs, read);
  jobs.forEach((job, i) => (job.block.text = texts[i]));
  return { read: jobs.length, skipped };
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

// The pages of a pdf: [{ text, pictures, figures }] (png buffers).
//   pictures  for a page without a text layer, a scan: its images, for the first maxScans of those pages
//   figures   for a page with a text layer: the images drawn on it (a screenshot, a diagram), for the first
//             maxFigures of those in the file; an image that covers most of the page is its background or the
//             scan under a text layer made by OCR, and is left out, as is an image already taken on an earlier page
export async function pdfPages(bytes, { maxScans = MAX_READ_PAGES, maxFigures = 0 } = {}) {
  const lib = await pdfLibrary();
  const { OPS } = lib;
  const task = lib.getDocument({ data: new Uint8Array(bytes), isOffscreenCanvasSupported: false, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  const seen = new Set();
  let scans = 0;
  let figures = 0;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const text = pageText((await page.getTextContent()).items);
      const short = text.replace(/\s/g, '').length < SCAN_TEXT;
      const found = { pictures: [], figures: [] };
      if ((short && scans < maxScans) || figures < maxFigures) {
        // The page's images and the share of the page each covers.
        const images = [];
        const [x0, y0, x1, y1] = page.view;
        const pageArea = Math.abs((x1 - x0) * (y1 - y0)) || 1;
        // The area an image covers is the determinant of the transformation in force when it is drawn.
        let ctm = [1, 0, 0, 1, 0, 0];
        const stack = [];
        const times = (m, t) => [t[0] * m[0] + t[1] * m[2], t[0] * m[1] + t[1] * m[3], t[2] * m[0] + t[3] * m[2], t[2] * m[1] + t[3] * m[3],
          t[4] * m[0] + t[5] * m[2] + m[4], t[4] * m[1] + t[5] * m[3] + m[5]];
        const ops = await page.getOperatorList();
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          const args = ops.argsArray[i];
          if (fn === OPS.save) stack.push(ctm);
          else if (fn === OPS.restore) ctm = stack.pop() || ctm;
          else if (fn === OPS.transform) ctm = times(ctm, args);
          else if (fn === OPS.paintFormXObjectBegin) {
            stack.push(ctm);
            if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = times(ctm, [...args[0]]);
          } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
          if (fn !== OPS.paintImageXObject && fn !== OPS.paintInlineImageXObject) continue;
          const arg = args[0];
          const image = typeof arg === 'string' ? await new Promise((resolve) => (arg.startsWith('g_') ? page.commonObjs : page.objs).get(arg, resolve)) : arg;
          if (image?.data) images.push({ image, share: Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / pageArea });
        }
        // A scan: little text and an image over half the page or more. Its images are read as the page.
        if (short && scans < maxScans && images.some((x) => x.share > 0.5)) {
          for (const { image } of images) if (image.width >= 200 && image.height >= 200) found.pictures.push(pagePicture(image));
        } else {
          for (const { image, share } of images) {
            if (small(image.width, image.height) || share > 0.8 || share < 0.01 || figures + found.figures.length >= maxFigures) continue;
            const png = pagePicture(image);
            const key = createHash('sha1').update(png).digest('hex');
            if (seen.has(key)) continue;
            seen.add(key);
            found.figures.push(png);
          }
        }
      }
      if (found.pictures.length) scans++;
      figures += found.figures.length;
      pages.push({ text, pictures: found.pictures.slice(0, 4), figures: found.figures });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

async function pdfText(name, bytes, read) {
  const pages = await pdfPages(bytes, { maxScans: read ? MAX_READ_PAGES : 0, maxFigures: read ? MAX_READ_PICTURES : 0 });
  const jobs = [];
  for (const page of pages) {
    for (const picture of page.pictures) jobs.push({ page, scan: true, bytes: picture, format: 'png', prompt: READ_PAGE });
    for (const picture of page.figures) jobs.push({ page, bytes: picture, format: 'png', prompt: READ_PICTURE });
  }
  const texts = await readAll(jobs, read);
  for (const page of pages) {
    page.scanText = [];
    page.figureText = [];
  }
  jobs.forEach((job, i) => (job.scan ? job.page.scanText : job.page.figureText).push(texts[i]));
  const scanned = pages.filter((page) => page.pictures.length).length;
  const figures = jobs.filter((job) => !job.scan).length;
  const parts = [];
  for (const [i, page] of pages.entries()) {
    const body = [page.pictures.length ? page.scanText.join('\n\n') : page.text.trim(),
      ...page.figureText.filter(Boolean).map((t) => `Picture, read by a model:\n\n${t.trim()}\n\n(End of picture)`)].filter((t) => t.trim()).join('\n\n');
    if (body) parts.push(pages.length > 1 ? `## Page ${i + 1}\n\n${body}` : body);
  }
  if (!parts.length) return null;
  const how = [scanned ? `text of ${plural(pages.length, 'page')}, ${scanned} read from the scan by a model` : `text layer of ${plural(pages.length, 'page')}`];
  if (figures) how.push(`${plural(figures, 'picture')} on the pages read by a model`);
  return { text: `# ${name}\n\n${parts.join('\n\n')}\n`, how: how.join(', ') };
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
  if (kind === 'pptx' || kind === 'docx' || kind === 'xlsx') {
    const extracted = extract(name, bytes);
    if (!extracted) return null;
    const pictures = read ? await readPictures(extracted, read) : { read: 0, skipped: 0 };
    // Headings alone are no text.
    if (!extracted.blocks.some((block) => block.type !== 'heading' && toMarkdown([block]).trim())) return null;
    const text = toMarkdown(extracted.blocks);
    const how = [`text of the ${kind} file`];
    if (extracted.notes?.length) how.push('with its speaker notes');
    if (pictures.read) how.push(`${plural(pictures.read, 'picture')} in it read by a model`);
    if (pictures.skipped) how.push(`${plural(pictures.skipped, 'picture')} not read (a format the model does not take, too large, or over ${MAX_READ_PICTURES})`);
    return { text, how: how.join(', ') };
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
