// Contract drift: the API the service publishes now, compared with the reviewed contract in contracts/.
// A breaking difference fails; any other difference is listed in the report so the contract gets refreshed.
//
//   default                 the running service's /v3/api-docs (needs apiDocs on the environment)
//   CONTRACT_SOURCE=file    the spec the unit tests write (sim/service-*/target/openapi), no running service needed
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../src/fixtures';
import { loadContract, OpenApi } from '../src/contract';
import { diffContracts } from '../src/contract-diff';

const fromFile = process.env.CONTRACT_SOURCE === 'file';

for (const service of ['a', 'b'] as const) {
  test(`service-${service} matches its reviewed contract @contract`, async ({ env, workerRequest }) => {
    let current: OpenApi;
    if (fromFile) {
      current = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'sim', `service-${service}`, 'target', 'openapi', `service-${service}.json`), 'utf8'));
    } else {
      test.skip(!env.apiDocs, `${env.name} does not publish /v3/api-docs`);
      const response = await workerRequest.get(`${env.services[service]}/v3/api-docs`);
      expect(response.status(), 'GET /v3/api-docs').toBe(200);
      current = await response.json();
    }
    const { breaking, info } = diffContracts(loadContract(service), current);
    for (const change of info) test.info().annotations.push({ type: 'contract change', description: change });
    expect(breaking, `breaking changes in service-${service} (fix the code, or review and run npm run contracts:update)`).toEqual([]);
  });
}
