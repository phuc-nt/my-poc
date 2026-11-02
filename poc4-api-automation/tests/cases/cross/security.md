---
feature: SEC
title: Access control on both services
service: a
specs:
  - specs/security.spec.ts
source:
  - common:src/main/java/**/SecurityConfig.java
  - common:src/main/java/**/ApiKeyFilter.java
  - common:src/main/java/**/OwnerGuard.java
  - common:src/main/java/**/SimProperties.java
  - service-b:src/main/resources/application.yml
---

# SEC: Access control on both services

Who may call what. Each path prefix belongs to one caller group: `/app` and `/web` take a user token and only for the user's own data, `/bo` takes a back-office token, `/internal` takes the internal API key, `/partner` takes the partner key. A caller with no or bad credentials is E101 (401); a caller who is known but not allowed is E102 (403). The suite is read-only, so it runs on every environment.

## SEC-01 An expired token is refused
- **Rule:** A token past its expiry time is not accepted.
- **Given:** A user token that expired a minute ago (needs an IdP that can issue one; skipped elsewhere).
- **When:** The user reads their profile.
- **Then:** 401 E101.
- **Operations:** `GET /app/v1/users/{userId}`

## SEC-02 A tampered or unsigned token is refused
- **Rule:** Only tokens signed by the IdP are accepted.
- **Given:** A valid user token.
- **When:** The user reads their profile with the signature changed, with `alg: none` and no signature, and with "not-a-jwt".
- **Then:** Each is 401 E101.
- **Operations:** `GET /app/v1/users/{userId}`

## SEC-03 A user cannot read another user's data
- **Rule:** On `/app` and `/web`, the path's user id must be the token's user, on both services.
- **Given:** Two pooled test users.
- **When:** One user reads the other's profile on `/app` and `/web` and the other's ownerships on B.
- **Then:** Each is 403 E102.
- **Operations:** `GET /app/v1/users/{userId}`, `GET /web/v1/users/{userId}`, `b GET /app/v1/users/{userId}/ownerships`

## SEC-04 A user token on /bo and a back-office token on /app are refused
- **Rule:** Tokens are scoped: a user is not support staff, and support staff do not act as a user.
- **Given:** A user token and a back-office token.
- **When:** The user searches users on `/bo`; the back office reads a profile on `/app`.
- **Then:** Both are 403 E102.
- **Operations:** `GET /bo/v1/users`, `GET /app/v1/users/{userId}`

## SEC-05 /internal and /partner take only their own key
- **Rule:** No key or a wrong key is E101; a valid user or back-office token without the key is known but not allowed, E102.
- **Given:** A user token, the partner key, a wrong key, the internal key and a back-office token.
- **When:** Each calls an internal endpoint on A, the internal key calls `/bo` on B, and a user and a back-office token send a partner callback on B (only where writes are allowed).
- **Then:** The user token on `/internal` is 403 E102; the partner key, the wrong key and the internal key on `/bo` are 401 E101; the callbacks with tokens are 403 E102.
- **Operations:** `GET /internal/v1/users/{userId}`, `b GET /bo/v1/tcus/{tcuId}`, `b POST /partner/v1/callbacks/sim-status`

## SEC-06 Error bodies leak no stack trace or SQL
- **Rule:** No error answer shows internals (exception names, stack frames, SQL, framework packages).
- **Given:** An anonymous call, an unknown route and a malformed user id.
- **When:** Each is sent.
- **Then:** None of the bodies mentions an exception, a stack frame, SQL, Spring or MyBatis.
- **Operations:** `GET /app/v1/users/{userId}`
