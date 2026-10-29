// Devices (limit of five) and consents for the worker's own user. Each test removes what it created.
import { test, expect } from '../../src/fixtures';
import { pushToken } from '../../src/data';

const DEVICES = '/app/v1/users/{userId}/devices';

test.describe('devices @write', () => {
  test.afterEach(async ({ userA, account }) => {
    const params = { userId: account.userId };
    const list = await userA.get(DEVICES, { params });
    for (const d of list.body?.data ?? []) {
      await userA.delete(`${DEVICES}/{deviceId}`, { params: { ...params, deviceId: d.deviceId } });
    }
  });

  test('register, list and remove a device', async ({ userA, account }) => {
    const params = { userId: account.userId };
    const created = await userA.post(DEVICES, { params, body: { platform: 'IOS', pushToken: pushToken() } });
    await expect(created).toBeOk(201);
    const list = await userA.get(DEVICES, { params });
    await expect(list).toBeOk();
    expect(list.body.data.map((d: any) => d.deviceId)).toContain(created.body.data.deviceId);
    const removed = await userA.delete(`${DEVICES}/{deviceId}`, { params: { ...params, deviceId: created.body.data.deviceId } });
    await expect(removed).toBeOk();
    await expect(await userA.delete(`${DEVICES}/{deviceId}`, { params: { ...params, deviceId: created.body.data.deviceId } })).toBeNg(404, 'E243');
  });

  test('a sixth device is E250', async ({ userA, account }) => {
    const params = { userId: account.userId };
    for (let i = 0; i < 5; i++) {
      await expect(await userA.post(DEVICES, { params, body: { platform: i % 2 ? 'IOS' : 'ANDROID', pushToken: pushToken() } })).toBeOk(201);
    }
    await expect(await userA.post(DEVICES, { params, body: { platform: 'IOS', pushToken: pushToken() } })).toBeNg(409, 'E250');
  });

  test('bad input is E200 on the field', async ({ userA, account }) => {
    const params = { userId: account.userId };
    await expect(await userA.post(DEVICES, { params, body: { platform: 'WINDOWS', pushToken: 'x' } })).toBeNg(400, 'E200', 'platform');
    await expect(await userA.post(DEVICES, { params, body: { platform: 'IOS' } })).toBeNg(400, 'E200', 'pushToken');
    await expect(await userA.post(DEVICES, { params, body: { platform: 'IOS', pushToken: 'x'.repeat(257) } })).toBeNg(400, 'E200', 'pushToken');
    await expect(await userA.delete(`${DEVICES}/{deviceId}`, { params: { ...params, deviceId: 'not-an-id' } })).toBeNg(400, 'E200', 'deviceId');
  });
});

test.describe('consents @write', () => {
  test('save a consent, read it on app and web, and publish consent.updated', async ({ userA, as, account, wiremock }) => {
    const params = { userId: account.userId, consentType: 'MARKETING' };
    const version = `1.${Date.now() % 1000}`;
    const saved = await userA.put('/app/v1/users/{userId}/consents/{consentType}', { params, body: { version, agreed: true } });
    await expect(saved).toBeOk();
    for (const prefix of ['app', 'web']) {
      const list = await as('a', { user: account.userId }).get(`/${prefix}/v1/users/{userId}/consents`, { params });
      await expect(list).toBeOk();
      expect(list.body.data).toContainEqual(expect.objectContaining({ consentType: 'MARKETING', version, agreed: true }));
    }
    const events = await wiremock.requests(saved.uuid!, '/events/v1/publish');
    expect(events.map((e) => e.body)).toContainEqual(expect.objectContaining({
      topic: 'privacy-events', type: 'consent.updated', payload: expect.objectContaining({ consentType: 'MARKETING', version }),
    }));
  });

  test('bad input is E200 on the field', async ({ userA, account }) => {
    const path = '/app/v1/users/{userId}/consents/{consentType}';
    await expect(await userA.put(path, { params: { userId: account.userId, consentType: 'TERMS' }, body: { version: 'v2', agreed: true } })).toBeNg(400, 'E200', 'version');
    await expect(await userA.put(path, { params: { userId: account.userId, consentType: 'TERMS' }, body: { version: '2.0' } })).toBeNg(400, 'E200', 'agreed');
    await expect(await userA.put(path, { params: { userId: account.userId, consentType: 'COOKIES' }, body: { version: '2.0', agreed: true } })).toBeNg(400, 'E200', 'consentType');
  });
});
