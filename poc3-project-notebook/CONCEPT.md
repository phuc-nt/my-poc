# PoC 3: Project Knowledge Notebook

This document describes a concept that has been built and run end to end. It is written for decision makers and for teams who consider building the same thing: what the concept does for a project team, how it works, what was verified and what was not, what it costs, how it compares with Atlassian Rovo, and what a team must arrange before a pilot with real content.

It contains no code and needs none to be read. How to deploy it with your own Atlassian site and AWS project is in the [engineering guide](docs/02-engineering-guide.md), section 7. Every figure here was measured on the PoC's invented test content, not on real project documents.

## 1. Summary

| | |
|---|---|
| **What it does** | A web app in the style of Google's NotebookLM. A project team asks questions about the project's pages in Confluence, its issues in Jira and the files attached to both, and gets answers with numbered links to the pages, issues and files they came from. It also writes study material and research reports from the documents, counts and sums exactly where a search cannot, and gives the same knowledge to the AI assistants on the team's machines (Claude Code, Kiro) |
| **Who it is for** | Business analysts, bridge system engineers and solution architects who must learn a project's business from a large and scattered set of documents |
| **Access** | People sign up with their email; an administrator approves them. Each person reads only the Confluence spaces and Jira projects granted to them, and inside those only the pages and issues that Confluence and Jira let them read. The same rules apply in the web app and from an AI assistant |
| **Status** | Built and run on AWS against a Confluence Cloud and Jira Cloud site filled with invented content. The automated end-to-end test passes (88 of 88 checks). 38 of 38 questions on attached files were answered. The web app's agent answered 78 of 79 questions, the same as a coding agent on the same documents (section 6). Not yet tried with real content or real users |
| **Running cost** | About 0.03 USD per question in agent mode at the model's list price, 0.21 to 0.26 USD per research report, plus the AWS services, of which the storage of the indexed documents (5 USD per GB a month at list price) is the largest (section 8) |
| **Needed to go further** | A decision on which spaces and projects are indexed and who may read each, a decision that questions and document passages may be sent to the Claude API, a read-only Atlassian account, and an AWS project in a Region that offers managed knowledge bases (section 7) |
| **What it is not** | A source of truth, and not a replacement for Confluence or Jira. The answer is a guide to the documents, with links to check. It never writes to Confluence or Jira |

## 2. The use case

A project team joins a long-running project. The business is described in hundreds of pages, issues and files: requirement specifications, basic and detailed designs, meeting minutes, Q&A sheets with the customer, test reports, release notes, spread over Confluence spaces and Jira projects, in more than one language. A business analyst who needs to know how a rule works, or a bridge engineer preparing a question for the customer, must first know which document holds it.

The concept answers four needs:

1. **Ask and check.** A question in plain language, an answer in the reader's language, and a link to every page, issue and file it relies on.
2. **Learn a domain.** A notebook groups the sources one person works on. From it the system writes a briefing, an FAQ, a glossary, a mind map, a timeline or an onboarding guide, each citing its documents, or a research report on a topic the person names.
3. **Count exactly.** "How many issues are open, per assignee?" and "what is the total of this column?" are computed, not estimated from the passages a search returns.
4. **Work from the editor.** The same documents, with the same access rules, are tools for the AI assistant in the code editor.

| The concept fits when | It does not fit when |
|---|---|
| The knowledge is written down in Confluence Cloud and Jira Cloud, in pages, issues and attached files | It is in people's heads or in chat history only |
| A copy that is minutes old for Jira and up to a day old for Confluence is good enough | Answers must reflect a Confluence change made minutes ago, with nobody pressing "sync now" |
| The searchable copy may be kept in the team's own AWS project, and questions with the passages they read may be sent to the Claude API | The data owner forbids either |
| People's emails in the app are the emails of their Atlassian accounts | Accounts cannot be matched by email |

## 3. What the user sees

