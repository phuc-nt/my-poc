---
feature: FWK
title: Guards of the test framework
specs:
  - specs/framework.spec.ts
source:
  - tests:src/api-client.ts
  - tests:src/mask.ts
  - tests:src/env.ts
  - tests:src/contract.ts
  - tests:src/contract-diff.ts
  - tests:src/data.ts
---

# FWK: Guards of the test framework

The suite's own safety checks. They prove that the suite cannot leak credentials into reports, cannot write where writes are not allowed, cannot target production, and that its contract checks catch what they claim to catch. They need no running service and run first in the pipeline.

## FWK-01 Masking hides credentials, PINs and emails
- **Rule:** Nothing secret or personal reaches a report.
- **Given:** Headers with a bearer token and an API key, a body with PINs, an email and a nested access token, and a signed link.
- **When:** They are masked.
- **Then:** The token, key, PINs, access token and signature read `<redacted>`; the email keeps only its first letter and domain; other headers are unchanged.

## FWK-02 A read-only environment blocks every write before it leaves
- **Rule:** With `allowWrite: false` no POST, PUT, DELETE or PATCH is sent.
- **Given:** A client on a read-only environment.
- **When:** It sends each write method.
- **Then:** Each is stopped with a WriteBlockedError before any request goes out.

## FWK-03 Production is refused whatever the flags say
- **Rule:** The suite never targets production, and an environment must be complete before a run starts.
- **Given:** Environment settings marked production, named like production, with stubs but no WireMock, and with no test users.
- **When:** Each is checked.
- **Then:** The first two are refused as production; the others name what is missing; a complete one passes.

## FWK-04 Generated VINs are valid and marked as test data
- **Rule:** Test VINs pass the product's VIN rule and carry the `PWT` prefix the purge looks for.
- **Given:** 200 generated VINs.
- **When:** They are checked.
- **Then:** All match `PWT` plus 14 VIN characters, and none repeats.

## FWK-05 The contract check catches an unknown field, a wrong type and an unknown operation
- **Rule:** A response is held to the reviewed contract: no extra fields, the right types, and only documented operations.
- **Given:** The reviewed contract of service A.
- **When:** A profile with an extra field, one with a wrong type, a call to an undocumented operation and a bad error envelope are validated.
- **Then:** Each is reported, naming the field or the operation.

## FWK-06 The contract diff calls a renamed response field and a new required request field breaking
- **Rule:** Changes that break existing clients are breaking; additions are information.
- **Given:** Service A's contract with the profile's `email` renamed `mailAddress` and a new required `otp` on the PIN change.
- **When:** The two contracts are compared.
- **Then:** The removed `email` and the required `otp` are breaking; `mailAddress` is information; a contract compared with itself has no change.
