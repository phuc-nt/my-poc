---
feature: A-DEV
title: Push devices of a user
service: a
specs:
  - specs/service-a/devices-consents.spec.ts
source:
  - service-a:src/main/java/**/controller/AppUserController.java
  - service-a:src/main/java/**/service/DeviceService*.java
  - service-a:src/main/java/**/repository/Device*.java
  - service-a:src/main/resources/mapper/DeviceRepository.xml
  - service-a:src/main/java/**/dto/Device.java
  - service-a:src/main/java/**/dto/RegisterDeviceRequest.java
  - service-a:src/main/java/**/dto/Platform.java
---

# A-DEV: Push devices of a user

The mobile app registers the phone it runs on so that the user can receive push notifications. A user may have at most five devices; the app removes a device when the user signs out. Each test removes every device it registered.

## A-DEV-01 Register, list and remove a device
- **Rule:** A registered device appears in the user's list until it is removed; removing it twice is an unknown device.
- **Given:** A test user with no devices.
- **When:** The app registers an iOS device, lists the devices, removes the device, and removes it again.
- **Then:** The registration is 201 and returns a device id. The list contains it. The removal is OK. The second removal is 404 E243.
- **Operations:** `POST /app/v1/users/{userId}/devices`, `GET /app/v1/users/{userId}/devices`, `DELETE /app/v1/users/{userId}/devices/{deviceId}`

## A-DEV-02 A sixth device is refused
- **Rule:** A user may have at most five devices.
- **Given:** A test user with no devices.
- **When:** The app registers five devices, then a sixth.
- **Then:** The first five are 201; the sixth is 409 E250.
- **Operations:** `POST /app/v1/users/{userId}/devices`

## A-DEV-03 Bad device input is refused on the field
- **Rule:** The platform must be IOS or ANDROID, the push token is required and at most 256 characters, and a device id must be a uuid.
- **Given:** A test user.
- **When:** The app registers a WINDOWS device, a device with no push token, a device with a 257-character token, and removes the device "not-an-id".
- **Then:** Each is 400 E200 on the field at fault: `platform`, `pushToken`, `pushToken`, `deviceId`.
- **Operations:** `POST /app/v1/users/{userId}/devices`, `DELETE /app/v1/users/{userId}/devices/{deviceId}`
