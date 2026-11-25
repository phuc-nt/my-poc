import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserClassifier } from '../src/slack/user-classifier.js';

const clientReturning = (user, error) => ({
  users: { info: async () => { if (error) throw error; return { ok: true, user }; } },
});
const classify = createUserClassifier({ internalDomains: ['@Corp.Example', 'sub.corp.example'] });
const person = (email, extra = {}) => ({ id: 'U1', profile: email === undefined ? {} : { email }, ...extra });

test('the whole domain must match, case-insensitively', async () => {
  assert.equal((await classify(clientReturning(person('A.B@CORP.EXAMPLE')), 'U1')).userClass, 'internal');
  assert.equal((await classify(clientReturning(person('a@sub.corp.example')), 'U1')).userClass, 'internal');
  for (const email of ['a@corp.example.evil', 'a@xcorp.example', 'a@other.corp.example', 'corp.example@evil.example', 'a@evil.example']) {
    assert.equal((await classify(clientReturning(person(email)), 'U1')).userClass, 'external', email);
  }
});

test('no email, a bot, a deactivated user, an unconfirmed email or a failed call is unknown', async () => {
  const cases = [
    clientReturning(person(undefined)),
    clientReturning(person('')),
    clientReturning(person(null)),
    clientReturning(person('not-an-email')),
    clientReturning(person('bot@corp.example', { is_bot: true })),
    clientReturning(person('gone@corp.example', { deleted: true })),
    clientReturning(person('new@corp.example', { is_email_confirmed: false })),
    clientReturning(null, Object.assign(new Error('An API error occurred: ratelimited'), { data: { error: 'ratelimited' } })),
  ];
  for (const client of cases) assert.equal((await classify(client, 'U1')).userClass, 'unknown');
});

test('the result never carries the email', async () => {
  const result = await classify(clientReturning(person('a.b@corp.example', { is_restricted: true })), 'U1');
  assert.deepEqual(result, { userClass: 'internal', reason: 'internal domain', guest: true });
});

test('a classifier needs at least one domain', () => {
  assert.throws(() => createUserClassifier({ internalDomains: [' '] }));
});
