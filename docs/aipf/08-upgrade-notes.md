# AIPF: Hand-over Notes for the Upgrade Plan

These are the hand-over notes of [08](08-upgrade-plan.md), one section per line of its section 8.1, as rule 10 of section 9 asks. Each says what was built, what was not and why, the tests added, and the deploy steps. The code is in `aipf-sdlc`, one branch per line, merged into `main` locally.

## Line 1: records and labels (`upgrade/1-records-and-labels`)

Items: P0-6, REC-1, REC-2, REC-4, and UX-11's date normalisation.

**Built**
- **P0-6.** `jiraWebhook` decides on the changelog's label lists, not on the work item's labels alone. A run starts when `aipf` is in the new list and not in the old one, or when an item is created with `aipf`. The harness label (`aipf-pi`, and so on) still picks the harness, and a change to it alone starts nothing. Every call logs one JSON line `{webhook, event, issueKey, from, to, decision, reason}`, with `decision` one of `started`, `ignored`, `refused` or `failed`. A bad secret logs only `{"webhook":"jira","decision":"refused","reason":"bad secret"}`, with no path.
- **REC-1.** `nextAttempt` no longer adds an attempt when the failure budget runs out. An exhausted run keeps the attempt of its last session, so three failures end at attempt 3.
- **REC-2.** Each attempt that ends adds `{attempt, reason, at}` to the run's `retries` list. The console's run card and run page show the last retry and the count, from `retries` rather than `lastReason`. `lastReason` is still written, so the views that read it keep working until UX-12.
- **REC-4.** `afterDeveloper` writes its outcome (`pr`, `no_pr` or `needs_human`) as the developer session's verdict. It writes only when the session row exists, so it never makes a row up. The developer's verdicts in `registry/agents.json` are now `["pr", "no_pr", "needs_human"]`, so the session runner accepts them.
- **UX-11 (dates).** `runView` gives `startedAt` and `stoppedAt` as ISO strings, whether they come from the workflow (a `Date`) or the table (a string), so times compare and sort.
- **Store port.** `update(pk, sk, fields, { append })` adds values to the end of lists in the same write: DynamoDB `list_append`, a read and a write on the update time in Firestore (retried up to five times when another writer came first), and a plain append in memory. `platform/README.md` describes it. REC-2 needs it, and P0-3's amendments will use it.

**Differences from the plan**
- The webhook's reasons are finer than the plan's list: `aipf removed`, `aipf not added`, `already labelled`, `no label change`, `no work item`, `not this project`, `harness not allowed`, and `locked by <runId>`.
- The `paused` reason waits for line 3, where P0-2 adds `PLATFORM/PAUSE`.

**Not built.** Nothing else in the line.

**Tests** (95 in all, all passing; 88 before)
- `orchestrator.test.mjs`:
  - the label cases: aipf added, removed, already there, `aipf-pi` alone, `aipf` added beside `aipf-pi` (harness pi) and beside another `aipf-*` label (claude-code), created with `aipf`, and no label change;
  - the decision lines, the lock reason, and the bad secret logged without a path;
  - the retries list and the exhausted attempt;
  - three failures ending at attempt 3;
  - the developer verdicts, with no session row made up.
- `platform.test.mjs`: `append` in the memory store, and the Firestore read, conflict and write-back.

**Deploy.** This line changes Lambda and console code only, with no stack resource and no workflow change.
1. Wait until no run is running. `aipf.sh pause` arrives with line 3.
2. Run `providers/aws/aipf.sh up`.

Runs already in the table have no `retries` until their next retry, and the console shows nothing for them. The backfill after line 14 fills `retries` from `lastReason`.

## Line 2: one guarded start (`upgrade/2-guarded-start`)

Item: P0-1.

**Built**
- **Store port.** `put(item, { ifAbsentOrEquals: { runId } })` writes only when the item is missing or still holds those values. On DynamoDB it is `attribute_not_exists(pk) OR (runId = :r)`. On Firestore it is a read, then a write on the update time it saw. The memory store checks it directly.
- **`startRun`.** It takes `ISSUE#<key>/ACTIVE` with that condition, so the lock the console or the webhook took for this run passes, and a start from the CLI takes a free one.
  - A lock held by another live run makes this run a duplicate. The run is written as `RUN#<runId>/RUN` with `status: 'duplicate'`, `duplicateOf` and `endedAt`, and `startRun` returns `{ duplicate: true, activeRunId }`. It posts nothing and deletes nothing.
  - `duplicate` joins `TERMINAL`, so a late execution event for it changes nothing.
- **Workflow.** A `Started` choice after `StartRun` sends `$run.duplicate = true` to a `Succeed` state, `Duplicate`, before any agent. Step Functions' `ValidateStateMachineDefinition` returns OK for the new definition.
- **Releases.** The console's failure path after a failed `StartExecution` now deletes the lock only while it is that run's. The other releases were conditional already, except `aipf.sh reset`, which moves to `endRun` with P0-7 (line 4).
- **Console.**
  - A duplicate shows as the outcome `duplicate`, with a filter in the Runs list and a "duplicate of <run>" link on its page.
  - Insights counts duplicates in `outcomes` and leaves them out of every rate, time and cost.

**Differences from the plan**
- `startRun` takes over a lock whose run has already ended (`done`, `escalated`, `failed`, `timed_out`, `stopped` or `duplicate`). It removes that lock on the condition of the old run id and tries again.
  - This is the "stale lock" case of the tests, and nothing else should be held by a run that has ended.
  - A lock whose run still says `running`, but whose execution has stopped, is left for the reconciler (P0-2, line 3), as the plan says.
  - A lock with no run record yet is a start in progress, and it is not taken over either.

**Not built.** Nothing else in the line.

**Tests** (102 in all, all passing)
- `orchestrator.test.mjs`:
  - its own lock, from the console or the webhook, and a free one from the CLI;
  - a duplicate that names the active run, writes nothing to Jira or Slack, keeps the other run's lock and ignores its own execution event;
  - three starts on one item from the label, the CLI and the console, where one run works;
  - a stale lock taken over, and a live one not.
- `platform.test.mjs`:
  - the store condition in memory and on Firestore;
  - the workflow's `Started` and `Duplicate` states.
- `insights.test.mjs`: a duplicate counted in `outcomes` and in no rate.
- On AWS, outside the unit tests, the AWS adapter ran against the temporary table `aipf-plan08-table`:
  - the lock was written when absent, written again by the same run, and refused (`Conflict`) for another run;
  - `append` created the list and added to it;
  - ten parallel appends were all kept.

  The unit tests cannot load `platform/aws.mjs`, because the SDK comes from the Lambda runtime.

**Deploy.** This line changes Lambda and console code and the workflow definition, with no new stack resource.
1. Wait until no run is running.
2. Run `providers/aws/aipf.sh up`. The new definition applies to new executions only.

Lambda code from this line with the old workflow would send a duplicate on to `Plan`, where it fails on the missing plan, so deploy both together. `up` does.

## Line 3: no lost events (`upgrade/3-no-lost-events`)

Item: P0-2.

**Built**
- **Console resume (how 1).** After a merge or a close, `decide` removes `ISSUE#<key>/APPROVAL` on the condition `#t = :t` (the task token; `token` is a reserved word in DynamoDB), then sends `{ decision: 'merged' }` or `{ decision: 'closed' }` with `SendTaskSuccess`.
  - `TaskTimedOut`, `TaskDoesNotExist` and `InvalidToken` mean the step no longer waits, and are not errors.
  - Any other error puts the row back, so the CodeCommit event, a replay or the reconciler can still resume the run. The merge stands either way.
  - The response and the audit line say `resumed: true|false`.
- **One way to end an approval.** `pullRequestEvent`, the console and the reconciler all end an approval the same way. Whoever removes the row on its token resumes the step, so a step is resumed once. In the orchestrator this is `decideApproval`.
  - A replayed or late pull request event returns `{ ignored: 'decided already' }`.
  - `requestApproval` now writes `createdAt` on the row, for the reconciler's two minutes.
- **Kept events (how 2).** The stack has:
  - the SQS queue `${App}-lost-events` (14 days, SSE-SQS) and its policy for the three rules' ARNs;
  - `OrchestratorInvokeConfig` (`$LATEST`, 2 retries, 21,600 s, `OnFailure` to the queue);
  - `RetryPolicy` 185 / 86,400 and `DeadLetterConfig` on the targets of `MainChangedRule`, `PullRequestRule` and `WorkflowEndedRule`.
  
  The orchestrator role has `sqs:SendMessage` on the queue.
- **Alarms (how 3).** There are two alarms:
  - `${App}-events-dropped`: `AWS/Lambda AsyncEventsDropped` of the orchestrator, a sum above 0 over 5 minutes, with missing data not breaching;
  - `${App}-lost-events`: the queue's `ApproximateNumberOfMessagesVisible`, a maximum above 0.
  
  `aipf.sh status` shows the queue depth and both alarms' states.
- **Replay (how 4).** `aipf.sh events [list|replay [--all]]` runs the new `providers/aws/lost-events.mjs`, which calls the AWS CLI as the person at the terminal.
  - It reads both kinds of message. A Lambda destination record gives `requestPayload` and the reason in `requestContext.condition`. A rule's dead-letter message gives the body and the reason in `ERROR_CODE`, with the target from `TARGET_ARN`.
  - `list` prints the age, the target, the reason, a short source (for example `pull request 90 pullRequestMergeStatusUpdated`, `execution SCRUM-90-1 FAILED`, `action reconcile`) and the path. It never prints a payload.
  - `replay` sends the event again: `lambda invoke` with the payload in a 0600 temporary file, or `codebuild start-build` for the snapshot target. It deletes the message only when the target took it. A failed replay keeps its message and exits 1.
- **Reconciler (how 5).** The `reconcile` action runs from `ReconcileRule`, every five minutes. It makes one `store.scan(['APPROVAL', 'RUN', 'ACTIVE'])` and leaves rows younger than two minutes alone.
  - An approval whose pull request is merged or closed resumes its run (`scm.pullRequest(id)`, new in both connectors).
  - A `running` run whose execution is not running goes to `executionEnded` with `reconciled: true`.
  - A lock whose run is terminal, or whose execution is not running, is released on the condition of its run id.
  - Each fix posts one chat line that says the reconciler found it. A failing row logs `{reconcile, pk, error, message}`, and the rest go on.
  - `PLATFORM/RECONCILER` keeps `lastRunAt` and the last 50 fixes, and `status` shows them.
  - The platform ports gain `store.scan(sk | [sks])` and `workflow.status(name)`. AWS uses a paginated `Scan` with `sk IN (...)` and `DescribeExecution`, where null means no execution. Firestore uses one `runQuery` with `sk IN`. Memory filters directly. `platform/README.md` describes both.
