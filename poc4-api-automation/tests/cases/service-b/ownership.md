---
feature: B-OWN
title: Vehicle ownership and subscriptions
service: b
specs:
  - specs/service-b/ownership.spec.ts
source:
  - service-b:src/main/java/**/controller/AppOwnershipController.java
  - service-b:src/main/java/**/controller/InternalController.java
  - service-b:src/main/java/**/service/OwnershipService*.java
  - service-b:src/main/java/**/service/ServiceAClient.java
  - service-b:src/main/java/**/repository/Ownership*.java
  - service-b:src/main/java/**/repository/Subscription*.java
  - service-b:src/main/resources/mapper/OwnershipRepository.xml
  - service-b:src/main/resources/mapper/SubscriptionRepository.xml
  - service-b:src/main/java/**/dto/Ownership.java
  - service-b:src/main/java/**/dto/CreateOwnershipRequest.java
  - service-b:src/main/java/**/dto/Plan.java
  - service-b:src/main/java/**/dto/Subscription*.java
  - service-b:src/main/java/**/dto/VinOwner.java
  - service-b:src/main/java/**/ServiceBProperties.java
  - common:src/main/java/**/DownstreamClient.java
---

# B-OWN: Vehicle ownership and subscriptions

A customer adds a registered vehicle to the app (an ownership) and can buy one connected-service plan for it. Service B asks service A whether the user exists and is not locked, and charges the plan through the payment provider. Other systems look up a vehicle's current owner through the internal API.

Each test ends every active ownership it created.

## B-OWN-01 Own a registered vehicle, look the owner up, then end it
- **Rule:** A registered VIN can have one active owner. The internal lookup returns that owner until the ownership ends.
- **Given:** A registered test VIN and a test user.
- **When:** The user adds the vehicle; a back-end system looks up its owner; the user adds it again; the user ends the ownership twice; the owner is looked up again.
- **Then:** The ownership is 201. The lookup returns the VIN, the user and the ownership. The second add is 409 E250 on `vin`. The first end is OK with ENDED, the second 404 E243 on `ownershipId`. The last lookup is 404 E243.
- **Operations:** `POST /app/v1/users/{userId}/ownerships`, `GET /internal/v1/vins/{vin}/owner`, `DELETE /app/v1/users/{userId}/ownerships/{ownershipId}`

## B-OWN-02 An unregistered VIN cannot be owned
- **Rule:** Only a VIN that went through registration can be owned.
- **Given:** A test VIN that was never registered.
- **When:** A user adds it.
- **Then:** 404 E243 on `vin`.
- **Operations:** `POST /app/v1/users/{userId}/ownerships`

## B-OWN-03 A locked user cannot add a vehicle
- **Rule:** Service B refuses users that service A reports as locked.
- **Given:** The environment's locked test user.
- **When:** That user adds a vehicle.
- **Then:** 403 E206.
- **Operations:** `POST /app/v1/users/{userId}/ownerships`

## B-OWN-04 A subscription charges the plan price once; a second plan is refused
- **Rule:** An ownership has at most one active plan. Subscribing charges the plan price (BASIC: 980 JPY) once to the user.
- **Given:** A test user who owns a registered vehicle.
- **When:** The user subscribes to BASIC, then to PREMIUM, then lists the subscriptions.
- **Then:** BASIC is 201 ACTIVE with a payment reference. The payment provider got one charge of 980 JPY for the user. PREMIUM is 409 E250. The list has one subscription.
- **Operations:** `POST /app/v1/users/{userId}/ownerships/{ownershipId}/subscriptions`, `GET /app/v1/users/{userId}/ownerships/{ownershipId}/subscriptions`, `POST /app/v1/users/{userId}/ownerships`

## B-OWN-05 A declined card makes no subscription
- **Rule:** When the payment is declined, the user is told (E610) and no subscription exists.
- **Given:** A test user who owns a registered vehicle, and a payment provider that declines this request only.
- **When:** The user subscribes to PREMIUM, then lists the subscriptions.
- **Then:** 422 E610, and the list is empty.
- **Operations:** `POST /app/v1/users/{userId}/ownerships/{ownershipId}/subscriptions`, `GET /app/v1/users/{userId}/ownerships/{ownershipId}/subscriptions`

## B-OWN-06 A slow payment provider times out as E611
- **Rule:** Service B stops waiting for the payment provider after its timeout (2 s), so the app is not left hanging.
- **Given:** A test user who owns a registered vehicle, and a payment provider that answers after 3 s for this request only.
- **When:** The user subscribes to BASIC.
- **Then:** 502 E611 in under 2.9 s.
- **Operations:** `POST /app/v1/users/{userId}/ownerships/{ownershipId}/subscriptions`

## B-OWN-07 Bad ownership and subscription input is refused on the field
- **Rule:** A nickname has at most 32 characters, a plan is BASIC or PREMIUM, an ownership id is a uuid.
- **Given:** A test user.
- **When:** The user adds a vehicle with a 33-character nickname, subscribes to GOLD, and lists the subscriptions of ownership "nope".
- **Then:** Each is 400 E200 on `nickname`, `plan` and `ownershipId`.
- **Operations:** `POST /app/v1/users/{userId}/ownerships`, `POST /app/v1/users/{userId}/ownerships/{ownershipId}/subscriptions`, `GET /app/v1/users/{userId}/ownerships/{ownershipId}/subscriptions`