| Page | What it offers |
|---|---|
| **Notebook** | Left: the sources the person may read, as checkboxes, each with its documents and their state. Centre: the chat. Right: the studio and the person's notes |
| Chat | Four modes. *Fast*: one search, then the answer, streamed. *Deep*: the question is split into sub-questions, shown as they run. *Agent*: the model looks things up in several steps with reading tools, searching again in other words and reading whole documents when passages are not enough; each step is shown. *Research*: an outline, every section researched at the same time, then a report with a summary and the points the documents leave open. Each answer has numbered citations that open the passage beside the answer, follow-up questions, a language choice, copy, export and "save as note" |
| Checking an answer | A click on a citation shows the passage, when its document changed and when its source last synced. A reader shows the whole extracted document with the cited passage marked. The next questions can be limited to one document |
| Search palette | Passages as the person types, without a model |
| Studio | Six outputs written from the notebook's sources, each with citations, saved as notes: briefing, FAQ, glossary, mind map (drawn as a diagram), timeline, onboarding guide |
| Team library | Answers shared with the team. A person sees an entry only when they may read every source it cites; an administrator marks entries verified |
| **Sync** | Each source's last sync, its state, documents indexed and failed, the reason each failed document failed, the history, and a button to sync now (administrators) |
| **MCP** | Personal access tokens for Claude Code and Kiro, with the configuration to paste |
| **Users** (administrators) | People waiting for approval, their requested sources, roles and grants; the import of permissions from Confluence and its report |
| **Quality** (administrators) | From the question log: what was asked, what the documents could not answer, which answers were voted down, which documents are cited most |
| **Cost** (administrators) | The month's usage and its cost at list prices |

## 4. How it works

### 4.1 The components

| Component | What it does |
|---|---|
| **Outside the AWS project** | |
| Confluence Cloud, Jira Cloud | Where people write. Read, never changed |
| Claude API | Writes the answers. For each answer it receives the question, the notebook's recent messages and the passages and documents the answer reads |
| **Indexing** | |
| Knowledge bases | Amazon Bedrock Managed Knowledge Bases. Each holds up to five data sources. The service extracts the text of pages and files, cuts it into passages and makes them searchable by words and by meaning |
| Confluence sources | One per set of spaces, read by AWS's managed Confluence connector once a day, or at once with "sync now" |
| Jira sources | One per set of projects. The service has no Jira connector, so the app's monitor reads the issues, comments and attachments changed since its last run, every 15 minutes |
| The step before the knowledge base | The managed parser keeps about half the words of some file formats in Vietnamese and none of a slide's speaker notes. So for Word, Excel, PowerPoint and PDF files, scans and pictures, the monitor adds a second document with the file's full text. Pictures, scanned pages and the pictures placed inside Office and PDF files are read by a model with image input, served in the Region. A citation still opens the file |
| **The app** | |
| Web app | A single page served by Amazon CloudFront from a private bucket |
| Sign-in | Amazon Cognito: sign-up with email and a confirmation code, password reset |
| API | One AWS Lambda function behind CloudFront: notebooks, chat, research and studio (streamed), documents, sync status, tokens, users, usage. It checks the person's access on every call |
| MCP server | The same function at `/mcp`. A personal access token identifies the person. Eight tools: search, ask, list sources, list documents, read a document, query Jira, query a table, list notebooks |
| Store | One Amazon DynamoDB table: people, grants, notebooks, messages, notes, token hashes, sync history, the restriction index, the question log, usage counters |
| **Operations** | |
| Monitor | A Lambda function every 15 minutes: the Jira sync, the text documents, each source's sync jobs and why documents failed, the page and issue restrictions, metrics; once a day the permission import |
| Alarms | Amazon CloudWatch: a source not synced for 30 hours, a failed sync, a monitor error; email through Amazon SNS. A dashboard of the same |
| Secrets | AWS Secrets Manager: the Atlassian API tokens and the Claude API key |

Everything on AWS is in one AWS project (one AWS account) and one Region, is described as code, and is created or removed with two commands.

### 4.2 Who sees what

Access has two layers.

1. **The source.** A person signs up and confirms their email. They can sign in but read nothing; they can ask for sources. An administrator approves them and ticks the sources they may read. Or the permission import has already done it: it reads who may read each Confluence space (people and groups) and gives those grants to the matching emails, now or when the person signs up. Grants on a Jira source are given by an administrator.
2. **The page and the issue.** Inside a granted source, a Confluence page with a read restriction, the pages and files below it, and a Jira issue on a security level, are shown only to the people the restriction names, matched by email. The monitor reads the restrictions every 15 minutes. Administrators of the app are checked like anyone else.

