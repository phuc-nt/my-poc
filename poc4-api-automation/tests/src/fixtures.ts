// The test API: import { test, expect } from '../src/fixtures' in every spec.
//
// Worker fixtures: env, tokens, account (this worker's own test user), tcuId (this worker's own unit).
// Test fixtures:   userA/userB (as the worker's user), boA/boB (back office), internalA/internalB (API key),
//                  partnerB (partner key), anonA/anonB (no credentials), as(service, caller) for anything else,
//                  wiremock (per-test stubs, removed afterwards), contracts.
import { expect as baseExpect, test as base, APIRequestContext } from '@playwright/test';
import { ApiClient, ApiResult, CallRecord, HeaderSource } from './api-client';
import { TokenProvider } from './auth';
import { ContractValidator } from './contract';
import { EnvConfig, loadEnv, secret, ServiceName } from './env';
import { WireMock } from './wiremock';

export type Caller =
  | { user: string; ttlSeconds?: number }
  | 'backoffice'
  | 'internal'
  | 'partner'
  | 'anonymous'
  | { headers: Record<string, string> };

type WorkerFixtures = {
  env: EnvConfig;
  workerRequest: APIRequestContext;
  tokens: TokenProvider;
  account: { userId: string };
  tcuId: string;
  contracts: ContractValidator;
};

type TestFixtures = {
  calls: CallRecord[];
  as: (service: ServiceName, caller: Caller) => ApiClient;
  userA: ApiClient; userB: ApiClient;
  boA: ApiClient; boB: ApiClient;
  internalA: ApiClient; internalB: ApiClient;
  partnerB: ApiClient;
  anonA: ApiClient; anonB: ApiClient;
  wiremock: WireMock;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  env: [async ({}, use) => use(loadEnv()), { scope: 'worker' }],
  workerRequest: [async ({ playwright }, use) => {
    const request = await playwright.request.newContext();
    await use(request);
    await request.dispose();
  }, { scope: 'worker' }],
  tokens: [async ({ env, workerRequest }, use) => use(new TokenProvider(env, workerRequest)), { scope: 'worker' }],
  account: [async ({ env }, use, workerInfo) => {
    const userId = env.accounts.pool[workerInfo.parallelIndex];
    if (!userId) throw new Error(`Worker ${workerInfo.parallelIndex} has no test account: the pool has ${env.accounts.pool.length}`);
    await use({ userId });
  }, { scope: 'worker' }],
  tcuId: [async ({ env }, use, workerInfo) => {
    await use(env.tcuPool?.[workerInfo.parallelIndex] ?? '');
  }, { scope: 'worker' }],
  contracts: [async ({}, use) => use(ContractValidator.fromFiles()), { scope: 'worker' }],

  calls: async ({}, use, testInfo) => {
    const calls: CallRecord[] = [];
    await use(calls);
    if (testInfo.status !== testInfo.expectedStatus && calls.length) {
      await testInfo.attach('api-calls.json', { body: JSON.stringify(calls, null, 2), contentType: 'application/json' });
    }
  },
  as: async ({ env, tokens, request, calls }, use) => {
    await use((service, caller) => {
      const headers: HeaderSource = async () => {
        if (caller === 'anonymous') return {};
        if (caller === 'backoffice') return { Authorization: `Bearer ${await tokens.backoffice()}` };
        if (caller === 'internal') return { 'X-Api-Key': secret(env.keys.internalEnv) };
        if (caller === 'partner') return { 'X-Partner-Key': secret(env.keys.partnerEnv) };
        if ('headers' in caller) return caller.headers;
        return { Authorization: `Bearer ${await tokens.user(caller.user, caller.ttlSeconds)}` };
      };
      return new ApiClient(service, request, env, headers, calls);
    });
  },
  userA: async ({ as, account }, use) => use(as('a', { user: account.userId })),
  userB: async ({ as, account }, use) => use(as('b', { user: account.userId })),
  boA: async ({ as }, use) => use(as('a', 'backoffice')),
  boB: async ({ as }, use) => use(as('b', 'backoffice')),
  internalA: async ({ as }, use) => use(as('a', 'internal')),
  internalB: async ({ as }, use) => use(as('b', 'internal')),
  partnerB: async ({ as }, use) => use(as('b', 'partner')),
  anonA: async ({ as }, use) => use(as('a', 'anonymous')),
  anonB: async ({ as }, use) => use(as('b', 'anonymous')),
  wiremock: async ({ env, request }, use, testInfo) => {
    testInfo.skip(!env.stubs || !env.wiremockUrl, `${env.name} has no stub server`);
    const wiremock = new WireMock(request, env.wiremockUrl!);
    await use(wiremock);
    await wiremock.cleanup();
  },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let validator: ContractValidator | undefined;
const contracts = () => (validator ??= ContractValidator.fromFiles());

function summary(r: ApiResult): string {
  return `${r.method} ${r.template} -> ${r.status} ${r.text.slice(0, 400)}`;
}

/** Checks shared by OK and NG: the protocol headers every response must carry. */
function headerProblems(r: ApiResult, result: 'OK' | 'NG'): string[] {
  const problems: string[] = [];
  if (r.headers['x_result_status'] !== result) problems.push(`X_RESULT_STATUS is ${r.headers['x_result_status']}, expected ${result}`);
  if (r.uuid && r.headers['x_one_time_uuid'] !== r.uuid) problems.push(`X_ONE_TIME_UUID ${r.headers['x_one_time_uuid']} does not echo ${r.uuid}`);
  if (!r.uuid && !UUID.test(r.headers['x_one_time_uuid'] ?? '')) problems.push('X_ONE_TIME_UUID was not generated');
  if (Number.isNaN(Date.parse(r.headers['x_event_time'] ?? ''))) problems.push(`X_EVENT_TIME is not a timestamp: ${r.headers['x_event_time']}`);
  return problems;
}

export const expect = baseExpect.extend({
  /** Status, OK envelope, protocol headers and the contract schema of a successful call. */
  toBeOk(r: ApiResult, status = 200) {
    const problems = [
      ...(r.status === status ? [] : [`status ${r.status}, expected ${status}`]),
      ...(r.body?.result === 'OK' ? [] : ['body.result is not OK']),
      ...headerProblems(r, 'OK'),
      ...contracts().validate(r).map((p) => `contract: ${p}`),
    ];
    return {
      pass: problems.length === 0,
      name: 'toBeOk',
      message: () => (this.isNot ? `expected not OK: ${summary(r)}` : `${problems.join('\n')}\n${summary(r)}`),
    };
  },
  /** Status, NG envelope with the error code (and field), X_ERROR_CODE and the error contract. */
  toBeNg(r: ApiResult, status: number, code: string, field?: string) {
    const errors: { code: string; field?: string }[] = r.body?.errors ?? [];
    const problems = [
      ...(r.status === status ? [] : [`status ${r.status}, expected ${status}`]),
      ...(errors.some((e) => e.code === code && (field === undefined || e.field === field))
        ? [] : [`no error ${code}${field ? ` on ${field}` : ''} in ${JSON.stringify(errors)}`]),
      ...(r.headers['x_error_code'] === errors[0]?.code ? [] : [`X_ERROR_CODE ${r.headers['x_error_code']} is not the first error's code`]),
      ...headerProblems(r, 'NG'),
      ...contracts().validate(r).map((p) => `contract: ${p}`),
    ];
    return {
      pass: problems.length === 0,
      name: 'toBeNg',
      message: () => (this.isNot ? `expected not ${code}: ${summary(r)}` : `${problems.join('\n')}\n${summary(r)}`),
    };
  },
});
