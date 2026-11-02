---
feature: A-EXP
title: Asynchronous CSV export
service: a
specs:
  - specs/service-a/backoffice-export.spec.ts
source:
  - service-a:src/main/java/**/controller/BackOfficeController.java
  - service-a:src/main/java/**/controller/FileController.java
  - service-a:src/main/java/**/service/Export*.java
  - service-a:src/main/java/**/repository/Export*.java
  - service-a:src/main/resources/mapper/ExportRepository.xml
  - service-a:src/main/java/**/dto/Export*.java
  - service-a:src/main/java/**/ServiceAProperties.java
  - common:src/main/java/**/Digests.java
---

# A-EXP: Asynchronous CSV export

Support exports users or consents created in a date range (at most 31 days) as a CSV file. The request is queued and a background worker writes the file. Support polls the export until it is done, then downloads it through a signed, short-lived link. When a notify address is given, a mail tells that person the file is ready.

The row counts rely on the seeded users created in March 2026.

## A-EXP-01 An export is queued, then done with a signed link to the right rows
- **Rule:** An export starts QUEUED and ends DONE with the row count and a download link. The link is signed: any change to it is refused.
- **Given:** Four seeded users created in March 2026.
- **When:** Support exports USERS from 2026-03-01 to 2026-03-30, polls until DONE, downloads the file, then downloads a link with a changed signature.
- **Then:** The request is 202 QUEUED; the status becomes DONE with 4 rows. The file is CSV with the header `user_id,email,display_name,locked,created_at` and 4 rows. The changed link is 403.
- **Operations:** `POST /bo/v1/exports`, `GET /bo/v1/exports/{requestId}`, `GET /files/{fileName}`

## A-EXP-02 The notify address gets a mail once the file is ready
- **Rule:** When the request names a notify address, one mail goes there with the request id once the file is ready.
- **Given:** A back-office caller.
- **When:** Support exports CONSENTS for January 2026 with a notify address.
- **Then:** Within 15 s the mail provider receives one mail to that address with the request id, carrying the request's uuid.
- **Operations:** `POST /bo/v1/exports`

## A-EXP-03 A bad range or kind is refused
- **Rule:** The range ends after it starts, spans at most 31 days, uses real dates; the kind is USERS or CONSENTS; the notify address is an email.
- **Given:** A back-office caller.
- **When:** Support requests a reversed range, a two-month range, kind ORDERS, the date 2026-02-30, and the notify address "not-an-email".
- **Then:** Each is 400 E200; the last three name `kind`, `from` and `notifyEmail`.
- **Operations:** `POST /bo/v1/exports`

## A-EXP-04 An unknown export is refused
- **Rule:** Support can only read the status of an export that exists.
- **Given:** A request id no export has.
- **When:** Support reads its status.
- **Then:** 404 E243.
- **Operations:** `GET /bo/v1/exports/{requestId}`
