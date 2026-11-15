// Tables inside a document, and exact questions on them: filter, count, sum, group. A model that reads a table
// of some hundred rows miscounts; here the rows are counted by code and the model only chooses the question.
//
// A table comes from three places: a table element of a parsed file (a spreadsheet, a Word table), a Markdown
// pipe table in a text (a page, a text document made by the preparation step), or a CSV or TSV file as a whole.

export const fold = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').trim();

const MAX_ROWS = 20_000;

function csvRows(text, sep) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) break;
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const pipeCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

// Markdown pipe tables of a text, each with the last heading or line before it as its title.
function pipeTables(text) {
  const out = [];
  const lines = String(text).split('\n');
  let before = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('|') && i + 1 < lines.length && isRule(lines[i + 1]) && lines[i + 1].includes('-')) {
      const rows = [pipeCells(line)];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) rows.push(pipeCells(lines[j++]));
      out.push({ title: before, rows });
      i = j - 1;
    } else if (line.trim()) before = line.trim().replace(/^#+\s*/, '').slice(0, 120);
  }
  return out;
}

// The tables of a document. content: { text } or { elements } as kb.mjs documentParts returns; name: the file name.
// Each: { n, title, header: [column], rows: [[cell]] }.
export function tablesOf(content, name = '') {
  let found = [];
  if (content.elements) {
    let before = '';
    for (const x of content.elements) {
      if (x.tableRows?.length) found.push({ title: before, rows: x.tableRows.map((r) => r.map((c) => String(c ?? '').trim())) });
      else if (x.text?.trim()) {
        const inner = pipeTables(x.text);
        found.push(...inner);
        before = x.text.trim().split('\n').pop().replace(/^#+\s*/, '').slice(0, 120);
      }
    }
  } else if (/\.(csv|tsv)$/i.test(name)) {
    const sep = /\.tsv$/i.test(name) ? '\t' : (content.text.split('\n')[0].split(';').length > content.text.split('\n')[0].split(',').length ? ';' : ',');
    found = [{ title: name, rows: csvRows(content.text || '', sep) }];
  } else found = pipeTables(content.text || '');
  return found.filter((t) => t.rows.length >= 2 && t.rows[0].length >= 1).map((t, i) => {
    const width = Math.max(...t.rows.slice(0, 200).map((r) => r.length));
    const seen = new Map();
    const header = Array.from({ length: width }, (_, c) => {
      const base = String(t.rows[0][c] ?? '').replace(/\s+/g, ' ').trim() || `col ${c + 1}`;
      seen.set(base, (seen.get(base) || 0) + 1);
      return seen.get(base) > 1 ? `${base} (${seen.get(base)})` : base;
    });
    return { n: i + 1, title: t.title, header, rows: t.rows.slice(1, MAX_ROWS + 1).map((r) => Array.from({ length: width }, (_, c) => String(r[c] ?? '').trim())) };
  });
}

// A number as people write it: 1,234.5 and 1.234,5 and 12% and 1 200 đ. NaN when the cell is not one.
export function numberOf(cell) {
  let s = String(cell ?? '').replace(/[\s %₫đ$€¥£]|vnd|usd|jpy/gi, '');
  if (/^\(.*\)$/.test(s)) s = `-${s.slice(1, -1)}`;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (/^-?\d+,\d+$/.test(s)) return Number(s.replace(',', '.'));
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return NaN;
}

function column(table, name) {
  const want = fold(name);
  let at = table.header.findIndex((h) => fold(h) === want);
  if (at < 0) {
    const close = table.header.map((h, i) => [h, i]).filter(([h]) => fold(h).includes(want));
    if (close.length === 1) at = close[0][1];
  }
  if (at < 0) throw new Error(`No column "${name}" in this table. Its columns: ${table.header.join(' | ')}`);
  return at;
}

const OPS = ['not contains', 'contains', '>=', '<=', '!=', '=', '>', '<'];

// "Status = Done", "Amount >= 1000", "Owner contains an": a test of one row.
function condition(table, text) {
  const s = String(text);
  for (const op of OPS) {
    // The column is the text before the first operator that leaves a known column on its left.
    let from = 0;
    for (;;) {
      const i = s.toLowerCase().indexOf(op, from);
      if (i < 0) break;
      const left = s.slice(0, i).trim();
      let at = -1;
      try { at = left ? column(table, left) : -1; } catch { /* not a column: try the next place */ }
      if (at >= 0) {
        const right = s.slice(i + op.length).trim().replace(/^["']|["']$/g, '');
        const num = numberOf(right);
        const text2 = fold(right);
        return (row) => {
          const cell = row[at];
          const n = numberOf(cell);
          const both = !Number.isNaN(n) && !Number.isNaN(num);
          const cmp = both ? n - num : fold(cell).localeCompare(text2);
          switch (op) {
            case 'contains': return fold(cell).includes(text2);
            case 'not contains': return !fold(cell).includes(text2);
            case '=': return both ? n === num : fold(cell) === text2;
            case '!=': return both ? n !== num : fold(cell) !== text2;
            case '>': return cmp > 0;
            case '>=': return cmp >= 0;
            case '<': return cmp < 0;
            default: return cmp <= 0;
          }
        };
      }
      from = i + 1;
    }
  }
  throw new Error(`Cannot read the filter "${s}". Write it as "Column = value", with one of: ${OPS.join(', ')}. Columns: ${table.header.join(' | ')}`);
}

const cellOut = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const markdown = (header, rows) => [`| ${header.map(cellOut).join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cellOut).join(' | ')} |`)].join('\n');
const round = (n) => (Number.isInteger(n) ? n : Math.round(n * 1e4) / 1e4);

// The answer to one question on one table, as text: a count, a sum, the groups, or the matching rows.
export function queryTable(table, { filter = [], group_by: groupBy, aggregate, columns, limit } = {}) {
  const tests = filter.map((f) => condition(table, f));
  const rows = table.rows.filter((row) => tests.every((t) => t(row)));
  const head = `${rows.length} of ${table.rows.length} rows match${filter.length ? ` (${filter.join('; ')})` : ''}.`;
  const [fn, ...rest] = String(aggregate || (groupBy ? 'count' : '')).split(':');
  const how = fn.trim().toLowerCase();
  if (how && !['count', 'sum', 'avg', 'min', 'max'].includes(how)) throw new Error('aggregate is "count", or "sum:Column", "avg:Column", "min:Column", "max:Column"');
  const valueAt = how && how !== 'count' ? column(table, rest.join(':').trim()) : -1;
  const reduce = (list) => {
    if (how === 'count') return { value: list.length, skipped: 0 };
    const nums = list.map((r) => numberOf(r[valueAt]));
    const good = nums.filter((n) => !Number.isNaN(n));
    const value = !good.length ? null : how === 'sum' ? good.reduce((a, b) => a + b, 0) : how === 'avg' ? good.reduce((a, b) => a + b, 0) / good.length : how === 'min' ? Math.min(...good) : Math.max(...good);
    return { value: value === null ? '-' : round(value), skipped: nums.length - good.length };
  };
  const name = how === 'count' ? 'count' : `${how} of ${table.header[valueAt]}`;
  if (groupBy) {
    const at = column(table, groupBy);
    const groups = new Map();
    for (const row of rows) {
      const key = row[at] || '(empty)';
      groups.set(key, [...(groups.get(key) || []), row]);
    }
    let skipped = 0;
    const lines = [...groups].map(([key, list]) => {
      const r = reduce(list);
      skipped += r.skipped;
      return [key, r.value, list.length];
    }).sort((a, b) => (typeof b[1] === 'number' && typeof a[1] === 'number' ? b[1] - a[1] : 0));
    const header = how === 'count' ? [table.header[at], 'count'] : [table.header[at], name, 'rows'];
    return `${head} ${groups.size} groups by ${table.header[at]}.\n\n${markdown(header, lines.map((l) => (how === 'count' ? l.slice(0, 2) : l)))}${skipped ? `\n\n${skipped} cells are not numbers and were left out.` : ''}`;
  }
  if (how) {
    const r = reduce(rows);
    return `${head} ${name}: ${r.value}${r.skipped ? ` (${r.skipped} cells are not numbers and were left out)` : ''}`;
  }
  const max = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const cols = Array.isArray(columns) && columns.length ? columns.map((c) => column(table, c)) : table.header.map((_, i) => i);
  const shown = rows.slice(0, max);
  return `${head}${rows.length > max ? ` The first ${max} follow; narrow the filter or raise limit (500 at most).` : ''}\n\n${markdown(cols.map((i) => table.header[i]), shown.map((r) => cols.map((i) => r[i])))}`;
}

// What a document's tables are, for a call that names no table.
export const describe = (tables) => tables.map((t) => `Table ${t.n}${t.title ? ` (${t.title})` : ''}: ${t.rows.length} rows. Columns: ${t.header.join(' | ')}`).join('\n');
