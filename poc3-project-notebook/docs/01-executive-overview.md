# Project Notebook: Executive Overview

For leadership teams. It covers the problem, the solution, how it is built, what it costs to run and what a pilot needs. It assumes no technical background. The concept with its test results is in [CONCEPT.md](../CONCEPT.md), and the engineering detail, including how to build it in your own environment, is in [02-engineering-guide.md](02-engineering-guide.md).

The figures were measured on a proof of concept filled with invented test content, not on real project documents.

## 1. In one page

| | |
|---|---|
| **Problem** | People who join a project lose days finding out which of hundreds of Confluence pages, Jira issues and attached files holds the answer they need |
| **Solution** | A private assistant, in the style of Google's NotebookLM. It answers questions from the project's own documents, links every answer to its sources, writes study material and research reports, counts exactly where a search cannot, and serves the same knowledge to the AI assistants in engineers' code editors |
| **Where it runs** | In the organisation's own AWS project (AWS account), in one Region. The documents stay in Confluence and Jira; only a searchable copy is kept. The answers are written by a Claude model through the Claude API, which receives each question and the passages it reads |
| **Status** | Built and tested end to end. All 88 automated checks pass. 38 of 38 questions on attached files were answered. On 79 questions it answered as well as a coding agent reading the same documents (78 each). Not yet used by real people on real content |
| **Running cost** | About 0.03 USD per question and 0.21 to 0.26 USD per research report for the model, plus the AWS services, mainly 5 USD a month per GB of indexed documents (section 5) |
| **Compared with Atlassian Rovo** | Rovo works inside Confluence and Jira with nothing to run. The Project Notebook adds study material, research reports, sync monitoring and access from the code editor, with the searchable copy and the choice of model in the organisation's hands (section 6) |
| **Decision asked for** | A pilot with one real project team, for which data owners and IT must grant access (section 7) |

## 2. The problem

A project's business knowledge is written down, but it is scattered. Requirement specifications, designs, meeting minutes, customer Q&A sheets, test reports and release notes are spread over Confluence spaces and Jira projects, much of it in attached Word, Excel, PowerPoint and PDF files, in more than one language.

The cost falls on the people who must learn that knowledge fastest:

- **Business analysts** must know how a business rule works before they can change it.
- **Bridge system engineers** must find the earlier answer before they ask the customer again.
- **Solution architects** must see the whole system across many documents.

Today they search, ask colleagues, and read whole documents to find one paragraph. Senior people are interrupted to answer the same questions again. Generic AI chat tools have not read the project's documents, and pasting documents into them breaks most data rules.

## 3. The solution

A web application where each person:

1. **Asks and checks.** They ask in plain language and get an answer in their own language. Every fact has a numbered link to the page, issue or file it came from, so the answer can be checked in one click. When the documents do not cover a question, the assistant says so instead of guessing.
2. **Learns a domain.** A notebook groups the sources one person works on. From them the assistant writes a briefing, an FAQ, a glossary, a mind map, a timeline, an onboarding guide, or a research report on a topic the person names, each with its sources.
3. **Gets exact numbers.** "How many issues are open, per assignee?" is counted in Jira at that moment, not estimated.
4. **Works from the code editor.** Engineers' AI assistants (Claude Code, Kiro) read the same documents, under the same access rules.

Six principles shape it:

- **It adds to Confluence and Jira; it does not replace them.** The documents stay where people write them.
- **Every citation opens the original** page, issue or file.
- **It only reads.** It never changes a page or an issue.
- **The searchable copy stays in one AWS project and one Region.** The one deliberate exception is the Claude API, which writes the answers.
- **It keeps itself up to date.** Jira is re-read every 15 minutes and Confluence every day. A monitoring page and email alarms show a source that is out of date or a file that could not be read.
- **Permissions come from the source.** Each person reads only the spaces and projects granted to them, and inside those only the pages and issues that Confluence and Jira let them read.

## 4. How it is built

```mermaid
flowchart LR
  subgraph Where people write
    C[Confluence]
    J[Jira]
  end
  subgraph The organisation's AWS project, one Region
    K[(Managed search index<br/>Amazon Bedrock Knowledge Bases)]
    A[Notebook application<br/>web app, sign-in, access rules]
    O[Monitoring and alarms]
  end
  M[AI model<br/>Claude API]
  C -- read daily --> K
  J -- read every 15 minutes --> K
  P[Project team<br/>web browser] --> A
  E[Engineers' AI assistants] --> A
  A -- search within what the person may read --> K
  A -- question and passages --> M
  O -- watch every source --> K
```

