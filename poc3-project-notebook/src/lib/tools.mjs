// The reading tools behind the MCP server (mcp.mjs) and the web UI's agent and research modes (agent.mjs): search,
// list_sources, list_documents, get_document, and two that compute instead of retrieve: query_jira (a live JQL
// query, for exact counts and complete lists) and query_table (filter, count and sum on a table of a document).
// `ids` are the source ids this call may read; nothing outside them is reachable, whatever the model or the MCP
// client passes. Inside a source, a document restricted to other people answers as if it did not exist (acl.mjs).

import { search, listSources, documents, documentText, documentParts, mayRead, visible, titleOf } from './kb.mjs';
import { guard } from './acl.mjs';
import { queryJira, COUNT_BY } from './jira.mjs';
import { tablesOf, queryTable, describe, fold } from './tables.mjs';

export const READ_TOOLS = [
  {
    name: 'search',
    description: 'Search the project documents (Confluence pages, Jira issues and the files attached to them) the user may read. Returns the best passages with their document title, link and source. Use it to find facts, requirements, specs or decisions.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'What to look for, in any language' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Optional source names from list_sources' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
    }, required: ['query'] },
  },
  {
    name: 'list_sources',
    description: 'List the document sources (Confluence spaces, Jira projects) the user may read, with their last sync.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_documents',
    description: 'List the documents of one source, completely: title, kind, last change, link, and for a file the page or issue it is attached to (parent). Use the filters to answer "which files are attached to page X" or "how many PDF files". The result gives the exact total. Pass a link to get_document.',
    inputSchema: { type: 'object', properties: {
      source: { type: 'string', description: 'A source name from list_sources' },
      kind: { type: 'string', description: 'Optional: page, blogpost, attachment (every attached file), issue, or a file extension such as pdf, xlsx, docx' },
      title_contains: { type: 'string', description: 'Optional: only documents whose title contains this text' },
      parent: { type: 'string', description: 'Optional: only the files attached to the page or issue whose title (or issue key) contains this text' },
    }, required: ['source'] },
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
    name: 'query_jira',
    description: `Ask Jira itself, now, with a JQL query: the exact number of matching issues, the complete list, and counts per group. Use it for "how many", "list all", "who has the most", "which issues are open / overdue / in version X" — questions a search cannot answer because it returns only the closest passages. The query is limited to the projects of the user's Jira sources; do not add a project clause unless you want fewer projects. Examples: statusCategory != Done · assignee is EMPTY AND priority in (High, Highest) · fixVersion = "2.0" ORDER BY priority DESC · duedate < now() AND statusCategory != Done · text ~ "thanh toán".`,
    inputSchema: { type: 'object', properties: {
      jql: { type: 'string', description: 'The JQL condition, with an optional ORDER BY. Empty for every issue.' },
      count_by: { type: 'string', description: `Optional: also count the matching issues per ${Object.keys(COUNT_BY).join(', ')}` },
      limit: { type: 'integer', default: 50, maximum: 200, description: 'How many issues to list (the total and the counts always cover all of them)' },
      source: { type: 'string', description: 'Optional: one Jira source name from list_sources; by default every Jira source the user may read' },
    }, required: ['jql'] },
  },
  {
    name: 'query_table',
    description: 'Compute on a table inside one document (a spreadsheet, a CSV file, a table of a page, of a Word or PDF file): filter rows, count, sum, average, group. Use it instead of counting rows yourself. Call it first with only source and link to see the tables and their columns, then with a table number and the question.',
    inputSchema: { type: 'object', properties: {
      source: { type: 'string' }, link: { type: 'string', description: 'The document link from list_documents or search' },
      table: { type: 'integer', description: 'The table number, from the first call' },
      filter: { type: 'array', items: { type: 'string' }, description: 'Conditions that must all hold, each "Column op value" with op one of =, !=, >, >=, <, <=, contains, not contains. Example: ["Status = Done", "Amount >= 1000"]' },
      group_by: { type: 'string', description: 'A column: one line per distinct value' },
      aggregate: { type: 'string', description: '"count" (the default with group_by), or "sum:Column", "avg:Column", "min:Column", "max:Column"' },
      columns: { type: 'array', items: { type: 'string' }, description: 'When listing rows: the columns to show (all by default)' },
      limit: { type: 'integer', default: 100, maximum: 500, description: 'When listing rows: how many' },
    }, required: ['source', 'link'] },
  },
];

// Why an input does not fit a tool's schema, or '' when it does. A streamed tool input is not checked by the API,
// and its parser can hand over a cut-off object, so the agent mode checks before it runs a tool.
export function invalid(tool, input) {
  const { properties, required = [] } = tool.inputSchema;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'the input must be an object';
  const unknown = Object.keys(input).filter((k) => !properties[k]);
  if (unknown.length) return `unknown parameter ${unknown.join(', ')}; ${tool.name} takes ${Object.keys(properties).join(', ') || 'no parameter'}`;
  const missing = required.filter((k) => input[k] === undefined || (input[k] === '' && k !== 'jql'));
  if (missing.length) return `missing ${missing.join(', ')}`;
  for (const [k, v] of Object.entries(input)) {
    const type = properties[k].type;
    const ok = type === 'string' ? typeof v === 'string'
      : type === 'integer' ? Number.isInteger(v)
        : type === 'array' ? Array.isArray(v) && v.every((x) => typeof x === 'string') : true;
    if (!ok) return `${k} must be ${type === 'array' ? 'an array of strings' : `a ${type}`}`;
  }
  return '';
}

