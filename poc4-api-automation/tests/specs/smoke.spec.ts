// The first suite to run anywhere: read-only, a few seconds, one call per caller group and service.
// Safe on a shared environment because it only reads, and every test user reads only their own data.
import { test, expect } from '../src/fixtures';

test.describe('smoke @smoke', () => {
  test('both services report UP', async ({ anonA, anonB }) => {
    for (const client of [anonA, anonB]) {
      const r = await client.get('/health');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ status: 'UP' });
    }
  });

  test('app: a user reads their own profile', async ({ userA, account }) => {
    const r = await userA.get('/app/v1/users/{userId}', { params: { userId: account.userId } });
    await expect(r).toBeOk();
    expect(r.body.data.userId).toBe(account.userId);
  });

  test('web: the same profile through the web prefix', async ({ as, account }) => {
    const r = await as('a', { user: account.userId }).get('/web/v1/users/{userId}', { params: { userId: account.userId } });
    await expect(r).toBeOk();
  });

  test('back office: user search answers a page', async ({ boA }) => {
    const r = await boA.get('/bo/v1/users', { query: { size: 5 } });
    await expect(r).toBeOk();
    expect(r.body.data.items.length).toBeLessThanOrEqual(5);
  });

  test('internal: user status with the API key', async ({ internalA, account }) => {
    const r = await internalA.get('/internal/v1/users/{userId}', { params: { userId: account.userId } });
    await expect(r).toBeOk();
  });

  test('app: a user lists their vehicles on service B', async ({ userB, account }) => {
    const r = await userB.get('/app/v1/users/{userId}/ownerships', { params: { userId: account.userId } });
    await expect(r).toBeOk();
  });

  test('back office: a telematics unit on service B', async ({ boB, tcuId }) => {
    test.skip(!tcuId, 'no unit pool on this environment');
    const r = await boB.get('/bo/v1/tcus/{tcuId}', { params: { tcuId } });
    await expect(r).toBeOk();
  });

  test('no credentials is refused with E101', async ({ anonA, anonB, account }) => {
    await expect(await anonA.get('/app/v1/users/{userId}', { params: { userId: account.userId } })).toBeNg(401, 'E101');
    await expect(await anonB.get('/bo/v1/tcus/{tcuId}', { params: { tcuId: 'TCU-0001' } })).toBeNg(401, 'E101');
  });
});
