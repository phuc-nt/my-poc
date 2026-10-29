// Back-office search and the asynchronous CSV export: request, poll, signed download, mail.
import { test, expect } from '../../src/fixtures';
import { SEED } from '../../src/data';
import type { ApiResult } from '../../src/api-client';

test.describe('back-office search', () => {
  test('search by email pages through the test users', async ({ boA }) => {
    const first = await boA.get('/bo/v1/users', { query: { email: 'pw-user-', size: 3, page: 0 } });
    await expect(first).toBeOk();
    expect(first.body.data.total).toBe(8);
    expect(first.body.data.items).toHaveLength(3);
    const last = await boA.get('/bo/v1/users', { query: { email: 'pw-user-', size: 3, page: 2 } });
    expect(last.body.data.items).toHaveLength(2);
  });

  test('bad paging and filters are E200 on the parameter', async ({ boA }) => {
    await expect(await boA.get('/bo/v1/users', { query: { size: 0 } })).toBeNg(400, 'E200', 'size');
    await expect(await boA.get('/bo/v1/users', { query: { size: 101 } })).toBeNg(400, 'E200', 'size');
    await expect(await boA.get('/bo/v1/users', { query: { page: -1 } })).toBeNg(400, 'E200', 'page');
    await expect(await boA.get('/bo/v1/users', { query: { page: 'x' } })).toBeNg(400, 'E200', 'page');
    await expect(await boA.get('/bo/v1/users', { query: { email: 'ab' } })).toBeNg(400, 'E200', 'email');
  });

  test('unlocking an unknown user is E243 @write', async ({ boA }) => {
    await expect(await boA.post('/bo/v1/users/{userId}/unlock', { params: { userId: 'auth0|pw-nobody' } })).toBeNg(404, 'E243');
  });
});

test.describe('CSV export @write', () => {
  test('queued, then done with a signed link to the right rows', async ({ boA, request }) => {
    const queued = await boA.post('/bo/v1/exports', { body: { kind: 'USERS', from: '2026-03-01', to: '2026-03-30' } });
    await expect(queued).toBeOk(202);
    expect(queued.body.data.status).toBe('QUEUED');
    const requestId = queued.body.data.requestId;

    let status!: ApiResult;
    await expect.poll(async () => {
      status = await boA.get('/bo/v1/exports/{requestId}', { params: { requestId } });
      return status.body.data.status;
    }, { timeout: 15_000, intervals: [500, 1000] }).toBe('DONE');
    await expect(status).toBeOk();
    expect(status.body.data.rowCount).toBe(SEED.marchUsers);

    const file = await request.get(status.body.data.downloadUrl);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toContain('text/csv');
    const lines = (await file.text()).trim().split('\n');
    expect(lines[0]).toBe('user_id,email,display_name,locked,created_at');
    expect(lines).toHaveLength(SEED.marchUsers + 1);

    // The link is signed: any change to it is refused.
    const tampered = await request.get(status.body.data.downloadUrl.replace(/signature=(.)/, (_: string, c: string) => `signature=${c === '0' ? '1' : '0'}`));
    expect(tampered.status()).toBe(403);
  });

  test('the notify address gets a mail once the file is ready', async ({ boA, wiremock }) => {
    const queued = await boA.post('/bo/v1/exports', { body: { kind: 'CONSENTS', from: '2026-01-01', to: '2026-01-31', notifyEmail: 'pw-export@example.test' } });
    await expect(queued).toBeOk(202);
    // The worker carries the request's uuid into the mail call, so the journal can find it.
    await expect.poll(async () => (await wiremock.requests(queued.uuid!, '/mail/v1/send')).length, { timeout: 15_000 }).toBe(1);
    const [mail] = await wiremock.requests(queued.uuid!, '/mail/v1/send');
    expect(mail.body).toMatchObject({ to: 'pw-export@example.test', requestId: queued.body.data.requestId });
  });

  test('a bad range or kind is E200', async ({ boA }) => {
    await expect(await boA.post('/bo/v1/exports', { body: { kind: 'USERS', from: '2026-03-30', to: '2026-03-01' } })).toBeNg(400, 'E200');
    await expect(await boA.post('/bo/v1/exports', { body: { kind: 'USERS', from: '2026-01-01', to: '2026-03-01' } })).toBeNg(400, 'E200');
    await expect(await boA.post('/bo/v1/exports', { body: { kind: 'ORDERS', from: '2026-01-01', to: '2026-01-02' } })).toBeNg(400, 'E200', 'kind');
    await expect(await boA.post('/bo/v1/exports', { body: { kind: 'USERS', from: '2026-02-30', to: '2026-03-01' } })).toBeNg(400, 'E200', 'from');
    await expect(await boA.post('/bo/v1/exports', { body: { kind: 'USERS', from: '2026-01-01', to: '2026-01-02', notifyEmail: 'not-an-email' } })).toBeNg(400, 'E200', 'notifyEmail');
  });

  test('an unknown export is E243', async ({ boA }) => {
    await expect(await boA.get('/bo/v1/exports/{requestId}', { params: { requestId: '00000000-0000-4000-8000-000000000000' } })).toBeNg(404, 'E243');
  });
});
