# AIPF: Reference Platforms

This document records how other platforms and products run AI agents as parts of a development team: how they are built, how they work, and what the AI platform (AIPF) can learn from them. It is for the engineers and architects who will design the AIPF, and it uses the components in [02-platform-components.md](02-platform-components.md) as its frame.

Status: desk research from vendor documentation and announcements, as of 2026-10-18. None of these platforms was tried here. Many features are in beta or preview and change monthly; dates are given so that the reader can judge how fresh each claim is. Claims found only in third-party sources are marked *(unverified)*.

## 1. Summary

- **Anthropic's Claude Platform (Claude Managed Agents) is the closest to the AIPF's own design:** agents defined as versioned configuration, a sandbox per session, long-running sessions with an event history, several agents working together, credentials kept out of the sandbox, permission policies, versioned memory, a separate grader, schedules and budgets. It is a toolkit to build an agent team on, not a team itself: roles, work board, approvals across the lifecycle, customer isolation and the organisation's process remain to be built.
- **The cloud providers sell the same parts inside the customer's own cloud environment.** AWS (Bedrock AgentCore), Google (Gemini Enterprise Agent Platform) and Microsoft (Foundry Agent Service) offer a managed agent loop, a sandbox per session, an MCP tool gateway, an identity per agent, per-call policy and evaluation, in the customer's network and Region and with a choice of models. OpenAI's Agents API, like Anthropic's, runs in the vendor's cloud, and keeps data in the US only.
- **Every product runs each task in a throwaway VM or container.** They differ mainly in how that environment is defined. This supports the AIPF finding that how far a project can be automated is bounded by the environment the agent can build for it ([02](02-platform-components.md), section 5).
- **The agent loop stays with the vendor.** Several products let the sandbox run on the customer's own machines, but prompts, tool results and transcripts still go to the vendor. Only Factory offers a fully air-gapped deployment.
- **Credentials do not enter the sandbox** in the better designs: a placeholder sits in the sandbox and a proxy substitutes the real value on the way out.
- **Human merge approval is the default checkpoint everywhere.** Review agents' approvals do not count towards required approvals by default.
- **The products cover the developer role well, QA and DevOps partly, PM and BA hardly at all.** "AI software company" products with PM, architect and engineer agents (Atoms, ChatDev) build new applications on their own hosting; they do not work on existing codebases under an organisation's process.

## 2. Claude Platform: Claude Managed Agents

Anthropic launched Claude Managed Agents as a public beta on 2026-04-08. Anthropic runs the agent loop and the sandboxes; the customer configures agents through an API and watches them through an event stream. Every endpoint needs a beta header. Price: normal token rates plus USD 0.08 per session-hour of active runtime. Because sessions are stateful, it is not eligible for zero data retention or a HIPAA agreement.

Named customers include Notion, Rakuten (specialist agents in Slack and Teams, each deployed within a week), Asana (AI Teammates), Sentry (an agent that writes patches and opens pull requests), and Atlassian (agent tasks assigned from Jira).

### 2.1 Building blocks

| Concept | What it is |
|---|---|
| Agent | Model, system prompt, tools, MCP servers and skills. Versioned. |
| Environment | Where tools run: a cloud sandbox, or a sandbox the customer hosts. Not versioned. |
| Session | A running instance of an agent in an environment. Keeps its filesystem and history, runs for a long time, can be steered or interrupted while it works. |
| Events | A server-sent event stream of everything the session does. The history is kept on the server. |

Built-in tools: bash, file operations (read, write, edit, glob, grep), web search and fetch, MCP servers, and custom tools that the customer's code answers. A tool output longer than 100,000 characters is saved to a file in the sandbox instead of filling the context.

### 2.2 Environments

**Cloud sandbox.** Each session gets a fresh, isolated Linux container with common runtimes and databases installed.

- A `packages` list (apt, cargo, gem, go, npm, pip) adds packages; they are cached across sessions that share the environment.
- Networking is `limited` (an `allowed_hosts` list, plus switches for package managers and MCP servers) or `unrestricted`. Through the API, `unrestricted` is the default when nothing is set.
- A session can be given resources at start: files, a GitHub repository, memory stores.

**Self-hosted sandbox** (since 2026-05-19). The agent loop stays at Anthropic; a worker the customer runs executes the bash and file tools.

- Files stay on the customer's hosts, but tool results still go to Anthropic.
- It gives up GitHub repository mounting, skill discovery from the repository, credentials injected as environment variables, and the pre-installed packages.
- Cloudflare Sandboxes can host it (2026-05-21). MCP tunnels (research preview) let agents reach MCP servers inside a private network.

### 2.3 Several agents

