// Who may call what: tokens, scopes, ownership and the two API keys. Read-only, so it runs on any environment.
import { test, expect } from '../src/fixtures';

const PROFILE = '/app/v1/users/{userId}';

function tamper(jwt: string): string {
  const [header, payload, signature] = jwt.split('.');
  return [header, payload, signature.slice(0, -4) + (signature.endsWith('AAAA') ? 'BBBB' : 'AAAA')].join('.');
}

function unsigned(jwt: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  return `${header}.${jwt.split('.')[1]}.`;
}

test.describe('security', () => {
  test('an expired token is E101', async ({ as, env, account }) => {
    test.skip(env.auth.kind !== 'oauth-mock', 'needs an IdP that issues short-lived tokens');
    const r = await as('a', { user: account.userId, ttlSeconds: -60 }).get(PROFILE, { params: { userId: account.userId } });
    await expect(r).toBeNg(401, 'E101');
  });

  test('a tampered or unsigned token is E101', async ({ as, tokens, account }) => {
    const token = await tokens.user(account.userId);
    for (const bad of [tamper(token), unsigned(token), 'not-a-jwt']) {
      const r = await as('a', { headers: { Authorization: `Bearer ${bad}` } }).get(PROFILE, { params: { userId: account.userId } });
      await expect(r).toBeNg(401, 'E101');
    }
  });

  test("a user cannot read another user's data (E102), on either service", async ({ userA, userB, env, account }) => {
    const other = env.accounts.pool.find((u) => u !== account.userId);
    test.skip(!other, 'needs two pooled users');
    await expect(await userA.get(PROFILE, { params: { userId: other! } })).toBeNg(403, 'E102');
    await expect(await userA.get('/web/v1/users/{userId}', { params: { userId: other! } })).toBeNg(403, 'E102');
    await expect(await userB.get('/app/v1/users/{userId}/ownerships', { params: { userId: other! } })).toBeNg(403, 'E102');
  });

  test('scopes: a user token on /bo and a back-office token on /app are E102', async ({ userA, boA, account }) => {
    await expect(await userA.get('/bo/v1/users', { query: { page: 0, size: 1 } })).toBeNg(403, 'E102');
    await expect(await boA.get(PROFILE, { params: { userId: account.userId } })).toBeNg(403, 'E102');
  });

  // No key or a wrong key is E101. A valid token without the key is authenticated but not allowed: E102.
  test('/internal and /partner take only their own key', async ({ userA, userB, boB, as, env, account }) => {
    const internal = '/internal/v1/users/{userId}';
    await expect(await userA.get(internal, { params: { userId: account.userId } })).toBeNg(403, 'E102');
    await expect(await as('a', 'partner').get(internal, { params: { userId: account.userId } })).toBeNg(401, 'E101');
    await expect(await as('a', { headers: { 'X-Api-Key': 'wrong-key' } }).get(internal, { params: { userId: account.userId } })).toBeNg(401, 'E101');
    await expect(await as('b', 'internal').get('/bo/v1/tcus/{tcuId}', { params: { tcuId: 'TCU-0001' } })).toBeNg(401, 'E101');
    // A partner callback with a user or back-office token, and no partner key, is refused too.
    for (const client of [userB, boB]) {
      if (!env.allowWrite) break; // read-only run: the write guard would stop the call before it left
      await expect(await client.post('/partner/v1/callbacks/sim-status', { body: { iccid: '8999000000000000001', status: 'ACTIVE' } })).toBeNg(403, 'E102');
    }
  });

  test('error bodies leak no stack trace or SQL', async ({ anonA, userA, account }) => {
    const responses = [
      await anonA.get(PROFILE, { params: { userId: account.userId } }),
      await userA.get('/app/v1/users/{userId}/nothing-here', { params: { userId: account.userId } }),
      await userA.get(PROFILE, { params: { userId: 'bad id' } }),
    ];
    for (const r of responses) expect(r.text).not.toMatch(/Exception|at [a-z]+\.[a-z]+\.|SQL|org\.springframework|mybatis/i);
  });
});
