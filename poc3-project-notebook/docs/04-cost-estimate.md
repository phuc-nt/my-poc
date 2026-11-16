# Project Notebook: cost estimate

What Project Notebook costs to use and to run, for a team deciding whether to pilot it. All prices are list prices: the Claude API's for the model, and those of the PoC's AWS Region for AWS (read 2026-10-25). A team's own contract, Region and free tier change them.

Each figure is marked as one of two kinds:

- **Measured.** Taken on the running system, either from its usage counters or from AWS Cost Explorer.
- **Estimated.** Worked out from list prices and an assumed load.

## 1. In short

| | Per month |
|---|---|
| Fixed AWS services (monitoring, sign-in, the application, secrets) | about 9 USD at list price; about 1 USD while the AWS free tier covers CloudWatch and Lambda |
| Knowledge base storage | 5 USD per GB of indexed documents |
| Questions | about 0.03 USD each for the model, plus about 0.004 USD of searches |
| A 30-person team (6,000 questions, 100 reports, 10 GB) | about 360 USD, three quarters of it the model |

The model is the largest cost, and it grows with the number of questions. Storage grows with the documents. The fixed services barely move.

## 2. Measured AWS spend during the PoC

Read from AWS Cost Explorer on 2026-11-16. The figures are usage at list price before any credits. The PoC ran on two separate test days and was removed after each.

| Service | Day 1 (first build) | Day 2 (rebuild and full tests) | What it was |
|---|---|---|---|
| Bedrock Managed Knowledge Base | 0.92 USD | 2.80 USD | Searches only: 543 `Retrieve` and 93 agentic searches on day 1; 2,130 and 167 on day 2 |
| Bedrock models | 0.86 USD | 0.70 USD | Chat models on Bedrock during the tests and the preparation lab. The reader model `qwen.qwen3-vl-235b-a22b` was 0.028 USD of day 2 |
| Secrets Manager | 0.06 USD | 0.02 USD | The app's secrets, by the hour |
| DynamoDB | 0.006 USD | 0.010 USD | On-demand writes and reads |
| S3, CloudFront, CloudWatch | under 0.002 USD | under 0.002 USD | |
| Lambda, Cognito, SNS, CloudFormation, KMS | 0 | 0 | Within the free tier |
| **Total** | **1.84 USD** | **3.53 USD** | |

Day 2 ran the whole test load: the end-to-end tests, the attachment test, the 79-question comparison and the preparation lab. A real team's day of use is lighter than that.

No storage charge appeared at the test size (a few dozen documents). No separate charge for indexing appeared either.

**Not in the AWS bill.** The Claude API (Claude Sonnet 5.5) is billed by Anthropic. The app's own usage counters for it were lost when the PoC was removed. The per-request figures in section 3 were measured before that.

## 3. Cost of use

### 3.1 Per request

| Request | Model (Claude API) | Searches (AWS) | Kind |
|---|---|---|---|
| A question in agent mode: about 12,200 input and 530 output tokens, 2.4 tool calls | 0.03 USD | about 0.004 USD | Measured (model, average of 79 questions); estimated (searches) |
| A question that computes on a table (`query_table`) | 0.08 USD | | Measured on a few questions |
| An exact count in Jira (`query_jira`) | 0.10 USD | | Measured on a few questions |
| A research report: 3 to 5 sections, 10 or 11 lookups | 0.21 to 0.26 USD | about 0.015 USD | Measured on three reports |
| A fast-mode question | about 0.02 USD | 0.002 USD | Estimated, not measured |
| A studio output | not measured | | |
| The API function's run time, about 20 s at 1 GB | | about 0.0003 USD | Estimated |

The search cost depends on how many knowledge bases a user has grants in. A search runs one `Retrieve` per knowledge base at 0.001 USD each. An agentic search costs 0.004 USD.

### 3.2 Preparing files (once per file version)

The preparation step makes a text copy of each pptx, docx, xlsx, doc, pdf, picture and scanned page. Most of it is code and costs nothing. Only pictures go to the reader model: picture files, scanned pages, and the pictures placed inside pptx, docx, xlsx and pdf files (up to 40 per file; icons and repeats are skipped).