- A coordinator agent lists up to 20 predefined agents, each pinned to a version. Agents defined inline by the coordinator can be switched off.
- Delegation is one level deep, with at most 25 child threads per session. Threads persist.
- Threads share the sandbox, its filesystem and the session's credentials, but each has its own context.
- Dynamic workflows (beta, 2026-10-09): the agent writes a program that runs many agents in phases in the background, reported through workflow events.
- An advisor model can be consulted in the middle of a turn.

### 2.4 Permissions and credentials

**Permission policies**, per toolset and per tool:

| Policy | Behaviour |
|---|---|
| `always_allow` | The call runs. Default for the built-in tools. |
| `always_ask` | The session pauses until someone confirms. Default for MCP tools. |
| `auto` (since 2026-09-10) | The server judges each call. |

**Vaults** hold credentials per end user, up to 20 per vault:

- `mcp_oauth`: OAuth for MCP servers, refreshed automatically.
- `static_bearer`: a fixed token.
- `environment_variable`: the sandbox sees only a placeholder; the real value is substituted on the way out, only towards the allowed hosts and only in the header or body named. This breaks request signing done inside the sandbox, such as AWS SigV4.

Credentials are looked up again when they rotate, and webhooks report changes. MCP servers belong to the agent; vault credentials belong to the session.

Since 2026-10-07, web fetch only opens URLs that have already appeared in the session, to make it harder to send data out.

### 2.5 Memory

Memory stores (beta) are text documents shared across a workspace and mounted into the sandbox as folders.

- Mounted `read_write` or `read_only`. Up to 8 stores per session, 100 kB per memory, 10,000 memories per store.
- Every change creates an immutable version, kept for 30 days; content can be redacted.
- "Dreams" (research preview) consolidate a store into a new store.
- The documentation warns that memory can be poisoned by prompt injection, and recommends `read_only` for reference material.

### 2.6 Outcomes

The caller defines an outcome with a description, a rubric in Markdown and a maximum number of iterations (default 3, at most 20). A separate grader, with its own context, checks the work against the rubric and either accepts it or sends it back. The result is one of: satisfied, needs revision, maximum iterations reached, failed, interrupted. Outputs are written to a fixed folder and fetched through the Files API.

### 2.7 Operations

| Feature | Since |
|---|---|
| Scheduled sessions (cron) | 2026-06-09 |
| Session budgets: the session pauses when its spending cap is reached | 2026-08-07 |
| Configuration as code: agents and environments applied from repository files, with a lock file | 2026-09-03 |
| OpenTelemetry export of traces | 2026-10-14 (beta) |

Also: webhooks; skills loaded from a repository's `.claude/skills` folder; a terminal can attach to a running session; a session viewer in the console; a setting for where inference runs (`inference_geo`).

### 2.8 Claude Platform on AWS

Launched 2026-05-11. Anthropic operates the platform; AWS provides sign-in through IAM, logging to CloudTrail, and billing through AWS Marketplace.

- It needs a new Anthropic organisation and outbound web identity federation enabled in IAM.
- It is offered in all AWS commercial Regions, but **the Region does not decide where inference runs**: `inference_geo` is `us` or `global`. Anthropic is the data processor.
- Differences for Managed Agents: autonomous work is limited to 6 hours, no memory stores on self-hosted sandboxes, workers authenticate with SigV4, no MCP tunnels.
- Not offered there: HIPAA, the computer and browser tools, OAuth, fast mode.
- Compared with Amazon Bedrock: Bedrock is operated by AWS and has FedRAMP and HIPAA, but lacks Agent Skills and code execution.

For an organisation whose data must stay in one Region (the AIPF requirement in [02](02-platform-components.md), section 6), this is a deciding point: neither the direct nor the AWS offering keeps inference in a chosen non-US Region.

## 3. Agent infrastructure from the cloud and model providers

AWS, Google, Microsoft and OpenAI now sell the same basic parts as Anthropic: a managed agent loop, an isolated sandbox per session, a tool gateway speaking MCP, an identity for each agent, a registry of agents and tools, and evaluation. The difference that matters most for the AIPF is that the three cloud providers run these parts inside the customer's own cloud environment, with its network, identity and Regions, and let the customer choose the model.

### 3.1 AWS: Amazon Bedrock AgentCore

Generally available since 2025-10-13; Policy (2026-03-03), Evaluations (2026-03-31), the managed Harness (July 2026) and Agent Registry (August 2026) followed. Its services are Harness, Runtime, Memory, Gateway, Identity, Code Interpreter, Browser, Observability, Evaluations, Optimization, Policy, Registry and Payments.

