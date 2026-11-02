---
feature: X-FEAT
title: Short name of the feature
service: a
specs:
  - specs/service-a/feature.spec.ts
source:
  - service-a:src/main/java/**/FeatureController.java
  - service-a:src/main/java/**/FeatureService.java
---

# X-FEAT: Short name of the feature

What the feature is for, who uses it, and what a tester must know about it.

## X-FEAT-01 The main success path
- **Rule:** The business rule this case protects.
- **Given:** The starting state.
- **When:** The action.
- **Then:** The expected outcome, in the product's terms.
- **Operations:** `POST /app/v1/feature`
- **Status:** planned
