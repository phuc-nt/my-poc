// Ownership and subscriptions: service B checks the user with service A, and charges through the payment provider.
import { test, expect } from '../../src/fixtures';
import { testVin } from '../../src/data';
import type { ApiClient } from '../../src/api-client';

const OWNERSHIPS = '/app/v1/users/{userId}/ownerships';
const SUBSCRIPTIONS = `${OWNERSHIPS}/{ownershipId}/subscriptions`;

/** A VIN that has been through registration, ready to be owned. */
async function registeredVin(boB: ApiClient, partnerB: ApiClient): Promise<string> {
  const vin = testVin();
  const started = await boB.post('/bo/v1/vin-registrations', { body: { vin, modelCode: 'PW100' } });
  await expect(started).toBeOk(202);
  await expect(await partnerB.post('/partner/v1/callbacks/vin-registration', { body: { executionId: started.body.data.executionId, vin, result: 'SUCCEEDED' } })).toBeOk();
  return vin;
}

test.describe('ownership @write', () => {
  test.afterEach(async ({ userB, account }) => {
    const list = await userB.get(OWNERSHIPS, { params: { userId: account.userId } });
    for (const o of (list.body?.data ?? []).filter((o: any) => o.status === 'ACTIVE')) {
      await userB.delete(`${OWNERSHIPS}/{ownershipId}`, { params: { userId: account.userId, ownershipId: o.ownershipId } });
    }
  });

  test('own a registered vehicle, look the owner up internally, then end it', async ({ userB, boB, partnerB, internalB, account }) => {
    const vin = await registeredVin(boB, partnerB);
    const params = { userId: account.userId };
    const created = await userB.post(OWNERSHIPS, { params, body: { vin, nickname: 'pw car' } });
    await expect(created).toBeOk(201);
    const ownershipId = created.body.data.ownershipId;

    const owner = await internalB.get('/internal/v1/vins/{vin}/owner', { params: { vin } });
    await expect(owner).toBeOk();
    expect(owner.body.data).toEqual({ vin, userId: account.userId, ownershipId });

    await expect(await userB.post(OWNERSHIPS, { params, body: { vin } })).toBeNg(409, 'E250', 'vin');
    const ended = await userB.delete(`${OWNERSHIPS}/{ownershipId}`, { params: { ...params, ownershipId } });
    await expect(ended).toBeOk();
    expect(ended.body.data.status).toBe('ENDED');
    await expect(await userB.delete(`${OWNERSHIPS}/{ownershipId}`, { params: { ...params, ownershipId } })).toBeNg(404, 'E243', 'ownershipId');
    await expect(await internalB.get('/internal/v1/vins/{vin}/owner', { params: { vin } })).toBeNg(404, 'E243');
  });

  test('an unregistered VIN is E243 on vin', async ({ userB, account }) => {
    await expect(await userB.post(OWNERSHIPS, { params: { userId: account.userId }, body: { vin: testVin() } })).toBeNg(404, 'E243', 'vin');
  });

  test('a locked user is E206, checked through service A', async ({ as, env }) => {
    test.skip(!env.accounts.locked, 'no locked account on this environment');
    const locked = env.accounts.locked!;
    const r = await as('b', { user: locked }).post(OWNERSHIPS, { params: { userId: locked }, body: { vin: testVin() } });
    await expect(r).toBeNg(403, 'E206');
  });

  test('subscribe: the plan price is charged once, a second plan is E250', async ({ userB, boB, partnerB, account, wiremock }) => {
    const vin = await registeredVin(boB, partnerB);
    const params = { userId: account.userId };
    const { ownershipId } = (await userB.post(OWNERSHIPS, { params, body: { vin } })).body.data;
    const sub = await userB.post(SUBSCRIPTIONS, { params: { ...params, ownershipId }, body: { plan: 'BASIC' } });
    await expect(sub).toBeOk(201);
    expect(sub.body.data).toMatchObject({ plan: 'BASIC', status: 'ACTIVE' });
    expect(sub.body.data.paymentRef).toMatch(/^ch_/);

    const charges = await wiremock.requests(sub.uuid!, '/payment/v1/charges');
    expect(charges).toHaveLength(1);
    expect(charges[0].body).toMatchObject({ customerRef: account.userId, amount: 980, currency: 'JPY' });

    await expect(await userB.post(SUBSCRIPTIONS, { params: { ...params, ownershipId }, body: { plan: 'PREMIUM' } })).toBeNg(409, 'E250');
    const list = await userB.get(SUBSCRIPTIONS, { params: { ...params, ownershipId } });
    await expect(list).toBeOk();
    expect(list.body.data).toHaveLength(1);
  });

  test('a declined card is E610 and no subscription is made @stub', async ({ userB, boB, partnerB, account, wiremock }) => {
    const vin = await registeredVin(boB, partnerB);
    const params = { userId: account.userId };
    const { ownershipId } = (await userB.post(OWNERSHIPS, { params, body: { vin } })).body.data;
    const uuid = crypto.randomUUID();
    await wiremock.stubFor(uuid, { urlPathPattern: '/payment/v1/charges', status: 402, jsonBody: { error: 'card_declined' } });
    await expect(await userB.post(SUBSCRIPTIONS, { uuid, params: { ...params, ownershipId }, body: { plan: 'PREMIUM' } })).toBeNg(422, 'E610');
    expect((await userB.get(SUBSCRIPTIONS, { params: { ...params, ownershipId } })).body.data).toEqual([]);
  });

  test('a payment provider slower than the timeout is E611 @stub', async ({ userB, boB, partnerB, account, wiremock }) => {
    const vin = await registeredVin(boB, partnerB);
    const params = { userId: account.userId };
    const { ownershipId } = (await userB.post(OWNERSHIPS, { params, body: { vin } })).body.data;
    const uuid = crypto.randomUUID();
    await wiremock.stubFor(uuid, { urlPathPattern: '/payment/v1/charges', status: 201, jsonBody: { chargeId: 'ch_late' }, delayMs: 3000 });
    const r = await userB.post(SUBSCRIPTIONS, { uuid, params: { ...params, ownershipId }, body: { plan: 'BASIC' } });
    await expect(r).toBeNg(502, 'E611');
    expect(r.ms).toBeLessThan(2900);
  });

  test('bad input is E200 on the field', async ({ userB, account }) => {
    const params = { userId: account.userId };
    await expect(await userB.post(OWNERSHIPS, { params, body: { vin: testVin(), nickname: 'x'.repeat(33) } })).toBeNg(400, 'E200', 'nickname');
    await expect(await userB.post(SUBSCRIPTIONS, { params: { ...params, ownershipId: '00000000-0000-4000-8000-000000000000' }, body: { plan: 'GOLD' } })).toBeNg(400, 'E200', 'plan');
    await expect(await userB.get(SUBSCRIPTIONS, { params: { ...params, ownershipId: 'nope' } })).toBeNg(400, 'E200', 'ownershipId');
  });
});
