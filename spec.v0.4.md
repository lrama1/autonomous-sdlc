# Autonomous Role-Mirrored SDLC Platform
**Detailed Product & Technical Specification**

**Version:** 0.4  
**Date:** October 2026  
**Status:** Includes all prior decisions + prescriptive rules

---

## 1. Vision & Goal

Build a platform that runs a full software development lifecycle using specialized AI agents that deliberately mirror real organizational roles. Humans remain in the loop through role-specific, agent-initiated interactions. The entire process is made visible and navigable via a graphical SDLC workflow and a dedicated human workspace.

**Core promise:**
> “A Product Owner states a goal. Specialized agents (Product, Architect, Frontend Engineer, Backend Engineer, QA, DevOps, Security) collaborate and proactively pull in the matching human only when judgment is required. Everyone can always see exactly where the initiative sits in the SDLC and where their current interaction belongs.”

---

## 2. What This Platform Should **Not** Be

This boundary is deliberate and non-negotiable.

**It should NOT be:**
- A better autonomous coding agent (Devin, Cursor background agents, Factory Droids, Claude Code standalone, GitHub Copilot coding agent, etc.).
- A pure “ticket → PR” machine.
- An AI pair-programmer or in-IDE coding assistant.
- A generic multi-agent orchestration framework or agent playground.
- An enterprise control-plane / software-factory governance layer whose primary job is managing other agents.
- A low-code / no-code app builder.
- A replacement for Jira, Linear, or GitHub Projects.
- A system that tries to minimize or eliminate human involvement.

**Positioning rule:**  
If a feature makes the product look or feel like “Devin but with more agents” or “Port but prettier,” it is out of scope.

---

## 3. Unique Differentiator

The differentiator is the combination of three things that current tools do not deliver together:

1. **Role-mirrored agents** that correspond one-to-one with real organizational roles and are expected to initiate contact with the matching human.
2. **Agent-initiated, role-specific human collaboration**.
3. **A living graphical SDLC map** (React + xyflow) that shows both the overall progress of an Initiative and the exact location of any current human–agent interaction, paired with a clean role-aware Workspace.

---

## 4. Core Concepts

- **Initiative** — A significant body of work with its own SDLC pipeline instance.
- **Stage** — Product → Architecture → Implementation → Testing → Security → DevOps/Release → Feedback.
- **Agent** — Specialized AI agent owned by a role.
- **Human Role** — Product Owner, Architect, Frontend Engineer, Backend Engineer, QA, DevOps, Security.
- **Escalation / Task** — Agent-created request directed at a specific human role.
- **Artifact** — Spec, ADR, architecture diagram, code, test results, etc.
- **Workspace** — Role-aware web interface for tasks, live sessions, and approvals.
- **SDLC Map** — Graphical pipeline (xyflow) showing status and current interaction point.

---

## 5. Prescriptive Rules (Non-Negotiable)

These rules are enforced by the orchestrator and agents. They exist to reduce ambiguity, increase consistency, and keep agent output high-quality.

### 5.1 Project Initialization
- When a Product Owner or Technical Leader creates a new Initiative, the system **immediately** requests a GitHub repository URL.
- One primary GitHub repository per Initiative (monorepo style is preferred for MVP).
- The Product Agent will not proceed to detailed specification work until a valid repository is provided and accessible.

### 5.2 Technology Constraints
- **Backend**: Only Node.js (TypeScript strongly preferred) or Python are allowed.
- **Frontend**: React + TypeScript only.
- **Database**: PostgreSQL is the default. Any deviation requires an explicit Architecture Decision Record (ADR).
- **Infrastructure-as-Code**: Terraform (aligned with the platform’s own backend deployment).

### 5.3 Architectural Constraints
- All backend services **must** follow Hexagonal Architecture (Ports & Adapters).
  - Clear separation of Domain, Application, and Infrastructure layers is mandatory.
  - Domain and Application layers must have no direct dependencies on frameworks or external services.
- Significant technical decisions must be captured as Architecture Decision Records (ADRs) **before** implementation begins.
- Standard repository structure is enforced from day one (example):
  ```
  /
  ├── apps/               # Deployable applications
  ├── packages/           # Shared libraries
  ├── docs/               # Specs, architecture overview
  ├── adrs/               # Architecture Decision Records
  ├── infra/              # Terraform
  ├── ARCHITECTURE.md
  └── README.md
  ```
- The Architect Agent creates an initial `ARCHITECTURE.md`, `README.md`, and ADR template as part of the Architecture stage.

### 5.4 Process Constraints
- No implementation code is written until:
  1. The Product Spec has been approved by the Product Owner, **and**
  2. The high-level Architecture has been approved by the human Architect.
- Agents must declare assumptions explicitly and visibly when they proceed without human input.
- Autonomy level is configurable per role or Initiative but defaults to escalating on architectural or cross-cutting decisions.

### 5.5 Quality Constraints
- Backend domain and application layers must include unit tests.
- Frontend components that contain non-trivial logic must include tests.
- A stage cannot be marked “Done” until the basic quality gates for that stage have passed.

### 5.6 Documentation & Traceability
- Every Initiative maintains a living `docs/` and `adrs/` folder.
- The graphical SDLC map always links to the latest versions of key artifacts.

---

## 6. User Roles (MVP)

