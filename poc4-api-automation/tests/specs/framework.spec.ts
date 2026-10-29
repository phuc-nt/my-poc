// Tests of the test framework itself: the guards and checks that keep the suite safe and honest.
// They need no running service: npm run framework.
import { test as base, expect } from '@playwright/test';
import { ApiClient, ApiResult, WriteBlockedError } from '../src/api-client';
import { ContractValidator, loadContract } from '../src/contract';
import { diffContracts } from '../src/contract-diff';
import { EnvConfig, guard } from '../src/env';
import { maskBody, maskHeaders } from '../src/mask';
import { testVin } from '../src/data';

const test = base;

const ENV: EnvConfig = {
  name: 'unit', production: false, allowWrite: true, stubs: false, apiDocs: false,
  services: { a: 'http://a.invalid', b: 'http://b.invalid' },
  auth: { kind: 'env-token', userTokenEnvPrefix: 'T_', backofficeTokenEnv: 'T_BO' },
  keys: { internalEnv: 'K_I', partnerEnv: 'K_P' },
  accounts: { pool: ['auth0|u1'] },
};

function ok(service: 'a' | 'b', template: string, body: unknown, method: ApiResult['method'] = 'GET', status = 200): ApiResult {
  return { service, method, template, url: '', status, headers: {}, body, text: '', uuid: null, ms: 0 };
}

test.describe('framework @framework', () => {
  test('masking hides credentials, PINs and emails', () => {
    expect(maskHeaders({ Authorization: 'Bearer abc.def.ghi', 'X-Api-Key': 'k', accept: 'application/json' }))
      .toEqual({ Authorization: 'Bearer <redacted>', 'X-Api-Key': '<redacted>', accept: 'application/json' });
    expect(maskBody({ currentPin: '246810', newPin: '975318', email: 'someone@example.test', nested: [{ accessToken: 't' }] }))
      .toEqual({ currentPin: '<redacted>', newPin: '<redacted>', email: 's***@example.test', nested: [{ accessToken: '<redacted>' }] });
    expect(maskBody('/files/x.csv?expires=1&signature=0a1b2c')).toBe('/files/x.csv?expires=1&signature=<redacted>');
  });

  test('a read-only environment blocks every write before it leaves', async () => {
    const client = new ApiClient('a', {} as any, { ...ENV, allowWrite: false }, async () => ({}), []);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      await expect(client.call(method, '/app/v1/x')).rejects.toBeInstanceOf(WriteBlockedError);
    }
  });

  test('production is refused whatever the flags say', () => {
    expect(() => guard({ ...ENV, production: true })).toThrow(/never targets production/);
    expect(() => guard({ ...ENV, name: 'prod-jp' })).toThrow(/never targets production/);
    expect(() => guard({ ...ENV, stubs: true })).toThrow(/wiremockUrl/);
    expect(() => guard({ ...ENV, accounts: { pool: [] } })).toThrow(/pool is empty/);
    expect(guard(ENV)).toBe(ENV);
  });

  test('generated VINs are valid and marked as test data', () => {
    const vins = Array.from({ length: 200 }, testVin);
    for (const vin of vins) expect(vin).toMatch(/^PWT[A-HJ-NPR-Z0-9]{14}$/);
    expect(new Set(vins).size).toBe(vins.length);
  });

  test('the contract check catches an unknown field, a missing type and an unknown operation', () => {
    const contracts = ContractValidator.fromFiles();
    const profile = { result: 'OK', data: { userId: 'auth0|u1', email: 'x@example.test', locked: false } };
    const good = contracts.validate(ok('a', '/app/v1/users/{userId}', profile));
    expect(good.filter((p) => !/must have required/.test(p))).toEqual([]);
    expect(contracts.validate(ok('a', '/app/v1/users/{userId}', { ...profile, data: { ...profile.data, mail: 'x' } })).join('\n'))
      .toContain('must NOT have additional properties: mail');
    expect(contracts.validate(ok('a', '/app/v1/users/{userId}', { ...profile, data: { ...profile.data, locked: 'no' } })).join('\n'))
      .toContain('/data/locked must be boolean');
    expect(contracts.validate(ok('a', '/app/v2/users/{userId}', profile))).toEqual(['GET /app/v2/users/{userId} is not in contract service-a']);
    expect(contracts.validate(ok('a', '/x', { result: 'NG', errors: [{ code: 'E9', messageId: 'x', message: '' }] }, 'GET', 400)).length).toBeGreaterThan(0);
  });

  test('the contract diff calls a renamed response field and a new required request field breaking', () => {
    const before = loadContract('a');
    const after = structuredClone(before);
    const profile = after.components!.schemas!.UserProfile;
    profile.properties.mailAddress = profile.properties.email;
    delete profile.properties.email;
    const pin = after.components!.schemas!.ChangePinRequest;
    pin.properties.otp = { type: 'string' };
    pin.required = [...(pin.required ?? []), 'otp'];
    const { breaking, info } = diffContracts(before, after);
    expect(breaking).toContain('GET /app/v1/users/{userId} 200.data.email: response field removed');
    expect(breaking.some((b) => /request\.otp: request field added \(required\)/.test(b))).toBe(true);
    expect(info.some((i) => /data\.mailAddress: response field added/.test(i))).toBe(true);
    expect(diffContracts(before, before)).toEqual({ breaking: [], info: [] });
  });
});