Every reading path applies both layers: search, all four chat modes, document lists, the reader, the library, the counts and the MCP tools. A hidden document answers as if it did not exist. It fails closed: a source whose restrictions have not been read yet shows nothing, and when Confluence or Jira cannot be read the last restrictions stay in force.

### 4.3 One question

| Step | Fast mode | Agent mode |
|---|---|---|
| 1. Ask | The person types in a notebook. A follow-up ("and on mobile?") is first rewritten to stand alone | The same |
| 2. Find | One search in each knowledge base that holds one of the person's sources, filtered to those sources and to what the person may read | The model chooses among six reading tools, several times: search, list sources, list documents, read a document, query Jira, query a table. At most 8 rounds, 24 tool calls and 3 minutes |
| 3. Write | The question and the numbered passages go to the model with fixed rules: answer only from the documents, cite each fact, keep names and numbers as written, say so when the documents do not cover it | The same rules, on the passages the model chose to use |
| 4. Stream | The passages appear first, then the answer as it is written, then follow-up questions. The exchange is kept in the notebook | Each tool call is shown as a step while it runs and kept with the answer |

Deep mode uses Bedrock's agentic retrieval for step 2: a planning model splits the question, runs several searches and keeps the passages that matter. Research mode runs one tool loop per section of the report, all at once.

**Exact counts.** A search returns the closest passages, never "all of them". So `query_jira` runs a query in Jira at that moment, inside the projects of the person's sources, and returns the exact total and the counts per status, assignee and so on. `query_table` filters, counts and sums the rows of a table in one document.

## 5. Security

| Concern | Answer |
|---|---|
| A person reads a source not granted to them | Grants are checked on the server on every call, for the web app and MCP alike. Tested with accounts holding different grants (section 6) |
| A person reads a restricted page or issue inside a granted source | The restriction index is applied on every reading path. The blocking was tested; reading real restrictions from a site was not (section 9) |
| A stranger signs up | They get an account with no source until an administrator approves them |
| An MCP token leaks | It reads only what its owner may read, expires (90 days by default, 365 at most), can be revoked, and is stored only as a hash |
| The API is called around CloudFront | The function refuses any request without the secret header that CloudFront adds |
| The source credentials or the Claude API key leak | They are in Secrets Manager. The knowledge base's role reads the connector's secret; the app's functions read only their own secrets. The Atlassian account only needs to read |
| Text inside a document tries to instruct the model | Passages are data. The model's tools only read, and only what the person may read |
| Content leaves the AWS project | The searchable copy, the search and the store stay in the AWS project, in one Region. With a Claude model, each question and the passages and documents its answer reads are sent to the Claude API. This is a deliberate exception: fast and deep mode can be set to a model served by Amazon Bedrock in the Region; agent and research mode cannot |
| Questions are personal data | Messages are kept until the person clears them or deletes the notebook. The question log for the quality page holds no name or email and expires after 180 days |

## 6. What was verified

The test content is invented: wiki pages and blog posts, issues with comments, and 23 files in Vietnamese of ten formats, on a Confluence Cloud and Jira Cloud test site. The detail of every test is in the [README](README.md).

| Test | Result |
|---|---|
| **End to end.** An automated test signs in as five accounts (an administrator, members with different grants, a person not yet approved) and checks the deployed app through its public address, the web routes and the MCP server alike | 88 of 88 checks passed |
| **Attached files.** 38 questions, each answered from one part of one file (a sheet, a slide, a table, speaker notes, a scanned page, a picture), attached to Jira issues and to Confluence pages | 38 of 38. On the files alone, without the step before the knowledge base: 34 of 38 |
| **Words kept from a file.** How much of a file's true text reaches the knowledge base | With the file's text document: 96 to 100%. The managed parser alone, on Word, PowerPoint and PDF files in Vietnamese: 47 to 62% |
| **Pictures inside files.** Four Japanese files (xlsx, pptx, docx, pdf) with screen captures, a flow chart and tables pasted as pictures, through the step before the knowledge base | The text of every picture was transcribed word for word and placed where the picture stands; tables came out as tables. Not yet asked through a deployed knowledge base |
| **A file attached or removed later** | Answered from after the next sync, and gone from the answers after it was removed |
| **The web app's agent against a coding agent.** The same 79 questions, the same model, through the web app's agent mode and through Claude Code with the MCP server | 78 of 79 each. The web app's first run scored 76; one line was then added to its instructions, so 76 is the unbiased number |
| **Page and issue restrictions.** Lists, search, reader, source guide, MCP and agent mode, against a restriction index written by hand | 12 of 12 checks. Reading real restrictions from Confluence and Jira was not tested: the test site had neither feature |
| **Research mode.** Three reports | 3 to 5 sections, 29 to 43 seconds, 10 or 11 lookups each |
| **Speed of an agent answer** | 5.8 seconds median over the 79 questions, with 2.4 tool calls per question |

