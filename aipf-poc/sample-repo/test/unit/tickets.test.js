import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../../src/http.js';
import { formatTicketNo, validateTicketInput } from '../../src/tickets.js';

test('validateTicketInput trims and returns serial and issue', () => {
  assert.deepEqual(validateTicketInput({ serial: ' C5-0001 ', issue: ' no video ' }), { serial: 'C5-0001', issue: 'no video' });
});

test('validateTicketInput rejects a missing serial', () => {
  assert.throws(() => validateTicketInput({ issue: 'x' }), (e) => e instanceof HttpError && e.status === 400);
});

test('validateTicketInput rejects a missing issue', () => {
  assert.throws(() => validateTicketInput({ serial: 'C5-0001' }), (e) => e instanceof HttpError && e.status === 400);
});

test('formatTicketNo gives a ticket number', () => {
  assert.equal(formatTicketNo(7), 'T-7');
});
