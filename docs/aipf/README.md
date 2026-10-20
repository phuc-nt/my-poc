# AIPF: an AI Platform for an Agent-Run Development Team

Notes from internal discussion on the organisation's own AI platform (AIPF): a platform on which agents carry the roles of a whole development team (PM, BA, developer, QA, DevOps) across the software lifecycle, its management and its operations. These are position and requirement documents. Nothing in them has been built yet.

| Document | For |
|---|---|
| [01 Why an internal AIPF](01-why-an-internal-aipf.md): the goal, the reasons to build it rather than rely on personal AI tools | Decision makers |
| [02 Platform components](02-platform-components.md): orchestration, context, tool gateway, environments, governance, model gateway, measurement, channels | Engineers and architects |
| [03 AI-ready repository standard](03-ai-ready-repo.md): levels and a checklist a project must meet before agents work on it | Technical leads |
| [04 Reference platforms](04-reference-platforms.md): how Claude Managed Agents, the cloud providers' agent platforms and coding-agent products are built and work, compared with the components in 02, and lessons for the AIPF | Engineers and architects |
| [05 System design on AWS](05-system-design.md): a first design for an organisation on AWS, CodeCommit, Atlassian, SharePoint and Slack, with replaceable agent CLIs and model providers | Engineers and architects |
| [06 POC architecture](06-poc-architecture.md): a first POC with Claude Code on a Claude subscription, keeping AgentCore Gateway and Policy so the agent CLI stays replaceable | Engineers building the POC |
| [07 Architecture and component names](07-architecture-and-names.md): the whole AIPF redrawn by layer, one name and role per component, compared with the names that cloud, model and development-tool vendors use | Engineers and architects |
| [08 Upgrade plan](08-upgrade-plan.md): the next round of the POC after round 3: the decisions taken, four milestones (correctness and safety, outcomes and flow, the console's views, the agents' instructions and tools), the technical design, the order of work, the rules for implementers and the round 4 checks | Engineers and agents building the POC; the owner choosing the scope |
