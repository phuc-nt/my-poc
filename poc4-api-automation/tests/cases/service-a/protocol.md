---
feature: A-PRO
title: Shared API protocol
service: a
specs:
  - specs/service-a/internal-protocol.spec.ts
source:
  - common:src/main/java/**/Correlation*.java
  - common:src/main/java/**/EnvelopeWriter.java
  - common:src/main/java/**/ResultHeader*.java
  - common:src/main/java/**/GlobalExceptionHandler.java
  - common:src/main/java/**/ErrorCode.java
  - common:src/main/java/**/RestApiResponse.java
  - common:src/main/java/**/ApiError.java
  - common:src/main/java/**/ApiException.java
  - common:src/main/java/**/Responses.java
  - common:src/main/java/**/CommonConfig.java
  - common:src/main/java/**/validation/UserId.java
  - service-a:src/main/resources/application.yml
  - service-a:src/main/java/**/dto/UserProfile.java
---

# A-PRO: Shared API protocol

Every endpoint of both services follows one protocol, which the mobile app, the web site and the back office all rely on:
- each request carries an `X-One-Time-Uuid`, which the response echoes in `X_ONE_TIME_UUID` (one is generated when it is missing);
- every answer, success or error, is the `RestApiResponse` envelope with the `X_RESULT_STATUS` and `X_ERROR_CODE` headers;
- errors map to fixed codes: E200 bad input, E201 wrong method, E243 not found;
- user ids contain `|` (for example `auth0|...`) and must work raw and percent-encoded.

The tests run against service A; service B shares the code (the `common` module).

## A-PRO-01 The uuid is echoed, or generated when missing
- **Rule:** The response carries the caller's `X-One-Time-Uuid` back; without one, the service makes one up and still answers.
- **Given:** A test user.
- **When:** The user reads the profile with a uuid, then without one.
- **Then:** The first response's `X_ONE_TIME_UUID` equals the uuid sent. The second is OK.
- **Operations:** `GET /app/v1/users/{userId}`

## A-PRO-02 A malformed uuid is refused on the header
- **Rule:** An `X-One-Time-Uuid` that is not a uuid is bad input.
- **Given:** A test user.
- **When:** The user reads the profile with the uuid "not-a-uuid".
- **Then:** 400 with the first error E200 on the field `X-One-Time-Uuid`.
- **Operations:** `GET /app/v1/users/{userId}`

## A-PRO-03 An unknown route answers E243 in the envelope
- **Rule:** A path no endpoint has is answered in the envelope, not with the server's default page.
- **Given:** A back-office caller.
- **When:** It calls `/bo/v1/nothing-here`.
- **Then:** 404 E243.

## A-PRO-04 A wrong method answers E201
- **Rule:** A method an endpoint does not support is E201 in the envelope.
- **Given:** A back-office caller.
- **When:** It sends DELETE to the user search.
- **Then:** 405 E201.

## A-PRO-05 Malformed JSON and a wrong content type are refused in the envelope
- **Rule:** A body the service cannot read is refused with the envelope, never with a stack trace.
- **Given:** A test user.
- **When:** The app registers a device with truncated JSON, then with an XML body.
- **Then:** The JSON one is 400 E200. The XML one is an error status of 400 or above with `result: NG`.
- **Operations:** `POST /app/v1/users/{userId}/devices`

## A-PRO-06 User ids with "|" work raw and percent-encoded
- **Rule:** The services accept a raw `|` in the path (Tomcat relaxed characters) and the encoded `%7C`.
- **Given:** A test user whose id contains `|`.
- **When:** The user reads the profile with the id percent-encoded, then raw.
- **Then:** Both are OK and return the same user id.
- **Operations:** `GET /app/v1/users/{userId}`

## A-PRO-07 A malformed user id is refused on userId
- **Rule:** A user id without the `provider|id` shape is bad input, checked after authorisation.
- **Given:** A caller with the internal API key.
- **When:** It reads the status of the user "no-pipe-here".
- **Then:** 400 E200 on `userId`.
- **Operations:** `GET /internal/v1/users/{userId}`
