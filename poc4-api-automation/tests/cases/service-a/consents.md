---
feature: A-CNS
title: Privacy consents
service: a
specs:
  - specs/service-a/devices-consents.spec.ts
source:
  - service-a:src/main/java/**/controller/AppUserController.java
  - service-a:src/main/java/**/controller/WebUserController.java
  - service-a:src/main/java/**/service/ConsentService*.java
  - service-a:src/main/java/**/repository/Consent*.java
  - service-a:src/main/resources/mapper/ConsentRepository.xml
  - service-a:src/main/java/**/dto/Consent*.java
  - common:src/main/java/**/EventPublisher.java
---

# A-CNS: Privacy consents

A user agrees to (or declines) each version of the terms and the marketing policy. The mobile app saves the answer; the app and the web site both show the current answers. Every change is published as `consent.updated` on the `privacy-events` topic, which the privacy team's systems consume.

## A-CNS-01 A saved consent shows on app and web and is published
- **Rule:** A saved consent is visible through both the app and the web prefix, and is published once as `consent.updated`.
- **Given:** A test user.
- **When:** The app saves the MARKETING consent with a new version, agreed; then the app and the web list the consents.
- **Then:** The save is OK. Both lists contain MARKETING with that version and `agreed: true`. One `consent.updated` event with the type and version carries the request's uuid.
- **Operations:** `PUT /app/v1/users/{userId}/consents/{consentType}`, `GET /app/v1/users/{userId}/consents`, `GET /web/v1/users/{userId}/consents`

## A-CNS-02 Bad consent input is refused on the field
- **Rule:** The version looks like 2.1, the answer (agreed) is required, and the consent type is one the product knows (TERMS, PRIVACY, MARKETING).
- **Given:** A test user.
- **When:** The app saves TERMS with version "v2", TERMS with no answer, and COOKIES.
- **Then:** Each is 400 E200 on `version`, `agreed` and `consentType`.
- **Operations:** `PUT /app/v1/users/{userId}/consents/{consentType}`
