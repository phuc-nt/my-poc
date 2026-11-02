---
feature: B-VIN
title: VIN registration through the external workflow
service: b
specs:
  - specs/service-b/vin-registration.spec.ts
source:
  - service-b:src/main/java/**/controller/BackOfficeController.java
  - service-b:src/main/java/**/controller/PartnerCallbackController.java
  - service-b:src/main/java/**/service/VinRegistrationService*.java
  - service-b:src/main/java/**/repository/VinRegistration*.java
  - service-b:src/main/resources/mapper/VinRegistrationRepository.xml
  - service-b:src/main/java/**/dto/VinRegistration*.java
  - service-b:src/main/java/**/dto/VinCallback.java
  - service-b:src/main/java/**/dto/CallbackResult.java
  - common:src/main/java/**/validation/Vin.java
---

# B-VIN: VIN registration through the external workflow

Before a customer can own a vehicle in the app, the back office registers its VIN. Service B starts an external workflow (the vehicle catalogue check) and records the VIN as REQUESTED. The workflow reports back through a partner callback, signed with the partner key: SUCCEEDED makes the VIN REGISTERED, FAILED makes it REJECTED with a reason.

Tests create their own VINs with the `PWT` prefix, which the purge of test data (adoption guide Q11) recognises.

## B-VIN-01 A VIN is requested, then registered by the workflow callback
- **Rule:** A registration starts the `vin-registration` workflow with the VIN and model, and the callback completes it.
- **Given:** A new test VIN.
- **When:** The back office registers it with model PW100; the workflow calls back SUCCEEDED; the back office reads the registration.
- **Then:** The request is 202 REQUESTED with an execution id. The workflow provider received the VIN and model. The callback answers REGISTERED, and so does the read.
- **Operations:** `POST /bo/v1/vin-registrations`, `POST /partner/v1/callbacks/vin-registration`, `GET /bo/v1/vin-registrations/{vin}`

## B-VIN-02 Callbacks are idempotent; a conflicting result is refused
- **Rule:** The workflow may call back twice with the same result; a different result after the first is a conflict.
- **Given:** A VIN whose registration was requested.
- **When:** The workflow calls back FAILED twice, then SUCCEEDED.
- **Then:** Both FAILED callbacks are OK with REJECTED and the reason. The SUCCEEDED one is 409 E250 on `result`.
- **Operations:** `POST /bo/v1/vin-registrations`, `POST /partner/v1/callbacks/vin-registration`

## B-VIN-03 A duplicate VIN and a wrong execution id are refused
- **Rule:** A VIN is registered once; a callback must name the execution that was started.
- **Given:** A VIN whose registration was requested.
- **When:** The back office registers it again; the workflow calls back with the execution id "exec-wrong".
- **Then:** The second registration is 409 E250 on `vin`. The callback is 404 E243 on `executionId`.
- **Operations:** `POST /bo/v1/vin-registrations`, `POST /partner/v1/callbacks/vin-registration`

## B-VIN-04 A workflow that cannot start is E611 and nothing is saved
- **Rule:** When the workflow provider is down, the registration fails as a whole: no VIN is left half-registered.
- **Given:** A new test VIN, and a workflow provider that answers 503 for this request only.
- **When:** The back office registers it, then reads it.
- **Then:** The registration is 502 E611; the read is 404 E243 on `vin`.
- **Operations:** `POST /bo/v1/vin-registrations`, `GET /bo/v1/vin-registrations/{vin}`

## B-VIN-05 Bad VINs and model codes are refused
- **Rule:** A VIN has 17 capitals and digits without I, O or Q; a model code has 3 to 10 capitals and digits (PW100).
- **Given:** A back-office caller.
- **When:** It registers a VIN containing an I, one containing an O, "SHORT", and a lower-case one; then a model "p"; then reads the VIN "BAD".
- **Then:** Each is 400 E200 on `vin`, except the model, which is on `modelCode`.
- **Operations:** `POST /bo/v1/vin-registrations`, `GET /bo/v1/vin-registrations/{vin}`

## B-VIN-06 Callbacks need the partner key
- **Rule:** Only the workflow, with the partner key, may report a result.
- **Given:** A callback body.
- **When:** It is sent with no credentials, then with a wrong partner key.
- **Then:** Both are 401 E101.
- **Operations:** `POST /partner/v1/callbacks/vin-registration`
