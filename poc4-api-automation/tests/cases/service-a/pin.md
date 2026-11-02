---
feature: A-PIN
title: PIN change and account lock
service: a
specs:
  - specs/service-a/pin.spec.ts
source:
  - service-a:src/main/java/**/controller/AppUserController.java
  - service-a:src/main/java/**/service/UserService*.java
  - service-a:src/main/java/**/repository/UserR*.java
  - service-a:src/main/resources/mapper/UserRepository.xml
  - service-a:src/main/java/**/dto/ChangePinRequest.java
  - service-a:src/main/java/**/dto/PinChangeResult.java
  - common:src/main/java/**/validation/Pin.java
  - common:src/main/java/**/EventPublisher.java
---

# A-PIN: PIN change and account lock

A user protects sensitive actions in the mobile app with a six-digit PIN. The user can change it by giving the current PIN. Five wrong PINs in a row lock the account; only the back office can unlock it. Weak PINs (repeated or sequential digits) are refused. Every change is published as `user.pin-changed` so that other systems can notify the user.

Each test leaves the worker's user unlocked with the seed PIN: the back office unlock runs after every test.

## A-PIN-01 A wrong PIN says how many attempts are left
- **Rule:** A wrong current PIN is refused, and the user is told how many attempts remain before the lock.
- **Given:** A test user with no failed attempts.
- **When:** The user changes the PIN with a wrong current PIN.
- **Then:** 400 E204 on `currentPin`, and the message says "4 attempts left".
- **Operations:** `PUT /app/v1/users/{userId}/pin`

## A-PIN-02 A weak new PIN is refused
- **Rule:** The new PIN must be six digits and not trivially guessable.
- **Given:** A test user who knows the current PIN.
- **When:** The user tries 111111, 123456, 654321, 12345 and abcdef as the new PIN.
- **Then:** Each is 400 E200 on `newPin`, and the PIN does not change.
- **Operations:** `PUT /app/v1/users/{userId}/pin`

## A-PIN-03 The fifth wrong PIN locks the account until the back office unlocks it
- **Rule:** Five consecutive wrong PINs lock the account. A locked account refuses even the right PIN. The back office can unlock it.
- **Given:** A test user with no failed attempts.
- **When:** The user enters a wrong PIN five times, then the right PIN, then the back office unlocks the user.
- **Then:** Attempts one to four are 400 E204. The fifth is 403 E206. The right PIN is then 403 E206 too, and the profile shows `locked: true`. After the unlock the profile shows `locked: false`.
- **Operations:** `PUT /app/v1/users/{userId}/pin`, `GET /app/v1/users/{userId}`, `POST /bo/v1/users/{userId}/unlock`

## A-PIN-04 The right PIN changes it and publishes user.pin-changed
- **Rule:** With the right current PIN the PIN changes at once, the old PIN stops working, and a `user.pin-changed` event goes to the `user-events` topic.
- **Given:** A test user who knows the current PIN.
- **When:** The user changes the PIN, then tries the old PIN again.
- **Then:** The change is OK, one `user.pin-changed` event carries the request's uuid, and the old PIN is 400 E204. The test changes the PIN back afterwards.
- **Operations:** `PUT /app/v1/users/{userId}/pin`