const MISSING = 'This document is not in the knowledge base (not synced yet, or it failed to index)';
const LIST_MAX = 300;
const ATTACHED = new Set(['page', 'blogpost', 'issue']);

// Returns { passages } for search, { value } for the two lists, { document } for get_document and { records }
// for the two queries: each record { source, uri, title, text, key, live?, closed? } is a computed result the
// answer can cite like a document.
export async function readTool(name, args, { ids, userId, syncOf }) {
  const readable = (await listSources()).filter((s) => ids.includes(s.id));
  const sourceByName = (n) => readable.find((s) => s.name === n || s.id === n || s.title === n);
  const source = (n) => {
    const s = sourceByName(n);
    if (!s) throw new Error('Unknown source, or you may not read it. See list_sources.');
    return s;
  };
  switch (name) {
    case 'search': {
      const scope = Array.isArray(args.sources) && args.sources.length ? args.sources.map((n) => source(n).id) : ids;
      return { passages: await search(String(args.query || ''), scope, { n: Math.min(Math.max(Number(args.limit) || 8, 1), 20), userId }) };
    }
    case 'list_sources':
      return { value: await Promise.all(readable.map(async (s) => ({ name: s.name, title: s.title, type: s.type, lastSync: await syncOf(s.id) }))) };
    case 'list_documents': {
      const s = source(args.source);
      let list = await visible(userId, s, await documents(s));
      const kind = fold(args.kind);
      if (kind) list = list.filter((d) => (kind === 'attachment' ? !ATTACHED.has(d.kind) : fold(d.kind) === kind || fold(d.title).endsWith(`.${kind}`)));
      if (args.title_contains) list = list.filter((d) => fold(d.title).includes(fold(args.title_contains)));
      if (args.parent) list = list.filter((d) => d.parent && fold(d.parent).includes(fold(args.parent)));
      return { value: { total: list.length, shown: Math.min(list.length, LIST_MAX),
        documents: list.slice(0, LIST_MAX).map((d) => ({ title: d.title, kind: d.kind, modified: d.modified, link: d.uri, ...(d.parent && { parent: d.parent }) })) } };
    }
    case 'get_document': {
      const s = source(args.source);
      const uri = String(args.link);
      if (!(await mayRead(userId, s, uri))) throw new Error(MISSING);
      const body = await documentText(s, { uri });
      const max = Math.min(Math.max(Number(args.max_chars) || 30000, 1000), 100000);
      return { document: { source: s, uri, text: body.slice(0, max), total: body.length, cut: body.length > max ? max : 0 } };
    }
    case 'query_jira': {
      const targets = args.source ? [source(args.source)] : readable.filter((s) => s.type === 'JIRA');
      if (!targets.length || targets.some((s) => s.type !== 'JIRA')) throw new Error('query_jira needs a Jira source the user may read. See list_sources.');
      const acl = await guard(userId, targets.map((s) => s.id));
      const records = await Promise.all(targets.map(async (s) => {
        const out = await queryJira(s, { jql: String(args.jql || ''), countBy: args.count_by, limit: args.limit,
          hides: (uri) => acl.hides(s.id, uri), restricted: (uri) => acl.restricted(s.id, uri) });
        return { ...out, source: s, live: true, key: `jira|${s.id}|${args.jql}|${args.count_by || ''}|${args.limit || ''}` };
      }));
      return { records };
    }
    case 'query_table': {
      const s = source(args.source);
      const uri = String(args.link);
      if (!(await mayRead(userId, s, uri))) throw new Error(MISSING);
      const name2 = titleOf(uri);
      const tables = tablesOf(await documentParts(s, { uri }), name2);
      if (!tables.length) throw new Error('No table was found in this document. Read it with get_document.');
      const { source: _s, link: _l, table: n, ...question } = args;
      const asks = Object.keys(question).length > 0;
      let table = n ? tables.find((t) => t.n === n) : tables.length === 1 && asks ? tables[0] : null;
      if (n && !table) throw new Error(`No table ${n} in this document.\n${describe(tables)}`);
      if (!table && asks) throw new Error(`This document has ${tables.length} tables: say which with "table".\n${describe(tables)}`);
      const text = table
        ? `Table ${table.n}${table.title ? ` (${table.title})` : ''} of ${name2}, computed on all its ${table.rows.length} rows.\n${queryTable(table, question)}`
        : `${name2} has ${tables.length} table${tables.length > 1 ? 's' : ''}:\n${describe(tables)}${tables.length === 1 ? `\n\n${queryTable(tables[0], { limit: 20 })}` : ''}`;
      return { records: [{ source: s, uri, title: `${name2}${table ? ` — table ${table.n}` : ''}`, text, key: `table|${uri}|${JSON.stringify([n, question])}` }] };
    }
    default:
      throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
  }
}
