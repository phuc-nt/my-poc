# AIPF proof of concept

The proof of concept of the AI platform designed in [docs/aipf/06-poc-architecture.md](../docs/aipf/06-poc-architecture.md). A Jira work item labelled `aipf` starts a workflow on AWS: a developer agent works in a sandbox started from a snapshot of the repository, opens a pull request on CodeCommit, CI runs, a reviewer agent comments, and a person approves and merges. The agents reach Jira, CodeCommit, the knowledge base, project memory and Slack only through one AgentCore Gateway, where AgentCore Policy checks every tool call against the agent's role.

The agent CLI is a parameter of the run: Claude Code on a Claude subscription by default, OpenCode with a Bedrock model as the second CLI.

## What is here

| Path | What it is |
|---|---|
| `sample-repo/` | The repository the agents work on: a small Node.js and PostgreSQL service desk API with `AGENTS.md`, `.aipf/environment.yaml` and `buildspec.yml`. Pushed to CodeCommit by `up`. |
| `registry/tools.json` | The tools the gateway exposes, by target (Jira, CodeCommit, memory, Slack). The knowledge base target is added when the knowledge base exists. |
| `registry/roles/` | The instructions of each agent role (developer, reviewer), the same for every CLI. |
| `registry/policies/` | The Cedar policies: which role may call which tool. |
| `harness/` | The session image: the runner (`runner/session.mjs`), one adapter per CLI, and the Dockerfile. `snapshot.Dockerfile` adds the repository with its dependencies on top. |
| `functions/` | Lambda functions: `tools.mjs` behind the gateway, `orchestrator.mjs` for the workflow steps, the Jira webhook, the Slack forms and pull request events. |
| `orchestrator/workflow.asl.json` | The Step Functions workflow for one work item. |
| `memory-seed/` | The project memory notes the agents read, copied to S3 by `up`. |
| `test-set/work-items.json` | The test work items and what a good run does with each. |
| `infra/stack.yaml` | Everything else, as one CloudFormation stack. |
| `infra/aipf.sh` | Deploy, run, measure and remove the POC. |

## Run it

Needs the AWS CLI v2 signed in to the project, Node.js 22, Git, and Docker with `buildx`. Jira and Slack values come from `../.env` (see the comment at the top of `infra/aipf.sh`); they go to Secrets Manager and are never printed or committed. All resources are created in the project's selected Region (check it in AWS Settings > View all projects > Overview > Additional Info > Region).

```sh
infra/aipf.sh up          # stack, sample repository, approval rule, memory, gateway, policies (log-only)
infra/aipf.sh build       # harness image, then the session snapshot of main
claude setup-token        # on your machine: a long-lived token for your Claude subscription
infra/aipf.sh token       # paste it; it goes to Secrets Manager without being shown
infra/aipf.sh items       # create the test work items in Jira; prints their keys
infra/aipf.sh run KEY-1   # or label the work item aipf after `infra/aipf.sh webhook`
infra/aipf.sh run KEY-1 opencode zai.glm-5
infra/aipf.sh status
infra/aipf.sh answer KEY-1 [TEXT]   # what waits for a person, or answer it without the Slack link
infra/aipf.sh reset KEY-1 [why]     # stop its runs, close its pull requests, delete agent/KEY-1, back to To Do
```

Slack gets a message when a run starts, when an agent asks a question, when a pull request is ready for review, and when the run ends or needs a person. Questions and the "request changes" decision are answered through a link to a small form; merging the pull request in CodeCommit finishes the run.

`infra/aipf.sh policy enforce` switches the policy engine from logging to refusing. The rules are tuned in log-only mode first, then enforced before the rule-breaking test items run.

## Activity logs and cost

The POC records what it does and what it costs, to estimate production later.

| What | Where | Command |
|---|---|---|
| Every agent session: duration, setup time, turns, input, output and cache tokens, the CLI's cost estimate, tool calls, tool errors, refusals, git result | DynamoDB `aipf-poc` (`SESSION#…` items); full transcript in S3 `transcripts/<run>/<role>-<attempt>/` | `infra/aipf.sh sessions` (`--csv` for a spreadsheet) |
| Workflow steps, waits for people, attempts | Step Functions execution history; `/aws/vendedlogs/states/aipf-poc-work-item` | `infra/aipf.sh status`, `infra/aipf.sh logs workflow` |
| Session output | `/aipf-poc/sessions` | `infra/aipf.sh logs sessions` |
| Tool calls through the gateway | `/aws/vendedlogs/bedrock-agentcore/gateway/aipf-poc`, `/aws/lambda/aipf-poc-tools` | `infra/aipf.sh logs gateway`, `logs tools` |
| Policy decisions | Gateway log entries of AgentCore Policy; a denied call is joined with its request to name the tool | `infra/aipf.sh decisions [SINCE]` |
| CI and snapshot builds | `/aipf-poc/ci`, `/aipf-poc/snapshot` | `infra/aipf.sh logs ci` |
| Actual AWS cost by service | Cost Explorer, Usage record type: the whole project, and the resources tagged `Project=aipf-poc`; credits listed apart | `infra/aipf.sh cost [FROM] [TO]` |

Every resource is tagged `Project=aipf-poc`, and `up` activates `Project` as a cost allocation tag. Cost Explorer data is about a day behind, and tagged cost only counts from the day the tag was activated. Claude Code sessions on a subscription cost a flat fee; the session records still keep their tokens and the cost the CLI reports at list prices, which is what the same work would cost through Bedrock or an API key. OpenCode sessions on Bedrock show up in Cost Explorer under Amazon Bedrock. The project's credits cancel each service's cost, so `cost` reports usage before credits.

The results and measured costs of the first test round are in [docs/aipf/06-poc-architecture.md](../docs/aipf/06-poc-architecture.md), sections 13 and 14.

Logs are kept for 30 days and transcripts until the stack is removed.

## Security notes

- The sandbox security group allows outgoing HTTPS only; the tasks have public IP addresses and no NAT gateway, so there is no allowlist of host names. Production needs one.
- An agent can read its own task role credentials and its Claude token from inside the sandbox. The task role allows only what the role needs: pushes to `agent/*` branches, gateway calls, its transcript, its session record and model calls. Nothing in the POC uses real customer data.
- The gateway's exception level is DEBUG so agents see full tool errors; production uses the default.
- Pull requests into `main` need one approval from a person, enforced by a CodeCommit approval rule; the agents' roles cannot merge.

## Remove it

```sh
infra/aipf.sh down
```

It deletes the gateway, the policies, the log delivery, the approval rule template, the stack (with the sample repository, the data bucket, images and logs) and the deployment bucket. Revoke the Claude token at claude.ai afterwards. The knowledge base belongs to `../infra/kb.sh`.
