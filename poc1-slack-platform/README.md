# PoC 1: Slack Automation Platform

A small platform that connects Slack to other systems (a web app without an API, Jira, a knowledge base) and uses an LLM for the reading and writing in between. Three use cases reuse the same connections:

- **Web form automation:** a request sent from Slack makes the system sign in to a web app and fill in its form with Playwright. It stops at the confirmation screen and submits only after the requester approves. The sample is a building visitor form on a mock portal included in this repository.
- **Daily report:** reads the day's messages in project channels and the issues in Jira, and has an LLM write a daily report that also checks the chat against Jira.
- **Knowledge base chatbot:** answers questions in Slack from Confluence and SharePoint content indexed by Amazon Bedrock Managed Knowledge Base, with links to the sources. The same knowledge base is published as an MCP server for AI assistants in code editors.

Every path and command below is relative to this folder (`poc1-slack-platform/`). The other PoCs are listed in the [repository README](../README.md).

## Documents

| Document | For |
|---|---|
| [01 Platform overview](docs/01-platform-overview.md): building blocks, what was verified, service choices, cost, risks | Decision makers |
| [02 Platform architecture](docs/02-platform-architecture.md): shared parts, how each outside system is connected, rules for every use case, adding a use case | Engineers |
| [03 AWS deployment](docs/03-aws-deployment.md): deploying, verifying, operating and removing the AWS environment | Engineers |
| [04 Operating cost](docs/04-operating-cost.md): monthly cost by item, and how to recalculate it | Decision makers |
| [05 Prerequisites and access](docs/05-prerequisites-and-access.md): tools, services and permissions to request before starting | Everyone, first |
| [06 Dify and Bedrock](docs/06-dify-and-bedrock.md) and [07 Support bot: Dify vs Bedrock](docs/07-customer-support-bot-dify-vs-bedrock.md): comparisons from vendor documentation, not built here | Decision makers |
| [08 Knowledge base chatbot](docs/08-knowledge-base-chatbot.md): setting up the chatbot, its sources and the MCP server | Engineers |
| [09 Amazon Bedrock Managed Knowledge Base](docs/09-bedrock-managed-knowledge-base.md): the service from the beginning, its limits as tested, parsing quality, which parts of the chatbot are code, strengths and limits | Anyone new to the service |

Each use case also has a concept document for decision makers, without code: [web form automation](docs/concepts/01-web-form-automation.md), [daily report](docs/concepts/02-daily-report.md), [knowledge base chatbot](docs/concepts/03-knowledge-base-chatbot.md).

Settings that differ per environment (tokens, channels, Jira site, AWS profile, Region) go in `.env` and `infra/local.env`. Neither is committed.

## Run locally

Needs Node.js 22 or later.

```bash
npm install
npx playwright install chromium
cp .env.example .env        # set any PORTAL_PASSWORD; everything else is optional
npm test                    # 44 tests; the form tests drive a real browser on the mock portal
npm run demo                # the form flow in the terminal, asking before it submits
```

The LLM is chosen with `LLM_PROVIDER`: `openrouter` (default, needs `OPENROUTER_API_KEY`) or `bedrock` (default model `zai.glm-4.7-flash`, uses the AWS credentials already set, such as `AWS_PROFILE`). Without an LLM the app still runs and the form opens empty. `BROWSER_HEADLESS=false` shows the browser filling the form.

**With a Slack workspace** (Socket Mode, no public URL needed):

1. At `https://api.slack.com/apps`, choose **Create New App → From a manifest** and paste `slack-app-manifest.yaml`.
2. Under **Basic Information → App-Level Tokens**, create a token with `connections:write` and put it in `SLACK_APP_TOKEN`.
3. **Install App** to the workspace and put the Bot User OAuth Token in `SLACK_BOT_TOKEN`.
4. Run `npm run portal` and `npm run slack` in two terminals.
5. In Slack, type `/visitor`, or `/visitor` with a description. Sample requests and their expected results are in `test/fixtures/free-text-requests.js`.

Run only one Slack app process per app token; two would share the events.

## Daily report

```bash
npm run report -- --sample   # sample data, needs only an LLM
npm run report               # real Slack and Jira: fill REPORT_* (and JIRA_* for the check) in .env
npm run report -- --post     # post to REPORT_POST_CHANNEL
```

Invite the bot to each channel it reads or posts to. While `npm run slack` runs, `/daily-report` posts a report, and `REPORT_TIME=18:00` posts one every day. `npm run seed:jira -- --post` and `npm run seed -- <channel ID> --post` create sample issues and messages; the scenarios are in [docs/02](docs/02-platform-architecture.md), section 7.

## Knowledge base chatbot

```bash
npm run kb:build                  # sample documents in artifacts/kb/ (ignored by git)
npm run kb:confluence             # publishes the sample Confluence space
infra/kb.sh up                    # knowledge base, Confluence and SharePoint sources, MCP gateway
infra/kb.sh sync                  # first sync
npm run kb:check                  # asks the 28 test questions through the gateway
infra/kb.sh down                  # deletes everything kb.sh created
```

Then set `KB_MCP_URL` (printed by `up`) and `LLM_PROVIDER=bedrock` in `.env` and run `npm run slack`; ask with `/ask`, a mention or a direct message. SharePoint access, IDE setup and permissions are in [docs/08](docs/08-knowledge-base-chatbot.md).

## Run on AWS

The web form and daily report use cases run in one ECS Fargate task, calling Amazon Bedrock with the task role. All resources are in two CloudFormation stacks tagged `Project=slack-web-automation-poc`. Needs AWS CLI v2 signed in, Docker and a filled `.env`; permissions are in [docs/05](docs/05-prerequisites-and-access.md), section 6. Do not run `npm run slack` locally at the same time.

```bash
cp infra/local.env.example infra/local.env   # Region, CLI profile, time zone; ignored by git
infra/poc.sh up                 # private-nat profile (or: up public)
infra/poc.sh verify             # one-off task: outbound IP, form flow, today's report
infra/poc.sh status
infra/poc.sh pause | resume
infra/poc.sh down               # removes what costs money, keeps image and secrets (about 0.5 USD/month)
infra/poc.sh down --all
```

| Profile (`infra/profiles/`) | Network | Cost for a full month |
|---|---|---|
| `private-nat` | Private subnet, NAT Gateway, fixed Elastic IP | about 82 USD |
| `public` | Public subnet, IP changes at each task start | about 39 USD |

The task template does not yet include the knowledge base chatbot. Costs are list prices in one Region; see [docs/04](docs/04-operating-cost.md) and [docs/03](docs/03-aws-deployment.md).

## Layout

| Path | Contents |
|---|---|
| `src/core/` | Form fields and validation, job flow, secret store, logger |
| `src/worker/` | Playwright: sign in, fill the wizard, check the confirmation screen, submit |
| `src/llm/` | LLM calls (OpenRouter or Bedrock): pre-filling the form, writing the daily report |
| `src/report/` | Daily report: Slack channels, Jira, building and posting the report |
| `src/kb/` | Knowledge base chatbot: MCP client for the gateway, answer writer |
| `src/slack/` | Slack modals, handlers and app start |
| `src/mock-portal/` | The mock portal: a three-step wizard with the quirks of real sites |
| `kb/` | Sample knowledge base content, Confluence publisher, test questions |
| `infra/` | CloudFormation, profiles, `poc.sh` for the platform, `kb.sh` for the knowledge base |
| `test/`, `scripts/` | Tests and fixtures; terminal runners and Slack and Jira seeders |
| `docs/` | Platform documents; `docs/concepts/` holds one concept document per use case |
