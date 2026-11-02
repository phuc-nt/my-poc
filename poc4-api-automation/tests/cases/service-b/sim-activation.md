---
feature: B-SIM
title: SIM activation of a telematics unit
service: b
specs:
  - specs/service-b/tcu.spec.ts
source:
  - service-b:src/main/java/**/controller/BackOfficeController.java
  - service-b:src/main/java/**/controller/PartnerCallbackController.java
  - service-b:src/main/java/**/service/TcuService*.java
  - service-b:src/main/java/**/repository/Tcu*.java
  - service-b:src/main/resources/mapper/TcuRepository.xml
  - service-b:src/main/java/**/dto/Tcu.java
  - service-b:src/main/java/**/dto/SimState.java
  - service-b:src/main/java/**/dto/SimStatusCallback.java
---

# B-SIM: SIM activation of a telematics unit

Each vehicle has a telematics unit (TCU) with a SIM card. The back office orders the SIM's activation from the carrier; the unit is ACTIVATING until the carrier calls back with the new status. Each worker uses its own unit from the environment's pool and puts it back to INACTIVE after each test.

## B-SIM-01 Activation is ordered, then active once the carrier calls back
- **Rule:** Ordering an activation calls the carrier for the unit's SIM and sets ACTIVATING. A second order while one is running is a conflict. The carrier's callback finishes it.
- **Given:** An INACTIVE unit from the pool.
- **When:** The back office orders the activation, orders it again, then the carrier calls back ACTIVE.
- **Then:** The order is 202 ACTIVATING with the ICCID and an order id, and the carrier got `/telecom/v1/sims/<iccid>/activation`. The second order is 409 E250. The callback is OK with ACTIVE and the same order id.
- **Operations:** `POST /bo/v1/tcus/{tcuId}/sim/activate`, `POST /partner/v1/callbacks/sim-status`, `GET /bo/v1/tcus/{tcuId}`

## B-SIM-02 A carrier failure is E611 and the unit stays INACTIVE
- **Rule:** When the carrier is down, nothing changes on the unit.
- **Given:** An INACTIVE unit, and a carrier that answers 503 for this request only.
- **When:** The back office orders the activation, then reads the unit.
- **Then:** 502 E611, and the unit is still INACTIVE.
- **Operations:** `POST /bo/v1/tcus/{tcuId}/sim/activate`, `GET /bo/v1/tcus/{tcuId}`

## B-SIM-03 Unknown and malformed unit and SIM ids are refused
- **Rule:** A unit id looks like TCU-0001; an ICCID has 19 or 20 digits; the SIM status is one the carrier sends.
- **Given:** A back-office caller and the partner key.
- **When:** The back office reads TCU-9999 and "tcu-1"; the carrier calls back for an unknown ICCID, for "123", and with the status BROKEN.
- **Then:** 404 E243 on `tcuId`, 400 E200 on `tcuId`, 404 E243 on `iccid`, 400 E200 on `iccid`, 400 E200 on `status`.
- **Operations:** `GET /bo/v1/tcus/{tcuId}`, `POST /partner/v1/callbacks/sim-status`
