# PoC 3: Project Knowledge Notebook

This document describes a concept that has been built and run end to end. It is written for decision makers: what the concept does for a project team, how it works, what was proven and what was not, how it compares with Atlassian Rovo, what it costs, and what the team must be granted before a pilot with real content.

It contains no code and needs none to be read. The implementation and its engineering notes are in this folder's [README.md](README.md) (section 11).

## 1. Summary

| | |
|---|---|
| **What it does** | A web app in the style of Google's NotebookLM where a project team asks questions about the project's documents in Confluence and SharePoint and gets answers with numbered links to the pages and files they came from. It also writes study material from the documents (briefing, FAQ, glossary, mind map, timeline, onboarding guide), explains one document on request, and gives the same knowledge to the AI assistants on the team's laptops (Claude Code, Kiro) |
| **Who it is for** | Business analysts, bridge system engineers and solution architects who must learn a project's business from a large and scattered set of documents |
| **Access** | People sign up with their email; an administrator approves them. Each person reads only the Confluence spaces and SharePoint folders granted to them, in the web app and from their AI assistant alike. Grants can be imported from who may read each space and folder in Confluence and SharePoint |
| **Status** | Built and run on 2026-10-25 on AWS, against a real Confluence Cloud site and a real SharePoint Online site filled with invented content: 402 documents in 6 sources, 9 file formats. All 46 checks of an automated end-to-end test passed. Of 48 benchmark questions, 44 were answered correctly or rightly declined, none wrongly, in about 3 seconds each (section 6). Not yet tried with real content or real users |
| **Running cost** | About 10 USD a month at the POC's size, plus less than one US cent per question. For a team of 30 with 10 GB of documents and 6,000 questions a month, about 100 USD a month (section 8). The same 6,000 questions in Rovo would cost about 590 USD a month in credits beyond the plan's allowance, from December 2026 |
| **Needed to go further** | A decision on which spaces and folders are indexed and who may read each, a read-only Confluence account, an Entra ID application with administrator consent, and use of Claude models on Amazon Bedrock (section 7) |
| **What it is not** | A source of truth, and not a replacement for Confluence or SharePoint. The answer is a guide to the documents, with links to check |

## 2. The use case

A project team joins a long-running project. The business is described in hundreds of pages and files: requirement specifications, basic and detailed designs, meeting minutes, Q&A sheets with the customer, test reports, release notes, spread over Confluence spaces and SharePoint folders, in Vietnamese, English and Japanese. A business analyst who needs to know how a rule works, or a bridge engineer preparing a question for the customer, must first know which document holds it.

The concept answers three needs:

1. **Ask and check.** A question in plain language, an answer in the reader's language, and a link to every page and file it relies on.
2. **Learn a domain.** A notebook groups the sources one person works on. From it the system writes a briefing, an FAQ, a glossary, a mind map, a timeline or an onboarding guide, each citing its documents. A single document can be explained on request.
3. **Work from the editor.** The same documents, with the same access rules, are a tool for the AI assistant in the code editor.

| The concept fits when | It does not fit when |
|---|---|
| The knowledge is written down in Confluence Cloud and SharePoint Online | It is in people's heads, chat history or a ticket system only |
| Access can be decided per Confluence space and per SharePoint folder | Access differs page by page or file by file inside one folder, and that must be enforced exactly |
| A day-old copy of the documents is good enough | Answers must reflect a change made minutes ago |
| The content may be processed by Amazon Bedrock in the team's own AWS account | The data owner forbids cloud processing |

## 3. What the user sees

| Page | What it offers |
|---|---|
| **Notebook** | Left: the sources the person may read, as checkboxes, each with its documents and their state. Centre: the chat. Right: the studio and the person's notes |
| Chat | Two modes. *Fast* (first words after about 1.5 seconds, the whole answer in about 3): one search, then the answer, streamed. *Deep* (about 5 seconds on a short question, longer on a broad one): the question is split into sub-questions, shown as they run, for broad or multi-part questions. Each answer has numbered citations that open the passage they point to, three suggested follow-up questions, a language choice (Vietnamese, English, Japanese), copy, and "save as note" |
| Studio | Six outputs written from the notebook's sources, each with citations, saved as notes: briefing, FAQ, glossary, mind map (drawn as a diagram), timeline, onboarding guide. An optional focus narrows any of them, for example "payment flow" |
| Source guide | For one document: a summary, its key points and questions to ask about it |
| **Sync** | Each source's last sync, its state, documents indexed and failed, the reason each failed document failed, the history of syncs, and a button to sync now (administrators) |
| **MCP** | Personal access tokens for Claude Code and Kiro, with the configuration to paste |
| **Users** (administrators) | People waiting for approval, their requested sources, roles and grants; the import of permissions from Confluence and SharePoint and its report |
| **Cost** (administrators) | The month's usage and its cost at list prices: searches, deep searches, model tokens per model |

