// The internal API (API key) and the protocol every endpoint shares: correlation id, result headers, error mapping.
import { test, expect } from '../../src/fixtures';
import { pushToken } from '../../src/data';

test.describe('internal API', () => {
  test('push to a user with no device sends nothing @write', async ({ internalA, account }) => {
    const r = await internalA.post('/internal/v1/users/{userId}/notifications', { params: { userId: account.userId }, body: { title: 'Hi', body: 'Test' } });
    await expect(r).toBeOk();
    expect(r.body.data.sent).toBe(0);
  });

  test('a push provider failure is E611 @write @stub', async ({ internalA, userA, account, wiremock }) => {
    const params = { userId: account.userId };
    const device = await userA.post('/app/v1/users/{userId}/devices', { params, body: { platform: 'ANDROID', pushToken: pushToken() } });
    try {
      const uuid = crypto.randomUUID();
      await wiremock.stubFor(uuid, { urlPathPattern: '/push/v1/send', status: 500 });
      await expect(await internalA.post('/internal/v1/users/{userId}/notifications', { params, uuid, body: { title: 'Hi', body: 'Test' } })).toBeNg(502, 'E611');
      // Without the fault, the same push goes through.
      const ok = await internalA.post('/internal/v1/users/{userId}/notifications', { params, body: { title: 'Hi', body: 'Test' } });
      await expect(ok).toBeOk();
      expect(ok.body.data.sent).toBe(1);
    } finally {
      await userA.delete('/app/v1/users/{userId}/devices/{deviceId}', { params: { ...params, deviceId: device.body.data.deviceId } });
    }
  });

  test('an unknown user is E243', async ({ internalA }) => {
    await expect(await internalA.get('/internal/v1/users/{userId}', { params: { userId: 'auth0|pw-nobody' } })).toBeNg(404, 'E243');
  });
});

test.describe('protocol', () => {
  test('X-One-Time-Uuid is echoed, or generated when missing', async ({ userA, account }) => {
    const params = { userId: account.userId };
    const given = await userA.get('/app/v1/users/{userId}', { params });
    expect(given.headers['x_one_time_uuid']).toBe(given.uuid);
    const generated = await userA.get('/app/v1/users/{userId}', { params, uuid: null });
    await expect(generated).toBeOk();
  });

  test('a malformed X-One-Time-Uuid is E200 on the header', async ({ userA, account }) => {
    const r = await userA.get('/app/v1/users/{userId}', { params: { userId: account.userId }, uuid: 'not-a-uuid' });
    expect(r.status).toBe(400);
    expect(r.body.errors[0]).toMatchObject({ code: 'E200', field: 'X-One-Time-Uuid' });
  });

  test('an unknown route is E243', async ({ boA }) => {
    await expect(await boA.get('/bo/v1/nothing-here')).toBeNg(404, 'E243');
  });

  test('a wrong method is E201 @write', async ({ boA }) => {
    await expect(await boA.delete('/bo/v1/users')).toBeNg(405, 'E201');
  });

  test('malformed JSON and a wrong content type are refused with the envelope @write', async ({ userA, account }) => {
    const params = { userId: account.userId };
    await expect(await userA.post('/app/v1/users/{userId}/devices', { params, rawBody: { data: '{"platform":', contentType: 'application/json' } })).toBeNg(400, 'E200');
    const xml = await userA.post('/app/v1/users/{userId}/devices', { params, rawBody: { data: '<device/>', contentType: 'application/xml' } });
    expect(xml.body.result).toBe('NG');
    expect(xml.status).toBeGreaterThanOrEqual(400);
  });

  test('user ids with "|" work raw and percent-encoded', async ({ userA, account }) => {
    for (const encodePath of [true, false]) {
      const r = await userA.get('/app/v1/users/{userId}', { params: { userId: account.userId }, encodePath });
      await expect(r, `encodePath=${encodePath}`).toBeOk();
      expect(r.body.data.userId).toBe(account.userId);
    }
  });

  test('a malformed user id is E200 on userId', async ({ as }) => {
    // The token subject equals the path id, so the owner check passes and validation decides.
    const r = await as('a', { headers: {} }).get('/internal/v1/users/{userId}', { params: { userId: 'no-pipe-here' }, headers: { 'X-Api-Key': process.env.PW_INTERNAL_API_KEY ?? '' } });
    await expect(r).toBeNg(400, 'E200', 'userId');
  });
});
