// PIN change, attempt counting and locking. Every test leaves the worker's account unlocked with the seed PIN.
import { test, expect } from '../../src/fixtures';
import { SEED } from '../../src/data';

const PIN = '/app/v1/users/{userId}/pin';

test.describe('PIN @write', () => {
  test.afterEach(async ({ boA, account }) => {
    // Resets the attempt counter and the lock, whatever the test did.
    await expect(await boA.post('/bo/v1/users/{userId}/unlock', { params: { userId: account.userId } })).toBeOk();
  });

  test('a wrong PIN is E204 and says how many attempts are left', async ({ userA, account }) => {
    const r = await userA.put(PIN, { params: { userId: account.userId }, body: { currentPin: '135790', newPin: '975318' } });
    await expect(r).toBeNg(400, 'E204', 'currentPin');
    expect(r.body.errors[0].message).toContain('4 attempts left');
  });

  test('a weak new PIN is E200 on newPin', async ({ userA, account }) => {
    for (const weak of ['111111', '123456', '654321', '12345', 'abcdef']) {
      const r = await userA.put(PIN, { params: { userId: account.userId }, body: { currentPin: SEED.pin, newPin: weak } });
      await expect(r, `newPin ${weak}`).toBeNg(400, 'E200', 'newPin');
    }
  });

  test('the fifth wrong PIN locks the account until the back office unlocks it', async ({ userA, boA, account }) => {
    const params = { userId: account.userId };
    for (let left = 4; left >= 1; left--) {
      await expect(await userA.put(PIN, { params, body: { currentPin: '135790', newPin: '975318' } })).toBeNg(400, 'E204', 'currentPin');
    }
    await expect(await userA.put(PIN, { params, body: { currentPin: '135790', newPin: '975318' } })).toBeNg(403, 'E206', 'currentPin');
    // Locked: even the right PIN is refused.
    await expect(await userA.put(PIN, { params, body: { currentPin: SEED.pin, newPin: '975318' } })).toBeNg(403, 'E206');
    const profile = await userA.get('/app/v1/users/{userId}', { params });
    expect(profile.body.data.locked).toBe(true);

    const unlocked = await boA.post('/bo/v1/users/{userId}/unlock', { params });
    await expect(unlocked).toBeOk();
    expect(unlocked.body.data.locked).toBe(false);
  });

  test('the right PIN changes it, and publishes user.pin-changed', async ({ userA, account, wiremock }) => {
    const params = { userId: account.userId };
    const changed = await userA.put(PIN, { params, body: { currentPin: SEED.pin, newPin: SEED.otherPin } });
    try {
      await expect(changed).toBeOk();
      const events = await wiremock.requests(changed.uuid!, '/events/v1/publish');
      expect(events.map((e) => e.body)).toContainEqual(expect.objectContaining({ topic: 'user-events', type: 'user.pin-changed' }));
      // The old PIN no longer works.
      await expect(await userA.put(PIN, { params, body: { currentPin: SEED.pin, newPin: '864213' } })).toBeNg(400, 'E204');
    } finally {
      await expect(await userA.put(PIN, { params, body: { currentPin: SEED.otherPin, newPin: SEED.pin } })).toBeOk();
    }
  });
});