| Role                  | Core Responsibility                          | Typical Escalations Received          |
|-----------------------|----------------------------------------------|---------------------------------------|
| Product Owner         | Goals, scope, prioritization, acceptance     | Specs, scope questions                |
| Architect             | System design, ADRs, major tech decisions    | Design proposals, risk flags          |
| Frontend Engineer     | UI implementation                            | Complex UI logic, design trade-offs   |
| Backend Engineer      | Services, APIs, data                         | Complex logic, data modeling          |
| QA / Tester           | Quality strategy and triage                  | Persistent failures, test strategy    |
| DevOps                | Pipelines, infrastructure, releases          | Deploy plans, infra decisions         |
| Security              | Risk and compliance                          | High-risk findings, exceptions        |

---

## 7. High-Level Flow

1. Product Owner or Technical Leader creates an Initiative and states a goal.
2. System immediately requests a GitHub repository. Work does not proceed until one is provided.
3. Product Agent produces a structured Spec and escalates to the Product Owner for approval.
4. Architect Agent produces design, ADRs, diagrams, and initial repository scaffolding (including Hexagonal structure) and escalates to the human Architect.
5. Only after Spec + Architecture approval do Frontend and Backend Engineer Agents begin implementation.
6. Tester, Security, and DevOps Agents continue the flow with their own escalations.
7. Humans work from the Workspace and the graphical SDLC map. They always know both the overall stage and the exact point of their current interaction.

---

## 8. Functional Requirements

### 8.1 Human Workspace
- Role-scoped Inbox of open tasks/escalations.
- Ability to join or observe live agent sessions.
- Pending formal approvals/gates.
- List of Initiatives the user participates in.

### 8.2 Graphical SDLC Map (React + xyflow)
- Visual pipeline of stages for each Initiative.
- Status indicators (Not started / In progress / Waiting on human / Blocked / Done).
- Persistent context showing overall stage **and** exact location of the current human–agent interaction.
- Clickable nodes that open artifacts or active sessions.

### 8.3 Agent Behavior
- Agents escalate based on configurable confidence, risk, and policy rules.
- Agents write primary artifacts to the Initiative’s GitHub repository.
- Agents update central workflow state after significant actions.
- Agents respect all prescriptive rules listed in Section 5.

### 8.4 Artifact Management
- **Source of truth for code & text artifacts**: GitHub.
- **Workflow, task, and session state**: Platform database.
- Platform maintains an index/projection for fast UI rendering and linking.

---

## 9. Technical Architecture (MVP)

### 9.1 Repository Structure (Separate Repos)
```
github.com/your-org/
├── sdlc-platform-ui          # React + TypeScript + xyflow
│   └── Deployed to GitHub Pages via GitHub Actions
│
└── sdlc-platform-backend     # Orchestrator, APIs, agent runners
    ├── terraform/            # All AWS infrastructure
    └── src/                  # Application code
```

### 9.2 Frontend
- React + TypeScript + xyflow.
- Static SPA on GitHub Pages (no custom domain required for MVP).
- Client-side auth (Clerk / Auth0 / Cognito).

### 9.3 Backend (AWS + Terraform)
- Orchestrator service.
- API layer.
- Database for workflow/task/session state.
- Containerized runners for headless coding agents.
- GitHub App or fine-grained tokens.
- All infrastructure managed by Terraform.

### 9.4 Coding Engine Integration
- **Primary**: Headless Claude Code running inside AWS containers.
- **Model routing**: OpenRouter (via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`) so the platform is not locked to Anthropic models.
- Optional future support for headless GitHub Copilot as an alternative backend.
- Orchestrator owns role routing, escalation, state, and human interaction; Claude Code owns the coding work.

---

## 10. Agent Roster (MVP)

| Agent                     | Main Outputs                                      | Escalates to            |
|---------------------------|---------------------------------------------------|-------------------------|
| Product Agent             | Spec, user stories, acceptance criteria           | Product Owner           |
| Architect Agent           | ADRs, architecture diagrams, Hexagonal scaffolding, repo structure | Architect     |
| Frontend Engineer Agent   | UI code, components, PRs                          | Frontend Engineer       |
| Backend Engineer Agent    | Hexagonal services, APIs, data models, PRs        | Backend Engineer        |
| Tester Agent              | Test plans, test code, results                    | QA                      |
| DevOps Agent              | CI/CD, Terraform, deploy plans                    | DevOps                  |
| Security Agent            | Threat model notes, scan results                  | Security                |

---

## 11. Non-Functional Requirements (MVP)

- Least-privilege GitHub access.
- Full audit trail of agent actions and human decisions.
- Configurable autonomy thresholds.
- Ability for any human to pause an agent and inject guidance.
- Cost and concurrency controls.
- Secure handling of OpenRouter and GitHub credentials.

---

## 12. Explicitly Out of Scope

- Competing with Devin-style autonomous coding agents on raw coding performance.
- Building a proprietary coding agent loop from scratch.
- Supporting backend languages other than Node.js or Python.
- Deviating from Hexagonal Architecture for backend services.
- Full multi-tenancy and enterprise SSO (post-MVP).
- Custom domain and production-grade frontend hosting (post-MVP).

---

## 13. Success Metrics for MVP

- Product Owner can go from goal → approved Spec after providing a GitHub repository.
- Architect Agent produces Hexagonal-compliant scaffolding + ADRs and correctly escalates.
- Coding agents only begin work after Spec + Architecture approval.
- At least one coding agent opens a meaningful, reviewable PR that respects the prescribed architecture and technology constraints.
- Humans can open the Workspace, see the graphical pipeline, and immediately understand both overall progress and their current interaction point.

---

## 14. Open Decisions

- Precise escalation confidence/risk/policy rules.
- Detailed data model.
- Auth provider final choice.
- Exact container runtime and scaling strategy for headless Claude Code.
- Whether to support headless Copilot in the first release.
```
