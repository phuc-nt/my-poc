---
feature: CON
title: Contract drift
specs:
  - specs/contract-drift.spec.ts
source:
  - tests:src/contract-diff.ts
  - tests:scripts/update-contracts.mjs
  - service-a:src/test/java/**/OpenApiSnapshotTest.java
  - service-b:src/test/java/**/OpenApiSnapshotTest.java
---

# CON: Contract drift

The API each service publishes now, compared with the reviewed contract in `contracts/`. A breaking difference (a removed field or operation, a new requirement, a changed type) fails the test; any other difference is listed in the report so that the contract gets refreshed on purpose (`npm run contracts:update`). It reads either the running service's `/v3/api-docs` or, with `CONTRACT_SOURCE=file`, the spec the service's unit tests write at build time.

## CON-01 Service A matches its reviewed contract
- **Rule:** Service A's published API has no breaking difference from `contracts/service-a.json`.
- **Given:** Service A's current OpenAPI (live, or from the build).
- **When:** It is compared with the reviewed contract.
- **Then:** No breaking change; other changes are attached to the report.

## CON-02 Service B matches its reviewed contract
- **Rule:** Service B's published API has no breaking difference from `contracts/service-b.json`.
- **Given:** Service B's current OpenAPI (live, or from the build).
- **When:** It is compared with the reviewed contract.
- **Then:** No breaking change; other changes are attached to the report.