## 4. How it works

### 4.1 The components

| Component | What it does |
|---|---|
| **Outside** | |
| Confluence Cloud, SharePoint Online | Where people write. Read, never changed |
| **Indexing** | |
| Knowledge bases | Amazon Bedrock Managed Knowledge Bases. Each holds up to five sources; a source is one Confluence space or one SharePoint folder, read by a managed connector once a day. The service extracts the text of pages, attachments and files, cuts it into passages and makes them searchable by words and by meaning |
| **The app** | |
| Web app | A single page served by Amazon CloudFront from a private bucket |
| Sign-in | Amazon Cognito: sign-up with email and a confirmation code, password reset |
| API | One AWS Lambda function behind CloudFront: notebooks, chat and studio (streamed), documents, sync status, tokens, users, usage. It checks the person's grants on every call |
| MCP server | The same function at `/mcp`. A personal access token identifies the person; six tools (search, ask, list sources, list documents, read a document, list notebooks) see only that person's sources |
| Store | One Amazon DynamoDB table: people, grants, notebooks, messages, notes, token hashes, sync history, usage counters |
| Models | Amazon Bedrock, in the project's Region. Chat, deep mode and studio: GLM 5 (chosen over DeepSeek V3.2 in the benchmark, section 6). Claude models once the account's use case form is submitted (section 7) |
| **Operations** | |
| Monitor | A Lambda function every 15 minutes: reads each source's sync jobs and why documents failed, refreshes the document lists, publishes metrics, and once a day imports permissions |
| Alarms | Amazon CloudWatch: a source not synced for 30 hours, a failed sync, a monitor error; email through Amazon SNS. A dashboard of the same |
| Secrets | AWS Secrets Manager: the Confluence token, the SharePoint certificate's password, the app's own SharePoint credentials |

### 4.2 Who sees what

1. A person signs up and confirms their email. They can sign in but read nothing; they can ask for sources.
2. An administrator approves them and ticks the sources they may read. Or the permission import has already done it: it reads who may read each Confluence space (people and groups) and each SharePoint folder (people, SharePoint groups, Microsoft 365 groups), and gives those grants to the matching emails, now or when the person signs up.
3. Every search, in the web app and from the AI assistant, is limited to the person's sources and, inside a notebook, to the sources ticked there. The model never sees a passage from another source.

A grant covers a whole space or folder. Restrictions on single pages or files inside it are not carried over (section 9).

### 4.3 One question

| Step | What happens |
|---|---|
| 1. Ask | The person types in a notebook. If it follows earlier questions ("and on mobile?"), the model first rewrites it to stand alone |
| 2. Search | One search in each knowledge base that holds one of the person's sources, filtered to those sources. The best passages are merged by score |
| 3. Write | The question and the numbered passages go to the model with fixed rules: answer only from the documents, cite each fact, keep names and numbers as written, say so when the documents do not cover it, answer in the chosen language |
| 4. Stream | The passages appear first, then the answer as it is written, then the follow-up questions. The exchange is kept in the notebook |

In deep mode, step 2 is Bedrock's agentic retrieval: a planning model splits the question, runs several searches and keeps the passages that matter.

## 5. Security

| Concern | Answer |
|---|---|
| A person reads a source not granted to them | Grants are checked on the server on every call, for the web app and MCP alike. Tested with four accounts with different grants (section 6) |
| A stranger signs up | They get an account with no source until an administrator approves them |
| An MCP token leaks | It reads only its owner's sources, expires (90 days by default, 365 at most), can be revoked, and is stored only as a hash |
| The API is called around CloudFront | The function refuses any request without the secret header that CloudFront adds |
| The source credentials leak | They are in Secrets Manager. The knowledge base's role reads the connectors' secrets; the app's functions read only the app's own secret. The SharePoint app signs in with a certificate and can only read |
| Text inside a document tries to instruct the model | Passages are data; the model writes text and has no tool that changes anything |
| Questions and answers are personal data | They stay in the team's AWS account, in the project's Region. Messages are kept until the person clears them or deletes the notebook |

