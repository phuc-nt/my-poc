# AIPF: Why an Internal AI Platform

This document records why the organisation's AI Transformation (AX) strategy includes building its own AI platform (AIPF) rather than relying only on AI tools that each person uses on their own machine. It is for decision makers. The parts such a platform needs are in [02-platform-components.md](02-platform-components.md), and the standard a project must meet before agents can work on it is in [03-ai-ready-repo.md](03-ai-ready-repo.md).

Status: a position paper, written on 2026-10-18 from internal discussion. Nothing in it has been built or measured yet.

## 1. The goal

The goal is not to give each person an AI assistant. It is a **development team whose roles are carried by agents**: project manager (PM), business analyst (BA), developer, tester (QA) and DevOps engineer. The team covers the whole software lifecycle, its management and its operations, with people approving at set points and stepping in where agents cannot.

Personal AI tools (chat assistants, coding assistants in an editor) make one person faster at one task. A team needs more than that: shared context, roles and permissions, work that continues when nobody is at a keyboard, and a way to measure and improve. That is what the AIPF provides.

## 2. Why build it

### 2.1 The starting reasons

| Reason | What it means |
|---|---|
| Delivered as a service | Used from a browser or a chat tool; nothing to install or maintain on each machine |
| Not tied to a laptop | Work runs on the platform, so it continues when a laptop is closed and does not depend on what is installed on it |
| Multi-user | One platform serves many people and teams, with their own access |
| Shared knowledge and shared code | Agents read the organisation's knowledge base and its source repositories, not only what a person pastes in |

### 2.2 A team needs coordination, not only tools

- **Many agents with roles hand work to each other.** The PM agent splits work, a developer agent takes a task, the QA agent returns defects, the DevOps agent deploys. That needs a shared board, states and hand-over rules, as a human team has.
- **Work lasts days and weeks.** A feature spans sprints. Agents must be able to stop, resume and keep their context. A session on one machine cannot do that.
- **Project memory.** Decisions taken and why, the history of exchanges with the customer, lessons from incidents. This is the team's memory, not one conversation's.

### 2.3 Each agent needs an identity, permissions and accountability

- **Permissions by role.** The PM agent may edit the backlog but not deploy; the DevOps agent may deploy to staging, and production only after a person approves.
- **Every action is traceable:** which agent did what, when, on the basis of which requirement. Without that, real work cannot be delegated to agents.
- **Mandatory human approval** at set points: requirement sign-off, merge, production deployment, spending over budget, messages to the customer. Agents escalate to a person when unsure.
- **No personal credentials on laptops.** Agents act under platform identities with the least privilege their role needs.

### 2.4 It runs continuously, driven by events

- **Events, at any hour:** a customer email, a new ticket, a failed build, a production alert, a pull request waiting for review.
- **Routines on a schedule:** stand-up summary, sprint planning, weekly customer report, retrospective.

### 2.5 Management needs data across projects

- **Estimation, planning, progress tracking, risk and resource allocation** need the history of many projects, not only the current one.
- **A portfolio view:** many agent teams in parallel, some mixed with people, visible to management in one place.
- **AI cost tied to each project's profit and loss:** model usage, infrastructure and the time people spend approving, set against the cost of a human team, to show the real return.

### 2.6 Safety when agents act for real

- **Sandboxes** for agents that run code: their own container, restricted network, short-lived credentials.
- **Limited blast radius:** destructive actions blocked, rollback available, development, staging and production kept apart.
- **Isolation per customer.** One customer's code, data and context never reach another's. For outsourced work under non-disclosure agreements this is a requirement, not an option.
- **Data stays in the organisation's cloud environment and Region,** with central audit logs and guardrails.

### 2.7 Code, test and deploy need managed environments

An agent can only test what it can run. Coding assistants on a laptop use the environment the developer already set up; an agent team on the platform has no such laptop. The platform must create, hand out and remove environments for each task, isolated per customer, with cost limits and without production data. See [02-platform-components.md](02-platform-components.md), section 5.

### 2.8 The organisation's process is the advantage

- **Agents must follow the organisation's own process:** its lifecycle standard, document templates, review checklists, quality certifications, and the way it works with each customer. Off-the-shelf tools follow a generic process.
- **A process encoded in agents becomes an asset** that is hard to copy and improves with every project.

### 2.9 Measure and improve

- **Quality per role:** are specifications right, does code pass review, how many defects escape, how long from request to production.
- **Regression checks when a model or a prompt changes.** Models change monthly; the platform must show whether a change made the team better or worse.
- **No lock-in to one provider.** Each role can use the model that suits it, and models can be swapped as the market moves.

### 2.10 Replicate teams

- **A team becomes a template:** a new agent team for a new project in hours, instead of months of hiring and onboarding.
- **The business model can shift** from selling people's hours to selling the capacity of agent teams.

## 3. In one sentence

Personal AI tools make each person faster; the AIPF is where a team of people and agents works, with its organisation, permissions, memory, process, controls and measurement. That cannot be bought ready-made, because its most valuable part is the organisation's own process and data.

For a slide, three words: **control** (security, permissions, cost), **automation** (agents doing the work across the lifecycle, not only answering), and **accumulation** (shared knowledge and assets, measured).
