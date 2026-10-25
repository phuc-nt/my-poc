# Proofs of Concept

Three proofs of concept (PoCs), one folder each. Each folder has its own README, documents and, where there is code, its own commands, run from inside that folder.

| PoC | Folder | What it is | Contents |
|---|---|---|---|
| **PoC 1: Slack Automation Platform** | [poc1-slack-platform/](poc1-slack-platform/README.md) | A small platform that connects Slack to a web app without an API, Jira and a knowledge base, with an LLM for the reading and writing in between. Three use cases: web form automation, daily report, knowledge base chatbot | Code, AWS deployment (CloudFormation, ECS Fargate), platform documents 01 to 09, one concept document per use case in `docs/concepts/` |
| **PoC 2: AIPF** | [poc2-aipf/](poc2-aipf/README.md) | The organisation's own AI platform, on which agents carry the roles of a development team across the software lifecycle | Documents only. The POC code is in the separate `aipf-sdlc` repository |
| **PoC 3: Project Notebook** | [poc3-project-notebook/](poc3-project-notebook/README.md) | A web app in the style of NotebookLM: a project team asks questions about Confluence and SharePoint documents, writes study material from them and reads each source's sync state, with access per space and folder and an MCP server for code editors | Code, AWS deployment, an [executive overview](poc3-project-notebook/docs/01-executive-overview.md), an [engineering guide](poc3-project-notebook/docs/02-engineering-guide.md), and the full concept in [CONCEPT.md](poc3-project-notebook/CONCEPT.md) |

## How the PoCs relate

- PoC 3 reuses the Confluence and SharePoint test settings and the SharePoint certificate of PoC 1 (`poc1-slack-platform/.env`, `infra/local.env`, `infra/kb-cert/`). Its AWS resources are its own (prefix and tag `poc3-kb`).
- PoC 2's knowledge base work builds on PoC 1's documents 08 and 09.
- Each PoC's AWS resources are tagged separately: `slack-web-automation-poc` for PoC 1, `poc3-kb` for PoC 3.

## Not in git

Settings and secrets that differ per environment stay out of git: `.env`, `infra/local.env` and `infra/kb-cert/` in PoC 1, `infra/deploy.local.json` in PoC 3, and every `node_modules/`, build output and generated test data. See `.gitignore`.