## 6. What was verified

### 6.1 The content

The same invented content the AIPF benchmark uses, plus the company content of the earlier chatbot.

| Source | Content | Indexed | Failed |
|---|---|---|---|
| Confluence, engineering space | Pages, blog posts and attachments of two invented products | 68 | 0 |
| Confluence, company space | Pages, blog posts and attachments of an invented company | 206 | 0 |
| SharePoint, three project folders | Word, Excel, PowerPoint, PDF, web, Markdown, text and CSV files of three invented products | 32 | 1 |
| SharePoint, company folders | Word, Excel, PDF, web, Markdown, text and CSV files | 95 | 0 |
| **Total** | | **401** | **1** |

The one failure is a PowerPoint file the managed parser could not read; the sync page shows it with the parser's reason. Three other PowerPoint files were indexed.

### 6.2 The functions

An automated test signs in as five accounts (an administrator, three members with different sources, one person not yet approved) and checks, through the public address:

| Area | Checks | What is checked |
|---|---|---|
| Accounts and access | 13 | Sign-in of the five accounts; approval with sources; each member holds exactly its grants; a person not yet approved opens nothing and can ask for sources; a member cannot use the administrator functions; a call without a token is refused |
| Chat | 6 | A fast answer with citations and follow-up questions; its passages come only from granted sources; a deep answer with its steps; history is kept; a member granted one product gets no passage from another |
| Studio | 4 | The six outputs are offered; a briefing and a mind map are written and saved as notes |
| Documents | 5 | A source's documents with their state, including the failed one; a source not granted is refused; the source guide of a Confluence page and of a Word file |
| Sync | 4 | The state of the six sources; a member sees only its own; a failed document is named with its reason; a member cannot start a sync |
| MCP | 11 | A token is created; the protocol handshake; the six tools; each tool sees only the owner's sources and refuses others; a revoked token is refused |
| Other | 3 | The permission import runs; the month's usage and cost; the web page is served |
| **Total** | **46** | **All passed on the final deployment** |

### 6.3 Answer quality: the 48 benchmark questions

The benchmark has 48 questions with reference answers, half in Vietnamese and half in English: 20 whose answer is in a Confluence page, 24 in a SharePoint file, and 4 whose answer is in no document, where the right answer is to say so. They were asked in a notebook holding the four project sources, each question on its own.

Four answer sets were graded: the concept's fast mode with each of the two candidate models, its deep mode, and, as a baseline, the knowledge-base answer path of AIPF, the team's AI platform under construction, on the same documents. A separate model (Claude Sonnet) graded every answer against the reference without knowing which system wrote it; the four answers to each question were shuffled.

| | Fast, GLM 5 (chosen) | Fast, DeepSeek V3.2 | Deep, GLM 5 | AIPF baseline |
|---|---|---|---|---|
| **Right: correct, or rightly declined** | **44 (92%)** | 45 (94%) | 45 (94%) | 40 (83%) |
| Wrong | 0 | 2 | 0 | 3 |
| Partly right | 0 | 0 | 1 | 3 |
| Declined although a document holds the answer | 4 | 1 | 2 | 2 |
| Added a claim no document supports | 0 | 2 | 0 | 2 |
| Answered in the question's language | 48 | 46 | 48 | 46 |
| Right, Confluence (of 20) | 16 | 17 | 17 | 15 |
| Right, SharePoint (of 24) | 24 | 24 | 24 | 21 |
| Rightly declined, no document (of 4) | 4 | 4 | 4 | 4 |
| Whole answer, median | 3.1 s | 8.4 s | 4.8 s | 3.2 s |

What the numbers say:

