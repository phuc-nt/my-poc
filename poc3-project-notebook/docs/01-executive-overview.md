# Project Notebook: Executive Overview

For the leadership team. It covers the problem, the solution, how it is built and what it costs to run. It assumes no technical background. The engineering detail is in [02-engineering-guide.md](02-engineering-guide.md), and the full concept with every test result is in [CONCEPT.md](../CONCEPT.md).

## 1. In one page

| | |
|---|---|
| **Problem** | People who join a project lose days finding out which of hundreds of Confluence pages and SharePoint files holds the answer they need |
| **Solution** | A private assistant, in the style of Google's NotebookLM. It answers questions from the project's own documents, links every answer to its sources, writes study material and serves the same knowledge to the AI assistants in engineers' code editors |
| **Where it runs** | In our own AWS account, in one Region. The documents stay in Confluence and SharePoint. Only a searchable copy is kept, and only in our account |
| **Status** | Built and tested end to end on 2026-10-25, with real Confluence and SharePoint sites holding invented content: 402 documents, 9 file formats. All 46 automated checks passed. 44 of 48 benchmark questions were answered correctly or rightly declined, none wrongly, in about 3 seconds each |
| **Running cost** | About 10 USD a month at proof-of-concept size. About 100 USD a month for a team of 30. About 300 USD a month for 100 people. Less than one US cent per question |
| **Compared with Atlassian Rovo** | For the same 30-person team, Rovo would cost about 590 USD a month in extra credits from December 2026, and does not cover SharePoint study material or sync monitoring in the same way (section 6) |
| **Decision asked for** | A pilot with one real project team, for which data owners and IT must grant access (section 7) |

## 2. The problem

A project's business knowledge is written down, but it is scattered. Requirement specifications, designs, meeting minutes, customer Q&A sheets, test reports and release notes are spread over Confluence spaces and SharePoint folders, in Vietnamese, English and Japanese.

The cost falls on the people who must learn that knowledge fastest:

- **Business analysts** must know how a business rule works before they can change it.
- **Bridge system engineers** must find the earlier answer before they ask the customer again.
- **Solution architects** must see the whole system across many documents.

Today they search, ask colleagues, and read whole documents to find one paragraph. Senior people are interrupted to answer the same questions again. Generic AI chat tools cannot help: they have not read our documents, and pasting documents into them breaks our data rules.

## 3. The solution

A web application where each person:

1. **Asks and checks.** They ask in plain language and get an answer in their own language. Every fact has a numbered link to the page or file it came from, so the answer can be checked in one click. When the documents do not cover a question, the assistant says so instead of guessing.
2. **Learns a domain.** A notebook groups the sources one person works on. From them the assistant writes a briefing, an FAQ, a glossary, a mind map, a timeline or an onboarding guide, each with its sources. A single document can be summarised on request.
3. **Works from the code editor.** Engineers' AI assistants (Claude Code, Kiro) can search the same documents, under the same access rules.

Three controls keep it safe:

- **Access.** People sign up with their work email and an administrator approves them. Each person reads only the Confluence spaces and SharePoint folders granted to them. Grants can be copied from who may already read each space and folder.
- **Freshness.** The documents are re-read every day. A monitoring page and email alarms show any source that is out of date or any file that could not be read.
- **Cost visibility.** A cost page shows the month's usage and its cost.

It only reads. It never changes a document, and it is not a source of truth: it is a guide to the documents.

## 4. How it is built

```mermaid
flowchart LR
  subgraph Where people write
    C[Confluence]
    S[SharePoint]
  end
  subgraph Our AWS account, one Region
    K[(Managed search index<br/>Amazon Bedrock Knowledge Bases)]
    A[Notebook application<br/>web app, sign-in, access rules]
    M[AI model<br/>Amazon Bedrock]
    O[Monitoring and alarms]
  end
  C -- read daily --> K
  S -- read daily --> K
  P[Project team<br/>web browser] --> A
  E[Engineers' AI assistants] --> A
  A -- search within the person's grants --> K
  A -- write the answer --> M
  O -- watch every source --> K
```