- **Agent loop.** Either the customer's own framework code on Runtime (Strands, LangGraph, CrewAI, Google ADK, OpenAI Agents SDK and others), or the managed **Harness**: a loop defined by configuration, run in a microVM per session with a filesystem and shell. A custom container and S3 or EFS file systems can be mounted.
- **Isolation and long work.** Each Runtime session gets its own microVM, lasts up to 8 hours, ends after 15 minutes idle, and its memory is cleaned afterwards. Session storage (preview) keeps files across stop and resume. A shell API lets agents run builds and tests. The **Instances** compute type runs on EC2 in the customer's own AWS account, with sessions up to 14 days, GPU options, and several agents per instance.
- **Memory.** Short-term and long-term, including an "episodic" strategy that learns from earlier runs; long-term records can expire (since October 2026).
- **Tools.** Gateway turns APIs, Lambda functions and existing MCP servers into MCP tools. Runtime supports MCP and A2A.
- **Identity and permissions.** Each agent has a workload identity; inbound JWT authorisation, outbound credential providers, and acting on a user's behalf through token exchange. **Policy** checks every Gateway tool call before it runs, with rules in natural language or a Cedar-compatible language, and a log-only mode for testing.
- **Approvals.** Harness hooks call a Lambda function that can allow or deny a call; a consent portal lets end users approve access requested on their behalf.
- **Measurement.** OpenTelemetry into CloudWatch; 13 built-in evaluators, online and on demand; prompt recommendations, A/B tests and batch evaluations.
- **Models.** Any model: Bedrock, OpenAI, Gemini or LiteLLM providers, switchable within a session.
- **Hosting and price.** VPC and PrivateLink, GovCloud, Instances in the customer's account; no self-hosted control plane. Pay per use: about USD 0.0895 per vCPU-hour for Runtime, USD 0.005 per 1,000 Gateway calls, no extra charge for the Harness.

AWS also sells finished agents for team roles: **AWS DevOps Agent** (section 4.7), **AWS Security Agent** (on-demand penetration testing GA 2026-03-31; design and code review in preview), and **Kiro**, whose autonomous mode (Kiro Web GA 2026-09-01) plans, hands work to sub-agents and opens pull requests across several repositories, each task in its own sandbox. "Kiro never merges changes automatically."

### 3.2 Google: Gemini Enterprise Agent Platform

Vertex AI was renamed and folded into this platform in April 2026.

- **Agent Runtime** runs a container the customer supplies, with full support for Google's Agent Development Kit (ADK) and support for LangGraph, LlamaIndex and AG2. Long-running operations up to 7 days.
- **Sandboxes** for code execution, computer use and custom containers, with state kept 7 to 14 days. Computer-use and shell sandboxes are GA (2026-09-09) with VPC Service Controls and customer-managed keys.
- **Managed Agents API** (preview, 2026-05-19): agents defined by configuration and `AGENTS.md` / `SKILL.md` files, run in an isolated Linux sandbox.
- **Memory.** Sessions and Memory Bank.
- **Identity and gateway.** Agent Identity (GA April 2026) is based on SPIFFE, cannot be impersonated and allows no long-lived keys. **Agent Gateway** (GA 2026-06-18) denies all agent traffic unless an IAM policy allows it, understands MCP and A2A, and screens traffic with Model Armor. Agent Registry is GA.
- **Approvals.** ADK has action confirmations and human-input steps in its graph workflows.
- **Measurement.** Multi-turn automatic raters, agent simulation, an agent optimiser and a unified trace viewer.
- **Models.** More than 200 in Model Garden, Claude among them. ADK is open source and model-agnostic.
- **A2A** (agent-to-agent protocol) reached version 1.0 under the Linux Foundation on 2026-04-09.
- **Price.** About USD 0.085 per vCPU-hour and USD 0.009 per GiB-hour for agent compute.

### 3.3 Microsoft: Foundry Agent Service