- **No wrong answers with GLM 5.** DeepSeek scored one question more but gave two wrong answers with invented detail (a number of facts per group, a retry schedule from another feature). GLM 5 declined those instead, and was more than twice as fast. That is why it was chosen.
- **The misses are search misses.** All four questions GLM 5 declined are Confluence questions whose page did not come back among the passages; the model then said the documents do not cover it, as instructed. The same search found the right document for 89% of the questions in every system. Deep mode found one of the four (a port number) by searching again.
- **SharePoint was answered fully**, from Word, Excel, PowerPoint, PDF, web and text files alike.
- **The model keeps to the documents.** Every question whose answer is in no document was declined, in every system.

### 6.4 Speed

Measured on the 48 benchmark questions, three at a time, from a laptop in UTC+7 to the AWS Region. The answer streams, so the person reads the passages and the first words well before the end.

| | Passages shown | First words | Whole answer |
|---|---|---|---|
| Fast, GLM 5 | 1.0 s (1.6 s) | 1.6 s (2.4 s) | 3.1 s (5.4 s) |
| Fast, DeepSeek V3.2 | 1.0 s (1.3 s) | 5.6 s (16.3 s) | 8.4 s (17.6 s) |
| Deep, GLM 5 | 2.7 s (4.8 s) | 3.4 s (5.4 s) | 4.8 s (6.6 s) |

Median, with the 90th percentile in brackets. A studio output takes 15 to 22 seconds, streamed as it is written.

## 7. What the team needs to be granted

| # | What | From whom | Notes |
|---|---|---|---|
| 1 | Which Confluence spaces and SharePoint folders are indexed, and who may read each | Data owners, with the project leads | A grant covers a whole space or folder. Content with narrower access belongs in its own space or folder |
| 2 | A decision that this content and the questions may be processed by Amazon Bedrock | Data owner | Everything stays in the team's AWS account, in one Region |
| 3 | A dedicated Confluence Cloud account that can read the chosen spaces, and its API token | Confluence administrator | It may count as a paid user. It must be able to read space permissions for the import |
| 4 | An application in Microsoft Entra ID with read access to the chosen SharePoint sites, and administrator consent | Entra ID administrator | A certificate, no password. Reading the members of Microsoft 365 groups for the import needs one more read permission (`GroupMember.Read.All`); without it, nested groups are not expanded |
| 5 | Use of Claude models on Amazon Bedrock | Cloud team | The account's one-time Anthropic use case form in the Bedrock console. Until then the POC uses GLM 5, which needs no form |
| 6 | An AWS account in a Region where managed knowledge bases are offered | Cloud team | The POC used one Region for everything |
| 7 | Named people | Leadership | An administrator who approves people and grants, an owner for each source's content, an owner for the deployment |

## 8. Cost

AWS list prices in the POC's Region, read on 2026-10-25. The cost per use was measured: questions and studio outputs were run with the app's usage counters read before and after.

**Per use**

| Use | Cost | Made of |
|---|---|---|
| A fast question | 0.004 USD | One search (0.001 USD) and about 2,300 input and 130 output tokens of GLM 5 |
| A deep question | 0.009 USD | One agentic search (0.004 USD), about 1.3 searches beneath it, and about 2,800 input and 150 output tokens |
| A studio output | 0.015 USD | Four searches and about 6,000 input and 1,500 output tokens |
| An MCP search or question | 0.001 or 0.004 USD | As a search or a fast question |

Everything asked while building and testing the POC, about 260 questions plus studio outputs and MCP calls, came to 1.31 USD.

**Per month**

| Item | POC (6 sources, 10 MB) | Team of 30 (10 sources, 10 GB) |
|---|---|---|
| Knowledge base storage, 5 USD per GB | 0.05 | 50 |
| Fast questions | a few cents | 4,800 questions: 19 |
| Deep questions | a few cents | 1,200 questions: 11 |
| Studio outputs | a few cents | 300 outputs: 5 |
| Sync monitoring: metrics, alarms, dashboard | 8 | 10 |
| Secrets | 1.2 | 1.2 |
| Functions, table, sign-in, CDN, logs | under 1 | about 5 |
| **Total** | **about 10 USD** | **about 100 USD** |

Storage dominates as the documents grow; the model's share stays small. With Claude models (section 7), chat on Claude Haiku would cost about the same per question and studio on Claude Sonnet about four times as much, still a few USD a month at this size.

**Outside AWS**

