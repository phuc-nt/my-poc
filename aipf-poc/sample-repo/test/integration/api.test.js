// Runs the API against the database in DATABASE_URL (migrated and seeded: npm run db:migrate && npm run db:seed).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createHandler } from '../../src/app.js';
import { createPool } from '../../src/db.js';

let db;
let server;
let base;

before(async () => {
  db = createPool();
  await db.query('TRUNCATE tickets RESTART IDENTITY');
  server = createServer(createHandler(db));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.end();
});

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('GET /health', async () => {
  assert.deepEqual(await call('GET', '/health'), { status: 200, body: { ok: true } });
});

test('GET /products lists the seeded products', async () => {
  const { status, body } = await call('GET', '/products');
  assert.equal(status, 200);
  assert.equal(body.length, 8);
  assert.ok(body.find((p) => p.code === 'M3' && p.priceVnd === 2790000));
});

test('GET /devices/:serial returns the device with its product', async () => {
  const { status, body } = await call('GET', '/devices/C5-0001');
  assert.equal(status, 200);
  assert.deepEqual(body, { serial: 'C5-0001', productCode: 'C5', productName: 'ML Cam C5', purchaseDate: '2025-11-02' });
});

test('GET /devices/:serial gives 404 for an unknown serial', async () => {
  const { status, body } = await call('GET', '/devices/NOPE');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'not_found');
});

test('POST /tickets creates a ticket and GET /tickets/:id reads it back', async () => {
  const created = await call('POST', '/tickets', { serial: 'L9-0001', issue: 'Fingerprint not recognised' });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'open');
  const read = await call('GET', `/tickets/${created.body.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, created.body);
});

test('POST /tickets rejects a missing issue', async () => {
  const { status, body } = await call('POST', '/tickets', { serial: 'L9-0001' });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'invalid_input');
});