- **Agent types.** Prompt agents (the loop runs in Foundry), voice agents, and **hosted agents** (the customer's container; GA 2026-07-09).
- **Hosted agents.** Each session in a VM-isolated sandbox with a persistent home folder, scaling to zero; idle timeout 2 to 60 minutes; sessions deleted after 30 days unused; up to 2 vCPU and 4 GiB. Each agent has its own Entra identity: acting for a user on behalf of that user, autonomous work under a managed identity. The customer's own virtual network; 31 regions.
- **Tools.** Toolboxes expose tools through one managed MCP endpoint with central authentication. Built-in memory; tracing through Application Insights.
- **Models.** The Foundry catalogue; hosted agents accept the OpenAI, Anthropic and GitHub Copilot SDKs.
- **Microsoft Agent Framework 1.0** (2026-04-03), the successor to Semantic Kernel and AutoGen: graph workflows with checkpoints; sequential, concurrent, hand-off, group-chat and manager-led patterns; human approval steps; MCP; providers including Foundry, OpenAI, Claude, Bedrock, Gemini and Ollama.
- **Entra Agent ID** (GA) and **Agent 365** (an agent registry with access control and Defender and Purview protection, USD 15 per user per month) govern agents across the organisation, including agents running on other clouds.

### 3.4 OpenAI

- **Agents API** (public beta, 2026-09-10) offers the Codex agent loop as a managed service. The environment is none, an OpenAI-hosted sandbox with configurable packages and network, or a self-hosted executor (Docker, Lambda, a laptop). It supports MCP, several agents and context compaction. **Data residency is US only, and zero data retention is not supported, even with a self-hosted sandbox.**
- **Agents SDK** (Python, TypeScript) runs inside the customer's own application: hand-offs, guardrails, human review, tracing, and sandboxes from partners such as E2B, Modal, Daytona and Cloudflare.
- **AgentKit is being withdrawn:** Agent Builder, Evals and the prompts API shut down on 2026-11-30, a year after they were introduced.
- **Frontier**, an enterprise platform announced 2026-02-05 for selected customers, is reported to give each agent its own identity and permissions, accept other vendors' agents and models, and run on customer infrastructure *(unverified; OpenAI's pages could not be read and no general availability was found)*.

### 3.5 The providers side by side

| | Anthropic Managed Agents | AWS AgentCore | Google Agent Platform | Microsoft Foundry | OpenAI Agents API |
|---|---|---|---|---|---|
| Who runs the agent loop | Anthropic | AWS, or the customer's code on AWS | Google, or the customer's container | Microsoft, or the customer's container | OpenAI |
| Sandbox per session | Container, or self-hosted worker | microVM; EC2 in the customer's account | Container sandbox | VM-isolated sandbox | OpenAI-hosted, or self-hosted executor |
| Longest session | 6 hours autonomous on AWS; long-running otherwise | 8 hours; 14 days on Instances | 7 days | Until idle timeout; kept 30 days | Not documented |
| Agent identity | Session-scoped vault credentials | Workload identity, token exchange | SPIFFE agent identity | Entra Agent ID | Not documented for the API |
| Per-call policy | Allow, ask, automatic | Policy on every Gateway call, Cedar-compatible | Gateway denies by default, IAM allows | Central authentication on toolboxes | Guardrails in the SDK |
| Models | Claude | Any | Any (200+) | Catalogue, several vendors | OpenAI |
| Data residency | `us` or `global` | Customer's Region and VPC | Customer's Region, VPC-SC | Customer's region and network | US only |

The table records what each vendor documents, not what was tested here.

## 4. Products that act as members of a development team

### 4.1 GitHub Copilot cloud agent, Agent HQ and code review

- **How it works.** The cloud agent researches, plans and codes in the background on GitHub Actions runners. One task covers one repository and one branch and ends in one pull request. A session lasts at most 59 minutes, and the repository must be on GitHub.
- **Triggers.** The agents panel, issues, pull requests, chat; Slack, Teams, Jira, Linear and others. Since 2026-06-02, automations on a schedule, on new issues or on pull request changes.
- **Environment.** A workflow file, `.github/workflows/copilot-setup-steps.yml`, with a single job. Ubuntu or Windows runners, standard, larger or self-hosted; no macOS. If a setup step fails, the agent carries on without the rest.
- **Network.** A recommended allowlist is on by default and can be enforced by the organisation. It covers only processes the agent starts from its shell, not MCP servers or setup steps; GitHub calls it "not a complete security solution."
- **Guardrails.** Only users with write access can start it. It pushes only to `copilot/` branches. Workflows do not run on its pull requests until a person with write access approves them. The person who asked for the work cannot approve its pull request. Code scanning and secret scanning run on its changes.
- **Agent HQ** (2025-10-28): one place to direct agents across GitHub, the editor, mobile and the command line, with a control plane for policies, audit and the agents and models allowed. Claude and Codex agents run inside it (public preview for Business and Pro since 2026-02-26).
- **Code review** reads instructions from the repository (`.github/copilot-instructions.md`, `AGENTS.md`, skills; only the first 4,000 characters of each instructions file). Its reviews do not count towards required approvals by default.
- **Price.** Usage-based credits since 2026-06-01, plus Actions minutes.

### 4.2 Cognition: Devin