| Item | Cost |
|---|---|
| The Confluence account the connector reads with | One Confluence user licence at the site's price, if the site counts it as a paid user |
| The Entra ID application for SharePoint | None |
| Rovo for comparison | See section 10 |

## 9. Limits and risks

| Limit or risk | Effect | What would address it |
|---|---|---|
| A grant covers a whole space or folder | A page or file restricted inside a granted space or folder is readable through the app | Keep restricted content in its own space or folder; the managed service's per-document access control is a later step |
| The permission import expands groups one level | A member of a group inside a group is not found; Confluence users who hide their email are skipped (counted in the report) | The `GroupMember.Read.All` permission for Microsoft 365 groups; the administrator grants the rest by hand |
| The copy is up to a day old | A page changed this morning answers with yesterday's text | An administrator can start a sync at any time from the sync page |
| Some files cannot be parsed | One PowerPoint file of four failed; it is listed with the reason on the sync page | Save it again in another format |
| Search misses | One Confluence question in four did not find its page in fast mode; the answer then says the documents do not cover it | Deep mode; tuning the passage size and count with real content |
| Five sources per knowledge base | More spaces and folders need more knowledge bases, searched together | Already handled by the design; it is a quota of the service |
| No per-person rate limit | One person or a script could run up the model cost | A daily quota per person before a wider pilot |
| Claude models not yet enabled | GLM 5 writes well but has not been compared with Claude here | Submit the use case form and rerun the benchmark |
| Not tried with real users | Usefulness for real project work is unproven | A pilot with one project team |

## 10. Compared with Atlassian Rovo

Rovo is Atlassian's AI built into Confluence and Jira. It was not run in this POC; the comparison is from Atlassian's published documentation, read on 2026-10-25.

| | This concept | Rovo |
|---|---|---|
| Where it lives | A separate web app and an MCP server | Inside Confluence and Jira, no separate app |
| Sources | Confluence and SharePoint, through AWS managed connectors | Atlassian products plus many connectors, SharePoint and OneDrive among them |
| Access control | Per space and per folder, imported from Confluence and SharePoint, checked on every call | Per page and per file, taken from the source at query time; each person also connects their own SharePoint account |
| SharePoint setup | An Entra ID application with read access to the chosen sites | A SharePoint global administrator connects it; it also indexes people's profiles from Entra ID (department, email, hire date), with no option yet to turn that off |
| Learning a domain | Notebooks over chosen sources, six study outputs, a guide per document, notes | Chat, search, agents that can be built for a task |
| Writing back | None; it only reads | Writes and edits pages and work items |
| Local AI assistants | MCP server over Confluence and SharePoint, with the same grants | Rovo MCP server, over Atlassian data |
| Sync visibility | Each source's state, failed documents and reasons, alarms | Managed by Atlassian, not shown in this detail |
| Data location | The team's AWS account, one Region | Atlassian's cloud |
| Models | Chosen by the team, in its own account | Chosen by Atlassian |
| Running it | The team deploys and operates it | Nothing to operate |

**Cost.** Rovo gives each user a monthly allowance of credits, pooled across the organisation: 25 on Standard, 70 on Premium and 150 on Enterprise. A quick chat answer costs 10 credits; a "think deeper" answer costs more, by an amount not published. Beyond the allowance, credits cost 0.01 USD each from 3 December 2026. Rovo Search stays free.

For 30 Standard users asking 6,000 quick questions a month: 60,000 credits, less 750 included, is about 590 USD a month, against about 100 USD for this concept with storage included. On Premium the allowance is 2,100 credits and the cost about the same.

**In short.** Rovo is the better choice for working inside Confluence and Jira, with page-level permissions and nothing to run. This concept is the better choice for a team that must learn a project from Confluence and SharePoint together, wants study material and the same knowledge in its code editor, needs to see that every source is in sync, and wants the cost and the data in its own account.

## 11. Where the detail is

The implementation, how to deploy and test it, and what was learned building it are in the repository: [README.md](README.md). The managed knowledge base service itself is introduced in [PoC 1 doc 09, Amazon Bedrock Managed Knowledge Base](../poc1-slack-platform/docs/09-bedrock-managed-knowledge-base.md), and the earlier Slack chatbot on the same service in [PoC 1, use case 3](../poc1-slack-platform/docs/concepts/03-knowledge-base-chatbot.md).
