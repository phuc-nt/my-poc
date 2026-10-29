// SIM activation on the worker's own unit: ordered from the carrier, finished by the carrier's callback.
import { test, expect } from '../../src/fixtures';

test.describe('SIM activation @write', () => {
  test.beforeEach(async ({ tcuId }) => test.skip(!tcuId, 'no unit pool on this environment'));
  test.afterEach(async ({ boB, partnerB, tcuId }) => {
    // Put the unit back to INACTIVE through the same callback the carrier uses.
    const tcu = await boB.get('/bo/v1/tcus/{tcuId}', { params: { tcuId } });
    if (tcu.body?.data?.simStatus !== 'INACTIVE') {
      await expect(await partnerB.post('/partner/v1/callbacks/sim-status', { body: { iccid: tcu.body.data.iccid, status: 'INACTIVE' } })).toBeOk();
    }
  });

  test('ordered, then active once the carrier calls back', async ({ boB, partnerB, tcuId, wiremock }) => {
    const ordered = await boB.post('/bo/v1/tcus/{tcuId}/sim/activate', { params: { tcuId } });
    await expect(ordered).toBeOk(202);
    expect(ordered.body.data.simStatus).toBe('ACTIVATING');
    const { iccid, orderId } = ordered.body.data;
    const [order] = await wiremock.requests(ordered.uuid!, '/telecom/v1/sims/.*');
    expect(order.url).toBe(`/telecom/v1/sims/${iccid}/activation`);

    await expect(await boB.post('/bo/v1/tcus/{tcuId}/sim/activate', { params: { tcuId } })).toBeNg(409, 'E250');
    const active = await partnerB.post('/partner/v1/callbacks/sim-status', { body: { iccid, status: 'ACTIVE' } });
    await expect(active).toBeOk();
    expect(active.body.data).toMatchObject({ simStatus: 'ACTIVE', orderId });
  });

  test('a carrier failure is E611 and the unit stays INACTIVE @stub', async ({ boB, tcuId, wiremock }) => {
    const uuid = crypto.randomUUID();
    await wiremock.stubFor(uuid, { urlPathPattern: '/telecom/v1/sims/.*', status: 503 });
    await expect(await boB.post('/bo/v1/tcus/{tcuId}/sim/activate', { params: { tcuId }, uuid })).toBeNg(502, 'E611');
    expect((await boB.get('/bo/v1/tcus/{tcuId}', { params: { tcuId } })).body.data.simStatus).toBe('INACTIVE');
  });

  test('unknown and malformed ids', async ({ boB, partnerB }) => {
    await expect(await boB.get('/bo/v1/tcus/{tcuId}', { params: { tcuId: 'TCU-9999' } })).toBeNg(404, 'E243', 'tcuId');
    await expect(await boB.get('/bo/v1/tcus/{tcuId}', { params: { tcuId: 'tcu-1' } })).toBeNg(400, 'E200', 'tcuId');
    await expect(await partnerB.post('/partner/v1/callbacks/sim-status', { body: { iccid: '8999999999999999999', status: 'ACTIVE' } })).toBeNg(404, 'E243', 'iccid');
    await expect(await partnerB.post('/partner/v1/callbacks/sim-status', { body: { iccid: '123', status: 'ACTIVE' } })).toBeNg(400, 'E200', 'iccid');
    await expect(await partnerB.post('/partner/v1/callbacks/sim-status', { body: { iccid: '8999000000000000001', status: 'BROKEN' } })).toBeNg(400, 'E200', 'status');
  });
});