- **Environment.** Each session boots a fresh copy of a VM snapshot (Linux; Windows and macOS can be added). The snapshot is built from a **blueprint**, a declarative YAML file that Devin can draft itself, and is rebuilt on change and about once a day. Changes made in a session do not flow back to the snapshot. Secrets are encrypted and injected as environment variables; in the vendor's words, Devin can work out the tools it needs but "cannot discover your credentials."
- **Repository knowledge.** Playbooks (procedure, specifications, advice, forbidden actions, what is needed from the user), versioned. DeepWiki generates a wiki of each repository with diagrams; the pages can be fixed with a file in the repository. Devin reads `AGENTS.md`, `CLAUDE.md` and similar files.
- **Several agents.** A coordinator session starts child sessions, each with its own VM, playbook and spending cap.
- **Triggers.** Schedules, Slack, Jira, Linear, GitHub (including failed checks), GitLab, PagerDuty, webhooks. A "triage" session can watch a Slack channel and start child sessions.
- **Review.** Devin Review on GitHub, GitLab and Azure DevOps, with security scans that cannot be switched off.
- **Deployment options.** Multi-tenant SaaS; a single-tenant VPC run by Cognition; and **Outposts**, where sessions run on the customer's machines over outbound HTTPS only. In every option the agent loop stays in Cognition's cloud.
- **Price** (2026-04-14). Free, USD 20 and USD 200 a month for individuals; usage-based for teams; Enterprise by agreement.

### 4.3 Factory

- **Agents.** Built-in worker and explorer agents, and custom agents defined as Markdown files in the repository. Earlier role agents (knowledge, reliability, product) appear only in older third-party material *(unverified)*.
- **Software Factory** (private preview): a lifecycle system that runs all day: triage, code generation, validation (review, security, QA), release with deployment gates, documentation, and incident response. Work is handed over from Linear, Jira or Teams.
- **Missions.** A plan is drafted, a person approves it, an orchestrator runs it in milestones, and an agent does user-facing QA. Factory says Missions suit projects at "Agent Readiness Level 4" or above, and that whether to run work in parallel is still "an open question".
- **Automations.** Triggers from schedules, Slack, GitHub and webhooks; templates such as ticket to pull request, pull request review, CI failure triage, incident response, QA and security audit. Approvals are graded by risk.
- **Environment.** Persistent machines that pause when idle, started from snapshots; or the customer's own machine.
- **Guardrails.** The command-line agent is read-only by default; autonomy is raised in three steps (low, medium, high).
- **Deployment options.** SaaS, hybrid, fully inside the customer's infrastructure, or **fully air-gapped**, with the customer's own model gateway. It is the only product found that runs entirely on the customer's side.

### 4.4 Cursor cloud agents and Bugbot

- **Environment.** Each task runs on an isolated Ubuntu VM. A setup agent builds and checks the environment and saves it once a build succeeds; a failed build keeps the previous one. Advanced: a Dockerfile and `.cursor/environment.json` with install, start and terminal commands. Secrets from the dashboard, an AWS role or OIDC. Egress allowlist, tunnels to private networks, Docker inside the VM.
- **Triggers and parallelism.** Desktop, web, mobile, Slack, Linear, GitHub, Bitbucket and an API. Any number of agents in parallel, each on its own branch with its own pull request. Agents can use a computer and attach screenshots and videos.
- **Automations** (2026-03-05): schedules, Slack, Linear, GitHub, PagerDuty, webhooks; each run in its own sandbox, with a memory tool to learn from earlier runs.
- **Bugbot** reviews pull requests with rules from `.cursor/BUGBOT.md`, learns rules over time, and can start a cloud agent to fix what it finds.

### 4.5 OpenAI Codex cloud

- **Environment** (new design, around 2026-09-29). Each task gets its own VM. Codex works out the runtimes and drafts the install script; a "start skill" launches the services and checks that they are ready. Publishing an environment snapshots its filesystem. Network secrets: programs see only a placeholder, and a proxy substitutes the real value. Internet access: package managers only, a custom list, or everything. No GitLab and no GitHub Enterprise Server.
- **Older environments**, still used for review and integrations: a container from a universal image with setup and maintenance scripts; secrets available only during setup; internet off by default for the agent.
- **Code review** flags only the most serious issues, follows rules in the nearest `AGENTS.md`, and can start a task to fix them.

### 4.6 Claude Code on the web and in CI

- **Cloud sessions** on an Anthropic VM or a self-hosted environment, started from web, mobile, desktop, the command line, scheduled routines or Slack. A GitHub proxy means credentials never enter the VM. Sessions run in parallel and can move to a local machine.
- **Environment.** Network levels none, trusted (default), full or custom. A setup script runs as root; if it finishes within about five minutes, the result is cached as a snapshot for about seven days. Hooks run at the start of every session. Docker is available.
- **Self-hosted environments** (public beta): runners poll outward; code stays on the customer's machines, transcripts go to Anthropic.
- **GitHub Actions** action: started by a mention or by a workflow; only users with write access can trigger it; can call models through Bedrock, Vertex AI or Microsoft Foundry.