- **Retry budget (how 6).** All 16 Lambda steps retry `Lambda.*` errors with `IntervalSeconds 2`, `MaxAttempts 8`, `BackoffRate 2`, `MaxDelaySeconds 60` and `JitterStrategy FULL`.
- **StartRun catch (how 7).** `StartRun` catches `States.ALL` to the `Fail` state `StartFailed` (error `StartRunFailed`, with the error's cause). The handler passes the event's `cause` to `executionEnded`. Its no-record branch releases the lock as before and now posts `AIPF could not start a run on <item>: <message>`, with ARNs and account numbers masked and the text cut to 300 characters. A stop (`ABORTED`) posts nothing.
- **Pause (how 8).** `aipf.sh pause [why]` writes `PLATFORM/PAUSE` `{by, at, reason}` and lists the running executions. `aipf.sh resume` deletes it and says how many events wait.
  - `aipf.sh run` refuses while paused.
  - The console's start returns 409 with the reason, before it takes the lock.
  - `startRun` releases its lock and fails, which ends in `StartFailed`.
  - The webhook comments on the work item, logs `decision: 'ignored', reason: 'paused'` and returns 202.
  - Running runs go on.
- **Docs.** The README's "Run it" and "When something fails" sections cover these. The POC environment's `NOTES.md` has a runbook: pause before a deploy, concurrency 0 is still the emergency stop and its events wait in the queue, then the replay, and the reconciler for stuck runs.

**Differences from the plan**
- The console part of P0-2 moves to line 12, with UX-20, which builds the cards: `GET platform/events`, `POST platform/events/replay`, a pause from the console, and the console role's `sqs:ReceiveMessage`/`DeleteMessage`, `lambda:InvokeFunction` and `cloudwatch:DescribeAlarms`. The admin roles come with UX-15 (line 16). Until then the CLI does all of it.
- `events replay` without `--all` replays the oldest message only. Several `reconcile` messages replay as one, and the others are deleted as repeats. A dead-lettered snapshot event replays as a new `codebuild start-build`.
- The pause's `by` is `the CLI` unless `AIPF_BY` names someone, so no local user name or email reaches Jira. The console will name its user (D-13 comes later).
- The lock pass also ends a running run whose lock is old even when the run row is young, so a run and its lock are ended together.
- On GCP, `workflow.status` is not built and returns undefined ("unknown"), so the reconciler leaves runs and locks there alone. Approvals still work.
- **A bug found on AWS and fixed.** A caught error with no cause has `"Cause": null` in its error output, so the plan's `$exists($states.input.Cause)` was true and the cause became the text `null`. `StartFailed` now uses `$states.input.Cause ? … : $states.input.Error ? … : 'unknown error'`.
- The plan's workflow check also asks that every path out of `TakeQueue` passes `ReleaseQueue`. Those states come with P1-3 (line 11), so that part of the check is added there.

**Not built.** Nothing else in the line. The round 4 B5 injection waits for the deploy.

**Tests** (117 in all, all passing; 102 before)
- `orchestrator.test.mjs` (31):
  - the reconciler with a merged, a closed, an open and a young approval (a late event and a second reconcile change nothing);
  - runs ended as failed, aborted and timed out;
  - a running execution left alone, and locks released for a done run and a missing execution, while one in progress and a young one are kept;
  - an unknown status left alone, and a failing row logged while the rest go on;
  - a replayed pull request event and end event that change nothing, and a failed resume that puts the approval row back;
  - the pause: the webhook (202 and a comment), `startRun` (refused, with the lock released), a running run's `done`, and a start after `resume`;
  - the `StartFailed` cause posted with `<arn>` and `<account>`, and nothing posted for a stop;
  - `createdAt` on the approval row.
- `console.test.mjs` (new, 4). The console is packaged as `deploy` does, in a temporary directory, and the `@aws-sdk/*` imports resolve through `module.registerHooks` to a fake SDK with an in-memory table that checks conditions. The tests:
  - approve and merge resumes with `merged`, after the conditional delete on the token;
  - a close resumes with `closed`, and a late step (`TaskTimedOut`) gives `resumed: false` with 200;
  - a throttled resume keeps the merge and puts the row back;
  - a pause gives 409 with no lock and no `StartExecution`, and a start works after it.
- `platform.test.mjs`:
  - the workflow check: every `Next`, `Default`, choice and catch names a state; every Lambda step has the P0-2 retry; `StartRun` catches to `StartFailed`;
  - `scan` and `status` in memory;
  - the Firestore `IN` query, with `status` asking nothing.
- On AWS, outside the unit tests:
  - `validate-template` passed (through the deploy bucket, because the template is 86 KB), and the new resources' properties match the CloudFormation schemas;
  - `ValidateStateMachineDefinition` returned OK;
  - the temporary state machine `aipf-plan08-start-failed` ran the real `StartRun` catch and `StartFailed`: a Lambda-style cause came through unchanged, and an error with no cause gave `States.Timeout` after the fix;
  - the execution status event from EventBridge carries `cause` as a string (rule `aipf-plan08-sfn-events`);
  - the AWS adapter's `workflow.status` gave `FAILED`, and `null` for a missing execution, and its `scan` found exactly the rows with the asked sort keys on `aipf-plan08-table`;
  - `events list` and `events replay [--all]` ran on the queue `aipf-plan08-replay-q` against the function `aipf-plan08-replay`, with a destination record, a dead-lettered event, two reconciles and a failing event. The function got each original event once and one reconcile, and the failing event stayed in the queue with exit code 1.

**Deploy.** This line adds stack resources (the queue and its policy, the invoke config, two alarms, the schedule, role grants), changes the rules' targets and the workflow, and changes Lambda and console code.
1. Wait until no run is running. The pause arrives with this line, so it cannot be used for this deploy.
2. Run `providers/aws/aipf.sh up`. The new definition applies to new executions only.
3. Check `providers/aws/aipf.sh status`: the queue is empty, both alarms are `OK` or `INSUFFICIENT_DATA`, and the reconciler has run after five minutes.
4. From then on, deploy with `pause`, a drain, `up` and `resume`.

The first reconcile reads every open approval, because rows written before this line have no `createdAt`. An approval whose pull request was merged or closed while an event was lost resumes then, and posts a line in the chat.

## Line 4: stops that tell (`upgrade/4-stops-that-tell`)

Item: P0-7.

**Built**
- **One action (how 1).** The orchestrator has a new action, `endRun({ runId, issueKey, by, reason, mode })`, where the mode is `stop` or `reset`. Any other mode throws.
  - The person is shown by name only: the part before the `@` (D-13). The reason is cut to 500 characters, and an empty one reads "no reason given".
  - A running run is handled in this order:
    1. The execution is stopped first, with the error `AIPF.Stop` or `AIPF.Reset` and the cause `<by>: <reason>`. Its event then names the same person and reason.
    2. The record is marked `stopped` with `endedAt`, `endedBy`, `endReason` and `endMode`. The write is by run id, on the condition that `endedAt` is missing. Of a stop and its own event, only one does the work; the other returns `{ ignored: 'the run has ended already' }`.
    3. `releaseRun` removes the lock (on its run id), the approval (while it is this run's), and `PLATFORM/STAGING_LEASE` and `PLATFORM/MERGE_QUEUE` (on their run id).
    4. The run's open `HUMAN#` rows and its `Q#` rows since `startedAt` get `closedAt` and `closedReason`.
  - **A stop** keeps the branch and the pull request. On an open pull request it comments "This run was stopped by <name>: <reason>. A person decides what to do with this pull request."
  - **A reset** comments on the pull request and closes it. It deletes the branch only when it is `agent/<the work item>`, moves the item to To Do, and removes the old `ISSUE#<key>/PR` row.
  - A stop of a run that has ended is refused (`the run is already <status>`).
  - **A reset of a run that has ended, or of a work item with no run,** still cleans up the pull request, the branch, the item and the rows. It releases any lock the run left, on its run id, but leaves the ended record as it is.
- **Notes (how 2).** For a running run, Jira gets `[AIPF platform] Run <runId> ended: stopped by <name>: <reason>. Comments above this line belong to that run.` (or "reset by"). The chat gets `AIPF: run <runId> of <item> ended: …`, then what happened to the pull request and the run's console link.
- **Callers (how 3).**
  - **The console's `stopRun`** refuses an unknown run (404) or one that is not `running` (409). It takes an optional `reason` in the body, defaulting to "stopped from the AIPF console", and calls `endRun` with a synchronous `Invoke`.
    - If the orchestrator takes no calls (the emergency stop at concurrency 0, or a function error), the console sends `StopExecution` with the same error and cause instead. It answers `status: 'stopping'` with a note, and the execution's event ends the run once the orchestrator runs again.
    - The harness MCP's `run_stop` goes the same way.
    - The console function and the harness function have `ORCHESTRATOR` set and `lambda:InvokeFunction` on the orchestrator.
  - **`aipf.sh reset KEY [why]`** calls `endRun` with `mode: 'reset'` and `by: 'the CLI'`. It does this for each running `KEY-*` execution; if none is running, for the run that holds the lock, or else for the work item alone. The payload goes through a private temporary directory. If the orchestrator takes no call, it stops the execution with `AIPF.Reset` and the cause `the CLI: <why>`, and the event finishes the reset later. The old direct table writes, the `reset` status and the Jira call in the script are gone.
  - **`executionEnded`** sends an `ABORTED` execution to `endRun` with `ended: true`, so nothing is stopped again. The person, the reason and the mode come from the event's `error` and `cause`, or from `workflow.describe` when the event has neither. A stop with any other error is shown as `someone outside AIPF`, with the cause as the reason.
- **The run's pull request (how 4).** `mcp-identity.mjs` takes the run from `--run` or `AIPF_RUN_ID` (an invalid one exits 2). It sets `run` in every call to a tool whose schema has it, replacing any `run` the agent sent, and hides `run` from the schemas as it does `agent`. `session.mjs` passes `--run`, and the workflow already sets `AIPF_RUN_ID` on every agent task.
  - `codecommit___create_pull_request` checks that the source branch is `agent/<the run's work item>`. It writes `prId` and `branch` on `RUN#<run>`, also when the pull request exists already, and no longer writes `ISSUE#<key>/PR`.
  - `endRun` also writes `prId` on the record when it finds the pull request by its branch.
- **Ended runs (how 5).** `gateway/tools.mjs` reads `RUN#<run>` for a call that names a run. An unknown run gets "the call names no known run"; a run that is not `running` gets `{ error: 'this run has ended', status }`. The tools role has `GetItem` and `UpdateItem` on `RUN#*` keys.
- **Closed questions.** The console's list of what waits for a person leaves out closed rows. An answer to a closed row gets 410 with the reason, and the update's condition also requires no `closedAt`. The answer form of the Slack link says "Run ended" (410). `aipf.sh answer` skips closed rows.
- **Ports.**
  - `workflow.describe(name)` gives `{ status, error, cause }`, or null when there is no execution. `workflow.stop(name, { error, cause })` gives true, or false when there is no execution. Both are in AWS and memory; GCP returns undefined for now.
  - `scm.closePullRequest(id)` and `scm.deleteBranch(branch)` are in both CodeCommit and GitHub. `deleteBranch` refuses `main`, and a missing branch is `{ deleted: false }`.
- **The stack.**
  - The orchestrator role gains `states:StopExecution`, `codecommit:UpdatePullRequestStatus`, and `codecommit:DeleteBranch` on the condition `codecommit:References` `refs/heads/agent/*`.
  - The console and harness roles gain `lambda:InvokeFunction` on the orchestrator.
  - `aipf.sh gateway` adds an optional `run` string to every Lambda tool's schema, next to the required `agent`.
- **Docs.** `platform/README.md` (the state table and the ports), `connectors/README.md`, the reset line in the README and the script's usage.

**Differences from the plan**
- `endRun` stops the execution before it claims the record, so the end event always carries AIPF's error and cause. The claim's condition makes the pair idempotent.
- `endMode` is a new field next to `endedBy` and `endReason`. The status is `stopped` for both modes; the old reset's `reset` status and `resetReason` are not written any more.
- The reset's notes say "reset by". Its pull request comment is "This run was reset by <name>: <reason>, so this pull request is closed and its branch deleted."
- **The error names.** AIPF's own stops carry `AIPF.Stop` or `AIPF.Reset`. The old reset sent `Reset`, which now reads as a stop from outside AIPF.
- **The run's `HUMAN#` rows are found with a Scan,** like the reconciler's, until UX-8's indexes exist (line 14).
- **`run` is added to the schemas in `aipf.sh gateway()`, not in `registry/tools.json`,** because `agent` is added there too. The filter takes `--run` as well as `AIPF_RUN_ID`.
- **Calls without a run** (sessions started before this line, or local runs) are not checked, as D-11 allows.
- **`finish`** (done, escalated, failed) now also releases the staging lease and the merge queue on the run id. Those rows come with lines 11 and 12; until then the removes find nothing.
- **The console's reason field** is UX-5 (line 9). The API takes `reason` now, and the button sends none yet. The harness MCP's stop sends no reason.
- **A bug found on AWS and fixed.** `DeleteBranch` of a branch that does not exist answers `{ "deletedBranch": {} }` with no error, so `{ deleted: Boolean(deletedBranch) }` would say deleted. The connector now reads `deletedBranch.branchName`, and the test has both answers.

**Not built.** Nothing else in the line. Round 4 B1 and B7 wait for the deploy.

**Tests** (129 in all, all passing; 117 before)
- `orchestrator.test.mjs` (35):
  - a stop of a running run: the execution stopped with `AIPF.Stop` and `ana: wrong ticket`; the record; the lock, approval and lease released while another run's queue entry stays; the run's `HUMAN#` and `Q#` rows closed, but another run's and an answered one kept; the pull request comment, the Jira line and the chat line; a second stop and the run's own event ignored;
  - a reset: the pull request closed, the branch deleted, To Do, the old `PR` row removed, `endMode`;
  - a reset of an escalated run on `main` (the branch is not deleted, the record is unchanged, its lock is released) and of a work item alone; a stop of an ended run refused; an unknown mode rejected;
  - stops through the event: one from outside AIPF, a console fallback (`AIPF.Stop` and its cause), and an event with neither, where `describe` gives them; the reconciler's line.
- `tools.test.mjs` (8): the branch check, `prId` and `branch` on the record, no `ISSUE#/PR` row, "this run has ended", an unknown run, and a running run that works.
- `mcp-identity.test.mjs` (3): the run from the environment, hidden, replacing the agent's; `--run` wins; no run strips it; a bad run exits 2.
- `connectors.test.mjs` (18): close and delete for GitHub (fake fetch) and CodeCommit (fake SDK), with a merged pull request, one outside the repository, a missing branch both ways, and `main` refused.
- `console.test.mjs` (8): a stop through `Invoke` (the function, the payload, no `StopExecution`, the default reason); unknown and ended runs refused before any call; a late conflict as 409; the fallback on `TooManyRequestsException` and on a function error, with nothing released; a closed question refused with 410.
- On AWS, outside the unit tests:
  - `validate-template` passed (through the deploy bucket).
  - The AWS adapter, on the temporary state machine `aipf-plan08-stop`: `describe` gave `RUNNING` with no error; `stop` gave true; then `ABORTED` with `AIPF.Stop` and the cause. A second stop on the ended execution gave true and kept the first error and cause. A missing execution gave false and null.
  - `aws lambda invoke --query FunctionError --output text` prints `None` when the function succeeds, which the reset reads.
  - `DeleteBranch` on the temporary repository `aipf-plan08-push`: a real branch answers its name and commit, and a missing one answers an empty object (the bug above).

**Deploy.** This line changes the stack (role grants, the console and harness environments), the gateway's tool schemas, and the Lambda, console and runner code. The workflow does not change.
1. Run `providers/aws/aipf.sh pause "line 4"` and wait until no run is running.
2. Run `providers/aws/aipf.sh up`, then `providers/aws/aipf.sh gateway`, so the targets get `run`. Then `providers/aws/aipf.sh build`, so the runner's filter sets it.
3. Check that a tool call from a new session carries `run` in the tools log line (`run` is not null).
4. Run `providers/aws/aipf.sh resume`.

Sessions that started before the build send no `run` and are not checked. Old `ISSUE#<key>/PR` rows go away on a reset of their item; nothing reads them.

## Line 5: decisions travel (`upgrade/5-decisions-travel`)

Items: P0-3, UX-4, UX-21.

**Built**
- **Amendments (P0-3 how 1).** A person's answer or change request is appended to the `amendments` list of `RUN#<runId>` with `list_append`, as `{ at, by, kind, text, attempt }`.
  - An answer also carries `agent`, `question` and `human` (the `HUMAN#` row's id). A change request carries `human`.
  - `nextAttempt` writes the amendment in the same update as the retry, and `answered` does the same for the PM and designer agents.
  - The attempt is the one the person answered: the developer's `attempt`, or the PM's or designer's `prep` count.
  - A step that runs again for a row already in the list adds nothing (dedupe by `human`).
  - `by` is the console name (D-13). An answer through the answer link has no name and reads "someone with the answer link".
  - The kinds `override` (UX-6) and `accept` (P1-1) have their headings in the prompt and the console, and arrive with lines 7 and 9.
- **Who and which row.** The console's answer gives the task output `{ answer, by, human }`, and its change request gives `{ decision: 'changes', feedback, by, human }`. The answer link gives `{ answer, human }` and `{ decision: 'changes', feedback, human }`.
  - The workflow's `Answered` and `ChangesRequested` steps pass `by` and `human` to the orchestrator. Each uses `$exists(...) ? ... : ''`, so an output without them gives an empty string.
- **The prompt (how 2).** `composePrompt` is exported and adds `## Amendments by a person` after the handoff, oldest first, for every role. The developer gets it before its feedback, so a second change request does not hide the first.
  - The section opens with the plan's sentence.
  - Each amendment is a heading: `### <n>. <Answer | Change request | Override | Accepted> by <name>, at attempt <a> (<YYYY-MM-DD HH:MM> UTC)`. An answer shows "The <agent> asked:" with the question, then "The answer:".
  - The latest 20 fit. Older ones are counted: "<n> older amendments are on the work item's comments."
  - The text is cut at 4000 characters and the question at 2000.
  - The runner reads the list from the `RUN` item it reads already. The session summary records `amendments`, the count.
  - `session.mjs` runs its command only when it is the entry point, so a test can import it. The image's Node 22 has no `import.meta.main`.
- **Roles (how 3).** `reviewer.md`, `tester.md` and `operator.md` tell the agent to read the amendments and check the work against them. The tester takes the criteria from the story as the amendments change them.
- **The work item (how 4).** Each amendment is posted as `[AIPF platform] Amendment by <name> (<kind>): <text>`. An answer adds "The question, from the <agent>:" and the question. The post ends with the run's console link (UX-21).
- **Decisions and answers (UX-4).** The run detail now gives `decisions`, built from the run's `HUMAN#` rows (questions and reviews) merged by row id with its amendments, plus amendments with no row.
  - Each line has: the kind (question, change request, review), the state (answered, late, open, expired), the agent, what was asked, the answer, who, when, the attempt, and whether it travels to later agents.
  - **Late.** A row answered after its step stopped waiting is late. The console's answer sets `late` on the row when the resume finds no task (it still answers 409). The answer page sets it when its resume fails (410).
  - **Expired.** A row closed by `endRun`, or left open by a run that has ended, is expired.
  - **Reviews decided in the repository.** A review decided in CodeCommit (the pull request event or the reconciler) gets `answeredAt`, `answer` ("merged in CodeCommit") and `decidedIn` on its row, written by the orchestrator's `decideApproval`, and `late` when the run no longer waited.
  - **The run page.** A **Decisions and answers** panel between the review panel and the tabs, with a coloured left border per state and "↪ Goes to every later agent as an amendment." on lines that travel.
  - **The timeline.** A **🧑 Decisions** lane with a point per decision, coloured by its state.
  - **Questions for you** keeps only the open questions: not answered and not closed.
- **Run links (UX-21).** `notify(text, runId)` and `trackerNote(key, text, runId)` end the text with "The run in the AIPF console: <link>", unless it holds the link already.
  - This covers the start, a deploy failure, a tester failure, done, escalate, a failed start, `endRun` (stop and reset), the reconciler's two messages and each amendment.
  - `askHuman`, `requestApproval` and a failed or timed-out workflow already linked to the run and are unchanged.
  - **Reasons.** A declined work item and an unhealthy staging take their reason from the first paragraph of the agent's reply: headings, rules and the verdict line are skipped, and the text is cut at a sentence end within 600 characters. Before, they took the last 600 characters.
  - **In Progress.** `startRun` moves the work item to In Progress (best effort).
- **Jira links.** The Jira connector's ADF comment turns every `https://` address into a link mark, and leaves out the punctuation after it, so the console link is clickable in Jira.
- **Names.** The console passes the person's console name, not the sign-in email, as `by` to the squash merge's commit message ("Approved by <name> in the AIPF console.") and to the close. Its "Changes asked by <name>" pull request comment does the same. Before, all three held the email, against section 9 (D-13).

**Differences from the plan**
- **The orchestrator appends, not the console's `decide`.** The plan says "the orchestrator's `answered` and the console's `decide` append". Only the orchestrator has Jira, and it runs for both the console and the answer link. So the console passes `by` and `human` through the task output, and the orchestrator appends and posts.
- **Amendments stay in DynamoDB,** not in the workflow state. The runner reads them from the `RUN` item.
- **UX-4's "approval comments"** come from the review's `HUMAN#` row, which now records how the review was decided, not from CodeCommit's pull request comments. The console reads no pull request comments for this panel.
- **"In Progress" is set at `startRun`,** just before the first session starts, not by the session itself.
- **"(see the precedence)"** in the section points at P0-5's precedence in `_common.md`, which comes with line 7.
- **The run's `HUMAN#` rows are found with a Scan** on every run page view, like line 4's, until UX-8's indexes (line 14). The task token is never returned.
- **A possible race:** when the pull request event's `decidedIn` lands before the console's own answer on the row, the line says "in CodeCommit" instead of the person's name. Both are written on the condition that `answeredAt` is missing, so only one wins. It needs a merge from the console and a pull request event within milliseconds.
- **The pre-run Jira notes** (the paused label and an engine that is not allowed) carry no console link, because there is no run.

**Not built.** Nothing else in the line. Round 4 C3 waits for the deploy.

**Tests** (145 in all, all passing; 129 before)
- `orchestrator.test.mjs` (42):
  - a change request and an answer appended once, with `by`, `kind`, `attempt` and `human`; the second call for the same row adds nothing; the Jira posts, with no `@aipf.invalid` address in any text;
  - an answer through the link ("someone with the answer link"); the exhausted branch appends too; a CI failure adds none;
  - a PM agent's answer appended with its `prep` attempt;
  - the `HUMAN#` rows record the attempt;
  - In Progress at `startRun`; the link on `escalate`; the link not doubled on `askHuman`;
  - the first paragraph for a declined work item (PM) and an unhealthy staging (operator);
  - `decidedIn` on a pull request event ("merged in CodeCommit"); a row the console answered stays as it is;
  - the earlier stop and reset tests now expect the link at the end of the Jira and chat lines.
- `session.test.mjs` (4, new): the section after the handoff, oldest first, with the headings; every role, the developer's before its feedback; no section without amendments; the 20 cap with its count; the 4000 and 2000 cuts; the three role files.
- `console.test.mjs` (11): the decisions' order, states, names and attempts; only the open question in **Questions for you**; no email or token in the body; after the run ends, the open question is expired and none is asked; the answer's output with `by` and `human`; a late 409 marks the row late; the change request's output; "by ana" in the pull request comment and the squash commit message.
- `connectors.test.mjs` (19): a link in a Jira comment is a link mark, without the punctuation after it.
- `platform.test.mjs` (17): the workflow's `Answered` and `ChangesRequested` payloads carry `by` and `human`, empty when the link sent them.
- On AWS, outside the unit tests: `TestState` on the `Answered` payload with the guard gave `SUCCEEDED` and `""` for a missing `by`. Without the guard, the same input failed with `States.QueryEvaluationError`, which is why the guard is there.

**Deploy.** This line changes the workflow (the two payloads), the orchestrator and console code (the API and `app.js`/`app.css`), the runner (`session.mjs`) and the role files. The stack's resources and grants do not change.
1. Run `providers/aws/aipf.sh pause "line 5"` and wait until no run is running.
2. Run `providers/aws/aipf.sh up` (the workflow, the Lambda functions and the console), then `providers/aws/aipf.sh build` (the runner image with the roles).
3. Start a run, answer a question in the console, and check: the `RUN#` item holds one amendment with the console name; the work item has the `Amendment by` comment with the run link; the run page shows the line in **Decisions and answers**.
4. Run `providers/aws/aipf.sh resume`.

The new orchestrator takes the old payloads (`by` and `human` are optional), and the old workflow works with the new code, so the order of the steps within the pause does not matter. Runs that started before the deploy have no amendments for their earlier answers.

## Line 6: pushes confined (`upgrade/6-push-scope`)

Item: P0-4.

**Built**
- **Two users (how 1).** The harness image runs the session runner as root and adds the user `agent` (uid and gid 1001), which owns `/workspace`. The snapshot images end with `USER root` again, in `harness/snapshot.Dockerfile` and in the stack's inline snapshot Dockerfile. Their setup step still runs as `agent`.
  - `session.mjs` starts the agent CLI, the repository's commands (`sh`) and all of its own git as `agent`, when it runs as root. Run by hand or in the tests, it starts them as the current user.
  - The runner's git runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false`, so a branch's hook never runs with the runner's credentials.
  - The children's environment comes from `agentEnv` in the new `harness/runner/scope.mjs`. It never has the task token, the Claude token (the adapter adds it to the Claude Code process only), `ECS_CONTAINER_METADATA_URI*` or `ECS_AGENT_URI`. `HOME`, `USER` and `LOGNAME` are the agent's.
  - The adapters' configuration (the MCP file, OpenCode's and Pi's directories) goes in an agent-owned `/tmp/aipf-agent-*`. The transcripts stay in the runner's `/tmp/aipf-session-*`.
- **Scoped credentials (how 2).** With `AIPF_PUSH_SCOPE=session`, the runner reads its role from `GetCallerIdentity` (`AIPF_TASK_ROLE_ARN` overrides it) and assumes it again:
  - `RoleSessionName` is `<agent>-<runId>-<attempt>`, cut to 64 characters, for example `developer-SCRUM-7-1760000000000-1`;
  - `DurationSeconds` is 3600;
  - the session policy allows `*` on `*`. Its `OnlyThisRunsBranch` statement denies `GitPush`, `DeleteBranch`, `DeleteFile`, `PutFile`, `CreateCommit`, `MergeBranches*` and `MergePullRequest*` when any reference is not `refs/heads/agent/<KEY>`. Its `NoOtherSession` statement denies `sts:AssumeRole`, `sts:TagSession` and `sts:SetSourceIdentity`.
  - The stack gives the six agent roles (developer, reviewer, PM, designer, tester, operator) the trust statement `ScopedSessionsOfItself`: the account root, with `ArnEquals aws:PrincipalArn` on the role's own ARN, built with `!Sub`. The developer's and reviewer's policies, and `LightAgentPolicy` for the four light roles, allow `sts:AssumeRole` on their own ARNs.
  - The new `PushScope` parameter (`session` or `off`, default `session`) sets `AIPF_PUSH_SCOPE` in both task definitions. `aipf.sh up` passes `AIPF_PUSH_SCOPE` from the environment's settings, and `environments/example/settings.env` has it.
  - The session summary records `pushScope`, the session name. A failed `AssumeRole` ends the session in the phase `credentials`.
- **Credential process (how 3).** The runner serves the scoped credentials on `/run/aipf/creds.sock`. The directory is `root:agent 0750`, the socket `root:agent 0660`, and the agent's AWS configuration `/run/aipf/aws-config` is root's and `0644`.
  - The configuration has one profile, `credential_process = "<node>" "/opt/aipf/runner/creds.mjs"`, and the region. The children also get `AWS_CONFIG_FILE` and `AWS_EC2_METADATA_DISABLED=true`, and none of the container's credentials (`AWS_CONTAINER_*` or the direct `AWS_*` variables).
  - `creds.mjs` prints the credentials with their `Expiration`. With no answer it prints `aipf creds: <why>` and exits 1.
  - The runner assumes the role again once less than 20 minutes are left. One call at a time; a failed refresh keeps the current credentials while they last, and the log says `scoped credentials not renewed`.
  - The server runs in a worker thread (`startCredentialServer`), because the runner waits on git and the repository's commands with `spawnSync`, and they ask for credentials meanwhile.
  - `@aws-sdk/client-sts` 3.1152.0 is added to the harness.
- **The gateway principal (how 4).** `principal()` in `gateway/policies.mjs` accepts `assumed-role/<role>` and `assumed-role/<role>/*`. The Cedar policies are regenerated by `aipf.sh gateway`.
- **The pull request tool (how 5).** Already done in line 4: `codecommit___create_pull_request` refuses a source branch other than `agent/<the run's work item>` (`gateway/tools.mjs`).
- **What stays (how 6).** The role's `agent/*` allow and deny stay. The runner's own git, while it prepares the workspace (the force-push when a developer starts from `main`), uses a second session of the same name without the session policy. That session is passed only to that git, before any agent process exists, and is gone from the environment once the workspace is ready.
- **Detection (how 7).** The stack's `PushAuditRule` sends the sample repository's `referenceCreated`, `referenceUpdated` and `referenceDeleted` events to the orchestrator, with the retry policy and the lost-events queue of line 3. The orchestrator gets `APP`.
  - The new action `pushAudit` reads `callerUserArn`: `assumed-role/<APP>-<agent>/<session>`. A caller that is not an agent role (a person, the orchestrator) is ignored.
  - The session `<agent>-<runId>-<attempt>` names the run. The work item comes from the `RUN#` item, or from the run id when there is no item.
  - A push or create of `refs/heads/agent/<KEY>` is `ok`. Anything else, and any delete by an agent, is a mismatch. A mismatch is logged and posted to the chat: "AIPF push audit: the Developer agent of run <runId> pushed to `<ref>`; its run's branch is `agent/<KEY>`. IAM should have refused this: check the agent's role and the run's session policy.", with the run's link.
  - A session that names no run (the flag off, where the session is the ECS task's id) is checked against `agent/*` only.
- **Flag (how 8).** As in how 2. With `AIPF_PUSH_SCOPE=off` the agent keeps the container's credentials, as before; the two users, the removed tokens and `pushAudit` stay.
- **Docs.** The comments in `scope.mjs`, `session.mjs`, the Dockerfiles and the stack.

**Differences from the plan**
- **The session policy denies all the reference-writing actions,** not only `GitPush`, with `ForAnyValue:StringNotEquals`, which is the documented form for a key with many values. On AWS, the plain `StringNotEquals` also refused a push of two references, so this is the documented form, not a fix.
- **`NoOtherSession` is new.** The role now trusts itself, so a scoped session could otherwise assume the role again, without the policy. On AWS a scoped session's `AssumeRole` was refused, and an unscoped one's allowed.
- **The refresh comes with 20 minutes left,** not "after 50 minutes". botocore refreshes a `credential_process` result 15 minutes before it ends and must refresh it 10 minutes before. With a refresh at 50 minutes, botocore would ask from minute 45 and get the same credentials for 5 minutes.
- **The client is `node /opt/aipf/runner/creds.mjs`,** not an executable `/opt/aipf/runner/creds`.
- **The credential server's worker thread** is not in the plan. A server on the runner's main thread deadlocks: the runner waits in `spawnSync` on a git fetch through `git-remote-codecommit`, which waits on the socket. A test proves the worker answers while the main thread is blocked.
- **All of the runner's git runs as `agent`,** with hooks and fsmonitor off, so the files in `/workspace` keep one owner.
- **The runner's own push uses a named session** (`<agent>-<runId>-<attempt>`, no policy) instead of the container's credentials, so `pushAudit` can name its run (how 7's last sentence). With the flag off, the session is the ECS task's id, and `pushAudit` checks only `agent/*`: naming the run would need `ecs:DescribeTasks`, which is not built.
- **A delete of the run's own branch** is allowed by IAM (it is the run's reference), and `pushAudit` reports every delete by an agent as a mismatch.
- **The rule is matched by `detail-type`,** `CodeCommit Repository State Change`, before the pull request events.
- **Item 5 was done in line 4.** `aipf.sh` line 706 (the `agent/*` deny of the build) needs no change.

**Not built.** Nothing else in the line. Two gaps stay, outside the line:
- The agent roles can still write any `RUN#*` item (`PutItem`), with the scoped session as with the old one.
- Git's own configuration in the snapshot (`/workspace/.git/config`, written by the clone and the repository's setup from `main`) is trusted: a filter driver set there would run with the runner's session while it prepares the workspace. Only a person's merge to `main` can put one there.

Round 4 D4 waits for the deploy.

**Tests** (158 in all, all passing; 145 before)
- `scope.test.mjs` (9, new):
  - the session policy: the actions, the exact branch, `ForAnyValue`, the `Null` guard, `NoOtherSession`, and a key that is not a work item refused;
  - the session name and its 64-character cut;
  - the role ARN from the caller's ARN, with a role that is not assumed refused;
  - the refresh: cached until 20 minutes are left, one call at a time, the old credentials kept while they last, then the error;
  - `agentUser` from a passwd file, and null when not root;
  - the AWS configuration;
  - the socket and `creds.mjs`: the answer, the JS SDK's default chain through `credential_process`, an `AccessDenied` answer, and no socket (`ENOENT`);
  - the worker server against a fake STS (`AWS_ENDPOINT_URL_STS`): the `AssumeRole` parameters, a client answered while the main thread waits in `spawnSync`, and an `AccessDenied` start rejected;
  - the gateway's principal pattern on a bare role, a named session, and another role.
- `mcp-identity.test.mjs` (4): the agent's environment: never the tokens or the task's metadata; the flag off keeps the container's credentials; the flag on gives only `AWS_CONFIG_FILE`, `AWS_EC2_METADATA_DISABLED` and `AWS_REGION`; the user's `HOME`, `USER` and `LOGNAME`.
- `orchestrator.test.mjs` (45): `pushAudit` with a scoped session (the run's branch `ok`; another branch, `main`, a tag and a delete reported with the run's link); a run with no `RUN#` item; an ECS task id as the session; the action form; a person, the orchestrator and an unknown role ignored; a pull request event still routed.
- In the harness image, built locally (not pushed), with a fake STS:
  - the runner is uid 0 and `agent` is 1001:1001;
  - `/run/aipf` is `root:agent 0750`, the socket `root:agent 0660`, the configuration `root 0644`;
  - the agent's environment has only `AWS_CONFIG_FILE`, `AWS_EC2_METADATA_DISABLED` and `AWS_REGION` of the AWS variables, and none of the runner's key, the task token, the Claude token or the metadata address;
  - as `agent`, `creds.mjs` answers, botocore (`custom-process`) and the JS SDK get the scoped key, and `cat /proc/<runner>/environ` and `/proc/1/environ` are refused; as `nobody`, `creds.mjs` gets `EACCES`;
  - Claude Code, OpenCode and Pi run as `agent`.
- On AWS, on the temporary role and repository `aipf-plan08-push`, with the shipped `sessionPolicy` and server:
  - the policy is 598 bytes, `PackedPolicySize` 31 %;
  - the scoped session's `AssumeRole` of its role is refused; the unscoped session's is allowed;
  - in the harness image, as `agent`, with the base session as the container's credentials: botocore's caller is `assumed-role/aipf-plan08-push/developer-SCRUM-200-1760000000001-2`; its `AssumeRole` is refused; a clone through `git-remote-codecommit` works; a push of `agent/SCRUM-200` is allowed, twice; one push of `agent/SCRUM-200` and `agent/SCRUM-299` is refused whole (no `agent/SCRUM-299` branch afterwards); `agent/SCRUM-299`, `main` and a delete of another branch are refused; `/proc/1/environ` is refused.

**Deploy.** This line changes the stack (six roles' trust and policies, `PushScope`, the rule and its permission, the orchestrator's environment), the gateway's Cedar policies, the orchestrator, the harness image and the snapshot images.
1. Run `providers/aws/aipf.sh pause "line 6"` and wait until no run is running.
2. Run `providers/aws/aipf.sh up` (the roles first, so a scoped `AssumeRole` is trusted before any image asks for one), then `providers/aws/aipf.sh gateway` (the principal pattern).
3. Run `providers/aws/aipf.sh build`, then `providers/aws/aipf.sh snapshot`, so every snapshot ends as root.
4. Start a run and check: the session log has `scoped credentials: session developer-<runId>-1`; the summary has `pushScope`; a gateway call works; the push of `agent/<KEY>` is allowed; the orchestrator's log has `pushAudit: ok` for it.
5. Run `providers/aws/aipf.sh resume`.

Both task definitions run the session image (`<App>/session:latest`), which `snapshot` builds from the newest harness image. Until `snapshot` runs, the tasks keep the old runner and the old `USER agent`, and ignore `AIPF_PUSH_SCOPE`: the new stack and gateway work with them, and `pushAudit` checks their pushes against `agent/*` only. The snapshot project also rebuilds on every change to `main`, from the newest harness image. To turn the scoped credentials off without a rebuild, set `AIPF_PUSH_SCOPE=off` in the environment's settings and run `up`.

## Line 7: rules and dependencies (`upgrade/7-rules-and-dependencies`)

Items: P0-5, and UX-6's banner and override reason.

**Built**
- **Preamble (P0-5 how 1).** The new `registry/roles/_common.md` holds the plan's two rules: the precedence, highest first, and the conflict rule. `composePrompt` puts it before the role's text in every prompt, as `# Rules for every AIPF agent`. AG-8's injection rule goes in the same file with line 18.
- **Dependency check (how 2).** `afterDeveloper` records `dependencyChange` on `RUN#<runId>` whenever the developer's session ends with a pull request. The new `dependencyChangeOf` reads the pull request's changed files with `scm.getPullRequest` and keeps those that match `DEPENDENCY_FILES`.
  - When no dependency file changed, `dependencyChange` is null.
  - For each changed `package.json`, it reads the file at the merge base (the destination commit when there is none) and at the branch head with the new `scm.fileAt(path, commit)`. `packageChanges` in `control-plane/lib.mjs` then lists what was added, removed or changed in `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`. The record is `{ files, packages: [{ file, section, name, change, from, to }] }`.
  - A `package.json` that cannot be read or parsed keeps its file in `files` with no packages, as the plan says.
  - A file list that cannot be read at all, or one cut short with no dependency file in it, is recorded as `{ files: [], packages: [], unread: <why> }`. The console still asks for the tick.
- **Messages (how 3).** `dependencyText` writes the change in one line, for example `Dependency change: package.json adds "dayjs" ^1.11.13 (package-lock.json changed).` It lists at most 12 packages and counts the rest.
  - `requestApproval`'s `[AIPF platform]` pull request comment adds the line after "CI passed". It warns that a merge made in CodeCommit skips the console's tick.
  - The Slack message adds the line with "Approve in the console asks you to tick that you checked it."
  - An unread change reads "Dependency change: unknown, <why>. Check the changed files yourself."
- **Console (how 4).** The review view gives `dependencyChange` and `reviewer` (`{ verdict, needsReason }`, or null when the reviewer is off or did not review this attempt).
  - `decide` refuses an approval when the run has a dependency change and `dependencyChecked` is not the boolean `true`. It answers 400 "Tick the dependency check first" and sends nothing to CodeCommit.
  - The approval's pull request comment adds "<name> ticked that they checked the dependency change."
  - The audit line says `dependencyChecked` and `override`.
- **Override reason (UX-6).** When the reviewer agent's verdict on the current attempt is not `approve`, including a session with no verdict, `decide` needs a `reason`. Its whitespace is collapsed to one line, and it is cut to 300 characters. With none, it answers 400 "The reviewer agent's verdict is <verdict>: give a one-line reason to approve over it".
  - The reason goes on the pull request's approval comment: "Over the reviewer agent's verdict (<verdict>), because: <reason>".
  - It is also appended to the run's `amendments` as `{ at, by, kind: 'override', text, attempt }`, so the tester and the operator get it under `## Amendments by a person`. A failed append is logged, and the merge stands.
- **Review panel.** Below the conflicts note, a dependency banner (`role="note"`, the amber "wait" colours) shows the ⚠ line, the tick "I checked the dependency change", and "The developer agent may add a dependency only when a person agreed. A merge in CodeCommit skips this tick."
  - Approve stays disabled until the box is ticked.
  - When the verdict is not approve, an override box asks "The reviewer agent's verdict is **<verdict>**. Why approve it anyway?" in a one-line field (300 characters). An empty field stops Approve with a message and puts the focus on it.
  - Both work in the light and dark themes.
- **Developer's rules (how 5).** `developer.md` keeps "Do not add dependencies" and adds the plan's two sentences.
- **Ports.** `scm.fileAt(path, commit)` in CodeCommit (`GetFile`; a missing file is null, any other error is thrown) and GitHub (the contents API at a ref; 404 is null). `connectors/README.md` describes it.
- **The stack.** The orchestrator role gains `codecommit:GetDifferences`, `codecommit:GetCommentsForPullRequest` (which `getPullRequest` also calls) and `codecommit:GetFile` on the repository.

**Differences from the plan**
- **`DEPENDENCY_FILES` is in both `session.mjs` and `lib.mjs`.** The plan moves it to `lib.mjs`. The harness image has no `control-plane/`, so the runner keeps its copy, and a test checks that the two patterns are equal.
- **Every changed file is read.** The plan says `getPullRequest`'s `files` "already come from `GetDifferences`", but both connectors read only the first page: 100 files on CodeCommit and on GitHub. A dependency file past the first page would have been missed, so both now page.
  - CodeCommit follows `NextToken` for up to 20 pages.
  - GitHub fetches `&page=N` for up to 30 pages, while a page is full.
  - Past that, or when GitHub's `changed_files` is larger than the list, the view says `filesCut: true`.
- **It fails closed.** An unreadable file list, or a cut one with no dependency file in it, still needs the tick (`unread`). The plan covers only a `package.json` that cannot be read.
- **It runs in `afterDeveloper`,** because CT-1's `AfterChecks` step comes with line 10. The check moves there with CT-1. A push made by hand after the developer's session is not checked again. The approval's `revisionId` check still stops a merge of a revision the person did not see.
- **The override is not posted to the work item.** The console has no tracker connector, and the amendment is written by the console after the merge. Line 5's amendments are written by the orchestrator, which posts them. The override is on the pull request and in the run's amendments, where the later agents read it.
- **The override needs a reason only when the reviewer's session for this attempt exists.** The reviewer turned off for the run, or no reviewer session (an older run), needs none. A session with no verdict needs one.
- **The tick's class is `dependency-tick`.** `.tick` is the timeline axis's class already.

**Not built.** The rest of UX-6 belongs to other lines:
- the reviewer's verdict with a link to its handoff beside CI's result (CT-1, line 10);
- the merge queue state, and the reload when the pull request's revision changed since the page loaded (P1-3, line 11). Until then, a stale `revisionId` gets 409 "pull request <id> changed since you opened it; look at it again", as before.

Round 4 D5 waits for the deploy.

**Tests** (169 in all, all passing; 158 before)
- `session.test.mjs` (6):
  - every prompt starts with `# Rules for every AIPF agent`, holds the precedence and the conflict rule, and has them before `## Your task`;
  - the developer's dependency line;
  - `session.DEPENDENCY_FILES` equals `lib`'s, source and flags.
- `connectors.test.mjs` (21):
  - CodeCommit paging (`NextToken`, the merge base);
  - CodeCommit `fileAt`: the text, null for a missing file, and `AccessDenied` thrown;
  - GitHub paging (101 files over two pages);
  - GitHub `fileAt`: base64, 404 as null, and the non-base64 error;
  - `filesCut` when `changed_files` is 500.
- `orchestrator.test.mjs` (48):
  - the recorded change: packages added, changed and removed, `devDependencies`, a `web/package.json`, and null with no dependency file;
  - `unread` on a `ThrottlingException` and on `filesCut`;
  - an unparseable `package.json` that keeps its file with no packages;
  - `requestApproval`'s pull request comment, its Slack line and the unread text, and the plain text with no change.
- `console.test.mjs` (15):
  - the review view's `dependencyChange` and `reviewer`, null with the reviewer off;
  - the tick:
    - refused for a missing value, `false` and `'true'`, with nothing sent to CodeCommit;
    - accepted with the comment line;
    - an unread change refused too;
  - the reason:
    - required;
    - whitespace collapsed;
    - the pull request comment;
    - the `override` amendment with `by: 'ana'` and the attempt;
  - no reason needed for an approve verdict, the reviewer off, or another attempt;
  - a missing verdict needs one.
- **The review panel in headless Chrome,** against the packaged console with a fake SDK, for four runs: a dependency change with the reviewer's `changes`, a dependency change with `approve`, a plain one, and an unread change with `changes`.
  - Screenshots in the light and dark themes, and at the narrowest window (500 px), with no page overflow (the same as before the line).
  - Driven by script:
    - Approve was disabled until the tick, and enabled after it.
    - An empty reason gave the message and moved the focus to the field.
    - The request bodies were `{ decision, revisionId, dependencyChecked: true, reason: 'flaky e2e' }`, `{ …, dependencyChecked: true }` and `{ decision, revisionId }`.
- **On AWS,** with the connector and `lib.mjs` as shipped, on the temporary repository `aipf-plan08-push`:
  - A pull request with 122 changed files came back whole over two `GetDifferences` pages, with no `filesCut`.
  - The dependency files were `package-lock.json` and `package.json`.
  - The packages were one changed, one removed, and one added in `devDependencies`, read at the merge base and the head.
  - A missing file gave null (`FileDoesNotExistException`), and a commit that does not exist was thrown (`CommitDoesNotExistException`).
  - The check's pull request was closed, and its branch deleted.
- `cfn-lint` gives the same warnings as before the line.

**Deploy.** This line changes the stack (the orchestrator role's grants), the orchestrator and console code (the API and `app.js`/`app.css`), the runner (`session.mjs`) and the role files. The workflow does not change.
1. Run `providers/aws/aipf.sh pause "line 7"` and wait until no run is running.
2. Run `providers/aws/aipf.sh up`: the grants, the orchestrator and the console.
3. Run `providers/aws/aipf.sh build`, then `providers/aws/aipf.sh snapshot`, so the sessions get the preamble and the developer's new line.
4. Start a run whose work item asks for a new package (round 4 D5), and check:
   - the developer asks first;
   - the pull request comment and the Slack message carry the dependency line;
   - the review panel shows the banner, and Approve needs the tick.
   
   On a run whose reviewer asked for changes, check that Approve needs a reason, and that the reason shows on the pull request and in **Decisions and answers** as an override.
5. Run `providers/aws/aipf.sh resume`.

Runs whose developer finished before the deploy have no `dependencyChange`, and the console asks for no tick on them. Their pull request is still checked by the approval rule.

## Line 8: records and time (`upgrade/8-records-and-time`)

Items: REC-3, REC-5, CT-3a; UX-1, UX-2, UX-3.

**Built**
- **ECS facts (CT-3a).** Each session state (`Pm`, `Designer`, `Developer`, `Reviewer`, `Tester`, `Operator`) assigns `$ecs` from its `runTask.sync` result. The reviewer assigns `$reviewerEcs`, because `$ecs` is the developer's until `RequestApproval`.
  - The fields kept are `CreatedAt`, `PullStartedAt`, `PullStoppedAt`, `StartedAt`, `ExecutionStoppedAt`, `StoppingAt`, `StoppedAt`, `StopCode`, `StoppedReason` and the `harness` container's `ExitCode`, plus `StepEnteredAt` from `$states.context.State.EnteredTime`.
  - Each `Catch` assigns `{ StepEnteredAt, Error, Cause }` instead.
  - The After step's payload adds `StepExitedAt` (the After step's own entered time) with `$merge`.
  - `RequestApproval` sends `reviewerEcs` only when the variable exists (`$exists`), since the `Review` choice skips the reviewer when it is off.
- **`ecsFacts` in `control-plane/lib.mjs`.** It turns that object into the row's `ecs`:
  - PascalCase or camelCase keys come in, and camelCase ISO strings go out (epoch milliseconds or ISO in).
  - On the `Catch` path, a JSON `Cause` is parsed as the task, and its times, stop code and the harness container's exit code are kept. Any other cause is kept as `cause`, cut to 300 characters.
  - `error` is cut to 120 characters. It returns null when nothing is left.
- **The After steps.** `afterStage`, `afterDeveloper`, `afterTester`, `afterOperator` and `requestApproval` (for the reviewer) write `ecs` on the session row through the new `sessionFacts`.
  - `afterDeveloper` writes it in the same update as the developer's verdict (REC-4). The others write it best effort.
  - A session with no row (the task failed before the runner wrote it) logs `sessionWithoutRecord` with the facts instead.
- **The runner** adds `workspaceSec`, the time of `prepareWorkspace`, to the session row.
- **Where the time went (`timeParts` in `console/trace.mjs`).** From the row's `ecs` times, its own start and end, and its `workspaceSec`, `environmentSec` and `agentSec`, it gives the step's time and these parts:
  - ECS provisioning (step entered to pull start), image pull, start (pull end to the runner's start);
  - workspace, environment, agent, and "Runner, other": `durationSec` less the known inner parts, or "Runner" when none is known;
  - record and exit (the runner's end to the container's exit);
  - "Stop: exit to stopping", "Stop: stopping to stopped";
  - detection (task stopped to the After step).

  It returns null for a row with no ECS times.
- **Each session's step (REC-3).** `sessionSteps` pairs each session with its step in the trace:
  - first the step of its agent whose time holds the session's start;
  - else the n-th step of its agent for the n-th session, if that step is free;
  - else the first free step.

  Every session view (the run page, the runs list, the MCP `run_get`) has `stepSeconds` from the row's ECS facts, to a tenth of a second. `runDetail` falls back to the trace's step for rows with none, and adds `step: { enteredAt, exitedAt }` and `timeParts`. `traceOf` now gives each step its `exitedAt`.
- **`aipf.sh sessions`** adds `stepSeconds`, `workspaceSec`, the part columns and `ecsError`, from the row's `ecs` through the same `timeParts`. The totals line adds the platform's time per session (step time less session time) for the sessions that have ECS facts.
- **The current stage (REC-5).**
  - While the run is running, `runDetail` takes `stage` from the new `stageNow`: the pipeline stage the workflow entered last, in time. A run sent back to the developer after the approval is at `developer`, not `approval`.
  - For the lists, which read only the record:
    - `nextAttempt` writes `developer`;
    - `answered` writes the asking agent;
    - a merge that resumes the workflow writes `deploy`, both in the orchestrator's `decideApproval` (the pull request event and the Slack path, best effort) and in the console's `resumeReview` (conditional on the run still `running`; a failed condition is ignored).
  - The runs list's `flowOf` reads `developer` and `deploy`.
- **Retries say whether they counted.** `nextAttempt` records `counted` on each retry (today every reason but `answer`), so the console stays right when P1-2 changes the rule (line 9).
- **The stepper (UX-1).** `progressOf`:
  - It gains `failed` (the stage's last step failed) and `escalated` (the stage where an escalated run ended). Only later stages are `not reached`.
  - Each stage carries `attempts: [{ result, seconds, reason }]`, `times` when more than one, and the total of its attempts' seconds.
  - An attempt's reason is the first outcome state between it and the stage's next attempt: "no pull request", "CI failed", "changes asked for", "deploy failed", "tests failed", "no tester verdict", "asked a person", "declined", "pull request closed", "unhealthy", "out of attempts" or "escalated". The last attempt has one only on the stage where the run is or ended.
  - The last node is `Ended`, with the outcome's word and a tone: good for `done`; bad for `escalated`, `failed` and `timed_out`; neutral for the rest. The word is the record's, or else the execution status: `SUCCEEDED` is done, `ABORTED` is stopped, and `TIMED_OUT` is timed out.

  The strip shows `×N`, the stage's total time, and a tooltip such as "Developer: no pull request · CI failed · done · 14 min 47 s in all". The Ended node shows ✅, ⛔ or ⏹️, and 🏁 while the run runs. The nodes are narrower (90 px) and their labels wrap, so the eleven nodes fit at 1280 px.
- **Attempt facts (UX-2).**
  - The run head shows the attempt of the last developer session, else the record's.
  - The retries note is a `details`. Its summary is "Attempt N: …" while the run runs, plus "K retries, M counted against the failure budget". Its list reads "After attempt N: <reason> · <when> · counted / not counted".
  - `REASON_TEXT` and `REASON_SHORT` gain `rebase`, `lease`, `error` and `killed`.
- **Sessions (UX-3).**
  - The columns are the plan's: Agent, Attempt, Model, Verdict, Agent time, Step time, Turns, Tool calls, Tool errors, Refused, Missing tools, Tokens and Cost.
  - Agent time's tooltip gives the runner's parts. Step time's tooltip gives where the step went.
  - Each session's details add "Where the step's 5 min 7 s went: …" and "The step ended with <error> (<stop code>)".
  - The timeline draws the step as a lighter bar under the agent's bar.
- **`harness.mjs`** `SESSION_FIELDS` adds `workspaceSec`, `agentSec` and `ecs`, so the MCP `session_get` tool returns them.

**Differences from the plan**
- **The pairing is not only "the n-th step for the n-th session".** A session with no row (its task failed before the runner wrote it) would shift every later pairing. So the step whose time holds the session's start comes first, and the n-th step is the fallback for rows with no start.
- **`aipf.sh sessions` takes the step time from the row's `ecs`, not the trace.** It reads only the table, so rows from before this line have an empty `stepSeconds`. The new columns are at the end, so scripts that read the old columns by position still work.
- **Insights does not sum the overhead yet.** The plan gives that to UX-11, and line 1 took only UX-11's date normalisation; no line of 8.1 has the rest. The step time and its parts are on each session row and in `aipf.sh sessions`.
- **On a timeout the task's facts are lost.** The `States.Timeout` cause is empty on AWS, so the row has only the error and the step's two times, and no parts.
- **The record's stage uses the pipeline ids** (`developer`, `deploy`), as the stepper does, beside the older `build` and `test`, which the lists still read.
- **Missing tools stays empty until AG-1** (line 18) records `toolsMissing`. The column and the tooltip are there. The verdict `killed` and its cost come with AG-10, also line 18. "Checks" (CT-1) as one stage with two lanes comes with line 10.

**Tests** (177 in all, all passing; 169 before)
- `orchestrator.test.mjs` (51):
  - `ecsFacts` with PascalCase keys and epoch milliseconds, a JSON cause with the harness container's exit code, a timeout's empty cause, a text cause, and null when empty;
  - the After steps write `ecs` on the session row, and a session without a row logs it;
  - the run record's stage: `developer` on a retry, the asking agent on an answer, `deploy` after a merge; a close leaves `approval`;
  - each retry's `counted`.
- `console.test.mjs` (16):
  - a merge through the console writes the stage `deploy`; a close, or a resume that failed, leaves `approval`;
  - the run page of a run sent back after changes were asked for: the stage `developer` though the record says `build`, Developer ×2 with "changes asked for", a session's step time of 307.2 s from its ECS facts and its eleven parts adding up to it, a row with no ECS facts given the trace's 90 s, and a running step with no time;
  - the runs list: the same 307.2 s from the row, and the record's stage.
- `trace.test.mjs` (11):
  - an escalated run: the developer's attempts "no pull request · CI failed · done", ×3 and 180 s in all; CI's "CI failed · done"; the approval `escalated` with "changes asked for"; later stages `not reached`; Ended `escalated` and bad;
  - a failed stage, `done` and good, `ABORTED` as stopped, `declined` as neutral, and `next` while running;
  - `stageNow`: `developer` again after the approval, nothing before the first stage, and never the end node;
  - each session with its step: a developer row paired by its start with the agent's second step, a row with no start given the step left, and a designer row with no step;
  - where a step went: the parts add up to 307.2 s of a 307.2-s step.
- **On AWS, on a temporary state machine** (`aipf-plan08-ct3a`, with the task definition `aipf-plan08-ct3a` on the temporary cluster):
  - The definition validated. The session state had the same `Assign`, `Catch` and After `$merge` as the shipped workflow.
  - **A container that exited 0:** the result had PascalCase keys and epoch-millisecond times, and `ecsFacts` and `timeParts` read it as provisioning 12.4 s, image pull 4.9 s, start 0.2 s, the container's 2.0 s, exit to stopping 10.0 s, stopping to stopped 12.9 s and detection 1.2 s: 43.6 s for a 2-s task. This is the platform time round 3 measured (about 63 s with the real image).
  - **A container that exited 3:** `States.TaskFailed`, with the task as JSON in the cause. `ecsFacts` kept its times, `EssentialContainerExited` and exit code 3.
  - **A timeout:** `States.Timeout` with an empty cause.
  - **The never-assigned `$reviewerEcs`:** `$exists` gave null, and the definition validated.
  - The workflow itself validated with `ValidateStateMachineDefinition` (no errors).
- **The console in headless Chrome,** against the packaged console with a fake SDK:
  - **An escalated run** (no pull request, CI failed, changes asked for, out of attempts): the eleven nodes fit at 1280 px with Ended ⛔ "escalated", the tooltips above, the retries list, and the sessions table with Step time and the parts.
  - **A running run** on attempt 2 after CI failed, in the dark theme: Developer "working · ×2", Ended 🏁 "next", and "Attempt 2: CI failed on the branch… 1 retry, 1 counted against the failure budget".
  - **At 500 px:** no page overflow.
  - **The runs list:** both runs, with the escalated one's red segment on Your review.

**Deploy.** This line changes the workflow, the orchestrator and console code, `app.js`/`app.css` and the runner. It adds no stack resource or grant.
1. Run `providers/aws/aipf.sh pause "line 8"` and wait until no run is running.
2. Run `providers/aws/aipf.sh up`: the workflow, the orchestrator and the console. The new definition applies to new executions only. Old executions send no `ecs`, and `ecsFacts` makes that a no-op.
3. Run `providers/aws/aipf.sh build`, then `providers/aws/aipf.sh snapshot`, so the sessions record `workspaceSec`.
4. Run `providers/aws/aipf.sh resume`. Start one test run, then check:
   - the run page's sessions show Step time and its parts, and the parts add up to the step;
   - `providers/aws/aipf.sh sessions` shows the same numbers;
   - the run page, the runs list, the MCP `run_get` and `aipf.sh sessions` agree on the stage, the attempt and the times (G1).

Rows from before the deploy have no `ecs`. Their Step time comes from the trace on the run page only.

## Line 9: outcomes and budget (`upgrade/9-outcomes-and-budget`)

Items: P1-2, P1-1, UX-10, UX-5.

**Built**
- **The failure budget (P1-2).** `nextAttempt` counts a failure only for the reasons of D-4 (`COUNTED`: `ci`, `deploy`, `tester`, `no_pr`, `error`).
  - Every retry adds one to the new `rounds`. The run is `exhausted` at `MAX_FAILURES` (3) failures or `MAX_ROUNDS` (8, env `MAX_ROUNDS`) rounds.
  - The record keeps `outOf`: "3 failures" or "8 rounds". `OutOfAttempts` says which budget ran out.
  - `feedbackText` gains `rebase`, `lease` and `error`. New runs start with `rounds: 0`.
- **The ends that are not failures (P1-1).** The new orchestrator action `end({ run, outcome, reason, prId, by, human, revertPr, commit })`:
  - runs `finish` first: the record's status and stage become the outcome, it gets `endedAt`, `endReason`, `endedBy` and `revertPr`, and every open row is closed;
  - then, best effort, labels and moves the work item (`ENDS`, D-6): `done` → Done; `declined` → `aipf-declined` and "Won't do"; `wont_do` → `aipf-wont-do` and "Won't do"; `closed` → `aipf-closed` and To Do; `reverted` → `aipf-needs-person`;
  - deletes the run's own agent branch on `closed` only (never a branch of another work item);
  - writes one sentence to Jira and Slack, such as "Run SCRUM-94-1 ended as closed: pull request 94 was closed without merging by ana. The branch agent/SCRUM-94 is deleted. The work item has the label aipf-closed and is in To Do."

  `escalate` now adds `aipf-needs-person` too. The Jira connector gains `addLabel(key, label)`, which refuses a label with a space.
- **The workflow.** `Declined`, `Closed`, the new `WontDo`, `NothingToPush` and `Reverted` assign `$ending` and go to the Task `End` (payload `$merge([$ending, { action: 'end', run: $run }])`), then to the `Succeed` state `Ended`, whose output is `{ runId, outcome }`. `End`'s `Catch` escalates.
  - `AskHuman` is followed by the new Choice `Reply`: `wont_do` goes to `WontDo`, anything else to `Answered`.
  - `WhatHappened` gains `nothing_to_push`.
- **The tester decision (P1-1).** `TesterResult`'s fail goes to `TesterDecision` (`waitForTaskToken`, 86 400 s; `States.Timeout` and `States.ALL` escalate). Its payload has the token, the pull request, the commit and the tester's report.
  - `askDecision` writes a `HUMAN#` row of kind `decision` (the report's last 6 000 characters, the attempt, `failuresLeft`), sets the stage `decision`, and posts to Slack the three choices with the console link.
  - `TesterChoice`:
    - `accept` → `Accepted`: an `accept` amendment with the console name, posted to the work item, then the operator. `done` then says "accepted by ana over the tester agent's finding".
    - `fix` → `TesterFailed`: today's `nextAttempt` with reason `tester`. The person's note is added to the developer's feedback as "The person who chose the fix adds: …".
    - `revert` → `Redeploy`: CodeBuild deploys `refs/heads/main` again (`startBuild.sync`), then `Reverted` ends the run `reverted`. A failed redeploy escalates with "revert of pull request 41 is merged".
    - anything else → `NoDecision`, which escalates.
  - `afterTester` on a fail notes the finding on the work item and hands the report to the decision. The Slack message comes from `askDecision`.
- **"Nothing to push" (P1-1).** In `developerOutcome`: after a fix from `main` (`lastReason` `tester`, `fromMain`), a session with no error whose `git` facts say 0 commits ahead and 0 uncommitted files, on a run whose pull request is merged, is `nothing_to_push`. It ends `done` with "the developer agent found nothing left to change after pull request N was merged. It said: …".
- **The console.**
  - `POST /api/human/<id>` on a `decision` row takes `{ decision: accept | fix | revert, note }`. It is refused with 409 unless the run is `running` at the stage `decision`, and a second decision is refused. The row is claimed, then:
    - for `revert`, the console reverts the pull request first (below). A revert it cannot make lets the claim go, so the run still waits.
    - then `SendTaskSuccess` with `{ decision, note, by, human, revertPr }`.
  - On a `question` row, `{ decision: 'wont_do', reason }` (a reason is required) resumes the run with the console name.
  - The audit line names the decision and the revert pull request.
  - `testerDecisionOf` gives the run page the open decision: when it was found, the commit, the failures left and the report, with secrets masked.
  - The inbox lists decisions with no answer link.
  - `runView` and the run page add `endReason`, `endedBy` and `revertPr`. `nowText` says, for example, "The run ended: reverted by ana (…). Revert pull request 95 is merged."
- **The revert (`review.mjs` `revert`).** On a merged pull request, from the merge's before and after commits:
  - It refuses with 409, and leaves nothing behind, when:
    - the pull request is not merged;
    - it changed no file, or more than 100;
    - a file it touched changed on `main` since ("README.md changed on main since pull request 41: revert it by hand");
    - it has a submodule;
    - the files to put back are over 5 MB in all.
  - Otherwise it creates `aipf/revert-<pr>-<base36>` from `main`. One `CreateCommit` puts back each file's earlier content and deletes the added files. The commit's author is "AIPF console" and its message names the person.
  - It opens "Revert pull request N: …", comments that the person's decision is its approval, overrides the approval rules and merges it (fast-forward where the branch allows, else squash).
  - It comments on the original pull request: "Reverted by pull request M, decided by ana in the AIPF console."
  - On a failure it closes the revert pull request. In `finally` it deletes the branch.
- **The console role** (`stack.yaml`):
  - `RevertMergedPullRequests`: `GetCommit`, `GetBranch` and `CreatePullRequest`;
  - `RevertBranchesOnly`: `CreateBranch` and `CreateCommit`;
  - `DeleteRevertBranches`: `DeleteBranch`.

  The last two allow only `codecommit:References` like `refs/heads/aipf/revert-*`. The role already had the merge, comment and override grants of P0-2 and UX-6.
- **Outcomes counted apart (UX-10).**
  - `insights.mjs` has `OUTCOMES` (D-3).
  - `outcomeOf` keeps each outcome.
  - `successOf` is done / (done + reverted + escalated + failed + timed_out), and null with none of those.
  - The donut, its legend (non-zero outcomes only), the daily chart and the outcomes line show every outcome and `running`. Each figure has "How it is counted".
  - `app.js` maps every outcome to its word (`OUTCOME_TEXT`) and keeps line 8's tones: good for done; bad for escalated, failed and timed out; neutral for the rest, reverted included, since it is no failure (D-3). The runs list's filters name each outcome.
- **In-page dialogs (UX-5).** One `dialog()` helper on `<dialog>` gives a title, the text being sent, the consequence, an optional or required field, Cancel and the named action. It traps focus, and Escape cancels.
  - It replaces the seven `confirm()` calls: stop staging, approve, ask for changes, close, stop run, and accept and reject a memory proposal.
  - It also serves the tester decision (three options with the plan's sentences, and a note) and "Don't do this item". `app.js` has no `confirm(` left.
  - The decision card on the run page has Accept, Fix and Revert, each opening the dialog with its option chosen.

**Differences from the plan**
- **"Nothing to push" reads the session's git facts, not a diff against `main`.** A session that left no commits and no changes on a branch made from `main` has nothing to push. The orchestrator does not fetch the repository.
- **The tester decision's Slack message links the console, not `/human/`.** The decision names a signed-in person (D-13), so `humanPage` answers a decision row with 403 and a link to the console.
- **`Reply` is a new Choice state** after `AskHuman`, not a route inside `Answered`, so `Answered` stays as it was.
- **The staging lease while the decision waits, and the release of the lease and the queue on an end, come with lines 11 and 12** (P1-3, P1-4), which build them. `end` releases what exists today: the lock and the open rows.
- **The Stop staging dialog leaves out "Runs that reach the deploy wait for the lease"** until P1-4 adds the lease. The Approve dialog has the text for no merge queue, since P1-3 is line 11.
- **The revert pull request is overridden, not approved.** CodeCommit refuses an approval by the pull request's own author, and the console is its author. The branch name has a base-36 suffix, so a second revert of the same pull request never meets an old branch.
- **The console's revert grants use `StringLike` on `codecommit:References`,** as tested on AWS (below): CodeCommit sends the key as one string for these calls.
- **`testerDecisionOf` masks the report only.** The rest of the row is ids and times.
- **`finish` closes the open rows on every end,** not only on an escalation.
- **The decision POST checks the run's status and stage** before it claims the row, so a decision after a timeout or a stop is refused and nothing is reverted.
- **`end` runs `finish` first, then the tracker and the chat best effort,** so a run is ended even when Jira or Slack is down.
- **`confirm()`'s line numbers** in `app.js` differ from the plan's; the same seven calls were replaced.

**Tests** (198 in all, all passing; 177 before)
- `orchestrator.test.mjs` (59):
  - each retry reason counts or not as D-4 says, is one round, and gets its feedback; two change requests leave three failures to spend (C3);
  - the run of the old budget test now ends on "3 failures" after `changes` (not counted); a run at seven rounds ends on "8 rounds" with two failures;
  - `end` for each outcome: its reason, label, status, Jira and Slack sentence; `closed` deletes the run's branch;
  - `end` with the tracker and the chat down still finishes the run; a branch of another work item is never deleted;
  - `escalate` adds `aipf-needs-person`;
  - `afterTester` on a fail; `askDecision`'s row with the failures left, and its Slack message with no answer link;
  - `accepted`'s amendment with the console name, and `done`'s "accepted by … over the tester agent's finding";
  - "nothing to push" after a fix from `main` ends `done`.
- `console.test.mjs` (23):
  - "Don't do this item" takes a reason and resumes with `wont_do` and the console name;
  - the run page and the inbox give the decision with no answer link, and the report is redacted;
  - accept and fix resume with the decision, the note and the name; a second decision is refused;
  - a decision on a run that no longer waits is refused before anything is claimed;
  - revert merges a revert pull request, then resumes with it; a revert the console cannot make lets the claim go and the run still waits;
  - an ended run gives how it ended, who ended it and the revert pull request.
- `insights.test.mjs` (8): `outcomeOf` keeps every outcome; success leaves out the person's choices (declined, closed, won't do, stopped, duplicate).
- `platform.test.mjs` (19): the workflow's decision states and that every end that is no failure goes through `End`; `OutOfAttempts` names the budget.
- `trace.test.mjs` (12): a run waits at the tester for a decision, then ends `reverted`, which is no failure.
- `connectors.test.mjs` (22): `addLabel`.
- **On AWS: the revert on CodeCommit**, on the temporary repository `aipf-plan08-push` with the temporary approval rule template `aipf-plan08-approval` (one approval), through the console's `review.mjs`. 25 of 25 checks passed, both as me and under the temporary role `aipf-plan08-revert`, which has only the console's revert statements:
  - a fast-forward merge and a squash merge were each reverted: `main`'s files were as before the pull request;
  - the revert pull request was merged and named the original; the revert commit's author was "AIPF console" with "Reverted by ana in the AIPF console";
  - no `aipf/revert-*` branch was left;
  - the original pull request had "Reverted by pull request N, decided by ana in the AIPF console."; the revert pull request had the override comment;
  - the template's rule applied to each pull request, and the override let the pull request's own author merge;
  - "README.md changed on main since pull request N: revert it by hand" and "is not merged: there is nothing to revert" gave 409 with no branch made.
  - Under the role, a branch outside `aipf/revert-*`, a commit to `main` and the deletion of `main` were denied. IAM's policy simulator gave the same answers.
- **On AWS: the workflow's new states** with TestState against the full definition (30 of 30):
  - `TesterResult`; `TesterDecision`'s payload with the token, the pull request, the commit and the report, its result in `$decided`, and its catches (after the retries ran out) to `Escalate`;
  - `TesterChoice` for each choice and an unknown one; `Accepted`; `TesterFailed` with and without a note;
  - `Redeploy` with `refs/heads/main` and its failure text; `Reverted`; `Reply` both ways; `WontDo`; `Closed` by a person and from CodeCommit (no name); `Declined`; `WhatHappened` to `NothingToPush`;
  - `End`'s payload and its catch; `Ended`'s output; `OutOfAttempts` with failures and with rounds; `NoDecision`.
  - The definition validated with `ValidateStateMachineDefinition`.
- **On AWS: a `waitForTaskToken` timeout is not retried.** TestState says the `States.TaskFailed` retrier matches `States.Timeout`. On a temporary state machine (`aipf-plan08-timeout-retry`, an SQS `waitForTaskToken` task with a 2-s timeout and the same `Retry` and `Catch`) the real engine scheduled the task once, timed it out and went straight to the `Catch`. So `AskHuman`, `RequestApproval` and `TesterDecision` time out after one wait, not three.
- **The stack:** `cfn-lint` gives the same 21 warnings as before the line; `validate-template` passed.
- **The console in headless Chrome,** against the packaged console with a fake SDK:
  - **A run waiting on the decision** (SCRUM-90): Tester "waits for your decision"; the banner "Your turn: the tester agent found pull request 90 not done on staging…"; the card with the finding (the token redacted), "Fix counts as a failure: 2 left before the run escalates", and Accept, Fix and Revert; the decision in "Decisions and answers". Also at 420 px, with no page overflow.
  - **The dialogs:** the tester decision with the three options and the note; "Don't do SCRUM-92?" in the dark theme with a required reason and "End the run"; "Stop staging?" with the text above. Accept and "Don't do" sent what the dialog showed, with the audit lines; Cancel and Escape sent nothing.
  - **A reverted run** (SCRUM-91): Ended "reverted" and "The run ended: reverted by ana (…). Revert pull request 95 is merged."
  - **Insights** with eight runs: success 33 % (one done of done, reverted and escalated); the donut, the legend and the daily chart with done, declined, closed, won't do, reverted, escalated and running; "How it is counted" under each.
  - **The runs list:** a filter per outcome with its count, and each run's word: "waits for your decision", "reverted 9 min ago", "won't do 27 min ago".

**Deploy.** This line changes the workflow, the orchestrator, the console code, `app.js`/`app.css` and the console role. It adds no resource.
1. Run `providers/aws/aipf.sh pause "line 9"` and wait until no run is running.
2. Run `providers/aws/aipf.sh up`: the console role's revert grants, the orchestrator, the console and the workflow. `MAX_ROUNDS` defaults to 8. The new definition applies to new executions only.
3. Run `providers/aws/aipf.sh resume`. In round 4, check:
   - A3: a declined item ends `declined` with `aipf-declined`;
   - C4: a closed pull request ends `closed`, with no branch left and the item in To Do with `aipf-closed`;
   - B11: a tester failure shows the three choices; `revert` ends `reverted`, with `main` reverted and staging redeployed;
   - C3: two change requests leave three failures to spend.

The Jira statuses "Won't do" (and "Needs a person", P1-6) exist only when the Jira admin adds them. Without them, the labels still apply and the transition is skipped.

## Line 10: a faster pipeline (`upgrade/10-faster-pipeline`)

Items: CT-1, CT-2, CT-3b, CT-4.

**Built**
- **CI and the reviewer in parallel (CT-1).** After `WhatHappened`, the `Parallel` state `Checks` has two branches:
  - `CI`, then `ImageBuild` (CT-2). A failure in either is caught into the `Pass` state `CINotPassed`, with `{ ci: 'failed', stage: 'ci' | 'image', error }`;
  - `Review`, the `Choice` that was before CI: `ReviewerOff` returns `{ reviewer: 'off' }`; `Reviewer` ends in `ReviewerDone` or `ReviewerError`, each with the step's ECS facts as `reviewerEcs`.

  Each branch hands its facts out as its last output. `Checks` merges them (`$merge($states.result)`) into its output and `$checks`, and its `Catch` escalates. No variable assigned inside a branch is read after it.
  - `AfterChecks` (the orchestrator's `afterChecks`) records `checks` on the run: `ci`, the failed `stage`, `image`, `commit`, `reviewer` and `attempt`. It also records the pull request's `dependencyChange` (P0-5), then the reviewer's ECS facts and hand-over.
  - `ChecksResult` goes to `RequestApproval` only when `$checks.ci` is `passed`; anything else goes to `CIFailed`.
  - `CIFailed` (`ciFailed`) names CI or the image build in the pull request note. It restarts the developer with that build's log (reason `ci`).
  - The console draws one "Checks" stage with two lanes, CI and the reviewer agent, in the stepper and in the flow (`trace.mjs` `PIPELINE`, `lanesOf`; `app.js` `stepLanes`; `app.css`). A failure goes to the lane its events chain back to (`previousEventId`). A CI failure fails the stage; a reviewer error does not. A run from before CT-1 shows its CI step as the checks stage.
- **A deploy that only rolls out (CT-2).**
  - `ImageBuild` starts the deploy project on the commit CI passed (`$ciCommit`, CI's `ResolvedSourceVersion`) with `AIPF_DEPLOY_MODE=image`. `deploy.sh` then builds and pushes `:<commit>` (skipped when the tag exists) and stops. It touches neither the database nor the service.
  - `DeployStaging` passes `IMAGE_TAG` (the checked image). When `main`'s head is that commit, `deploy.sh` reuses the image. When `main` moved past it (a merge made in CodeCommit), it builds first, as before.
  - **The release** polls `DescribeTasks` every 2 s and goes on once the `app` container's exit code is set. A non-zero exit code, or a task that stops without one, fails the deploy as before.
  - **The rollout** polls every 3 s. It ends when the new deployment (its id from `update-service`) has its desired count running and `HEALTHY`, and the other deployments run no task. A circuit breaker failure still ends the deploy with the service's events.
  - `deploy.sh` writes `AIPF_DEPLOYMENT_ID` and `AIPF_IMAGE_TAG` to `out.env`. The deploy project exports them (`exported-variables`), and `DeployStaging` assigns `$deployment` from `ExportedEnvironmentVariables`.
  - `AfterTester` reads that deployment through the new `ops.deployment(id)`. `FAILED` (ECS rolled back after the deploy counted it done) sends the run to `DeployFailed` with the reason, whatever the tester said. The run records `deployment`.
  - The staging health check's `Interval` is 5 s, not 10. The deploy role gets `ecs:ListTasks` on the cluster.
- **The step waits for the runner's token (CT-3b, item 1).**
  - The six session states (`Pm`, `Designer`, `Developer`, `Reviewer`, `Tester`, `Operator`) use `ecs:runTask.waitForTaskToken` with `HeartbeatSeconds: 300`. They pass `AIPF_TASK_TOKEN` (`$states.context.Task.Token`) to the `harness` container.
  - Each state keeps `StepEnteredAt` and the facts the runner sends: `TaskArn`, `PullStartedAt`, `PullStoppedAt`, `StartedAt` and `TokenSentAt`. A caught failure keeps `Error` and `Cause`.
  - **The runner** (`harness/runner/step.mjs`, used by `session.mjs`):
    - It reads the task metadata endpoint (v4) when it starts.
    - It sends `SendTaskHeartbeat` every 60 s from a worker thread: the runner blocks on `spawnSync`.
    - Once the session record is written, it sends `SendTaskSuccess` with the facts.
    - When it cannot record the session, it sends `SendTaskFailure` (`SessionFailed`, the redacted message).
    - When a heartbeat says the step no longer waits (`TaskTimedOut`, `InvalidToken`, `TaskDoesNotExist`), it exits 0.
    - Only error names are logged. The token is in the redactor and in the set of variables the agent never gets (`scope.mjs`). The agent's scoped credentials deny `states:SendTask*` (`NoStepToken`).
  - **A task that dies without a word (item 2).** The rule `SessionStoppedRule` sends ECS `STOPPED` events of the `-session` and `-light` families on the cluster to the orchestrator's new `taskStopped`. It reads the token from the `harness` override and calls `workflow.fail` (`TaskStopped`). The cause has the task's times, stop code, reason and the harness exit code. A step that already went on (`TaskTimedOut`, `InvalidToken`, `TaskDoesNotExist`) is no error.
  - `sessionFacts` refuses a token sent without a session row, as a session without a record. Each After step, the end of a run and `releaseRun` call the new `sandbox.stop({ runId, reason })` to stop the run's session tasks that still run.
  - `ecsFacts` reads both shapes and keeps the task id, never its ARN. The trace's parts for a token step are provisioning (from `StepEnteredAt`), pull, start, workspace, environment, agent, runner, "Record and token" and "Token to the next step".
  - The task roles get `states:SendTaskSuccess`, `SendTaskFailure` and `SendTaskHeartbeat`. IAM takes only `*` for them: the token scopes the call. The orchestrator gets `SendTaskFailure`, `ecs:ListTasks` on the cluster, `DescribeTasks` and `StopTask` on its tasks, and `DescribeServices` on staging. `harness` gains `@aws-sdk/client-sfn` 3.1152.0.
- **The platform ports.** A seventh port, `sandbox` (`stop`). `workflow.fail`; `ops.deployment`; `ci.lastDeploy` skips the image builds. The memory adapter has all of them; on Google Cloud they are not built and return `undefined`.
- **CI without the runtime install (CT-4).** Pull request 60 in `aipf-poc-sample` (`ct-4-ci-path`), for a person to merge. `buildspec.yml` drops `runtime-versions` and starts the install commands with `export PATH="$(ls -d /usr/local/n/versions/node/22.* | tail -n 1)/bin:$PATH"` and `node --version`. `environments/poc` has the same file and a `NOTES.md` line for any project repository on this CI image.

**Differences from the plan**
- **`ChecksResult` sends anything but `passed` to `CIFailed`.** The plan sends a CI failure there and everything else to approval. With this default, a missing or unknown CI result never reaches a person as passed.
- **`ImageBuild` builds the commit CI passed, not the branch head.** A push after CI started cannot slip into the image.
- **The image build runs the branch's setup before a person has reviewed it.** `docker build` runs `start.mjs setup` (for example `npm ci`) in the deploy project. Before, that happened only after a merge. The build steps run inside `docker build`, which does not get the project's credentials; CI already runs the same commands with CI's role. This is reasoning, not tested on AWS. The image is tagged with the commit, and only that commit, once merged, is deployed with it.
- **`ci.lastDeploy` skips the image builds.** The deploy project now runs both kinds of build, so it picks the last one without `AIPF_DEPLOY_MODE=image`.
- **The deploy role needs `ecs:ListTasks`** to find the new deployment's tasks. The plan did not list it.
- **The health check `Interval` is at `stack.yaml` about line 1080, not :856.**
- **A stopped database starts before the image build, not after it**, so the two overlap.
- **`dependencyChange` moved from `requestApproval` to `afterChecks`.** `requestApproval` keeps a path for executions started before CT-1, which have no `AfterChecks`: it records the reviewer facts and the dependency change itself (`checks.attempt` tells them apart).
- **`CIFailed` names the failed stage**, CI or the image build, in the pull request note.
- **`ops.deployment` falls back to the service's events.** ECS drops a replaced deployment from `DescribeServices`. A "deployment failed" event still gives `FAILED`; otherwise the result is `UNKNOWN`, which is no failure.
- **The run records `deployment`** (the id), and `AfterTester` takes it from the workflow. An execution of the old definition passes none, so nothing is checked.
- **Exported variables were checked on AWS** before the workflow relied on them: a temporary state machine ran `codebuild:startBuild.sync` on a temporary project (`aipf-plan08-runtime`). `$states.result.Build.ExportedEnvironmentVariables` had both variables, and the `$deployment` expression gave the id or `''`.
- **Tasks are found by their `AIPF_RUN_ID` override, not by `startedBy`.** Step Functions refuses `StartedBy` in `RunTask`'s arguments. `sandbox.stop` lists the cluster's running tasks (every page), describes them and stops those whose `harness` override names the run. The reason is cut to ECS's 255 characters.
- **The heartbeat runs in a worker thread.** The runner blocks on `spawnSync` for minutes, so a timer on the main thread would not fire. The worker's "gone" is handled only when the main thread is free, between commands. Until then the orchestrator's `sandbox.stop` (After steps, end of a run) covers it.
- **The runner fails its own step (`SessionFailed`)** when it cannot write the record, so the step does not wait for ECS's `STOPPED` event.
- **The runner reads the task metadata when it starts, not at the end.** The live check found that a read left pending while the runner blocks meets its own 3 s timeout before its answer, so the facts were empty. Fixed and checked again (below).
- **Provisioning is measured from `StepEnteredAt`.** The metadata endpoint has no task `CreatedAt`. The endpoint gives times in nanoseconds; `ecsFacts` keeps milliseconds.
- **Items 3 (SOCI) and 4 (the workspace fetch) are not built.** The plan makes each depend on CT-3a's numbers in round 4: the pull above 10 s, `workspaceSec` above 5 s.

**Tests** (228 in all, all passing; 198 before)
- `orchestrator.test.mjs` (69):
  - `afterChecks` records CI, the image, the reviewer and the dependency change, and hands over the verdict;
  - `ciFailed` names the image build;
  - `requestApproval` of an execution started before CT-1 records the reviewer and the dependency change itself;
  - `afterTester` sends a rolled-back deployment to `DeployFailed`, records one that rolled out, and checks nothing for an old execution;
  - `ecsFacts` reads the token's facts (with nanosecond times) and a `TaskStopped` cause: no account number on the row;
  - a token without a session row is refused, the run's tasks are stopped, and a failing stop is best effort;
  - `taskStopped` fails the step with a cause `ecsFacts` reads, and never logs the token; a used token and a task without one are no error;
  - the end of a run stops only its own tasks.
- `aws.test.mjs` (4, new, with a fake AWS SDK): `lastDeploy` skips the image builds; `ops.deployment` reads `rolloutState` and the service events; `sandbox.stop` pages, filters on the `harness` override and cuts the reason; `workflow.fail` cuts the cause to 32 768 characters, ignores a step that is gone, and throws any other error.
- `deploy.test.mjs` (6, new): `deploy.sh` against a stub `aws` and `docker` on `PATH`. It covers the reused image, the release at its exit code, the rollout's end on `HEALTHY`, the image mode, `main` past the checked image, a failed release or one with no exit code, a circuit breaker failure, and the early database start.
- `step.test.mjs` (4, new): `taskFacts`; `taskMetadata` with a local endpoint, a 500 and no endpoint; `stepToken`'s succeed, fail and gone, with the token never in a log line; the heartbeat worker against a local endpoint that answers like Step Functions, while the main thread blocks (`Atomics.wait`).
- `platform.test.mjs` (23): the `Parallel` branches and their outputs; no variable assigned in a branch read outside it; the deploy's `IMAGE_TAG` and `$deployment`; each session state's token, heartbeat, facts and catch.
- `trace.test.mjs` (14): the checks stage's two lanes, with a failure in its own lane; a token step's parts (281.9 s in all), and a stopped one's.
- `scope.test.mjs`: the token is never in the agent's environment; the `NoStepToken` deny.
- **The stack:** `cfn-lint` gives 7 warnings, as on `main`. `validate-template` (through the deploy bucket, as the template is over 51 200 bytes) passed. `ValidateStateMachineDefinition` gives `OK` with no diagnostics.
- **On AWS: CT-3b's token step, end to end**, with `step.mjs` as it is in the runner.
  - The set-up: a temporary state machine `aipf-plan08-ct3b` with the session state's shape (`waitForTaskToken`, the token in the `harness` override), on the cluster `aipf-plan08` (Fargate, a driver `run.mjs`). A rule like `SessionStoppedRule` fed an SQS queue, read by a local poller that ran the orchestrator's real `taskStopped` on the memory platform, with `workflow.fail` sending `SendTaskFailure`.
  - Times are from the step's entry:

  | Case | What happened |
  |---|---|
  | ok (120 s of work, heartbeat 90 s, a beat every 10 s) | The step lasted 146.6 s, past the 90 s heartbeat, while the main thread blocked on 10 s commands. It ended when the token was sent, at the container's exit; ECS set `StoppingAt` 10.1 s and `StoppedAt` 23.4 s later. The stop event's `taskStopped` was ignored (`TaskTimedOut`) |
  | ok, again after the metadata fix | The runner sent `TaskArn`, `PullStartedAt`, `PullStoppedAt`, `StartedAt` and `TokenSentAt`. Provisioning 14.3 s, pull 6.9 s, start 0.8 s |
  | crash (exit 3 before the token) | The container exited at 28.2 s, ECS `STOPPED` at 51.8 s; `taskStopped` failed the step with `TaskStopped` at 53.2 s (exit code 3, `EssentialContainerExited`) |
  | fail (`SessionFailed`) | The step failed at 27.5 s, at the exit; the later stop event was ignored |
  | silent (no heartbeat, `HeartbeatSeconds` 30) | `States.Timeout` at 30.6 s, but the task ran on to 180.3 s, the end of its work: Step Functions does not stop a `waitForTaskToken` task on a timeout, which is why the After steps call `sandbox.stop` |
  | gone (the execution stopped at 63.7 s) | The next heartbeat got `TaskTimedOut`, and the runner exited 0 at 77.5 s |

  - The ECS event carried the token in the override, as the plan says. Neither the poller's rows nor its output held it.
  - The one-container test task saved 23.4 s of stop wait. The plan's 35 s is round 3's median with the `db` sidecar; round 4 measures the real one.
- **On AWS: CT-4**, `aipf-poc-ci` on the branch before the pull request: source phase 7 s (62 to 69 s before), the build 48 s (82 to 109 s), `node --version` v22.23.3, lint passed, unit tests 54 of 54 and integration tests 74 of 74. The plan expected about 27 s; `npm ci` alone took 20 s of the install phase in this build.

**Deploy.** This line changes the stack, the workflow, the orchestrator, `deploy.sh`, the console code and the session runner. It adds `SessionStoppedRule` and its permission.
1. Run `providers/aws/aipf.sh pause "line 10"` and wait until no run is running: an execution of the old definition would meet the new After steps.
2. Run `providers/aws/aipf.sh build`: the harness image and then the snapshot, with the new runner. Do this before `up`. A runner without a token works as before; a token step whose runner sends no token would wait 300 s and fail.
3. Run `providers/aws/aipf.sh up`: the stop rule, the grants, the health check `Interval`, the deploy project's exported variables, `deploy.sh`, the orchestrator, the console and the workflow. The new definition applies to new executions only.
4. Run `providers/aws/aipf.sh resume`.
5. CT-4: a person merges pull request 60 in `aipf-poc-sample`, at any time. The merge rebuilds the snapshot, as any change to `main` does.

In round 4, check that the platform's overhead per agent step is under 35 s (CT-3a's parts), the deploy under 140 s (CodeBuild's phases and the log's times), CI's source phase under 10 s, and CI and the reviewer side by side in the console.

## Line 11: the merge queue (`upgrade/11-merge-queue`)

Items: P1-3, UX-7.

**Built**
- **Approve goes into the queue (P1-3, item 1).** With `AIPF_MERGE_QUEUE` other than `off` (the stack's new `MergeQueue` parameter, `on` by default; `aipf.sh` passes `AIPF_MERGE_QUEUE`), the console's Approve records the approval, does not merge, and resumes the step with `{ decision: 'approve', by, revisionId, commit }`.
  - `review.mjs` gains `approve` and `recordApproval`. `recordApproval` is the comment, the approval and the override of an old approval rule, as before; `approveAndMerge` now uses it too. The comment says the merge queue merges it.
  - The console writes the record's `stage: 'queue'` and `queue: { step: 'waiting', since, at }` with the resume (REC-5), so the lists show the queue before its first step.
  - The order is approve, resume, then mark the review answered. When the resume fails, the approval row is back, the review stays open, and the person gets a 503: "approve again in a minute".
- **The workflow's queue states (item 2):**
  - `Decision` sends `approve` to `QueueStart`, which keeps the approved commit as `$approvedCommit` and `$branchHead`.
  - `TakeQueue` (the orchestrator's `takeQueue`) does a conditional put of `PLATFORM/MERGE_QUEUE` with the run, the work item, the pull request, `takenAt` and `expiresAt`. The queue is free when it is empty, already this run's, held past its time, or held by a run that has ended. Otherwise `QueueWait` (30 s) loops back, and 30 minutes after the approval the run leaves as `lease` with a pull request note.
  - `MainMoved` (`mainMoved`, `scm.mergeState`) checks whether `main` can fast-forward to the branch: `current` goes to `Merge`, `moved` to `UpdateBranch`.
  - `UpdateBranch` runs the new CodeBuild project `${App}-update-branch` (`providers/aws/deploy/update-branch.sh`, ARM `SMALL`, no source, logs in `/${App}/update-branch`). It clones the repository, checks that the branch is at `$branchHead`, and merges `origin/main` with real git under the platform's identity (`aipf-platform@example.invalid`). It pushes without force and writes `AIPF_UPDATE` (`updated`, `current`, `conflict` or `changed`), `AIPF_COMMIT` and `AIPF_CONFLICTS`.
  - `BranchUpdated` (`branchUpdated`) handles the result:
    - `updated` goes to `MergedCI` and `MergedImage`: CI and the image build on the merged head.
    - `conflict` leaves the queue as `rebase` with the files, a note, and no failure counted (D-5).
    - `changed` is a push nobody approved, and escalates.
  - `Merge` (`mergeQueued`) fast-forwards `main` to the head CI passed. A head past the approved commit must hold only the platform's two-parent merges (at most ten, checked by `scm.commit`). The approval then stands for the new revision: the approval rules are set aside with a comment. If `main` moved meanwhile, the run goes back to `MainMoved`; a push meanwhile escalates.
  - Every way out passes through `ReleaseQueue` (`releaseQueue`, conditional on the run), then `QueueExit`:
    - `merged` goes to `DeployStaging`;
    - `rebase` and `lease` go to `QueueAgain` (`nextAttempt`, not counted);
    - `ci` goes to `CIFailed` ("on the merged head");
    - `closed` goes to `Closed`;
    - anything else escalates.

    Platform step failures go through `QueueError` to the same release. `releaseRun` also frees the queue at any end, and a hold lasts 60 minutes from each queue step.
- **A merge made in CodeCommit (item 3)** still arrives as `merged` and skips the queue. One made while the run waits in the queue is seen by `mainMoved` and `mergeQueued` and goes on to the deploy.
- **Other open pull requests (item 4).** After every merge into `main`, `pullRequestEvent` posts on every other open `agent/*` pull request into `main`. With the queue on: `main moved to <commit>; this branch is merged with it before its own merge.` With it off, the note asks the person to check for conflicts before approving.
- **The console (item 5, UX-6, UX-7):**
  - `queueStep` writes `run.queue = { step, since, at, holder?, files?, commit?, exit? }`. The steps are `waiting`, `taken`, `update`, `ci`, `merge`, `conflict`, `merged` and `done`.
  - The run view gives `queue` while the stage is `queue`. While the run waits, the queue view adds `ahead` (the holder, plus the runs that wait with an earlier approval) and `heldBy`.
  - The review view gives `mergeQueue` and, with it, `queue.ahead` and `queue.heldBy`.
  - `trace.mjs` has a "Merge queue" stage between the review and the deploy. A pass through the queue, with its 30 s loop, is one attempt, and the stage waits while another run holds the queue. A conflict comes back to the developer as "back from the merge queue".
  - `app.js`:
    - the flow and the stepper have the queue;
    - the timeline has "Update branch" and "CI on the merged head" lanes;
    - the review panel has the queue line ("Merge queue: N pull requests before this one · main moved since CI: it is merged in first"). With the queue, Approve is not held back by CodeCommit's conflict view (D-5);
    - the button reads "Approve" with the queue and "Approve and merge" without it, and the dialog has the plan's two texts;
    - the reasons `rebase` and `lease` name the queue.
  - **UX-7, `nowText`** names whose decision is pending and since when (a clock time and "ago") for the review, the tester decision and an agent's question. A review adds "the reconciler checks merged pull requests every 5 minutes". In the queue, it names the place ("N pull requests before this one", the holder and since when, the 30-minute wait) or the step (merging main into the branch, CI on the merged head with the commit, a conflict with its files, merging into main).
- **The rollout.** `requestApproval` marks the `HUMAN` and `APPROVAL` rows `mergeQueue: true` only when the workflow passes `mergeQueue: true` (the new definition) and the flag is on. An execution started before this line keeps the console's merge.
- **Connectors.** The scm contract gains `mergeState`, `mergeFastForward`, `approvals`, `overrideApprovals`, `commit` and `openPullRequests`. CodeCommit has all of them. GitHub has the reads; its merge and approval-rule calls throw, because the AWS provider runs on CodeCommit only. The view gains `mergeCommit` when there is one.
- **IAM.**
  - The orchestrator gets the `MergeQueue` statement: `GetMergeOptions`, `MergePullRequestByFastForward`, `EvaluatePullRequestApprovalRules`, `OverridePullRequestApprovalRules` and `GetCommit`.
  - The workflow role may start the update-branch project.
  - `UpdateBranchRole` gets `GitPull`, and `GitPush` only on `refs/heads/agent/*` (an explicit deny for any other reference). It may also read `platform/*` in the data bucket and write its own logs.

**Differences from the plan**
- **`StartBuild` of the update-branch project is on the workflow role**, as for CI, not on the orchestrator's: the workflow starts the build (`startBuild.sync`).
- **The orchestrator needs more CodeCommit calls than the plan lists:** `EvaluatePullRequestApprovalRules`, `OverridePullRequestApprovalRules` and `GetCommit`. CodeCommit resets approvals on each new revision, so a head with the queue's merge of `main` needs the person's approval carried over. The queue does that only along a chain of the platform's own merge commits back to the approved commit (D-5: "a clean update of `main` needs no new review").
- **A push to the branch after the approval escalates** (`pushed`): the plan does not say. Nobody approved that change, so a person looks at the run.
- **The other-pull-request note** comes from `pullRequestEvent` for every merge into `main`, the queue's and CodeCommit's alike, not only after `Merge`.
- **UX-7's staging lease text** ("waiting for staging: held by …") waits for line 12, which builds the lease's record (P1-4). `nowText` names the merge queue's holder now.
- **The script is in `providers/aws/deploy/`**, next to `deploy.sh`, and `aipf.sh up` uploads it with the others.
- **`mergeState` reads `main` by name**, at its tip, not the pull request's stored destination commit, which is old.
- **The queue's hold is 60 minutes from each queue step**, not one fixed time: a run that died holding the queue blocks the others for an hour at most.
- **A queue wait that runs out posts a pull request note**, as well as going back as `lease`.
- **The console computes the queue position** from the `RUN` rows (a Scan, until the indexes of UX-8) and the holder row. No position is stored.
- **The approval's pull request note mentions the queue**, and so does the chat message.
- **The run's `checks` image is not recorded again** after the build on the merged head. `DeployStaging` still passes the first image as `IMAGE_TAG`. `main`'s head is then the merged head, whose image `MergedImage` built, so `deploy.sh` finds that image by its tag (`image_exists`) and does not build again. It logs "main moved past the checked image".
- **The workflow ignores the `revisionId` the console sends.** It reads the revision from `mergeState` at the merge.
- **The trace's stage id is `queue`**, as the record's stage is, so the console's two sources agree.
- **The console writes `stage: 'queue'`** and the `waiting` step at the approval (REC-5), as it writes `deploy` after its own merge.
- **The trace makes one attempt of a queue pass.** Without that, each 30 s loop of `TakeQueue` and `QueueWait` would be one more attempt.
- **`test/step.test.mjs`'s heartbeat test** counts 4 beats instead of 3 when that file runs alone: the test's fake endpoint runs on the main thread that the test blocks. It passes in the full run, and neither the test nor `harness/` changed in this line.

**Tests** (250 in all, all passing; 228 before)
- `update-branch.test.mjs` (5, new): `update-branch.sh` against real git in a temporary directory. It covers:
  - a current branch, with nothing pushed;
  - a merge pushed as the platform's two-parent commit;
  - a real conflict that lists its files and leaves the branch;
  - a branch past the expected head, which it does not touch;
  - agent branches and commit ids only.
- `orchestrator.test.mjs` (79):
  - one run takes the queue, a second waits and names the holder, and takes it after the release;
  - a hold past its time, or of an ended run, is taken over, and 30 minutes of waiting end as `lease`;
  - `MainMoved`: current or moved, and a merge, a close or a push meanwhile;
  - `BranchUpdated`: CI on the merged head, and a conflict as `rebase` with its files and no failure;
  - `Merge` at the approved head with no override; past it only along the platform's merges, with the override and its comment; back to `MainMoved` when `main` moved; a push meanwhile escalates;
  - `ciFailed` on the merged head;
  - `requestApproval` marks the rows only with the queue on and in the new workflow;
  - the other pull requests' note in both wordings.
- `connectors.test.mjs` (23): CodeCommit's queue calls.
- `platform.test.mjs` (24): `Approve` goes to the queue, every way out passes through `ReleaseQueue`, and the exits are as above.
- `trace.test.mjs` (15): the queue is one stage that waits while another run holds it; two passes are two attempts; a CodeCommit merge skips it; a failed CI on the merged head fails the queue's attempt.
- `console.test.mjs` (27):
  - Approve with the queue resumes with the person, the revision and the commit, merges nothing, and writes the queue stage;
  - `off`, or rows without the flag, merge as before;
  - a failed resume gives 503, keeps the review open, and a second Approve goes through;
  - the place in the queue on the review view and the run page, with the holder, an expired hold and the run that holds the queue itself.
- **The stack:** `cfn-lint` gives 7 warnings, as on `main`. `validate-template` (through the deploy bucket) passed. `ValidateStateMachineDefinition` gives `OK` with no diagnostics.
- **Not yet on AWS.** B9 and B10 (two approved pull requests on one file within a minute) are round 4's.

**Deploy.** This line changes the stack (the `MergeQueue` parameter, the update-branch project, its role and log group, the grants), the workflow, the orchestrator, the console and the platform scripts in the bucket.
1. Run `providers/aws/aipf.sh pause "line 11"` and wait until no run is running.
2. Run `providers/aws/aipf.sh up`. It uploads `update-branch.sh` with `deploy.sh`, and sets `MergeQueue=on` unless `AIPF_MERGE_QUEUE=off` is set. The new definition applies to new executions only, and their approval rows carry the flag. A run that waits on a review from before keeps the console's merge.
3. Run `providers/aws/aipf.sh resume`.
4. To turn the queue off without a revert, run `AIPF_MERGE_QUEUE=off providers/aws/aipf.sh up`. The console then merges (P0-2), and the other pull requests get the "check for conflicts" note.

In round 4, B9 and B10 check two pull requests on one file, approved within a minute. The second merges after an automatic update and a green CI, or goes back to its developer as `rebase`, and no run counts a failure for it. The console shows the place in the queue and the step.

## Line 12: the staging lease (`upgrade/12-staging-lease`)

Items: P1-4, UX-20.

**Built**
- **The lease row (P1-4).** `PLATFORM/STAGING_LEASE` holds `runId`, `issueKey`, `prId`, `purpose` (`deploy` or `revert`), `takenAt` and `expiresAt`.
  - `takeLease` does a conditional put on the holder it read. The lease is free when it is empty, already this run's (a revert after the decision), held past its time, or held by a run that has ended. Two runs that try at once take it once.
  - The holder extends it at its steps: two hours from `takeLease`, `afterTester` and `accepted`, and 25 hours from `askDecision` (the 24-hour tester decision).
  - `afterOperator` and `nextAttempt` release it on the condition of the run id; `finish` and `endRun` already did through `releaseRun`. The reconciler releases a lease older than its young-row window whose run has no record, has ended, or whose execution is not running, and posts one chat line for it.
  - The run record gains `lease: { step, since, purpose, holder, holderSince, at, why }`, with the steps `waiting`, `taken` and `released`.
- **The workflow's lease states.** `Decision` (`merged`) and `QueueExit` (`merged`) go to `LeaseStart` (`$leaseFor: deploy`, `$leaseSince`), then `TakeLease`, then `LeaseTaken`:
  - taken: `DeployStaging`, or `Redeploy` for a revert;
  - not taken: `LeaseWait` (30 s), then `TakeLease` again;
  - after 45 minutes: `StagingAgain` (`nextAttempt`, reason `lease`, `waitsForStaging`), then `StagingLeft`. With rounds left it goes to `LeaseAgain` and waits again. Without, `StagingOut` escalates.
  - a revert that waited 45 minutes goes to `RevertWaited` and escalates: the revert is merged and a person deploys `main`.
  - `TesterDecision`'s `revert` goes to `RevertLease` (`$leaseFor: revert`), then `TakeLease`. The run holds the lease already, so it takes it at once.
  - Each time-out posts a pull request note: staging was held by the named work item, the change is merged, and nothing is wrong with it.
- **The trace.** The lease states are part of the "Deploy to staging" stage. One pass from `LeaseStart` to `DeployStaging` is one attempt, and the stage is `waiting` while another run holds staging. The revert's lease steps stay as they are. `StagingOut` and `RevertWaited` read "staging stayed held".
- **The console's run views (UX-7).**
  - The run view gives `lease` while the run is at the deploy, with `heldBy` (the work item, the run and since when) while it waits and another run holds staging.
  - `app.js`: the flow and the stepper show the deploy as waiting, the progress strip says "waits · SCRUM-n has staging", and `nowText` names the holder, since when, the 45 minutes and "goes round again, which is no failure" (for a revert: "a person takes over").
- **The Staging card** shows the last deploy's commit (from the image tag) and the holder ("held by SCRUM-n since …", "(revert)"), or "free: the next run to deploy takes it". The stop-staging dialog adds "Runs that reach the deploy wait for the lease."
- **The Platform view (UX-20):**
  - `docs` is `{ name: 'none', title: 'Not configured' }`, never `null`, and the card reads "the agents have no docs tools".
  - The knowledge base card has the name, status, embedding model, answer model and last update from `bedrock-agent:GetKnowledgeBase`, with the id masked (`KB••••••78`).
  - **Pause:** who paused, when and why, with "Pause…" (an optional reason) and "Resume".
  - **Holders:** the merge queue and staging, each with its run, pull request, since and until, a "past its time" badge, and "Release…" with a reason. With the queue off, its row says the console merges at the approval.
  - **Lost events:** the queue's depth and both alarms (a missing alarm reads `missing`), with "Replay oldest", "Replay all" and "Show the events" (sent, source, target, reason and how it came; never a payload).
  - **Reconciler:** the last run and its last ten fixes, newest first, with links.
  - Each read is best effort: a failed read gives `unknown` or nothing, and the rest of the view still loads.
- **The console's new routes** (each writes the console's JSON audit line):
  - `GET platform/events` peeks at up to 50 messages with a 30-second visibility and makes them visible again.
  - `POST platform/events/replay` (`all` or the oldest) sends each orchestrator event to the orchestrator again as an `Event` invoke and deletes the message once Lambda accepts it. A repeat of an event already sent is deleted, and a snapshot event is left with "providers/aws/aipf.sh events replay starts the snapshot".
  - `POST platform/pause` (`paused: true` or `false`) and `POST platform/lease/release` (`runId`, `what: staging` or `queue`, `reason`) go through the orchestrator's new `pause`, `resume` and `releaseLease` actions. A release names the run it releases. When another run holds it by then, the console gives 409 and names that run.
- **The CLI.** `aipf.sh status` has a "Merge queue and staging lease" section with each holder, or `free`. `lost-events.mjs` now reads messages with the console's `console/events.mjs`.
- **IAM and env.** The console role gains `sqs:GetQueueAttributes`, `ReceiveMessage`, `ChangeMessageVisibility` and `DeleteMessage` on the lost-events queue, and `cloudwatch:DescribeAlarms` on the two alarms. The console gets `LOST_EVENTS_QUEUE`. `bedrock:GetKnowledgeBase` and `lambda:InvokeFunction` on the orchestrator were there already.

**Differences from the plan**
- **A lease wait that runs out does not go to `AttemptsLeft`.** The change is merged by then, so a new developer attempt has nothing to do. `StagingAgain` counts a round (reason `lease`, no failure) and keeps the run's attempt, stage and feedback, and the run waits again until its rounds run out (`StagingOut`, then `Escalate`).
- **A revert's wait that runs out escalates** (`RevertWaited`): the plan does not say. The revert is merged, and only its deploy waits.
- **The lease's hold is per step** (two hours, 25 hours for the tester decision), not one fixed time, as the queue's is: a run that died holding staging blocks the others for two hours at most, and the reconciler frees it sooner.
- **The audit list (UX-13)** is line 16's: the Platform view has no audit card yet. The new actions write the console's JSON audit line now.
- **"Replay" and "Release" are for every console user** until UX-15's admin role (line 16).
- **The console's replay is asynchronous** (an `Event` invoke): a message is deleted once Lambda accepts the event, and a failure of that invocation comes back to the queue through the orchestrator's invoke config. Snapshot events replay from the CLI only, because the console role cannot start CodeBuild.
- **The console role needs `ChangeMessageVisibility` and `GetQueueAttributes`** as well as the plan's `ReceiveMessage` and `DeleteMessage`: the first makes peeked messages visible again, the second gives the depth.
- **The pause and the release go through orchestrator actions.** The console role cannot write `PLATFORM` rows, and the orchestrator also posts the chat line.
- **The release covers the merge queue too** (`what: queue`), as the plan's UX-20 card asks.
- **The deploy stage's time includes the lease wait**, and the run's stage is `deploy` while it waits.
- **The new SDK clients** (`@aws-sdk/client-sqs`, `client-cloudwatch`, `client-bedrock-agent`) come from the Lambda `nodejs22.x` runtime. `package.json` does not change.
- **`ageOf` in `events.mjs` is clamped at 0**, so a clock skew never gives a negative age.
- **`harness/runner/step.mjs`'s heartbeat thread keeps one heartbeat in flight.** This is not a plan item. Line 11 noted that `step.test.mjs`'s heartbeat test counted 4 beats instead of 3 when the file runs alone, and it then failed on `main` as well. Two heartbeats could overlap, so one went out after Step Functions said the step was gone. A tick now skips while a heartbeat is still on its way. The test passed five runs in a row, and the full suite passes. This is the only harness change in the line, so the harness image changes with it.

**Tests** (264 in all, all passing; 250 before)
- `orchestrator.test.mjs` (84):
  - one run takes the lease, and a second waits and names the holder;
  - the holder extends the lease at its steps, and the operator releases it;
  - a hold past its time, or of an ended run, is taken over;
  - 45 minutes of waiting count a round, no failure, and the run waits again;
  - every end releases the lease on the condition of the run id;
  - the reconciler releases an ended or dead run's lease, and leaves a young or a live one;
  - the console's release, pause and resume.
- `platform.test.mjs` (25): every staging deploy, the revert's too, comes after `TakeLease`, and every way on from it releases the lease.
- `trace.test.mjs` (16): the lease is part of the deploy stage, waits while another run holds staging, and one pass is one attempt.
- `console.test.mjs` (34):
  - the run's lease with `heldBy`, and no holder for an expired or missing lease;
  - the Staging card's commit and holder;
  - the Platform view's docs, knowledge base, alarms, reconciler, pause and holders, best effort;
  - `platform/events` without payloads;
  - replay of the oldest and of all, with repeats, the snapshot left and a throttle;
  - pause and resume, and the release of staging and the queue, with 400, 409 and 503.
- **The stack:** `cfn-lint` gives 7 warnings, as on `main`. `validate-template` (through the deploy bucket) passed. `ValidateStateMachineDefinition` gives `OK` with no diagnostics. The diff holds no account number, email (other than `@aipf.invalid`) or address (other than `example.invalid`).
- **Not yet on AWS.** B8 is round 4's.

**Deploy.** This line changes the stack (the console's grants and env), the workflow, the orchestrator, the console, `aipf.sh` and the harness image (`step.mjs`).
1. Run `providers/aws/aipf.sh pause "line 12"` and wait until no run is running.
2. Run `providers/aws/aipf.sh build` for the harness image, then `providers/aws/aipf.sh up`. The new definition applies to new executions only. An execution from before never takes the lease, and the holder's steps leave it alone (`holdLease` returns false).
3. Run `providers/aws/aipf.sh resume`, or press "Resume" on the Platform view.

In round 4, B8 labels three items at once. The second and third wait at the deploy with "waits · SCRUM-n has staging". No tester agent sees another run's deploy. `aipf.sh status` shows the holder, and `PLATFORM/STAGING_LEASE` is empty once all three end.

## Line 13: the pull request description and the clean-up (`upgrade/13-pr-description-and-cleanup`)

Items: P1-5, P1-6.

**Built**
- **The description tool (P1-5).** `codecommit___update_pull_request` (`pull_request_id`, an optional `title`, `description`) is in `registry/tools.json` and `gateway/tools.mjs`.
  - It changes the run's own pull request (`RUN#<run>.prId`) through `scm.updatePullRequest`.
  - It refuses another pull request ("pull request 6 is not this run's; this run's is 5"), a run with no pull request yet, a session that names no run, and an empty description.
  - The developer agent has the tool (`registry/agents.json`). `developer.md` step 6 says to update the title and description after every push to an open pull request, with the same sections, after every change request.
- **The escalation (P1-6).** `escalate`:
  - ends the run first (`finish`: the lock, the approval, the staging lease, the merge queue and the open rows);
  - comments `[AIPF platform] This run ended: <reason>. A person takes it from here.` on the run's pull request;
  - labels the work item `aipf-needs-person`, and moves it to "Needs a person" when the project has that status (`transition` returns `moved: false` otherwise);
  - writes a Jira note with the full reason and what it did ("Pull request n says so. The branch agent/KEY stays for that person. The work item has the label … and is in Needs a person.");
  - posts the reason's first paragraph to the chat, with the same tail and the console link;
  - keeps the branch, and returns `{ runId, prId, commented, labelled, moved }`.
- **Merged branches.** `done` deletes the run's branch through `scm.deleteBranch` and says so in its Jira note ("The branch agent/KEY is deleted."). So do the `closed` and `done` ends. `deleteRunBranch` deletes only `agent/<the run's work item>`, never another work item's branch or `main`.
- **The CLI.** `aipf.sh branches [list|prune [--apply]] [--days N]` (`providers/aws/branches.mjs`) lists each `agent/*` branch with its latest run, the run's outcome, the time since it ended, its pull request's state and what prune does with it.
  - `prune` lists the branches whose run ended more than seven days ago (or N) and whose pull request is merged or closed. `--apply` deletes them, and a failed delete prints only the error name.
  - A branch with no run on record, a running run, no pull request or an open one is kept.
  - The pull request comes from the run's record, or else from the latest pull request whose source is the branch.
- **IAM.** The tools function's role gains `codecommit:UpdatePullRequestTitle` and `UpdatePullRequestDescription`. The orchestrator role had `DeleteBranch` (on `agent/*`) already.

**Differences from the plan**
- **The tools role needs two more grants** (`UpdatePullRequestTitle`, `UpdatePullRequestDescription`). Section 7's IAM table lists only the orchestrator role's.
- **`update_pull_request` also refuses a session that names no run** and an empty description. The plan names only another pull request.
- **The `done` end deletes the branch too**, as `done` does: its pull request was merged. `reverted` keeps the branch.
- **`escalate` finds the pull request** from the run's record, or else from the branch's open pull request, and comments only when it found one. It never deletes the branch.
- **The chat gets the reason's first paragraph, and the Jira note the whole reason.**
- **`branches` has `--days N`** (default 7) for the one-time prune. Round 3 ran on 2026-10-20, so every round 3 run ended less than seven days ago, and `prune --apply` alone deletes none of the 19 branches before 2026-10-27. On the POC, `branches list` lists 19 branches and 0 to prune. `branches prune --days 0` (a dry run) lists all 19: 17 with a merged pull request and 2 with a closed one. Nothing is deleted. The one-time prune (`branches prune --apply --days 0`) waits for the owner's go-ahead.
- **Where the project has no "Needs a person" status,** the label alone marks the work item, and the notes leave the status out.

**Tests** (271 in all, all passing; 264 before)
- `tools.test.mjs`: the run's own pull request, with and without a title; another one; a run without a pull request; a session without a run; an empty description.
- `orchestrator.test.mjs` (87):
  - escalate comments on the pull request, labels and moves the work item, posts the first paragraph with the console link, releases every row and keeps the branch;
  - escalate finds the branch's open pull request, and a tracker outage still ends the run `escalated`;
  - done deletes its own branch, and keeps `agent/<another item>`, `feature/…` and `main`;
  - each end: `closed` and `done` delete the branch, the others keep it;
  - the done and escalate texts.
- `branches.test.mjs` (3, new): the latest run per branch; the prune decision for each case, `--days 0` too; the age text.
- `connectors.test.mjs` already covered `deleteBranch` (never `main`, a missing branch is `deleted: false`) and `addLabel`.
- **The stack:** `cfn-lint` gives 7 warnings, as on `main`. `validate-template` (through the deploy bucket) passed. The workflow does not change. The diff holds no account number, email or address.
- **On AWS (read-only):** `branches list` and `branches prune --days 0` ran against the POC in about 30 seconds.

**Deploy.** This line changes the stack (the tools role), the gateway tools function and its tool list, the orchestrator, `aipf.sh` and the harness image (`registry/` is copied into it: `agents.json` and `developer.md`).
1. Run `providers/aws/aipf.sh pause "line 13"` and wait until no run is running.
2. Run `providers/aws/aipf.sh build` for the harness image, then `providers/aws/aipf.sh up` for the stack, the functions and the gateway's targets.
3. Run `providers/aws/aipf.sh resume`.
4. With the owner's go-ahead, run `providers/aws/aipf.sh branches prune --days 0` and then the same command with `--apply`, for the 19 round 3 branches.

In round 4, C3 asks for a change on an open pull request, and its description must describe the change after it. E2 ends with a commented pull request and an item labelled `aipf-needs-person`, and `branches` lists no merged run's branch.

## Line 14: indexes, the inbox and the runs list (`upgrade/14-indexes-inbox-runs`)

Items: UX-8, UX-9, UX-10a.

**Built**
- **The indexes (UX-8).** The table gains three sparse global secondary indexes that project all attributes:
  - `run-index` (`gsiRuns`, always `RUN`, by `startedAt`) and `issue-index` (`gsiIssue`, the work item, by `startedAt`) on every `RUN#` row;
  - `open-index` (`openKind`: `question`, `approval` or `decision`, by `openedAt`) on a `HUMAN#` row while it waits.
  - The orchestrator writes `gsiRuns` and `gsiIssue` on every new run (a duplicate's too), and `openKind` and `openedAt` on every question, approval and tester decision.
  - An answer through its link (`humanPage`), a decision (`decidedIn`, and the console's claim of a tester decision) and a close (`closeOpenRows`) remove `openKind` and `openedAt` in the same write. The store's `update` gained `unset` for that: `REMOVE` on DynamoDB, the update mask on Firestore, a delete in memory.
  - A decision that cannot resume its run lets its claim go and puts the row back in `open-index` as it was.
- **The stepping.** The stack's new `TableIndexes` parameter (`0` to `3`, default `3`) says how many indexes exist, in the order `run-index`, `issue-index`, `open-index`.
  - `aipf.sh up` counts the table's indexes (`table_indexes`) and runs one stack update per missing index. After each one, it waits until every index is `ACTIVE` (`wait_indexes`, up to an hour), and then it adds the next.
  - A new table gets all three at once. A table that has all three gets the one update `up` always ran.
  - The console role and the harness MCP function's role (`runs_list`) gain `${Table.Arn}/index/*`.
- **The inbox's data (UX-8, UX-9).** `pendingHuman` is one `Query` of `open-index` per kind, oldest first.
  - The rows of runs that have ended are left out, and so is a review of an earlier attempt.
  - An approval comes with what the review sees first: CI, the reviewer agent's verdict on the attempt, and whether the pull request changes a dependency.
  - A tester decision comes with its finding, masked as on the run page.
  - The overview's counts read the same data.
- **The runs list's data (UX-10a).** `GET runs` takes `status` (`running` or `ended`), `outcome` (a word of D-3), `issueKey`, `startedBy`, `from`, `to` and `cursor`.
  - It queries `issue-index` for a work item and `run-index` otherwise, newest first, 50 a page. `from` and `to` bound the sort key, and a date in `to` takes in the whole day.
  - The cursor is the index key of the page's last row, base64 JSON. It is checked field by field, and a bad cursor or work item key gives 400.
  - The first page also has the chips' counts: the runs of each outcome for the page's work item, dates and starter, whatever the status or outcome. They come from at most ten index pages of two fields each, and `capped` says there were more.
  - Mission control (20 runs), Insights (60) and the harness MCP's `runs_list` read `run-index` too. No list reads an execution any more: a run's status and outcome come from its `RUN` row and its sessions. The history is read only for the run page.
- **The inbox (UX-9).** The sections come in the plan's order:
  - pull requests to review;
  - tester decisions;
  - questions;
  - memory proposals (from S3, as before);
  - proposed work items.
- **The inbox's cards:**
  - Each card has its work item (to its run), its age ("45 m", "2 h 10 m", "3 d 4 h") and its Jira and CodeCommit links.
  - A question or decision is overdue after 30 minutes, and a review after 2 hours. An overdue card has the red tone and its age in red.
  - A review card has its checks line.
  - A decision card shows the finding and is decided in place: Accept, Fix or Revert open the run page's dialog.
  - The head says how many wait and since when.
  - Home's "needs you" list is the same data: five items, oldest first.
- **The runs list (UX-10a).**
  - The chips are All, Running, Ended and each outcome, with counts. A chip with no runs is hidden unless it is the selected one.
  - The filter fields are the work item, started by, from and to. A work item key is uppercased, and a bad key shows the error and keeps the filters.
  - The columns are the plan's: Work item, Outcome (the reason as a tooltip, for example `escalated · tester found gaps`), Stage now, Attempt, Retries, Time, Cost, Started by and Started.
  - Started, Time and Cost sort, with `aria-sort`. "More" loads the next page.
  - The find box takes a run id, or a work item key, which opens that item's latest run.
  - At 400 px the filters are two columns and the table scrolls in its own box.
- **The backfill (`aipf.sh backfill [--apply]`, `providers/aws/backfill.mjs`).** One Scan of the `RUN`, `HUMAN`, `PR` and `Q#` rows. Its projection never reads `token`. The plan's writes:
  - every `RUN#` row gets `gsiRuns` and `gsiIssue`, and a `startedAt` that is not ISO becomes ISO;
  - a run with `lastReason` and no `retries` gets one retry from it;
  - an unanswered `HUMAN#` row of a running run gets `openKind` and `openedAt` (from `openedAt`, `createdAt` or now), and the rest are closed with `closedReason: 'run ended before the upgrade'`;
  - an answered or closed row that still has `openKind` leaves the index;
  - a `Q#` row is closed unless the work item's running run started at or before its question;
  - an `ISSUE#*/PR` row is deleted.

  Each write has a condition, so a second run writes nothing, and a row that changed in between is skipped. The dry run lists the writes by run id or work item, never a `HUMAN#` id, then a three-line summary and "Nothing is written without --apply". `--apply` counts the writes and the skips, and a failure prints only its error name.

**Differences from the plan**
- **Some reads keep their Scans:** the reconciler, `closeOpenRows`, `queuePlace` and `humanRowsOf` (a run's questions and reviews, answered or not). `open-index` holds only the rows that wait, and a work item's reset closes by work item, not by run. The run page still reads its sessions with one `Query` per run.
- **Every index read falls back to the Scan** while the index is missing, being built, or empty before the backfill (`unfilled`). The console works between the three stack updates and before the backfill, with the same pages, oldest or newest first.
- **The indexes ship through one `TableIndexes` parameter** that `up` steps from 1 to 3, not three edits of the template. The Lambda code changes in the first update, and the first two updates run with the fallback.
- **The live `startedAt` values are already ISO,** so the backfill's ISO step has nothing to change on the POC. It only adds the index keys, which needs no change of `startedAt`.
- **The lists name a run's status from its `RUN` row**: `DONE`, not `SUCCEEDED`, in the lists and in `runs_list`. A run reset before P0-7 (status `reset`) reads `ABORTED`, as its execution did. The run page still reads the execution. The lists no longer call `ListExecutions`.
- **The proposed work items are a Jira search link** with no count, oldest first. The console holds no Jira credentials, and the label comes with AG-4 in line 18. Without `JIRA_BASE_URL` the section says so and has no link.
- **The review card's CI is always "passed".** The workflow asks for a review only after CI passes, so the card does not read CI again.
- **The full runs table drops the "Agents" column,** per the plan's column list. Mission control's compact table keeps it.
- **The runs list adds what the plan does not list:**
  - the "Started by", "From" and "To" fields and the "Ended" chip;
  - the sort orders the loaded rows, not the server's pages, so a sort after "More" covers every row shown.
- **The backfill's retries have no `counted` flag.** The run page's fallback reads them as older records. A retry of a run that was not exhausted is attempt − 1, and its `at` is `attemptStartedAt`.
- **The backfill also deletes `ISSUE#*/PR` rows and closes stale `Q#` rows,** per section 11. Those rows carry no run id, so a `Q#` row is matched against the work item's running run.

**Tests** (288 in all, all passing; 271 before)
- `console.test.mjs` (40):
  - `GET runs` reads `run-index` newest first, 50 a page, with the next cursor and the chips' counts;
  - its filters by status, outcome, starter, work item and start, with counts that keep the work item, dates and starter;
  - the Scan fallback while `run-index` is missing or empty, with the same pages;
  - the inbox from `open-index`, oldest first, with the review's checks, and without an ended run's rows or a stale review;
  - the proposed work items' Jira link, and none without Jira;
  - a decision that cannot resume its run puts its row back in `open-index`.
- `orchestrator.test.mjs` (88): a run is in both run indexes, and a waiting row is in `open-index` until it is answered or closed.
- `platform.test.mjs` (27): the store contract's `unset` in the same write, and Firestore's update mask.
- `backfill.test.mjs` (8, new):
  - `isoOf`;
  - the `RUN` index keys and ISO times;
  - the retries;
  - open, close and unindex of `HUMAN#` rows, with no `HUMAN#` id in any text;
  - `Q#` and `PR` rows;
  - a second plan after the first is empty;
  - the CLI arguments of each write, and DynamoDB JSON both ways.
- **The browser pass** used a mock of the console API, in light, dark and 400 px wide, with no script errors, no CSP violations and no page scrolling sideways.
  - The runs list: "More", the cost sort both ways, the outcome tooltip, the chips, the work item filter and a bad key.
  - The find box, with a key, a run id and junk.
  - The inbox: the late decision card, its finding, and Accept through the dialog.
  - Home's five oldest.
- **The stack:** `cfn-lint` gives 7 warnings, as on `main`. `validate-template` (through the deploy bucket) passed. The workflow does not change. The diff holds no account number, email (other than `@aipf.invalid`) or address.
- **On AWS (read-only):** `backfill` (the dry run) against the POC table listed 152 writes:
  - 53 `RUN` rows to index;
  - 27 runs to get their retries;
  - 24 `HUMAN#` rows to close (all their runs have ended) and none to open;
  - 18 `Q#` rows to close;
  - 30 `ISSUE#*/PR` rows to delete.

  Nothing was written.

**Deploy.** This line changes the stack (the table's indexes and two roles' grants), the orchestrator, the console and harness MCP functions (one code bundle) and `aipf.sh`. The harness image does not change.
1. Run `providers/aws/aipf.sh pause "line 14"` and wait until no run is running.
2. Run `providers/aws/aipf.sh up`. It runs three stack updates, one per index, each about 9 minutes, and waits until each index is `ACTIVE`. If it stops part way, run `up` again: it starts from the indexes the table has.
3. Run `providers/aws/aipf.sh backfill` and read the list. With the owner's go-ahead, run `providers/aws/aipf.sh backfill --apply`. Run `backfill` again: it should list 0 writes.
4. Run `providers/aws/aipf.sh resume`.

In round 4, C6's inbox shows the same questions and pull requests as Slack, oldest first, with their ages, and an answer in one place takes the item out of the other within a refresh. No round 3 `HUMAN#` row is in the inbox. G4's runs come from `run-index`, and the runs list filters by work item through `issue-index` and pages with "More".

## Line 15: Insights, defined (`upgrade/15-insights-defined`)

Items: UX-12, UX-12a.

**Built**
- **The window (UX-12a).** `GET insights` takes `days`: `7`, `14` (the default), `30` or `all`. Any other value gives 400.
  - The window starts at 00:00 UTC on its first day, so "the last 14 days" is today and the 13 days before it, the same days as "Runs per day".
  - The route reads the window's runs from `run-index`, newest first, from that day on, with no Scan. While the index is missing or not yet backfilled, it reads them with the Scan, as the lists do since line 14 (UX-11's window bug).
  - At most 300 runs, the latest. `window.capped` says the window had more, and the page then says "the latest of the window only".
  - The page has the chips 7 days, 14 days, 30 days and All. Its first line names the window and its real start, for example "The last 14 days, since Oct 7, 2026 (UTC): 16 runs", or "Every run, since …".
  - With All, "Runs per day" starts at the oldest run's day, from 14 to 90 days long.
- **The filters (UX-12a).** `harness` and `model` (a name of letters, digits and `.:/@-`, else 400).
  - An engine keeps the runs of that engine. A model keeps the runs with a session on that model.
  - With a filter, the agents and models tables count only the sessions that match it.
  - The page has an Engine select and a Model select, each listing the window's engines or models with their run counts, before any filter applies, and a Clear button.
  - A chosen filter that the new window does not have stays in its select with 0 runs, and the page says "No runs of this engine or model in the window".
  - The page caches each window and filter for a minute. The Agents page reads the default window, as before.
- **First pass (UX-12).** Two figures, each out of the done runs:
  - "Done at attempt 1": the done runs that never went again.
  - "CI green at attempt 1": the done runs whose first attempt did not end before CI passed. An attempt ends before CI when it ends for `ci`, `no_pr`, `error`, `killed` or `answer`. A run whose record does not say how attempt 1 ended is left out, and the figure says "N not on record".
  - `firstPassRate` is "Done at attempt 1", as before.
- **Rework (UX-12).** The runs with a retry for any reason but `answer`, out of every run of the window. The reasons come from `retries` (REC-2): `changes`, `tester`, `rebase`, `ci`, `no_pr`, `killed`, `deploy` and `lease`, and also `error` (a session that failed). A run from before REC-2 counts its one retry from `lastReason`.
- **Retries by reason (UX-12).** This replaces "Why the developer went again". Each reason has a bar with how many runs went again for it and how many times. An answer is on its own grey line, "Answered (not rework)". The panel says a run can go again for several reasons.
- **Costliest runs (UX-12a).** Each work item links to its run. The column is now "Outcome", and its badge has the end reason as a tooltip.
- **The page.** Six figures, in rows of three, of six on a wide screen and of two at 400 px: success rate, done at attempt 1, CI green at attempt 1, rework, lead time and cost per done run. "How it is counted" explains the three new figures.
- **The data.** `insightsOf` returns:
  - `window` (`days`, `from`, `firstRun`, `runs` and `capped`);
  - `filters` (`harness`, `model`, and the window's `harnesses` and `models` with their runs);
  - `firstPass` (`doneAtAttempt1`, and `ciGreenAtAttempt1` with `unknown`);
  - `rework` (`n`, `of`, `rate`, `reasons` and `answers`).

  Each listed run has its `retries`, its `ciGreenFirst` and its `endReason`.

**Differences from the plan**
- **"CI green at attempt 1" comes from the retries,** not from a CI record. A run keeps no CI result per attempt, but each retry says how its attempt ended. A CI failure after the merge or of the image build also counts as `ci`, so it counts as "not green". The figure leaves out a done run with no record of attempt 1 (an older run that went again more than once).
- **"Done at attempt 1" counts attempts literally.** An answer to the developer's question starts attempt 2, so a run with an answer is not done at attempt 1, although it is not rework.
- **The lease counts as rework,** as the plan lists it, but `lease` covers two waits. A merge queue wait that runs out sends the change back to the developer, and that is a new attempt. A staging wait that runs out (`StagingAgain`) waits again at the same attempt, and the developer does no new work. Both count, so a run can be done at attempt 1 and still count as rework. The retry does not record which wait it was.
- **The window is at most 300 runs,** and each run reads its sessions with one `Query`, inside the console's 29-second limit. The POC has about 50 runs.
- **The window is in UTC days,** to match "Runs per day", not the last 24 × N hours.
- **The filters' lists are taken before the filters apply,** so a person can switch from one engine to another without clearing.
- **"Costliest runs" was already there.** This line adds the outcome's tooltip and renames the "Status" column to "Outcome".
- **The response changed:** `reasons` (the old counts of `lastReason`) is replaced by `rework.reasons`. `window.from` is now the window's first day, and `window.firstRun` is the start of its oldest run. The console is the only reader. `runs_list` in the harness MCP does not read Insights.
- **`reworkRate` changed its meaning.** It was the runs at attempt 2 or later. It is now the runs with a retry that is not an answer.
- **On a phone,** "Retries by reason" puts each bar under its label, so a label is never cut. A work item key in a table no longer breaks at its hyphen.
- **G4 in round 3 used `sessions --csv`,** which has no retries. Round 4's G4 takes them from the runs list's Retries column or the run page.

**Tests** (294 in all, all passing; 288 before)
- `insights.test.mjs` (12, 4 new):
  - `retriesOf` and `ciGreenFirst`, with older records and the unknown case;
  - first pass and rework by reason over seven runs: done at attempt 1, CI green with one unknown, rework without the answer, and the reasons in order;
  - the window of 7, 30 and all days, and All's chart from 14 to 90 days;
  - the engine and model filters, with the lists taken before them.
- `console.test.mjs` (42, 2 new):
  - `GET insights` reads `run-index` from the window's first day with no Scan, for 14 days by default, 30 and all, and applies the filters. `days` of `10`, `week` or `-7`, and an engine or model with a space or 201 characters, give 400. An empty window reads no Scan.
  - The Scan fallback while the index is missing or not filled, and a window of 301 runs reads the latest 300 and says it is capped.
- **The browser pass** used the mock of the console API, in light, dark and 400 px wide, with no script errors, no CSP violations and no page scrolling sideways.
  - Six figures in even rows at 1360 px and 1700 px, and two by two at 400 px.
  - "30 days", then the OpenCode engine: 1 run in the window, done at attempt 3 after an answer and a CI failure. Done at attempt 1 is 0%, CI green at attempt 1 is 0%, rework is 100%, and Clear appears.
  - "Retries by reason" with the answer's grey line, and "Costliest runs" with its links and badges.
- The diff holds no account number, email or address.

**Deploy.** This line changes the console and harness MCP functions (one code bundle). The stack, the workflow, the orchestrator and the harness image do not change. It reads `run-index`, so it comes after line 14's deploy. Before line 14's backfill, Insights reads the window with the Scan.
1. Run `providers/aws/aipf.sh pause "line 15"` and wait until no run is running.
2. Run `providers/aws/aipf.sh up`.
3. Run `providers/aws/aipf.sh resume`.

In round 4, G4 recomputes the success rate, both first-pass figures, rework and the retries by reason for one window from the runs list (outcomes, attempts and retries) and the session records, and gets the Insights numbers. G4 also checks the window's start, 7 days against 30 days, and one engine filter.
