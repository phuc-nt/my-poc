---
feature: SMK
title: Smoke suite
service: a
specs:
  - specs/smoke.spec.ts
source:
  - service-a:src/main/java/**/controller/*.java
  - service-b:src/main/java/**/controller/*.java
  - common:src/main/java/**/HealthController.java
---

# SMK: Smoke suite

The first suite to run on any environment, and the pipeline's gate: when it fails, nothing else runs. It is read-only, takes about a second, and makes one call per caller group (app, web, back office, internal, anonymous) on each service, so a failure points at a whole caller group or service being down or misconfigured, not at a business rule.

## SMK-01 Both services report UP
- **Rule:** Each service answers its health check without credentials.
- **Given:** A deployed environment.
- **When:** An anonymous caller reads `/health` on A and on B.
- **Then:** Both are 200 with `{ "status": "UP" }`.
- **Operations:** `a GET /health`, `b GET /health`

## SMK-02 App: a user reads their own profile
- **Rule:** The app's user token works on service A.
- **Given:** A pooled test user.
- **When:** The user reads their profile through `/app`.
- **Then:** OK, with the user's own id.
- **Operations:** `GET /app/v1/users/{userId}`

## SMK-03 Web: the same profile through the web prefix
- **Rule:** The web site's token works on service A.
- **Given:** A pooled test user.
- **When:** The user reads their profile through `/web`.
- **Then:** OK.
- **Operations:** `GET /web/v1/users/{userId}`

## SMK-04 Back office: user search answers a page
- **Rule:** The back-office credentials work on service A.
- **Given:** The back-office test identity.
- **When:** It searches users with page size 5.
- **Then:** OK, with at most 5 users.
- **Operations:** `GET /bo/v1/users`

## SMK-05 Internal: user status with the API key
- **Rule:** The internal API key works on service A.
- **Given:** The internal API key.
- **When:** It reads a pooled test user's status.
- **Then:** OK.
- **Operations:** `GET /internal/v1/users/{userId}`

## SMK-06 App: a user lists their vehicles on service B
- **Rule:** The app's user token works on service B.
- **Given:** A pooled test user.
- **When:** The user lists their ownerships.
- **Then:** OK.
- **Operations:** `b GET /app/v1/users/{userId}/ownerships`

## SMK-07 Back office: a telematics unit on service B
- **Rule:** The back-office credentials work on service B.
- **Given:** A unit from the environment's pool (skipped when there is no pool).
- **When:** The back office reads the unit.
- **Then:** OK.
- **Operations:** `b GET /bo/v1/tcus/{tcuId}`

## SMK-08 No credentials is refused with E101
- **Rule:** Protected endpoints refuse anonymous callers in the envelope.
- **Given:** No credentials.
- **When:** An anonymous caller reads a profile on A and a unit on B.
- **Then:** Both are 401 E101.
- **Operations:** `a GET /app/v1/users/{userId}`, `b GET /bo/v1/tcus/{tcuId}`
