// The MCP server for local agents (Claude Code, Kiro): Streamable HTTP without sessions. Each POST carries one
// JSON-RPC message (or a batch) and gets a JSON reply; notifications get 202. The caller signs in with a personal
// access token, and every tool only sees the sources that user may read.

import { answer } from './answer.mjs';
import { listSources } from './kb.mjs';
import { READ_TOOLS, readTool } from './tools.mjs';
import { record } from './usage.mjs';

const PROTOCOL = '2025-06-18';

const [SEARCH, ...READ] = READ_TOOLS;

const TOOLS = [
  { ...SEARCH, inputSchema: { ...SEARCH.inputSchema, properties: {
    query: SEARCH.inputSchema.properties.query,
    notebook: { type: 'string', description: 'Optional notebook id or name: search only its sources' },
    sources: SEARCH.inputSchema.properties.sources,
    limit: SEARCH.inputSchema.properties.limit,
  } } },
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
  ...READ,
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
  const read = (ids, input = args) => readTool(name, input, { ids, userId: ctx.user.email, syncOf: ctx.syncOf });
  switch (name) {
    case 'search': {
      // scope() has already narrowed the sources to the notebook and to the names asked for.
      const { passages } = await read(await ctx.scope(args), { query: args.query, limit: args.limit });
      if (!passages.length) return text('No passage matched. Try other words, or check list_sources.');
      return text(passages.map((p, i) => `[${i + 1}] ${p.title} — ${p.sourceTitle}${p.page ? `, page ${p.page}` : ''}\n${p.uri}\n${p.text.trim()}`).join('\n\n---\n\n'));
    }
    case 'ask': {
      const ids = await ctx.scope(args);
      const result = await answer({ question: String(args.question || ''), allowed: ids, mode: args.mode === 'deep' ? 'deep' : 'fast', lang: args.lang, emit: () => {}, userId: ctx.user.email });
      const refs = result.citations.map((c) => `[${c.n}] ${c.title}${c.page ? `, page ${c.page}` : ''} — ${c.uri}`).join('\n');
      return text(`${result.answer}\n\nSources:\n${refs || '(none)'}`);
    }
    case 'list_sources':
    case 'list_documents':
      return text((await read(await ctx.allowed())).value);
    case 'get_document': {
      const { document: d } = await read(await ctx.allowed());
      return text(d.cut ? `${d.text}\n\n[cut at ${d.cut} of ${d.total} characters]` : d.text);
    }
    case 'query_jira':
    case 'query_table': {
      const { records } = await read(await ctx.allowed());
      return text(records.map((r) => `${r.title} — ${r.source.title}\n${r.uri}\n\n${r.text}`).join('\n\n---\n\n'));
    }
    case 'list_notebooks': {
      const sources = await listSources();
      return text((await ctx.notebooks()).map((n) => ({ id: n.id, name: n.name, sources: n.sources.map((id) => sources.find((s) => s.id === id)?.name).filter(Boolean) })));
    }
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
          instructions: 'Search and ask the project\'s Confluence and Jira documents. Start with list_sources or search; use ask for a written answer with citations.',
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