### 4.7 Agents for other roles

| Product | Role | How it works |
|---|---|---|
| AWS DevOps Agent (GA 2026-03-31) | DevOps, SRE | Maps the system's topology, investigates incidents with root cause and mitigation, triages and finds duplicates, runs on schedules or events. Access limited per "Agent Space" through IAM roles. Connects to CloudWatch, Datadog, PagerDuty, ServiceNow, Slack and MCP. Billed per second of agent time. Release-readiness review in preview. |
| Azure SRE Agent | DevOps, SRE | Connects to PagerDuty, ServiceNow, GitHub, Azure DevOps and MCP; private network support added in 2026. GA date *(unverified)*. |
| Linear | PM (delegation) | Agents are **delegates, not assignees**: "an agent cannot be held accountable." Coding sessions run Claude Code or Codex from an issue and return a diff (2026-06-11). Coding environments detect toolchains, test in a browser and attach screenshots, at USD 0.25 per 20 minutes plus tokens (2026-08-20). |
| Atlassian Jira coding agent (Rovo Dev) | Developer, from Jira | Works from a Jira work item in a cloud sandbox and opens a pull request; one repository per session. General availability unclear. |
| Atoms (formerly MetaGPT X) | A whole "company" | Named agents for team lead, PM, architect, engineer, data analyst and researcher; the team lead asks for approval at checkpoints. Builds new applications on its own hosting; does not work on existing codebases or self-host. |
| ChatDev | A whole "company" (research) | Version 1 was a CEO, CTO, programmer and tester waterfall (ACL 2024 paper). Version 2 (2026) is a general multi-agent orchestration framework, not a managed product. |

## 5. How the environment is defined

| Approach | Products | Notes |
|---|---|---|
| A CI workflow file on CI runners | Copilot; the Claude, Factory and Cursor CI actions | Inherits CI limits: 59 minutes, Ubuntu or Windows |
| A declarative specification, built into a snapshot, cloned fresh for each task | Devin blueprints, Cursor `environment.json`, Codex published environments, Claude Code cached setup | The most common pattern |
| The agent writes the specification itself | Devin, Cursor setup agent, Codex start skill, Linear toolchain detection | A person still supplies the credentials |
| Persistent machines | Factory | Paused when idle |
| The customer's compute, the vendor's agent loop | Claude self-hosted sandbox, Devin Outposts, Cursor self-hosted, Copilot self-hosted runners | Code stays inside; prompts and results do not |

Common gaps: macOS and device testing are rare (only Devin offers macOS VMs); dependent services must be started by scripts; network controls are partial; credentials always need a person.

## 6. The AIPF components in these platforms

| AIPF component ([02](02-platform-components.md)) | Claude Managed Agents | Cloud agent platforms (AgentCore, Google, Foundry) | Coding products (Copilot, Devin, Factory, Cursor, Codex) | Still left to the AIPF |
|---|---|---|---|---|
| Orchestration | Coordinator with versioned sub-agents, one level deep; long sessions; schedules; webhooks; dynamic workflows | Managed loop or own framework; graph workflows with checkpoints (Agent Framework, ADK); A2A between agents | Coordinator and child sessions (Devin); triggers from tickets, chat, CI and alerts; Factory's lifecycle stages | Work board and states across PM, BA, Dev, QA, DevOps; hand-over rules; team templates |
| Context | Versioned memory stores; files; repository mounted; skills from the repository | Short- and long-term memory, Memory Bank, built-in memory tools | Instruction files in the repository (`AGENTS.md` and similar); playbooks; generated repository wikis | Knowledge base across projects; project memory per customer |
| Tool gateway | MCP servers per agent; vault credentials with egress substitution | MCP gateways with central authentication and outbound credential providers | MCP; proxies that keep credentials out of the VM | One door for all the organisation's tools, recorded per work item |
| Environments | Container per session, package cache, network allowlist; or self-hosted worker | microVM or VM sandbox per session; sessions of hours to days; compute in the customer's account | Snapshot per task from a declarative specification | Environments for projects outside containers (mobile, Windows, legacy) |
| Governance | Permission policies (allow, ask, auto); session-scoped credentials; budgets | Identity per agent (workload identity, SPIFFE, Entra Agent ID); policy on every tool call; deny by default; customer's network | Write access to trigger; agent branches; workflows wait for approval; requester cannot approve; scanning | Roles mapped to identities; approval gates across the lifecycle; customer isolation |
| Model gateway | Claude models only; `inference_geo` us or global | Any model, several vendors | Mostly one vendor's models; some let the customer choose | Budgets per project, version pinning, routing by role |
| Measurement | Grader with rubric; OpenTelemetry traces; session viewer | Built-in evaluators, simulation, A/B tests, optimisers, OpenTelemetry | Review agents; usage dashboards | Quality per role, flow, cost per work item, evaluation sets per role |
| Channels | API, console, terminal | API; Microsoft 365 and Gemini Enterprise apps | Slack, Teams, Jira, Linear, GitHub, editor, mobile | Customer reports through approval; portfolio view |