| Part | What it is | Why this choice |
|---|---|---|
| Search index | Amazon Bedrock Managed Knowledge Bases, with AWS's own Confluence and SharePoint connectors | AWS reads, parses and indexes the documents, so we do not build or run any of that |
| Application | A serverless web application: pay per use, nothing to patch, scales to zero when unused | Low running cost and little to operate |
| AI model | GLM 5, served by Amazon Bedrock inside our Region. Claude models can replace it with a setting change | It was chosen on accuracy (no wrong answers in the benchmark) and speed. The model is replaceable |
| Sign-in and access | Amazon Cognito accounts, with per-person grants checked on every request | The same rules apply in the web app and in the code editor |
| Monitoring | Amazon CloudWatch metrics, alarms and a dashboard | An out-of-date source raises an email alarm |

All of it is described as code and can be created or removed with one command each.

## 5. Running cost

AWS list prices, read on 2026-10-25. The cost of each use was measured on the running system. The 100-person column uses the same unit costs, scaled.

**Per use**

| Use | Cost |
|---|---|
| A quick question | 0.004 USD |
| A deep question (broad or multi-part, split into sub-questions) | 0.009 USD |
| A study output (briefing, FAQ, mind map …) | 0.015 USD |

**Per month**

| | Proof of concept | Team of 30 | 100 people |
|---|---|---|---|
| Size | 6 sources, 10 MB | 10 sources, 10 GB | 20 sources, 30 GB |
| Usage | Testing only | 4,800 quick and 1,200 deep questions, 300 study outputs | 16,000 quick and 4,000 deep questions, 1,000 study outputs |
| Search index storage (5 USD per GB) | 0.05 | 50 | 150 |
| Questions and study outputs | a few cents | 35 | 115 |
| Monitoring and alarms | 8 | 10 | 16 |
| Application, sign-in, storage, logs, secrets | 2 | 6 | 12 |
| **Total, USD per month** | **about 10** | **about 100** | **about 300** |

What drives the cost:

- **The volume of documents**, not the number of questions. Storage is half the bill or more at every size. Indexing only the spaces and folders a team needs keeps it down.
- **The choice of AI model** has a small effect. With Claude models, quick questions cost about the same and study outputs about four times as much. That is still a few dollars a month at the sizes above.
- Everything asked while building and testing the proof of concept, about 260 questions plus study outputs, cost 1.31 USD.

Outside AWS, the Confluence connector needs one Confluence account, which may count as a paid user. The SharePoint connector needs no licence.

## 6. Compared with Atlassian Rovo

| | Project Notebook | Atlassian Rovo |
|---|---|---|
| Best at | Learning a project from Confluence and SharePoint together | Working inside Confluence and Jira |
| Access control | Per space and per folder | Per page and per file |
| Study material, notebooks | Yes | Chat, search and custom agents |
| Sync monitoring | Each source's state, failed files, email alarms | Managed by Atlassian, not shown in detail |
| Data and models | Our AWS account; we choose the model | Atlassian's cloud; Atlassian chooses |
| Operating it | We deploy and run it | Nothing to run |
| Cost for 30 users, 6,000 quick questions a month | About 100 USD, storage included | About 590 USD in credits beyond the plan's allowance, from 3 December 2026 |

Rovo is the better choice for teams that work mainly inside Confluence and Jira and need page-level permissions. The Project Notebook is the better choice for teams that must learn a project from Confluence and SharePoint together and want the data and the cost in our own account. Rovo's figures come from Atlassian's published documentation. Rovo was not run in this proof of concept.

## 7. Risks and what a pilot needs

| Risk | How it is handled |
|---|---|
| A person sees content they should not | Grants are checked on every request, and this was tested with four accounts. A grant covers a whole space or folder, so content with narrower access must sit in its own space or folder |
| A wrong answer is trusted | Every answer links to its sources, and questions not covered by the documents are declined. No wrong answer was given in the benchmark |
| The copy is out of date | The copy is refreshed daily, alarms fire after 30 hours without a refresh, and an administrator can refresh at once |
| Costs grow unnoticed | The cost page shows usage. A daily limit per person should be added before a wide rollout |
| It has not been used by real people on real work | That is what the pilot is for |

For a pilot, the following must be granted:

1. **Data owners:** which spaces and folders to index, who may read each, and approval for Amazon Bedrock to process them in our account.
2. **Confluence administrator:** one read-only account for the connector.
3. **Microsoft 365 administrator:** an application with read access to the chosen SharePoint sites.
4. **Cloud team:** the AWS account, and (optionally) enabling Claude models on Bedrock.
5. **Leadership:** an administrator to approve people, and an owner for the deployment.

A one-month pilot with one project team and a few GB of documents would cost under 50 USD in AWS charges.
