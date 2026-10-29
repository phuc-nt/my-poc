// VIN registration: the back office starts an external workflow, which reports back through the partner callback.
import { test, expect } from '../../src/fixtures';
import { testVin } from '../../src/data';

const CALLBACK = '/partner/v1/callbacks/vin-registration';

test.describe('VIN registration @write', () => {
  test('requested, then registered by the workflow callback', async ({ boB, partnerB, wiremock }) => {
    const vin = testVin();
    const started = await boB.post('/bo/v1/vin-registrations', { body: { vin, modelCode: 'PW100' } });
    await expect(started).toBeOk(202);
    expect(started.body.data).toMatchObject({ vin, status: 'REQUESTED' });
    const { executionId } = started.body.data;

    const [workflow] = await wiremock.requests(started.uuid!, '/workflow/v1/executions');
    expect(workflow.body).toMatchObject({ stateMachine: 'vin-registration', input: { vin, modelCode: 'PW100' } });

    const done = await partnerB.post(CALLBACK, { body: { executionId, vin, result: 'SUCCEEDED' } });
    await expect(done).toBeOk();
    expect(done.body.data.status).toBe('REGISTERED');
    const read = await boB.get('/bo/v1/vin-registrations/{vin}', { params: { vin } });
    expect(read.body.data.status).toBe('REGISTERED');
  });

  test('callbacks are idempotent, and a conflicting result is E250', async ({ boB, partnerB }) => {
    const vin = testVin();
    const { executionId } = (await boB.post('/bo/v1/vin-registrations', { body: { vin, modelCode: 'PW100' } })).body.data;
    await expect(await partnerB.post(CALLBACK, { body: { executionId, vin, result: 'FAILED', reason: 'not in catalogue' } })).toBeOk();
    const again = await partnerB.post(CALLBACK, { body: { executionId, vin, result: 'FAILED', reason: 'not in catalogue' } });
    await expect(again).toBeOk();
    expect(again.body.data).toMatchObject({ status: 'REJECTED', reason: 'not in catalogue' });
    await expect(await partnerB.post(CALLBACK, { body: { executionId, vin, result: 'SUCCEEDED' } })).toBeNg(409, 'E250', 'result');
  });

  test('a duplicate VIN is E250, a wrong execution id is E243', async ({ boB, partnerB }) => {
    const vin = testVin();
    await expect(await boB.post('/bo/v1/vin-registrations', { body: { vin, modelCode: 'PW100' } })).toBeOk(202);
    await expect(await boB.post('/bo/v1/vin-registrations', { body: { vin, modelCode: 'PW100' } })).toBeNg(409, 'E250', 'vin');
    await expect(await partnerB.post(CALLBACK, { body: { executionId: 'exec-wrong', vin, result: 'SUCCEEDED' } })).toBeNg(404, 'E243', 'executionId');
  });

  test('a workflow that cannot start is E611 and nothing is saved @stub', async ({ boB, wiremock }) => {
    const vin = testVin();
    const uuid = crypto.randomUUID();
    await wiremock.stubFor(uuid, { urlPathPattern: '/workflow/v1/executions', status: 503 });
    await expect(await boB.post('/bo/v1/vin-registrations', { uuid, body: { vin, modelCode: 'PW100' } })).toBeNg(502, 'E611');
    await expect(await boB.get('/bo/v1/vin-registrations/{vin}', { params: { vin } })).toBeNg(404, 'E243', 'vin');
  });

  test('bad VINs and model codes are E200', async ({ boB }) => {
    for (const vin of ['PWT00000000000000I', 'PWT0000000000000O', 'SHORT', 'pwt00000000000000']) {
      await expect(await boB.post('/bo/v1/vin-registrations', { body: { vin, modelCode: 'PW100' } }), vin).toBeNg(400, 'E200', 'vin');
    }
    await expect(await boB.post('/bo/v1/vin-registrations', { body: { vin: testVin(), modelCode: 'p' } })).toBeNg(400, 'E200', 'modelCode');
    await expect(await boB.get('/bo/v1/vin-registrations/{vin}', { params: { vin: 'BAD' } })).toBeNg(400, 'E200', 'vin');
  });

  test('callbacks need the partner key', async ({ as }) => {
    const body = { executionId: 'exec-x', vin: testVin(), result: 'SUCCEEDED' };
    await expect(await as('b', 'anonymous').post(CALLBACK, { body })).toBeNg(401, 'E101');
    await expect(await as('b', { headers: { 'X-Partner-Key': 'wrong-key' } }).post(CALLBACK, { body })).toBeNg(401, 'E101');
  });
});