| Part | What it is | Why this choice |
|---|---|---|
| Search index | Amazon Bedrock Managed Knowledge Bases, with AWS's own Confluence connector and the application's own reader for Jira | AWS parses and indexes the documents, so little of that is built or run by the team |
| Attached files | Before indexing, the full text of each Word, PowerPoint and PDF file, scan and picture is extracted and indexed next to the file | Measured: the managed service alone kept about half the words of such files in Vietnamese; with this step, 96 to 100% |
| Application | A serverless web application: pay per use, nothing to patch, scales to zero when unused | Low running cost and little to operate |
| AI model | Claude Sonnet 5.5 through the Claude API | It can look things up in several steps, which the harder questions need. The quick modes can run on a model inside the AWS Region instead |
| Sign-in and access | Email accounts approved by an administrator, with each person's access checked on every request | The same rules apply in the web app and in the code editor |
| Monitoring | Metrics, alarms and a dashboard | An out-of-date source raises an email alarm |

All of it is described as code and can be created or removed with two commands.

## 5. Running cost

List prices. The model's cost per request was measured on the running system.

| Request | Model cost |
|---|---|
| A question, answered in several look-up steps | 0.03 USD |
| A question that computes on a table | 0.08 USD |
| An exact count in Jira | 0.10 USD |
| A research report | 0.21 to 0.26 USD |

On the AWS side:

- **Storage of the searchable copy** is 5 USD per GB a month and is the item that grows with the documents. Indexing only the spaces and projects a team needs keeps it down.
- **The fixed services** (monitoring, sign-in, the application) cost about 10 USD a month in an earlier build of the proof of concept. They were not measured again for the current build.

As an example, 30 people asking 6,000 questions a month over 10 GB of documents come to about 180 USD for the model and 50 USD for storage, plus the fixed services.

Outside AWS, the connector needs one Atlassian account, which may count as a paid user.

## 6. Compared with Atlassian Rovo

| | Project Notebook | Atlassian Rovo |
|---|---|---|
| Best at | Learning a project from its documents | Working inside Confluence and Jira |
| Access control | Per space and project, then per page and issue, refreshed every 15 minutes | Per page and issue, at the moment of the question |
| Study material, research reports, notebooks | Yes | Chat, search and custom agents |
| Writing to Confluence and Jira | No, by design | Yes |
| Sync monitoring | Each source's state, failed files, email alarms | Managed by Atlassian, not shown in detail |
| Data and models | Searchable copy in the organisation's AWS project; the organisation chooses the model | Atlassian's cloud; Atlassian chooses |
| Operating it | The organisation deploys and runs it | Nothing to run |

Rovo is the better choice for teams that work mainly inside Confluence and Jira and want nothing to operate. The Project Notebook is the better choice for teams that must learn a project from its documents and want the searchable copy, the model and the cost under their own control. Rovo's side comes from Atlassian's published documentation; Rovo was not run in this proof of concept. A cost comparison is in [CONCEPT.md](../CONCEPT.md), section 10.

## 7. Risks and what a pilot needs

| Risk | How it is handled |
|---|---|
| A person sees content they should not | Access is checked on every request, at two levels. The blocking was tested; reading real page and issue restrictions from a live site was not, and must be tested before real use |
| A wrong answer is trusted | Every answer links to its sources, and questions not covered by the documents are declined |
| Questions and passages are sent to the Claude API | A decision for the data owner. The quick modes can stay inside the AWS Region; the multi-step and research modes cannot |
| The copy is out of date | Jira every 15 minutes, Confluence daily; alarms fire after 30 hours without a refresh, and an administrator can refresh at once |
| Costs grow unnoticed | The cost page shows usage. A daily limit per person should be added before a wide rollout |
| It was tested on small, invented content only | That is what the pilot is for |

For a pilot, the following must be granted:

1. **Data owners:** which spaces and projects to index, who may read each, and approval for the two places the content is processed (the AWS project and the Claude API).
2. **Confluence and Jira administrator:** one read-only account for the connector.
3. **Cloud team:** the AWS project, in a Region that offers the managed search service, and a Claude API key with a spend limit.
4. **Project leads:** people use the same email in the application as in Atlassian.
5. **Leadership:** an administrator to approve people, and an owner for the deployment.
