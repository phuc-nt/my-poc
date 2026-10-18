import { HttpError, readJson, sendError, sendJson } from './http.js';
import { createTicket, getTicket } from './tickets.js';

export function createHandler(db) {
  const routes = [
    ['GET', /^\/health$/, async () => ({ status: 200, body: { ok: true } })],
    ['GET', /^\/products$/, async () => {
      const { rows } = await db.query('SELECT code, name, kind, price_vnd FROM products');
      return { status: 200, body: rows.map((r) => ({ code: r.code, name: r.name, kind: r.kind, priceVnd: r.price_vnd })) };
    }],
    ['GET', /^\/devices\/([^/]+)$/, async (req, [serial]) => {
      const { rows } = await db.query(
        'SELECT d.serial, d.product_code, d.purchase_date, p.name FROM devices d JOIN products p ON p.code = d.product_code WHERE d.serial = $1',
        [serial],
      );
      if (!rows.length) throw new HttpError(404, 'not_found', `Device ${serial} not found`);
      const r = rows[0];
      return { status: 200, body: { serial: r.serial, productCode: r.product_code, productName: r.name, purchaseDate: toDate(r.purchase_date) } };
    }],
    ['POST', /^\/tickets$/, async (req) => ({ status: 201, body: await createTicket(db, await readJson(req)) })],
    ['GET', /^\/tickets\/(\d+)$/, async (req, [id]) => ({ status: 200, body: await getTicket(db, Number(id)) })],
  ];

  return async function handle(req, res) {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      for (const [method, pattern, run] of routes) {
        const match = pattern.exec(path);
        if (match && req.method === method) {
          const { status, body } = await run(req, match.slice(1).map(decodeURIComponent));
          return sendJson(res, status, body);
        }
      }
      throw new HttpError(404, 'not_found', `No route for ${req.method} ${path}`);
    } catch (error) {
      if (!(error instanceof HttpError)) process.stderr.write(`${error.stack}\n`);
      sendError(res, error);
    }
  };
}

function toDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}