- **Price.** The reader model costs about 0.55 USD per million input tokens and about 3 USD per million output tokens, as billed in the PoC's Region.
- **Per page.** A picture or scanned page uses about 1,000 to 4,000 input tokens and a few hundred output tokens, so it costs about **0.002 to 0.005 USD**.
- **Example.** 2,000 scanned pages or pictures cost about 4 to 10 USD, once. A design document with 20 screen pictures in it costs about 0.04 to 0.10 USD.
- **When it runs again.** A file is read again only when it gets a new version.

## 4. Cost of running

### 4.1 Fixed services

These are estimated at list price for a team whose AWS free tier does not cover them.

| Item | How it is counted | USD a month |
|---|---|---|
| CloudWatch custom metrics | 2 per source for 3 sources, plus 3 totals: 9 × 0.30 | 2.70 |
| CloudWatch dashboard | 1 | 3.00 |
| CloudWatch alarms | 3 × 0.10 | 0.30 |
| CloudWatch Logs | about 1 GB of function and knowledge base logs | about 0.50 |
| Monitor function | 2,880 runs a month (every 15 minutes), about 15 s at 1 GB each | about 0.70 |
| Secrets Manager | 2 secrets × 0.40 | 0.80 |
| DynamoDB, S3, CloudFront, Cognito, SNS | Small at this size | under 1 |
| **Total** | | **about 9** |

The free tier covers 10 custom metrics, 10 alarms, 3 dashboards, 5 GB of logs and 400,000 GB-seconds of Lambda a month. With it, the fixed services come to about 1 USD a month. The measured days in section 2 show the same thing: CloudWatch, Lambda and Cognito cost nothing.

Each source added to the system adds 2 custom metrics, about 0.60 USD a month.

### 4.2 Storage

Knowledge base storage is 5 USD per GB of indexed documents a month. Every Confluence source holds its attachments twice, once as the original file and once as the text copy. The text copies are small next to the files.

### 4.3 Outside AWS

- **Claude API.** Billed by Anthropic, through the API key in the secret `poc3-kb/anthropic`.
- **Atlassian.** The account the connector and the monitor read with may count as one paid user. It costs nothing on a Free plan of up to 10 users.
- **Work.** Estimated at 2 to 4 hours a month. The tasks:
  - Answer an alarm when a source stops syncing.
  - Renew the Atlassian API token before it expires.
  - Rotate the Claude API key.
  - Grant new members access to sources.
  - Read the KB quality page.

## 5. Monthly scenarios

Estimated. The mix of questions is assumed:

- 80 % of questions in agent mode, at 0.03 USD each.
- 20 % on tables or Jira counts, at 0.09 USD each on average.
- Research reports counted separately, at 0.24 USD each.
- Searches at 0.004 USD a question.
- Fixed services at list price.

| Scenario | Use a month | Model | Storage | AWS services and searches | **Total a month** |
|---|---|---|---|---|---|
| A small team, 10 people | 1,000 questions, 20 reports, 2 GB | 47 USD | 10 USD | 13 USD | **about 70 USD** |
| One unit, 30 people | 6,000 questions, 100 reports, 10 GB | 276 USD | 50 USD | 36 USD | **about 360 USD** |
| A wide rollout, 100 people | 20,000 questions, 300 reports, 30 GB | 912 USD | 150 USD | 96 USD | **about 1,160 USD** |

The model is 65 to 80 % of every scenario. Where other documents of this PoC quote about 180 USD of model cost for 6,000 questions, that figure counts every question as a plain agent-mode question. The scenario above adds the table and Jira questions and the reports.

Add the one-time preparation of the existing files (section 3.2) when a source is first connected.

## 6. Where to watch the cost

- **The app.** The **Cost** page (admins) shows searches, agentic searches and tokens per model per day, at the list prices in `PRICES` in [src/lib/config.mjs](../src/lib/config.mjs). Set the prices of your own Region there.
- **AWS.** Cost Explorer, grouped by service. Every resource is tagged `Project=poc3-kb`. The tag can be used as a filter once it is activated as a cost allocation tag, which the management account of an organisation must do.
- **The Claude API.** The usage page of the Claude Console.

## 7. What is not known yet

- The cost of a fast-mode question and of a studio output was not measured.
- The table, Jira-count and research figures come from a few requests each.
- The monitor's run time and the log volume are estimates. The test days ran within the free tier, so the bill shows no cost for them.
- The test content was small and invented. Storage and reader-model cost on a real project's documents must be measured in a pilot.
- How many pictures a real design document holds is not known. A project whose Excel and PowerPoint files are full of screen captures pays the reader model for each one, once per file version.
