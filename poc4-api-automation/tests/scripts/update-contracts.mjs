#!/usr/bin/env node
// Refreshes contracts/service-*.json, the reviewed API contracts the tests hold the services to.
//
//   node scripts/update-contracts.mjs            from the files the unit tests write (sim/service-*/target/openapi)
//   node scripts/update-contracts.mjs --live     from the running services' /v3/api-docs
//
// Run it only for an intended API change, and commit the contract diff with the code change, so a reviewer sees it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');
const bases = { a: process.env.PW_BASE_URL_A ?? 'http://localhost:8081', b: process.env.PW_BASE_URL_B ?? 'http://localhost:8082' };

for (const service of ['a', 'b']) {
  const spec = live
    ? await (await fetch(`${bases[service]}/v3/api-docs`)).json()
    : JSON.parse(fs.readFileSync(path.join(root, '..', 'sim', `service-${service}`, 'target', 'openapi', `service-${service}.json`), 'utf8'));
  delete spec.servers; // the host differs between MockMvc and every environment
  fs.writeFileSync(path.join(root, 'contracts', `service-${service}.json`), JSON.stringify(spec, null, 2) + '\n');
  console.log(`contracts/service-${service}.json: ${Object.keys(spec.paths).length} paths`);
}