## 7. Lessons for the AIPF

1. **Separate the agent, the environment and the session.** Agents as versioned configuration, environments as a specification, sessions as running instances with an event history. Keep agents and environments in a repository and apply them as code, as Claude Managed Agents, Factory and Copilot do. *(02, sections 2 and 5)*
2. **Build environments from a specification into a snapshot, and clone a fresh one per task.** Let an agent draft the specification, keep the last good build when a new one fails, and have a person supply credentials. This is the pattern all the coding products converged on. *(02, section 5; 03)*
3. **Decide early where the agent loop runs.** A self-hosted sandbox keeps code inside but still sends prompts and tool results to the vendor. If customer contracts require that nothing leaves the organisation's cloud environment and Region, the choices are a loop the organisation runs itself, a cloud provider's agent platform in its own account and Region (for example AgentCore), or a fully self-hosted product. *(02, section 6)*
4. **Keep credentials out of the sandbox.** Put a placeholder in the sandbox and substitute the real value in an egress proxy, only towards allowed hosts. Note that this breaks request signing inside the sandbox, so cloud APIs need a different route. *(02, section 4)*
5. **Make permission a property of each tool call,** with allow, ask and automatic policies, and ask by default for tools that act outside the sandbox. Borrow the simple rules that work: agents push only to their own branches, pipelines on agent pull requests wait for a person, the requester cannot approve. *(02, section 6)*
6. **An agent is a delegate, not an owner.** Every work item has a person accountable for it, as Linear makes explicit. *(02, section 6)*
7. **Check work with a separate grader** that has its own context and a written rubric, and keep the number of revision rounds bounded. Do not count an agent reviewer's approval as a required human approval. *(02, section 8)*
8. **Version memory and protect it from poisoning.** Every change kept and reversible; reference material mounted read-only. *(02, section 3)*
9. **Cap spending per session and per project,** pause rather than fail when a cap is reached, and export traces in a standard format (OpenTelemetry). *(02, sections 7 and 8)*
10. **Keep agent hierarchies shallow.** Claude Managed Agents allows one level of delegation; Factory calls parallel work an open question. A board with clear hand-over between roles is safer than deep chains of agents. *(02, section 2)*
11. **Build on open protocols.** MCP for tools and A2A between agents are supported by all the cloud platforms, and agent instruction files (`AGENTS.md`, skills) are read by most coding products. Using them keeps roles, tools and repositories portable across vendors, which matters when a vendor withdraws a product within a year, as OpenAI is doing with AgentKit. *(01, section 2.9)*
12. **The organisation's part is the lifecycle, not the coding agent.** Coding, review and incident agents can be bought or wrapped. What no product provides is a team across PM, BA, developer, QA and DevOps, working on existing codebases under the organisation's process, with customer isolation, approvals and cost per project. That is where the AIPF's own work belongs. *(01, section 2.8)*

## 8. Sources

Claude Platform:

