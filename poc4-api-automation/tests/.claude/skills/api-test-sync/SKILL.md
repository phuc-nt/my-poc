---
name: api-test-sync
description: Bring the API test cases and tests up to date with changes in the product source code or its API contract. Use after product code changes (a merged pull request, a new release, a branch to review), when cases:check --strict reports stale features or unmapped source, when the contract drift test fails, or when asked "are the tests up to date", "what does this change break", "sync the tests".
---

# Sync the tests with the product

Read `AGENTS.md` first. The goal: every feature's cases describe what the current code does, and every test checks that.

## 1. Find what changed

```bash
npm run cases:impact                          # since each feature's last review (review.lock.json)
npm run cases:impact -- --base origin/main    # or: what this branch changes
npm run cases:impact -- --json                # the same, for a script
```
For the contract part, the build-output OpenAPI must be fresh: build the services first (in this PoC, `cd ../sim && mvn -q verify`).

The report gives, per feature: the changed source files, the contract changes (breaking / info), the cases on changed operations, the specs, and a `Run:` command. At the end it lists source changes no feature maps and contract changes no case covers.

## 2. Review each impacted feature

For each feature in the report:
1. Read the diff of its changed files (`git diff <commit from review.lock.json> -- <file>` in that root, or `git log -p`). Decide what changed in behaviour: a new field, a new rule, a new error code, a changed limit, a new third-party call, or nothing visible (a refactor).
2. Run the `Run:` command on an environment that has the new code. Failures tell you which assertions are outdated; passes do not prove the cases are complete.
3. Update the case file first: change the `Rule`, `Given`, `When`, `Then` that no longer hold; add cases for new rules and operations (`cases:next-id`); remove or mark `manual` the cases for removed behaviour. Then update the tests to match.
4. A breaking contract change: confirm with a person that it is intended (when it is not, it is a product defect: report it and stop for that feature). When intended, `npm run contracts:update`, and review the diff of `contracts/` before keeping it.
5. Re-run the feature's tests; then `npm run cases:stamp -- <FEATURE>`.

A pure refactor with no behaviour change still gets a stamp, after you read the diff and the tests pass. Say so in your answer.

## 3. Close the gaps

- **Unmapped source.** Each changed file no feature maps is either part of an existing feature (add it to that feature's `source:` list), a new feature (write it with the api-test-write skill), or not testable through the API (add it to `sourceIgnore` in `kit.config.json`).
- **Uncovered operations.** Each new operation in the contract needs a case, or an entry in `kit.config.json` `uncoveredOperations` with the reason.

## 4. Finish

```bash
npm run typecheck
npm run cases:matrix
npm run cases:check -- --strict      # no stale feature, no unmapped source, no uncovered operation
```
Answer with a table: feature, what changed in the product, cases added / changed / removed, tests run and passed, and any change you think is a defect. Do not stamp a feature you did not review.
