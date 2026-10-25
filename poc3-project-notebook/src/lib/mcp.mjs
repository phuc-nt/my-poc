// The MCP server for local agents (Claude Code, Kiro): Streamable HTTP without sessions. Each POST carries one
// JSON-RPC message (or a batch) and gets a JSON reply; notifications get 202. The caller signs in with a personal
// access token, and every tool only sees the sources that user may read.

import { answer } from './answer.mjs';
import { search, listSources, documents, documentText } from './kb.mjs';
import { record } from './usage.mjs';

const PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'search',
    description: 'Search the project documents (Confluence and SharePoint) the user may read. Returns the best passages with their document title, link and source. Use it to find facts, requirements, specs or decisions.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'What to look for, in any language' },
      notebook: { type: 'string', description: 'Optional notebook id or name: search only its sources' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Optional source names from list_sources' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
    }, required: ['query'] },
  },
  {
    name: 'ask',
    description: 'Ask a question about the project and get an answer written from the documents, with numbered citations. mode "deep" runs agentic retrieval for broad or multi-part questions (slower).',
    inputSchema: { type: 'object', properties: {
      question: { type: 'string' },
      notebook: { type: 'string', description: 'Optional notebook id or name' },
      sources: { type: 'array', items: { type: 'string' } },
      mode: { type: 'string', enum: ['fast', 'deep'], default: 'fast' },
      lang: { type: 'string', enum: ['vi', 'en', 'ja'], description: 'Answer language; by default the question\'s language' },
    }, required: ['question'] },
  },
  {
    name: 'list_sources',
    description: 'List the document sources (Confluence spaces, SharePoint folders) the user may read, with their last sync.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_documents',
    description: 'List the documents of one source: title, kind, last change and link. Pass the link to get_document.',
    inputSchema: { type: 'object', properties: { source: { type: 'string', description: 'A source name from list_sources' } }, required: ['source'] },
  },
  {
    name: 'get_document',
    description: 'Read the full text of one document, as the knowledge base extracted it. Long documents are cut at max_chars.',
    inputSchema: { type: 'object', properties: {
      source: { type: 'string' }, link: { type: 'string', description: 'The document link from list_documents or search' },
      max_chars: { type: 'integer', default: 30000, maximum: 100000 },
    }, required: ['source', 'link'] },
  },
  {
    name: 'list_notebooks',
    description: 'List the user\'s notebooks (named groups of sources) to scope search and ask.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

// ctx: { user, allowed(): ids, scope({ notebook, sources }): ids, notebooks(), syncOf(id) }
async function callTool(name, args, ctx) {
  await record({ mcpCalls: 1 });
  const sources = await listSources();
  const allowed = await ctx.allowed();
  const readable = sources.filter((s) => allowed.includes(s.id));
  const sourceByName = (n) => readable.find((s) => s.name === n || s.id === n || s.title === n);
  switch (name) {
    case 'search': {
      const ids = await ctx.scope(args);
      const found = await search(String(args.query || ''), ids, { n: Math.min(Number(args.limit) || 8, 20), userId: ctx.user.email });
      if (!found.length) return text('No passage matched. Try other words, or check list_sources.');
      return text(found.map((p, i) => `[${i + 1}] ${p.title} — ${p.sourceTitle}${p.page ? `, page ${p.page}` : ''}\n${p.uri}\n${p.text.trim()}`).join('\n\n---\n\n'));
    }
    case 'ask': {
      const ids = await ctx.scope(args);
      const result = await answer({ question: String(args.question || ''), allowed: ids, mode: args.mode === 'deep' ? 'deep' : 'fast', lang: args.lang, emit: () => {}, userId: ctx.user.email });
      const refs = result.citations.map((c) => `[${c.n}] ${c.title}${c.page ? `, page ${c.page}` : ''} — ${c.uri}`).join('\n');
      return text(`${result.answer}\n\nSources:\n${refs || '(none)'}`);
    }
    case 'list_sources':
      return text(await Promise.all(readable.map(async (s) => ({ name: s.name, title: s.title, type: s.type, lastSync: await ctx.syncOf(s.id) }))));
    case 'list_documents': {
      const s = sourceByName(args.source);
      if (!s) throw new Error('Unknown source, or you may not read it. See list_sources.');
      return text((await documents(s)).map((d) => ({ title: d.title, kind: d.kind, modified: d.modified, link: d.uri })));
    }
    case 'get_document': {
      const s = sourceByName(args.source);
      if (!s) throw new Error('Unknown source, or you may not read it. See list_sources.');
      const body = await documentText(s, { uri: String(args.link) });
      const max = Math.min(Number(args.max_chars) || 30000, 100000);
      return text(body.length > max ? `${body.slice(0, max)}\n\n[cut at ${max} of ${body.length} characters]` : body);
    }
    case 'list_notebooks':
      return text((await ctx.notebooks()).map((n) => ({ id: n.id, name: n.name, sources: n.sources.map((id) => sources.find((s) => s.id === id)?.name).filter(Boolean) })));
    default:
      throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
  }
}

async function one(message, ctx) {
  const { id, method, params = {} } = message;
  if (id === undefined || id === null) return null; // a notification
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  try {
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params.protocolVersion || PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'project-notebook', title: 'Project Notebook', version: '0.1.0' },
          instructions: 'Search and ask the project\'s Confluence and SharePoint documents. Start with list_sources or search; use ask for a written answer with citations.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call':
        try {
          return reply(await callTool(params.name, params.arguments || {}, ctx));
        } catch (error) {
          if (error.code) throw error;
          return reply({ ...text(`Error: ${error.message}`), isError: true });
        }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (error) {
    return { jsonrpc: '2.0', id, error: { code: error.code || -32603, message: error.message } };
  }
}

// Returns { status, body } for one POST body.
export async function handleMcp(body, ctx) {
  let message;
  try {
    message = JSON.parse(body || '');
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(message)) {
    const replies = (await Promise.all(message.map((m) => one(m, ctx)))).filter(Boolean);
    return replies.length ? { status: 200, body: replies } : { status: 202 };
  }
  const reply = await one(message, ctx);
  return reply ? { status: 200, body: reply } : { status: 202 };
}
