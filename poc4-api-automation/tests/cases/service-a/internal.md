---
feature: A-INT
title: Internal user API and push
service: a
specs:
  - specs/service-a/internal-protocol.spec.ts
source:
  - service-a:src/main/java/**/controller/InternalController.java
  - service-a:src/main/java/**/service/NotificationService*.java
  - service-a:src/main/java/**/service/UserService*.java
  - service-a:src/main/java/**/dto/InternalUserStatus.java
  - service-a:src/main/java/**/dto/Push*.java
  - common:src/main/java/**/DownstreamClient.java
---

# A-INT: Internal user API and push

Other back-end systems (service B among them) call service A's internal API with the internal API key: to read a user's status (exists, locked) and to push a notification to all of a user's devices through the push provider.

## A-INT-01 A push to a user with no device sends nothing
- **Rule:** A push to a user without devices succeeds and reports zero sends.
- **Given:** A test user with no devices.
- **When:** A back-end system pushes a notification to the user.
- **Then:** OK with `sent: 0`.
- **Operations:** `POST /internal/v1/users/{userId}/notifications`

## A-INT-02 A push provider failure is E611
- **Rule:** When the push provider fails, the caller gets E611 rather than a false success; the same push succeeds once the provider is back.
- **Given:** A test user with one Android device, and a push provider that answers 500 for this request only.
- **When:** A back-end system pushes, then pushes again without the fault.
- **Then:** The first push is 502 E611. The second is OK with `sent: 1`. The test removes the device.
- **Operations:** `POST /internal/v1/users/{userId}/notifications`, `POST /app/v1/users/{userId}/devices`, `DELETE /app/v1/users/{userId}/devices/{deviceId}`

## A-INT-03 An unknown user is refused
- **Rule:** The status of a user who does not exist is not found, not an empty status.
- **Given:** A user id no user has.
- **When:** A back-end system reads its status.
- **Then:** 404 E243.
- **Operations:** `GET /internal/v1/users/{userId}`
