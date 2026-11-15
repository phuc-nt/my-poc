#!/usr/bin/env node
// The pre-processing lab: what can be done to a file before it goes to the managed knowledge base, and what does
// each treatment change? A managed knowledge base has no parser setting, so the only place to act is the step
// between the source system and IngestKnowledgeBaseDocuments. The lab sends every fixture file of the attachment
// test as it is (the baseline), plus variants of the formats the parser reads badly, to a data source of its own
// (lab-preprocess, a CUSTOM one like the Jira source), and measures two things per treatment:
//
//   text     the share of the file's true words the knowledge base stored (GetDocumentContent against the
//            content written in eval/attachments/make.py), for all words and for words with Vietnamese accents
//   cases    the questions of eval/attachments/cases.json, searched only in the treatment's documents: is the fact
//            in the top passages, and does the chat model answer right from them
//
//   node scripts/preprocess-lab.mjs build     make each variant in eval/out/lab/
//   node scripts/preprocess-lab.mjs up        create the data source, send the variants, wait until they are indexed
//   node scripts/preprocess-lab.mjs measure   text and cases per treatment; results in eval/out/preprocess-lab.json
//   node scripts/preprocess-lab.mjs recount   count the text again from the stored text measure kept, without AWS
//   node scripts/preprocess-lab.mjs down      delete the documents, the files and the data source
//   node scripts/preprocess-lab.mjs readers   every image model of the Region, and Textract, on the pictures and scans
//
// Variants made here: Markdown, HTML and notes-only text of a deck or a Word file (src/lib/extract.mjs), a
// picture read by a model with image input in the Region. Variants made outside, picked up from
// eval/out/lab/converted/<variant>/ when they are there: pptx-notes-on-slide (python-pptx: the notes as a text
// box on their slide), pptx-pdf and docx-pdf (reportlab, a text PDF of the same content), docx-pandoc
// (pandoc -f docx -t gfm), png-pdf (Pillow: the picture as a one-page PDF), probe (a picture placed inside a
// docx and a pptx). Prints file names, states and numbers; no address, account or host.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BedrockAgentClient, IngestKnowledgeBaseDocumentsCommand, DeleteKnowledgeBaseDocumentsCommand, ListKnowledgeBaseDocumentsCommand } from '@aws-sdk/client-bedrock-agent';
import { BedrockAgentRuntimeClient, RetrieveCommand, AgenticRetrieveStreamCommand, GetDocumentContentCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { aws, file, kbId, dataSources, dataBucket, REGION } from '../infra/kb.mjs';
import { manifest, mimeOf } from './attach-fixtures.mjs';
import { extract, toMarkdown, toHtml, notesMarkdown } from '../src/lib/extract.mjs';
import { prepare, reader, pdfPages, READ_PICTURE, READ_PAGE } from '../src/lib/prepare.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = join(ROOT, 'eval', 'attachments', 'files');
const LAB = join(ROOT, 'eval', 'out', 'lab');
const CONVERTED = join(LAB, 'converted');
const SOURCE = 'lab-preprocess';
const CHAT_MODEL = process.env.CHAT_MODEL || 'zai.glm-5';
const VISION = { nova: 'amazon.nova-pro-v1:0', qwen: 'qwen.qwen3-vl-235b-a22b' };
const MIME = { md: 'text/markdown', html: 'text/html', pdf: 'application/pdf' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const agent = new BedrockAgentClient({ region: REGION, maxAttempts: 6 });
const runtime = new BedrockAgentRuntimeClient({ region: REGION, maxAttempts: 6 });
const models = new BedrockRuntimeClient({ region: REGION, maxAttempts: 6 });

// ---------- the variants

// A scanned pdf is a kind of its own: it has no text layer, so it is treated like a picture.
const kindOf = (name) => (/-scan\.pdf$/i.test(name) ? 'scan' : extname(name).slice(1).toLowerCase());
const stem = (name) => name.slice(0, -extname(name).length);
const fixtures = [...new Set(manifest.containers.flatMap((c) => c.files))].sort();

// What each kind of file is tried as, beyond the file itself. made: built here; a string: taken from converted/.
const VARIANTS = {
  pptx: { md: 'made', html: 'made', notes: 'made', 'notes-on-slide': 'pptx', pdf: 'pdf' },
  docx: { md: 'made', html: 'made', pandoc: 'md', pdf: 'pdf' },
  png: { 'vision-nova': 'made', 'vision-qwen': 'made', pdf: 'pdf' },
  pdf: { text: 'made' },
  doc: { text: 'made' },
  scan: { 'text-qwen': 'made', 'text-nova': 'made', 'page-png': 'made' },
};
// The treatments compared per kind: the documents that stand for one file in the knowledge base.
const TREATMENTS = {
  pptx: [['original'], ['original', 'notes'], ['md'], ['original', 'md'], ['html'], ['notes-on-slide'], ['pdf']],
  docx: [['original'], ['md'], ['original', 'md'], ['html'], ['pandoc'], ['pdf']],
  png: [['original'], ['vision-nova'], ['vision-qwen'], ['original', 'vision-nova'], ['pdf']],
  pdf: [['original'], ['text'], ['original', 'text']],
  doc: [['original'], ['text'], ['original', 'text']],
  scan: [['original'], ['text-qwen'], ['text-nova'], ['page-png'], ['original', 'text-qwen']],
};

async function readPicture(model, bytes) {
  const response = await models.send(new ConverseCommand({ modelId: model,
    messages: [{ role: 'user', content: [{ image: { format: 'png', source: { bytes } } }, { text: READ_PICTURE }] }],
    inferenceConfig: { maxTokens: 1500, temperature: 0 } }));
  return (response.output?.message?.content || []).map((b) => b.text || '').join('').trim();
}

// One document the lab sends: { id, file, kind, variant, path, name } (path: the local file that holds it).
function atoms() {
  const out = [];
  for (const name of fixtures) {
    const kind = kindOf(name);
    out.push({ file: name, kind, variant: 'original', path: join(FILES, name), name });
    for (const [variant, how] of Object.entries(VARIANTS[kind] || {})) {
      const stored = how === 'made' ? `${stem(name)}.${variant === 'html' ? 'html' : variant === 'page-png' ? 'png' : 'md'}` : `${stem(name)}.${how}`;
      const path = how === 'made' ? join(LAB, `${kind}-${variant}`, stored) : join(CONVERTED, `${kind}-${variant}`, stored);
      out.push({ file: name, kind, variant, path, name: stored });
    }
  }
  const probes = join(CONVERTED, 'probe');
  for (const name of existsSync(probes) ? readdirSync(probes).sort() : []) out.push({ file: name, kind: 'probe', variant: 'original', path: join(probes, name), name });
  return out.map((a) => ({ ...a, id: `lab://${a.kind}-${a.variant}/${a.file}` }));
}

async function build() {
  for (const name of fixtures) {
    const kind = kindOf(name);
    if (!VARIANTS[kind]) continue;
    const bytes = readFileSync(join(FILES, name));
    const write = (variant, stored, text) => {
      mkdirSync(join(LAB, `${kind}-${variant}`), { recursive: true });
      writeFileSync(join(LAB, `${kind}-${variant}`, stored), text);
      console.log(`${kind}-${variant}: ${stored} (${text.length} ${typeof text === 'string' ? 'characters' : 'bytes'})`);
    };
    if (kind === 'png') {
      for (const [short, model] of Object.entries(VISION)) {
        const text = await readPicture(model, bytes).catch((error) => `(${error.name}: ${error.message.slice(0, 160)})`);
        write(`vision-${short}`, `${stem(name)}.md`, `# ${name}\n\nText and description of the picture ${name}, read by a model.\n\n${text}\n`);
      }
      continue;
    }
    // The text document the sync would send (src/lib/prepare.mjs): the text layer of a pdf, the text of a doc,
    // a scanned page read by a model; and the scanned page as a picture file, for the knowledge base to read.
    if (kind === 'pdf' || kind === 'doc') {
      write('text', `${stem(name)}.md`, (await prepare(name, bytes)).text);
      continue;
    }
    if (kind === 'scan') {
      for (const [short, model] of Object.entries(VISION)) {
        const made = await prepare(name, bytes, { read: reader(model, REGION) }).catch((error) => ({ text: `(${error.name}: ${error.message.slice(0, 160)})` }));
        write(`text-${short}`, `${stem(name)}.md`, made.text);
      }
      write('page-png', `${stem(name)}.png`, (await pdfPages(bytes))[0].pictures[0]);
      continue;
    }
    const extracted = extract(name, bytes);
    write('md', `${stem(name)}.md`, toMarkdown(extracted.blocks));
    write('html', `${stem(name)}.html`, toHtml(extracted.blocks, extracted.title));
    if (kind === 'pptx') write('notes', `${stem(name)}.md`, notesMarkdown(extracted, name));
  }
  for (const a of atoms()) if (!existsSync(a.path)) console.log(`not there, left out: ${a.kind}-${a.variant} ${a.name}`);
}

// ---------- the data source

const lab = () => {
  const kb = kbId();
  const ds = dataSources(kb).find((d) => d.name === SOURCE);
  return { kb, id: ds?.dataSourceId };
};
const attributes = (values) => ({ type: 'IN_LINE_ATTRIBUTE', inlineAttributes: Object.entries(values).map(([key, v]) => ({ key, value: { type: 'STRING', stringValue: String(v) } })) });

async function listed({ kb, id }) {
  const out = new Map();
  let nextToken;
  do {
    const page = await agent.send(new ListKnowledgeBaseDocumentsCommand({ knowledgeBaseId: kb, dataSourceId: id, maxResults: 100, nextToken }));
    for (const d of page.documentDetails || []) out.set(d.identifier?.custom?.id, d);
    nextToken = page.nextToken;
  } while (nextToken);
  return out;
}

async function up() {
  let { kb, id } = lab();
  if (!id) {
    id = aws(['bedrock-agent', 'create-data-source', '--knowledge-base-id', kb, '--name', SOURCE, '--description', 'Pre-processing lab (scripts/preprocess-lab.mjs)',
      '--data-source-configuration', file('lab.json', { type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
        managedKnowledgeBaseConnectorConfiguration: { connectorParameters: { type: 'CUSTOM', version: '1', aclEnabled: false } } })]).dataSource.dataSourceId;
    console.log(`data source ${SOURCE}: created`);
  }
  const bucket = dataBucket();
  const have = await listed({ kb, id });
  const documents = [];
  for (const a of atoms()) {
    if (!existsSync(a.path) || have.has(a.id)) continue;
    const metadata = attributes({ lab_variant: `${a.kind}-${a.variant}`, lab_file: a.file, title: `${a.file} [${a.variant}]` });
    // The notes go in as text in the request, the way the Jira sync sends an issue; everything else as a file.
    if (a.variant === 'notes') {
      documents.push({ content: { dataSourceType: 'CUSTOM', custom: { customDocumentIdentifier: { id: a.id }, sourceType: 'IN_LINE',
        inlineContent: { type: 'TEXT', textContent: { data: readFileSync(a.path, 'utf8') } } } }, metadata });
      continue;
    }
    const key = `lab/${a.kind}-${a.variant}/${a.name}`;
    aws(['s3', 'cp', a.path, `s3://${bucket}/${key}`, '--content-type', MIME[kindOf(a.name)] || mimeOf(a.name), '--only-show-errors'], { json: false });
    documents.push({ content: { dataSourceType: 'CUSTOM', custom: { customDocumentIdentifier: { id: a.id }, sourceType: 'S3_LOCATION', s3Location: { uri: `s3://${bucket}/${key}` } } }, metadata });
  }
  for (let i = 0; i < documents.length; i += 10) {
    await agent.send(new IngestKnowledgeBaseDocumentsCommand({ knowledgeBaseId: kb, dataSourceId: id, documents: documents.slice(i, i + 10) }));
  }
  console.log(`sent ${documents.length} documents`);
  const started = Date.now();
  for (;;) {
    const states = [...(await listed({ kb, id })).values()].map((d) => d.status);
    const waiting = states.filter((s) => ['PENDING', 'STARTING', 'IN_PROGRESS'].includes(s)).length;
    console.log(`${Math.round((Date.now() - started) / 1000)} s: ${states.length - waiting}/${states.length} done`);
    if (!waiting || Date.now() - started > 30 * 60_000) break;
    await sleep(30_000);
  }
  const now = await listed({ kb, id });
  const counts = {};
  for (const d of now.values()) counts[d.status] = (counts[d.status] || 0) + 1;
  console.log('states:', JSON.stringify(counts));
  for (const [docId, d] of now) if (!/INDEXED/.test(d.status)) console.log(`  ${d.status} ${docId} ${d.statusReason || ''}`);
}

async function down() {
  const { kb, id } = lab();
  if (!id) return console.log(`no data source ${SOURCE}`);
  const ids = [...(await listed({ kb, id })).keys()].map((docId) => ({ dataSourceType: 'CUSTOM', custom: { id: docId } }));
  for (let i = 0; i < ids.length; i += 10) await agent.send(new DeleteKnowledgeBaseDocumentsCommand({ knowledgeBaseId: kb, dataSourceId: id, documentIdentifiers: ids.slice(i, i + 10) }));
  console.log(`deleted ${ids.length} documents`);
  aws(['s3', 'rm', `s3://${dataBucket()}/lab/`, '--recursive', '--only-show-errors'], { json: false });
  for (let waited = 0; (await listed({ kb, id })).size && waited < 600; waited += 15) await sleep(15_000);
  const configuration = aws(['bedrock-agent', 'get-data-source', '--knowledge-base-id', kb, '--data-source-id', id]).dataSource.dataSourceConfiguration;
  aws(['bedrock-agent', 'update-data-source', '--knowledge-base-id', kb, '--data-source-id', id, '--name', SOURCE, '--data-deletion-policy', 'DELETE',
    '--data-source-configuration', file('lab.json', configuration)], { quiet: true });
  aws(['bedrock-agent', 'delete-data-source', '--knowledge-base-id', kb, '--data-source-id', id]);
  console.log(`data source ${SOURCE}: removed`);
}

// ---------- measuring

// The words written into each fixture file: every string and number of its call in make.py (a dictionary's keys
// are the builder's own field names, not content).
function truth() {
  const python = `
import ast, json, sys
out = {}
for node in ast.parse(open(sys.argv[1]).read()).body:
    call = getattr(node, 'value', None)
    if not (isinstance(node, ast.Expr) and isinstance(call, ast.Call) and call.args and isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str)):
        continue
    keys = {id(k) for d in ast.walk(call) if isinstance(d, ast.Dict) for k in d.keys}
    words = [str(c.value) for a in call.args[1:] + [k.value for k in call.keywords] for c in ast.walk(a)
             if isinstance(c, ast.Constant) and id(c) not in keys and not isinstance(c.value, bool) and c.value is not None]
    out[call.args[0].value] = words
print(json.dumps(out))`;
  return JSON.parse(execFileSync('python3', ['-c', python, join(ROOT, 'eval', 'attachments', 'make.py')], { encoding: 'utf8' }));
}

const plain = (s) => String(s || '').toLowerCase().normalize('NFC').replace(/\*\*/g, '');
// 486.500.000, 486,500,000 and 486 500 000 all read as 486500000.
const digits = (s) => plain(s).replace(/(?<=\d)[.,\s ](?=\d{3}(\D|$))/g, '');
const tokens = (s) => new Set(digits(s).match(/[\p{L}\p{N}]+(?:[.,:/_-][\p{L}\p{N}]+)*/gu) || []);
const holds = (text, alternative) => plain(text).includes(plain(alternative)) || digits(text).includes(digits(alternative));
const missing = (text, expect) => expect.filter((group) => !group.some((alternative) => holds(text, alternative))).map((group) => group[0]);

// The knowledge base's own id of a document: agentic retrieval returns it, Retrieve does not.
async function documentId({ kb, id }, docId) {
  const response = await runtime.send(new AgenticRetrieveStreamCommand({
    messages: [{ role: 'user', content: { text: `summary of ${basename(docId)}` } }],
    retrievers: [{ description: 'one document', configuration: { knowledgeBase: { knowledgeBaseId: kb, retrievalOverrides: {
      filter: { andAll: [{ equals: { key: '_data_source_id', value: id } }, { equals: { key: '_source_uri', value: docId } }] }, maxNumberOfResults: 1 } } } }],
    agenticRetrieveConfiguration: { foundationModelType: 'MANAGED', rerankingModelType: 'MANAGED', maxAgentIteration: 1 }, generateResponse: false }));
  let found = null;
  for await (const event of response.stream) found = event.result?.results?.[0]?.metadata?._document_id || found;
  return found;
}

// What the knowledge base stored for a document: its text, tables as rows of cells.
async function storedText(source, docId) {
  const kbDocId = await documentId(source, docId);
  if (!kbDocId) return null;
  const content = await runtime.send(new GetDocumentContentCommand({ knowledgeBaseId: source.kb, dataSourceId: source.id, documentId: kbDocId, outputFormat: 'EXTRACTED' }));
  const raw = await (await fetch(content.presignedUrl)).text();
  if (!/json/.test(content.mimeType || '')) return raw;
  const doc = JSON.parse(raw);
  const text = doc.plainTextDocumentContent;
  if (text) return typeof text === 'string' ? text : text.text || '';
  return (doc.nonPlainTextDocumentContent || []).map((x) => [x.sectionTitle, x.text, ...(x.tableColumnHeaders || []), ...(x.tableRows || []).map((row) => row.join(' | '))].filter(Boolean).join('\n')).join('\n\n');
}

const share = (found, all) => (all ? `${Math.round((100 * found) / all)}%`.padStart(4) : '   -');

// How much of the true text is in the stored text: { all: [found, total], accented: [found, total], lost: [...] }.
// Words as plain runs of letters and digits: a number written 486.500.000 counts as 486, 500 and 000 on both
// sides, so the rows of a table that follow each other are not read as one long number.
const words = (s) => new Set(plain(s).match(/[\p{L}\p{N}]+/gu) || []);
function recall(trueWords, stored) {
  const have = words(stored);
  const want = [...words(trueWords.join('\n'))];
  const accented = want.filter((w) => /[^\x00-\x7f]/.test(w));
  return { all: [want.filter((w) => have.has(w)).length, want.length], accented: [accented.filter((w) => have.has(w)).length, accented.length], lost: want.filter((w) => !have.has(w)) };
}

async function passages(source, variants, question) {
  const r = await runtime.send(new RetrieveCommand({ knowledgeBaseId: source.kb, retrievalQuery: { text: question }, retrievalConfiguration: { managedSearchConfiguration: { numberOfResults: 5,
    filter: { andAll: [{ equals: { key: '_data_source_id', value: source.id } }, { in: { key: 'lab_variant', value: variants } }] } } } }));
  return r.retrievalResults.map((x) => ({ text: [x.content?.text, x.metadata?._table_description].filter(Boolean).join('\n'), variant: x.metadata?.lab_variant, file: x.metadata?.lab_file }));
}

async function answer(question, found) {
  const response = await models.send(new ConverseCommand({ modelId: CHAT_MODEL,
    system: [{ text: 'Trả lời câu hỏi bằng tiếng Việt, chỉ dựa trên các đoạn trích được cung cấp. Nếu các đoạn trích không có thông tin, trả lời đúng một câu: "Không có thông tin".' }],
    messages: [{ role: 'user', content: [{ text: `${found.map((p, i) => `[${i + 1}] ${p.text}`).join('\n\n')}\n\nCâu hỏi: ${question}` }] }],
    inferenceConfig: { maxTokens: 600, temperature: 0 } }));
  return (response.output?.message?.content || []).map((b) => b.text || '').join('');
}

async function measure() {
  const source = lab();
  if (!source.id) throw new Error(`no data source ${SOURCE}: run up first`);
  const states = await listed(source);
  const trueWords = truth();
  const all = atoms().filter((a) => states.has(a.id));
  const stored = new Map();
  for (const a of all) stored.set(a.id, await storedText(source, a.id).catch((error) => `(${error.name})`));
  const result = { at: new Date().toISOString(), baseline: [], treatments: [], probes: [] };

  console.log('\nBaseline: the file as it is. Stored text against the true text (all words, words with accents)');
  for (const a of all.filter((x) => x.variant === 'original' && x.kind !== 'probe')) {
    const r = recall(trueWords[a.file] || [], stored.get(a.id) || '');
    result.baseline.push({ file: a.file, kind: a.kind, state: states.get(a.id).status, all: r.all, accented: r.accented, lost: r.lost.slice(0, 40) });
    console.log(`${a.kind.padEnd(5)} ${a.file.padEnd(32)} ${states.get(a.id).status.padEnd(13)} ${share(...r.all)} ${share(...r.accented)}  ${r.lost.length ? `lost: ${r.lost.slice(0, 8).join(' ')}` : ''}`);
  }
  for (const a of all.filter((x) => x.kind === 'probe')) {
    const text = stored.get(a.id) || '';
    const read = ['340', 'ERR-GLS-4471'].filter((fact) => holds(text, fact));
    result.probes.push({ file: a.file, state: states.get(a.id).status, pictureFacts: read, characters: text.length });
    console.log(`probe ${a.file.padEnd(32)} ${states.get(a.id).status.padEnd(13)} picture text read: ${read.join(', ') || 'none'} (${text.length} characters stored)`);
  }

  for (const [kind, treatments] of Object.entries(TREATMENTS)) {
    console.log(`\n${kind}: treatments (text all / accented, facts in the top passages, right answers)`);
    const files = fixtures.filter((f) => kindOf(f) === kind);
    const cases = manifest.cases.filter((c) => files.includes(c.file));
    for (const treatment of treatments) {
      const present = files.every((f) => treatment.every((v) => all.some((a) => a.file === f && a.variant === v)));
      if (!present) {
        console.log(`${treatment.join(' + ').padEnd(24)} not sent`);
        continue;
      }
      const totals = { all: [0, 0], accented: [0, 0] };
      const lost = [];
      for (const f of files) {
        const text = treatment.map((v) => stored.get(all.find((a) => a.file === f && a.variant === v).id) || '').join('\n');
        const r = recall(trueWords[f] || [], text);
        for (const k of ['all', 'accented']) for (const i of [0, 1]) totals[k][i] += r[k][i];
        lost.push(...r.lost);
      }
      const variants = treatment.map((v) => `${kind}-${v}`);
      const rows = [];
      for (const c of cases) {
        const found = await passages(source, variants, c.question);
        const inPassages = !missing(found.filter((p) => p.file === c.file).map((p) => p.text).join('\n'), c.expect).length;
        const said = found.length ? await answer(c.question, found) : '';
        rows.push({ id: c.id, part: c.part, passages: inPassages, answer: !missing(said, c.expect).length, said: said.slice(0, 300) });
      }
      const failed = rows.filter((r) => !r.answer).map((r) => `${r.id} (${r.part})`);
      result.treatments.push({ kind, treatment, text: totals, lost: [...new Set(lost)].slice(0, 40), cases: rows });
      console.log(`${treatment.join(' + ').padEnd(24)} ${share(...totals.all)} ${share(...totals.accented)}  passages ${rows.filter((r) => r.passages).length}/${rows.length}  answers ${rows.filter((r) => r.answer).length}/${rows.length}`
        + `${failed.length ? `  failed: ${failed.join(', ')}` : ''}${lost.length ? `  lost words: ${[...new Set(lost)].slice(0, 6).join(' ')}` : ''}`);
    }
  }
  mkdirSync(join(ROOT, 'eval', 'out'), { recursive: true });
  writeFileSync(join(ROOT, 'eval', 'out', 'preprocess-lab.json'), JSON.stringify(result, null, 2));
  mkdirSync(join(LAB, 'stored'), { recursive: true });
  for (const a of all) writeFileSync(join(LAB, 'stored', `${a.kind}-${a.variant}--${a.file}.txt`), stored.get(a.id) || '');
  console.log('\nresults: eval/out/preprocess-lab.json; the stored text of every document: eval/out/lab/stored/');
}

// The text counts again, from the stored text measure kept (eval/out/lab/stored/): no call to AWS.
async function recount() {
  const file = join(ROOT, 'eval', 'out', 'preprocess-lab.json');
  const result = JSON.parse(readFileSync(file, 'utf8'));
  const trueWords = truth();
  const stored = (kind, variant, f) => {
    const path = join(LAB, 'stored', `${kind}-${variant}--${f}.txt`);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  };
  console.log('Baseline: the file as it is. Stored text against the true text (all words, words with accents)');
  for (const row of result.baseline) {
    const r = recall(trueWords[row.file] || [], stored(row.kind, 'original', row.file));
    Object.assign(row, { all: r.all, accented: r.accented, lost: r.lost.slice(0, 40) });
    console.log(`${row.kind.padEnd(5)} ${row.file.padEnd(32)} ${share(...r.all)} ${share(...r.accented)}  ${r.lost.length ? `lost: ${r.lost.slice(0, 8).join(' ')}` : ''}`);
  }
  let kind;
  for (const row of result.treatments) {
    if (row.kind !== kind) console.log(`\n${kind = row.kind}: treatments (text all / accented, facts in the top passages, right answers)`);
    const totals = { all: [0, 0], accented: [0, 0] };
    const lost = [];
    for (const f of fixtures.filter((x) => kindOf(x) === row.kind)) {
      const r = recall(trueWords[f] || [], row.treatment.map((v) => stored(row.kind, v, f)).join('\n'));
      for (const k of ['all', 'accented']) for (const i of [0, 1]) totals[k][i] += r[k][i];
      lost.push(...r.lost);
    }
    Object.assign(row, { text: totals, lost: [...new Set(lost)].slice(0, 40) });
    console.log(`${row.treatment.join(' + ').padEnd(24)} ${share(...totals.all)} ${share(...totals.accented)}  passages ${row.cases.filter((c) => c.passages).length}/${row.cases.length}  answers ${row.cases.filter((c) => c.answer).length}/${row.cases.length}`
      + `${lost.length ? `  lost words: ${[...new Set(lost)].slice(0, 6).join(' ')}` : ''}`);
  }
  writeFileSync(file, JSON.stringify(result, null, 2));
}

// ---------- the readers: which model in the Region reads a picture or a scanned page best

// Every model with image input that answers on demand in the Region reads the two pictures and the two scanned
// pages; Textract reads them too; and the two scanned pdf files go to a model as a document. Nothing is sent to
// the knowledge base: the transcript is compared with the true words here.
async function readers() {
  const trueWords = truth();
  const listed = aws(['bedrock', 'list-foundation-models', '--query',
    "modelSummaries[?contains(inputModalities, 'IMAGE') && contains(outputModalities, 'TEXT') && contains(inferenceTypesSupported, 'ON_DEMAND')].modelId"]);
  const pictures = [];
  for (const name of fixtures) {
    const bytes = readFileSync(join(FILES, name));
    if (kindOf(name) === 'png') pictures.push({ name, bytes, prompt: READ_PICTURE });
    if (kindOf(name) === 'scan') pictures.push({ name, bytes: (await pdfPages(bytes))[0].pictures[0], prompt: READ_PAGE, pdf: bytes });
  }
  const rows = [];
  const report = (label, results) => {
    const sum = (k, i) => results.reduce((n, r) => n + (r.recall ? r.recall[k][i] : 0), 0);
    const ok = results.filter((r) => r.recall);
    const failed = results.find((r) => r.error);
    rows.push({ reader: label, files: results.length, read: ok.length, all: [sum('all', 0), sum('all', 1)], accented: [sum('accented', 0), sum('accented', 1)],
      seconds: ok.length ? Math.round(ok.reduce((n, r) => n + r.ms, 0) / ok.length / 100) / 10 : null,
      tokens: [ok.reduce((n, r) => n + (r.usage?.inputTokens || 0), 0), ok.reduce((n, r) => n + (r.usage?.outputTokens || 0), 0)], error: failed?.error, texts: results.map((r) => ({ file: r.file, text: r.text })) });
    console.log(`${label.padEnd(42)} ${ok.length}/${results.length} read  ${ok.length ? `${share(sum('all', 0), sum('all', 1))} ${share(sum('accented', 0), sum('accented', 1))}  ${String(rows.at(-1).seconds).padStart(5)} s  tokens ${rows.at(-1).tokens.join(' in, ')} out` : ''}`
      + `${failed ? `  ${failed.error}` : ''}`);
  };
  const converse = async (model, content) => {
    const started = Date.now();
    const response = await models.send(new ConverseCommand({ modelId: model, messages: [{ role: 'user', content }], inferenceConfig: { maxTokens: 2000, temperature: 0 } }));
    return { text: (response.output?.message?.content || []).map((b) => b.text || '').join('').trim(), usage: response.usage, ms: Date.now() - started };
  };
  const attempt = async (file, run) => {
    try {
      const r = await run();
      return { file, ...r, recall: recall(trueWords[file] || [], r.text) };
    } catch (error) {
      return { file, error: `${error.name}: ${String(error.message).replace(/\d{12}/g, '<acct>').slice(0, 110)}` };
    }
  };
  console.log('\nReaders of the 2 pictures and the 2 scanned pages (true words read: all, with accents; mean time; tokens)');
  for (const model of listed.sort()) {
    const results = [];
    for (const p of pictures) results.push(await attempt(p.name, () => converse(model, [{ image: { format: 'png', source: { bytes: p.bytes } } }, { text: p.prompt }])));
    report(model, results);
  }
  const textract = [];
  for (const p of pictures) {
    textract.push(await attempt(p.name, async () => {
      const started = Date.now();
      const out = aws(['textract', 'detect-document-text', '--document', file('textract.json', { Bytes: p.bytes.toString('base64') })]);
      return { text: (out.Blocks || []).filter((b) => b.BlockType === 'LINE').map((b) => b.Text).join('\n'), ms: Date.now() - started };
    }));
  }
  report('Amazon Textract (DetectDocumentText)', textract);
  console.log('\nThe 2 scanned pdf files given to a model as a document');
  for (const model of [VISION.nova, VISION.qwen]) {
    const results = [];
    for (const p of pictures.filter((x) => x.pdf)) results.push(await attempt(p.name, () => converse(model, [{ document: { format: 'pdf', name: 'scan', source: { bytes: p.pdf } } }, { text: READ_PAGE }])));
    report(`${model} (pdf document)`, results);
  }
  mkdirSync(join(ROOT, 'eval', 'out'), { recursive: true });
  writeFileSync(join(ROOT, 'eval', 'out', 'preprocess-readers.json'), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  console.log('\nresults and transcripts: eval/out/preprocess-readers.json');
}

const run = { build, up, measure, recount, down, readers }[process.argv[2]];
if (!run) {
  console.error('usage: node scripts/preprocess-lab.mjs build|up|measure|recount|down|readers');
  process.exit(2);
}
run().catch((error) => {
  console.error(String(error.message || error).replace(/\d{12}/g, '<acct>'));
  process.exit(1);
});