- [Claude Managed Agents announcement](https://claude.com/blog/claude-managed-agents)
- [Claude Platform release notes](https://platform.claude.com/docs/en/release-notes/overview)
- Managed Agents documentation: [overview](https://platform.claude.com/docs/en/managed-agents/overview), [choosing an environment](https://platform.claude.com/docs/en/managed-agents/choosing-an-environment), [environments](https://platform.claude.com/docs/en/managed-agents/environments), [multiagent orchestration](https://platform.claude.com/docs/en/managed-agents/multiagent), [permission policies](https://platform.claude.com/docs/en/managed-agents/permission-policies), [memory](https://platform.claude.com/docs/en/managed-agents/memory), [vaults](https://platform.claude.com/docs/en/managed-agents/vaults), [outcomes](https://platform.claude.com/docs/en/managed-agents/define-outcomes)
- [Claude Platform on AWS](https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws)

Cloud and model providers:

- AWS: [AgentCore overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html), [Harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html), [Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html), [Identity](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html), [release notes](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.md), [Policy and Evaluations](https://aws.amazon.com/blogs/aws/amazon-bedrock-agentcore-adds-quality-evaluations-and-policy-controls-for-deploying-trusted-ai-agents/), [pricing](https://aws.amazon.com/bedrock/agentcore/pricing/), [Security Agent](https://aws.amazon.com/about-aws/whats-new/2026/03/aws-security-agent-ondemand-penetration), [Kiro Web](https://kiro.dev/blog/introducing-kiro-web/), [Kiro autonomous agent](https://kiro.dev/docs/autonomous-agent/)
- Google: [Gemini Enterprise Agent Platform](https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform), [Agent Runtime](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/runtime), [sandbox](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox), [release notes](https://docs.cloud.google.com/gemini-enterprise-agent-platform/release-notes), [Managed Agents API](https://blog.google/innovation-and-ai/technology/developers-tools/managed-agents-gemini-api), [Agent Identity](https://docs.cloud.google.com/iam/docs/agent-identity-overview), [Agent Gateway](https://docs.cloud.google.com/gemini-enterprise-agent-platform/govern/gateways/agent-gateway-overview), [ADK](https://adk.dev/), [A2A 1.0](https://linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
- Microsoft: [Foundry Agent Service](https://learn.microsoft.com/azure/foundry/agents/overview), [hosted agents](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agents), [July–August 2026 updates](https://devblogs.microsoft.com/foundry/whats-new-in-microsoft-foundry-july-august-2026/), [Agent Framework 1.0](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/), [Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/whats-new-agent-id), [Agent 365](https://www.microsoft.com/en-us/microsoft-agent-365)
- OpenAI: [Agents API architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture), [Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview), [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk), [deprecations](https://developers.openai.com/api/docs/deprecations), [Codex security](https://developers.openai.com/codex/agent-approvals-security)

Development team products:

- GitHub: [cloud agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent), [agent environment](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment), [firewall](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/customize-the-agent-firewall), [risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations), [automations](https://github.blog/changelog/2026-06-02-schedule-and-automate-tasks-with-copilot-cloud-agent/), [Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/), [code review](https://docs.github.com/en/copilot/concepts/agents/code-review)
- Devin: [environment](https://docs.devin.ai/onboard-devin/environment), [blueprints](https://docs.devin.ai/onboard-devin/environment/blueprints), [playbooks](https://docs.devin.ai/product-guides/creating-playbooks.md), [DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki.md), [managed Devins](https://docs.devin.ai/work-with-devin/advanced-capabilities.md), [automations](https://docs.devin.ai/product-guides/automations.md), [deployment](https://docs.devin.ai/enterprise/deployment/overview.md), [Outposts](https://docs.devin.ai/cloud/outposts/overview.md), [plans](https://cognition.com/blog/new-self-serve-plans-for-devin)
- Factory: [droids](https://docs.factory.com/user-guides/droids/understanding-droids), [Software Factory](https://docs.factory.com/software-factory/overview), [automations](https://docs.factory.com/software-factory/automations), [Missions](https://docs.factory.com/missions/overview), [Droid Computers](https://docs.factory.com/droid-computers/overview), [deployment](https://docs.factory.com/enterprise/network-and-deployment)
- Cursor: [cloud agent](https://cursor.com/docs/cloud-agent), [setup](https://cursor.com/docs/cloud-agent/setup), [automations](https://cursor.com/changelog/03-05-26), [Bugbot](https://cursor.com/docs/bugbot)
- OpenAI Codex: [cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments), [older environments](https://learn.chatgpt.com/docs/environments/cloud-environment), [GitHub integration](https://learn.chatgpt.com/docs/third-party/github), [SiliconANGLE report](https://siliconangle.com/2026/09/29/openais-codex-gets-reusable-cloud-environments-that-follow-developers-across-devices/)
- Claude Code: [on the web](https://code.claude.com/docs/en/claude-code-on-the-web.md), [cloud environments](https://code.claude.com/docs/en/cloud-environments), [self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments), [GitHub Actions](https://code.claude.com/docs/en/github-actions)
- Other roles: [AWS DevOps Agent](https://aws.amazon.com/about-aws/whats-new/2026/03/aws-devops-agent-generally-available), [Linear agents](https://linear.app/docs/agents-in-linear), [Linear coding environments](https://linear.app/changelog/2026-08-20-coding-environments), [Jira coding agent](https://support.atlassian.com/jira-software-cloud/docs/what-is-the-jira-coding-agent/), [Azure SRE Agent](https://github.com/microsoft/sre-agent), [Atoms](https://atoms.dev), [ChatDev paper](https://arxiv.org/html/2307.07924v4)
