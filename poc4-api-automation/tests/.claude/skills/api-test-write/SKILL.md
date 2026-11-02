---
name: api-test-write
description: Write new API tests for a product feature, endpoint or business rule, together with the plain-language test cases they automate. Use when asked to "add tests for", "cover", "automate" an API or feature, or to turn a requirement, ticket or bug into tests.
---

# Write API tests with their cases

Read `AGENTS.md` first. The order matters: case, then code.

## 1. Understand the feature from the code

- Find the controller methods, request and response DTOs, validation (Bean Validation annotations, custom constraints), service logic, error codes and the third parties called. Follow the actual code: names, codes and limits come from there.
- Find the operations in the reviewed contract (`contracts/service-x.json`): path templates, required fields, response schema.
- Check `cases/` for an existing feature that already covers this area (`grep -rl "<path or class>" cases/`). Extend it instead of creating a near-duplicate.
- If the requirement and the code disagree, note it; do not pick silently.

## 2. Write the cases

- A new feature: copy `cases/_template.md` to `cases/<area>/<name>.md`. Choose the feature id (`A-XYZ`: service letter, three capitals). Fill the front matter:
  - `specs`: the spec file(s) you will write;
  - `source`: every product file the feature depends on, as `<root>:<glob>` (roots in `kit.config.json`). Include the controller, service, mapper, DTOs, validation classes and the config properties it reads. Too narrow and source changes go unnoticed; a whole folder is too wide.
- Each case: `npm run cases:next-id -- <FEATURE>` for its id, then `Rule` (the business rule, one sentence), `Given`, `When`, `Then` (in product terms: status, error code, the fields that matter), `Operations`.
- Cover, for each operation, at least: the success path; each validation rule with the field it names; access (the wrong caller group, another user's data); the main business refusals; a third party failing, if the operation calls one (`@stub`). Prefer one case per rule over one case per input value.
- A case that cannot be automated yet gets `Status: planned` (or `manual`, with the reason in `Notes`).

## 3. Write the tests

- Put them in the spec the front matter names, in a `test.describe` per feature. Tag each test with its one case id plus `@write` / `@stub` as needed. Follow an existing spec in the same folder for structure.
- Use the fixtures and the matchers (`toBeOk`, `toBeNg(status, code, field?)`). Create your own data, clean up in `finally` or `afterEach`.
- Loops over many inputs inside one test are fine; give each assertion a message (`expect(r, \`newPin ${weak}\`)`).

## 4. Prove it

```bash
npm run typecheck
npx playwright test --grep @<FEATURE>-        # on an environment that allows the tags you used
npm run cases:matrix
npm run cases:check
npm run cases:stamp -- <FEATURE>               # the cases now match the current source
```
Run each new test once against a deliberately wrong expectation (change a code or a status) to see it fail, then put it back: a test that cannot fail protects nothing.

## 5. Answer

List the cases added (id and title), the tests and their tags, what ran and passed, and anything that looked like a product defect (with the case id that shows it).