What the tests do not show: behaviour on real project documents, at real volume, with real users. The comparison's hand review was not blind, and one answer per question was taken, so a difference of one or two questions is within the noise.

## 7. What a team needs before a pilot

| # | What | From whom | Notes |
|---|---|---|---|
| 1 | Which Confluence spaces and Jira projects are indexed, and who may read each | Data owners, with the project leads | Each source is a grant. Name a space in one source only |
| 2 | A decision that the content may be indexed by Amazon Bedrock in the team's AWS project, and that questions with the passages they read may be sent to the Claude API | Data owner | Without the second, fast and deep mode can run on a Bedrock model in the Region; agent and research mode are then not available |
| 3 | A dedicated Atlassian account that can read the chosen spaces and projects, and its API token | Confluence and Jira administrator | It may count as a paid user. It must be able to read space permissions, page restrictions and issue security levels |
| 4 | A Claude API key | Whoever holds the organisation's Claude Console | With a spend limit on its workspace |
| 5 | An AWS project in a Region where managed knowledge bases and their Confluence connector are offered | Cloud team | One Region holds everything |
| 6 | The same email for each person in the app and in Atlassian | Project leads | Restrictions are matched by email. An account that hides its email gets no access to restricted content |
| 7 | Named people | Leadership | An administrator who approves people and grants, an owner for each source's content, an owner for the deployment |

## 8. Cost

List prices; a team's own contract and Region change them. The cost per request was measured on the running system from its token and search counters.

**Per request, model at the Claude API's list price (Claude Sonnet 5.5)**

| Request | Cost | Made of |
|---|---|---|
| A question in agent mode | 0.03 USD | About 12,200 input and 530 output tokens, 2.4 tool calls |
| A question that works on a table | 0.08 USD | Measured on the test questions |
| A count in Jira | 0.10 USD | Measured on the test questions |
| A research report | 0.21 to 0.26 USD | 3 to 5 sections, 10 or 11 lookups |

The cost of a fast-mode question and of a studio output with Claude Sonnet 5.5 was not measured.

**AWS, at the list prices of the PoC's Region (read 2026-10-25)**

| Item | Cost |
|---|---|
| Knowledge base storage | 5 USD per GB a month |
| A search | 0.001 USD |
| An agentic search (deep mode) | 0.004 USD |
| Each custom CloudWatch metric | about 0.30 USD a month |

The fixed AWS services cost about 9 USD a month at list price, and about 1 USD while the AWS free tier covers CloudWatch and Lambda. The PoC's two test days cost 1.84 and 3.53 USD in AWS, nearly all of it searches and models. Reading a picture or a scanned page costs about 0.002 to 0.005 USD, once per file version. The full estimate, with monthly scenarios, is in [docs/04-cost-estimate.md](docs/04-cost-estimate.md).

**A worked example.** 30 people asking 6,000 questions a month in agent mode: about 180 USD for the model. 10 GB of indexed documents: 50 USD for storage. Add the fixed AWS services. Storage grows with the documents, the model cost with the questions.

**Outside AWS and the model.** The Atlassian account the connector reads with may count as one paid user.

## 9. Limits and risks

