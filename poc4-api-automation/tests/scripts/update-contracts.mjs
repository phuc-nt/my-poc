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
// The paths per service are in kit.config.json "contracts", shared with scripts/cases.mjs.
const { contracts } = JSON.parse(fs.readFileSync(path.join(root, 'kit.config.json'), 'utf8'));

for (const [service, c] of Object.entries(contracts)) {
  const spec = live
    ? await (await fetch(`${process.env[c.baseUrlEnv] ?? c.baseUrl}/v3/api-docs`)).json()
    : JSON.parse(fs.readFileSync(path.resolve(root, c.build), 'utf8'));
  delete spec.servers; // the host differs between MockMvc and every environment
  fs.writeFileSync(path.join(root, c.reviewed), JSON.stringify(spec, null, 2) + '\n');
  console.log(`${c.reviewed}: ${Object.keys(spec.paths).length} paths`);
}
