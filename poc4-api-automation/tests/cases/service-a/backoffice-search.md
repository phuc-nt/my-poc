---
feature: A-BOS
title: Back-office user search and unlock
service: a
specs:
  - specs/service-a/backoffice-export.spec.ts
source:
  - service-a:src/main/java/**/controller/BackOfficeController.java
  - service-a:src/main/java/**/service/UserService*.java
  - service-a:src/main/java/**/repository/UserR*.java
  - service-a:src/main/resources/mapper/UserRepository.xml
  - service-a:src/main/java/**/dto/UserPage.java
  - service-a:src/main/java/**/dto/UserSummary.java
---

# A-BOS: Back-office user search and unlock

Support staff look users up by email (a partial match) and page through the results. They can unlock a user who locked the account with wrong PINs (the unlock itself is exercised in A-PIN-03).

The search tests rely on the eight seeded test users whose emails start with `pw-user-`.

## A-BOS-01 Search by email pages through the matches
- **Rule:** The search matches part of the email and pages the result; the total counts every match.
- **Given:** Eight test users whose emails start with `pw-user-`.
- **When:** Support searches `pw-user-` with page size 3, pages 0 and 2.
- **Then:** Page 0 has 3 users and total 8; page 2 has the last 2.
- **Operations:** `GET /bo/v1/users`

## A-BOS-02 Bad paging and filters are refused on the parameter
- **Rule:** The page size is 1 to 100, the page is a number from 0, and an email filter has at least 3 characters.
- **Given:** A back-office caller.
- **When:** Support searches with size 0, size 101, page -1, page "x" and email "ab".
- **Then:** Each is 400 E200 on `size`, `size`, `page`, `page` and `email`.
- **Operations:** `GET /bo/v1/users`

## A-BOS-03 Unlocking an unknown user is refused
- **Rule:** Support can only unlock a user who exists.
- **Given:** A user id that no user has.
- **When:** Support unlocks it.
- **Then:** 404 E243.
- **Operations:** `POST /bo/v1/users/{userId}/unlock`