| Limit or risk | Effect | What would address it |
|---|---|---|
| Tested on small, invented content | Usefulness and accuracy on real project documents are unproven | A pilot with one project team |
| Real restrictions were not read in the test | The blocking works against a hand-written index; whether the index is built correctly from a real site's restrictions is untested | Run `scripts/restrict-test.mjs` on a site with page restrictions and issue security before real use |
| People are matched by email | A person whose app email differs from their Atlassian email, or who hides it, does not see restricted content they may read | The same email in both; the administrator checks the import's report |
| A new restriction takes up to 15 minutes | A page restricted now is still readable through the app until the next monitor run | An administrator can run the monitor at once |
| A space named in two sources | It is indexed in both, and a grant on either reads it | Name a space in one source only |
| The Confluence copy is up to a day old | A page changed this morning answers with yesterday's text | "Sync now" on the sync page |
| Exact counts have ceilings | `query_jira` reads at most 2,000 issues per query and says so when there are more; a document list shows 300 documents with the exact total; a table that a PDF or scan gave as running text cannot be computed | Narrow the query |
| A research report runs inside 300 seconds | A section still writing near the end is replaced by a line saying so | A narrower topic |
| Five data sources per knowledge base | More spaces and projects need more knowledge bases, searched together | Already handled by the design; it is a quota of the service |
| A file over 50 MB gets no text document, and at most 40 pictures inside one file are read | It is answered from what the managed parser reads | Split the file |
| Content is sent to the Claude API | Questions and the passages they read leave the AWS project | A data owner's decision (section 7), or a Bedrock model in the Region for fast and deep mode |
| No per-person rate limit | One person or a script could run up the model cost | A daily quota per person before a wider pilot; a spend limit on the Claude API workspace |
| The question log | Administrators read every question asked in the web app; a question's own words can point to a person | Tell the users; items expire after 180 days |
| No backup of the table | Notebooks and notes would be lost with the deployment. The documents stay in Confluence and Jira | Export the table before a teardown |

## 10. Compared with Atlassian Rovo

Rovo is Atlassian's AI built into Confluence and Jira. It was not run in this PoC; the comparison is from Atlassian's published documentation, read on 2026-10-25. Check the current documentation before deciding.

| | This concept | Rovo |
|---|---|---|
| Where it lives | A separate web app and an MCP server | Inside Confluence and Jira, no separate app |
| Sources | Confluence and Jira with their attached files | Atlassian products plus many connectors |
| Access control | Per space and project, then per page and issue, read from the source every 15 minutes and matched by email | Per page and issue, taken from the source at query time |
| Attached files | A second document with the file's full text, measured per format | Not measured here |
| Learning a domain | Notebooks over chosen sources, six study outputs, research reports, a guide per document, notes | Chat, search, agents that can be built for a task |
| Writing back | None; it only reads | Writes and edits pages and work items |
| Local AI assistants | MCP server with the same access rules | Rovo MCP server, over Atlassian data |
| Sync visibility | Each source's state, failed documents and reasons, alarms | Managed by Atlassian, not shown in this detail |
| Data location | The searchable copy in the team's AWS project, one Region; questions and passages to the Claude API | Atlassian's cloud |
| Models | Chosen by the team | Chosen by Atlassian |
| Running it | The team deploys and operates it | Nothing to operate |

**Cost.** Rovo gives each user a monthly allowance of credits, pooled across the organisation: 25 on Standard, 70 on Premium and 150 on Enterprise. A quick chat answer costs 10 credits. Beyond the allowance, credits cost 0.01 USD each from 3 December 2026. For 30 Standard users asking 6,000 quick questions a month, that is 60,000 credits less 750 included, about 590 USD a month. The same 6,000 questions in this concept's agent mode cost about 180 USD for the model plus the AWS services (section 8). The two are not the same kind of answer, so this is an order of magnitude, not a like-for-like price.

**In short.** Rovo is the better choice for working inside Confluence and Jira, with permissions taken at query time, writing back, and nothing to run. This concept is the better choice for a team that must learn a project from its documents, wants study material, research reports and the same knowledge in its code editor, needs to see that every source is in sync, and wants the searchable copy and the choice of model in its own hands.

## 11. Where the detail is

- [docs/01-executive-overview.md](docs/01-executive-overview.md): the short version for leadership.
- [docs/02-engineering-guide.md](docs/02-engineering-guide.md): the architecture, every AWS resource, the permissions, and how to deploy it in your own environment (section 7).
- [docs/04-cost-estimate.md](docs/04-cost-estimate.md): the cost of use and of running, measured and estimated, with monthly scenarios.
- [README.md](README.md): the layout of the code, the test results in full, and what was learned building it.
- [BACKLOG.md](BACKLOG.md): what is not built yet (in Vietnamese).
