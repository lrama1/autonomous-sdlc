# Semi-Autonomous, Human-in-the-Loop SDLC Platform
**Product & Technical Specification**

**Version:** 0.6 (returns to the original idea. Supersedes the regulated 0.5.x direction)  
**Date:** October 2026  
**Status:** Draft for a tool built for the author's own team and projects. Items marked **[H]** are hypotheses to test by using the tool.

> History: v0.4 ([spec.v0.4.md](./spec.v0.4.md)) was the original idea. v0.5.x ([spec.v0.5.3-regulated.md](./spec.v0.5.3-regulated.md)) pivoted to regulated, compliance-grade delivery. v0.6 drops that direction and keeps the useful non-regulated parts. Regulated features are parked in Appendix A, not deleted.  
> Clickable screen designs: [designs/index.html](./designs/index.html). The Trailmates and Kestrel Market examples match this spec. The medical-device and Harbor Retirement examples show the parked compliance pack. Narrated videos: [demo/README.md](./demo/README.md).

---

## 1. Vision & Goal

Build a platform where **AI agents and people build software together**. Agents do most of the drafting, coding, and testing, in roles that mirror a real team. People are pulled in **at the moments where human judgment adds value**, and left alone the rest of the time. Everyone can see where work stands and where they are needed.

**Core promise:**
> "State a goal. Specialized agents (product, architecture, frontend, backend, QA, DevOps, security) do the work and ask the right person, at the right time, in the right way. You are interrupted when your judgment matters, not for everything else."

**Purpose.** A tool for the author's own team and projects. Success is measured by whether the team ships faster, and with fewer and better interruptions, than by using the coding agents directly. It is not designed to be sold, certified, or audited by outsiders.

---

## 2. What This Platform Should **Not** Be

- **Not a better coding agent.** It uses existing engines (Claude Code, Copilot, Codex) for the coding work and does not build its own agent loop.
- **Not a regulated or compliance product.** No regulatory profiles, e-signatures, or audit-grade evidence in the core (parked in Appendix A).
- **Not a pure "ticket to PR" machine** that minimizes human involvement. Human collaboration is the point.
- **Not a generic multi-agent framework or agent playground.**
- **Not a replacement for Jira, Linear, or GitHub Projects**, and not an in-IDE assistant.
- **Not a low-code or no-code app builder.**

**Positioning rule:** if a feature does not make human-and-agent collaboration better, or help people see and steer the work, question whether it belongs.

---

## 3. What It Should Be Best At

Honest framing: semi-autonomous agent platforms are the most crowded part of the market (GitHub Agent HQ, GitLab Duo Agent Platform, Factory, Devin, Kiro, and others), and the basic "approval gate" is now a do-it-yourself pattern (for example, hooks that block an agent until a person approves). So the platform competes on **how well humans are brought into the loop**, not on the fact that they are. Four hypotheses **[H]**:

1. **Human-injection engine.** Well-timed questions, checkpoints, and approvals, with routing to the right person, reminders, batching, safe defaults, standing decisions, and answers from Slack or Teams (§5).
2. **Agent-engine-agnostic.** One workflow, roles, and human-in-the-loop layer over several coding engines, so a team is not locked to one (§11).
3. **Role-mirrored agents across the whole lifecycle**, not just code: product, architecture, implementation, QA, security, DevOps, each with a human counterpart (§8, §13).
4. **Living SDLC map as the control surface.** One picture of the stages, who is blocked on whom, and exactly where a person's interaction belongs (§10.2).

Idea parked for later: **earned autonomy**, where the autonomy dial rises per change type as agents prove themselves. The MVP shows the data to tune this by hand (§5.7, §17).

---

## 4. Core Concepts

- **Initiative**: a significant body of work with its own SDLC pipeline instance and one registered repository.
- **Stage**: Product → Architecture & Design → Implementation → Testing → Security → Release → Feedback.
- **Agent**: a specialized AI worker bound to a role as its preparer. Agents never approve.
- **Role and hat**: a role is a kind of responsibility (§8). A **hat** is a role held by a person. One person can wear several hats, and a hat can have a deputy.
- **Interaction**: anything an agent asks of a person (§5.1): question, checkpoint, review, decision request, or notice.
- **Checkpoint**: a planned decision point where a person approves before work continues (§8).
- **Assumption**: something an agent decided without asking, declared visibly, that a person can accept or reject later.
- **Standing decision**: an answer a person marks as reusable, so agents stop asking the same thing (§5.6).
- **Autonomy mode**: how often agents involve people: Guided, Balanced, or Autopilot (§6.1).
- **Artifact**: spec, ADR, diagram, code, tests, results, release notes.
- **Workspace**: the role-aware web app for inbox, review, and steering.
- **SDLC Map**: the xyflow visualization of stages, status, and the current human interaction point.
- **Standards Pack**: replaceable engineering rules the agents follow (§7).
- **Repository Registry** and **Integration Register**: allowlists of the repositories and external systems agents may touch (§6.5, §6.7).
- **Model Gateway**: the one service that carries every LLM call (§12.3).

---

## 5. How Humans Are Brought In (Human-Injection Engine)

This section is the heart of the product.

### 5.1 Interaction types
| Type | Purpose | Blocks the agent? | Default response |
|---|---|---|---|
| **Question** | The agent is unsure and needs information | Only if the work depends on it | A recommended answer, applied after a timeout if the work can safely continue |
| **Checkpoint** | A planned approval (spec, design, merge, release) | Yes, for the gated step | None. Waits |
| **Review** | Look at an output (PR, test results, preview) | Yes for merge, otherwise no | Waits, with reminders |
| **Decision request** | Choose between options, with the agent's recommendation | Usually no | The recommendation, after a timeout, unless it is a hard stop (§6.3) |
| **Notice** | Informational. Something was done or assumed | No | None |

### 5.2 When to involve a human
Three layers. Agents may escalate **more** than the policy says, never less on layers 1 and 2.
1. **Checkpoints**: set by the workflow and autonomy mode (§6.1, §8). Default: spec and design, change merge, release.
2. **Deterministic triggers**: rules, not model judgment. Examples: authentication or security code, payment paths, database migrations, infrastructure or cost changes, new dependencies, new external hosts, large diffs, deleted or skipped tests, lowered coverage thresholds, repeated failures after N attempts, security scan findings above a threshold, changes to protected paths. Editable by the team (§6.4).
3. **Agent judgment**: ambiguity, conflicting requirements, trade-offs the agent cannot settle, or a gut feeling that something is risky.

### 5.3 Blocking, assumptions, and defaults
- **Do not stop the world.** An agent asks, then continues with other work that does not depend on the answer. Dependencies are tracked, so only the dependent step waits.
- **Declare assumptions** instead of asking, when the cost of being wrong is low. Each is visible on the map and in a daily list, and can be accepted, rejected, or turned into a requirement. Rejecting one re-opens the affected work.
- **Defaults after timeout.** A question or decision request may carry a recommended answer and a deadline. At the deadline the recommendation is applied and flagged. Hard stops never default (§6.3).

### 5.4 Routing, reminders, and availability
- A role maps to a **person** through hats, availability, working hours, and a fallback chain (deputy, then team lead).
- **Reminders and SLAs** escalate along that chain. A reminder never approves on someone's behalf.
- **Out of office** and delegation with dates.

### 5.5 Channels
- **Workspace**: the full context, always available.
- **Slack, Teams, and email**: notifications with a deep link, and **direct answers for simple interactions** (pick an option, approve a low-risk review, snooze). Checkpoints that need real reading (spec, design, release) open the Workspace by default. The team can allow chat approval per interaction type.
- A person can **join or observe a live run**, **pause** it, and **steer** it with guidance. Steering is recorded.

### 5.6 Reducing interruption fatigue
- **Batching and digests**: low-priority items go into a digest at set times. Quiet hours are respected, except for hard stops.
- **De-duplication**: the same question from several agents is asked once.
- **Standing decisions**: a person can mark an answer "use this from now on" (for example, "always use the existing date library"). Agents search standing decisions before asking and cite them.
- **Priority**: asks are ranked by what they block and by deadline, so the inbox shows what to answer first.
- **"Didn't need to ask"**: one click on any interaction. It feeds the tuning data in §5.7.

### 5.7 What a good ask contains
Every interaction carries a **context card**: what the agent was doing, what it needs, why now, the options with a **recommendation**, the impact of each, links to artifacts, what is waiting on this, and the default and deadline. The goal is a one-minute answer.

Measured per Initiative and per agent: time to answer, questions per merged PR, share answered with the recommended option unchanged, share marked "didn't need to ask", and time agents spent blocked. These are shown in the Workspace so the team can tune triggers by hand. (Automatic tuning, "earned autonomy", is post-MVP.)

---

## 6. Autonomy, Trust, and Access

### 6.1 Autonomy modes
Set per Initiative, overridable per change type (§6.2). Default: **Balanced**.

| | Guided | Balanced (default) | Autopilot |
|---|---|---|---|
| Spec and design approval | Human approves each stage (spec, architecture, test plan) | Human approves spec and design together | Human approves, or objects within a review window |
| Pull requests | Human reviews every PR | One human review per PR. Pre-approved change types merge on green CI | Auto-merge on green CI when no trigger fired. Triggered PRs go to a human |
| Questions | Ask when unsure | Ask on triggers and blocking ambiguity. Otherwise assume and declare | Assume and declare. Ask only on triggers and hard stops |
| Release to staging | Human approves | Automatic after CI | Automatic after CI |
| Release to production | Human approves | Human approves | Human approves (hard stop) |

### 6.2 Pre-approved change types ("autopilot rules")
A person with the right hat defines change types that merge without review when CI is green and no trigger fires: for example documentation, UI copy, patch-level dependency updates, feature flags in staging, and test-only changes. Each rule has an owner and a review date. The Workspace shows what auto-merged and what was held, with reasons.

### 6.3 Hard stops (every mode)
Never automatic, never defaulted: production deploys, changes to protected paths, a new external host or credential (§6.7), exceeding a cost budget, destructive data migrations, and anything the agent flags as irreversible.

**Release calendar and change freeze.** A team can mark freeze windows (for example the weeks around a peak sales event). Normal production releases are held inside a freeze. Only security fixes and the **hotfix path** (§8.2) may ship, and a hotfix opens a follow-up review.

### 6.4 Rules and the independent-review rule
- Triggers and pre-approved types are written as simple versioned rules (YAML first, a policy engine later).
- **Independent review rule** (recommended, on by default): the person who started a run does not review its PR. A person who steers a run becomes a contributor and is also excluded.
- **Solo mode**: a single developer can hold every hat. The independent-review rule is off, and **simulated teammates** can stand in for roles to exercise multi-person flows. Simulated teammates are flagged on everything they touch and can never approve a production release.

### 6.5 Repository Registry and agent git access
- **Predetermined repositories only.** Agents read or write only repositories in the registry, maintained by an admin. An Initiative selects a registered repository instead of typing a URL.
- **Registry entry:** `repo`, `access` (`read-write` | `read-only`), `write_mode` (`direct` | `branch_pr`), `integration_branch` (default `main`), `protected_paths`, `model_policy` (`any` | `own-account`, §12.3), optional `allowed_paths`. Default protected paths: `.github/workflows/**`, `CODEOWNERS`, agent configuration (for example `.claude/**`), verification scripts, platform rules.
- **Write modes.** `direct`: agents commit to the integration branch (fine for scratch repositories). `branch_pr`: agents push only to `agent/<run-id>/**` and open PRs. **The Gate App's approving review is what allows a merge** (verified 2026-10-17, `spikes/README.md`, spike 4). GitHub cannot stop an App that holds `contents` and `pull_requests` write from merging, so protection must require the `verify` check, **one approving review**, and **dismissal of stale approvals**. The Gate App approves only after the platform's conditions are met.
- **Direct access from the sandbox.** Each run gets a short-lived GitHub App installation token (1 hour at most) scoped to one repository and the minimum permissions. The **runner** clones and pushes with it. The engine commits locally and never holds the token (built and verified 2026-10-17).
- **Integration branch.** PRs target only the registry entry's `integration_branch`. Baselines are plain tags (`spec-approved-N`, `release-X.Y.Z`) on that branch. Release branches are post-MVP.
- **Protected paths** are checked by the runner before every push, and by branch protection where the repository's GitHub plan supports it.

### 6.6 GitHub connection
- **Registering the Apps (admin, once).** Use GitHub's **App manifest flow**: the admin is redirected to GitHub once to approve, and GitHub returns the App ID, private key, and webhook secret to the platform, which stores them in the secrets manager. The Apps are installed with **Only select repositories** set to the registry. The platform compares installations with the registry on GitHub's installation events and blocks runs on any mismatch.
- **Two Apps** (decided 2026-10-16). An **Agent App** (contents and pull-request write) and a **Gate App** (checks, merge, branch protection). The Gate App's private key lives only in the Git Integration service, never in a sandbox.
- **Sign-in is OIDC SSO. GitHub is linked, not used to log in** (decided 2026-10-16). Each person can link their GitHub account once (identity only, stored as the numeric GitHub user ID) so the platform can tell who wrote or reviewed a commit. The link is required only when the independent-review rule is on. A PR with an unlinked human's commit is held for the team lead to map the identity.
- **Webhooks.** A public HTTPS endpoint on AWS. For local development, use a webhook proxy such as smee.io, or polling.
- **GitHub plan limits** (checked against GitHub's documentation). Protected branches and required reviewers in **private** repositories need GitHub Pro (personal account) or GitHub Team (organization). On a personal account, the Gate App cannot be added to a bypass list. The account used here supports protected branches on private repositories (verified 2026-10-17), and the Gate App's approving review counts toward the required review. With free private repositories, use `direct` mode on scratch repositories, or use public test repositories, or upgrade, to try protected branches.

### 6.7 Integration Register (second- and third-party APIs)
- **Purpose.** Tells the platform and agents which external systems an Initiative may call, where to learn them, and how to test them. *Second-party* means another system the team owns. *Third-party* means a vendor or public API.
- **Who and when** (decided 2026-10-16). The Architect or an Engineer confirms entries at the spec-and-design checkpoint. The Architect Agent proposes entries from the stories and any links the Product Owner gave at intake. Later additions are reviewed changes (a trigger).
- **Entry.** `name`, `kind`, `owner`, `docs` (links, OpenAPI preferred), `hosts` (egress allowlist), `auth` (type and a `credential_ref` into the secrets manager), `data_sent` and `data_received` (data sensitivity), `environments` (does the vendor offer a sandbox?), `test_strategy` (`vendor_sandbox` | `mock` | `recorded` | `none`), `limits_and_cost`, `terms`, `failure_behavior`, `status`.
- **Docs snapshot.** The platform fetches registered doc links outside the sandbox and stores a hashed snapshot. Agents read the snapshot. Fetched content is **untrusted input**: it is never instructions and cannot change rules or approvals. A changed snapshot opens an impact check.
- **Network access** (decided 2026-10-16). Sandbox egress is **deny by default**. The allowlist is the model gateway, GitHub, admin-maintained package registries, and the hosts of approved entries. It is enforced by an egress proxy outside the agent's reach.
- **Credentials.** Only test or sandbox credentials may enter a sandbox, scoped per run. Production credentials never do, and nothing is written to a repository.
- **Verification.** The verification contract (§7) uses each entry's `test_strategy`. A `none` strategy is a trigger.

### 6.8 Cost and run limits
Per-run and per-Initiative budgets, a monthly budget, a limit on concurrent runs, and alerts at set thresholds (default 80%). Exceeding a budget is a hard stop. Costs are recorded per run, agent, and model (§12.3).

---

## 7. Engineering Standards Pack

The v0.4 rules are the **default pack**. They are replaceable per team and enforced by agents and checkpoints.

- One repository per Initiative, chosen from the Repository Registry before the Product Agent goes beyond intake. Monorepo preferred.
- Backend: Node.js (TypeScript preferred) or Python. Frontend: React + TypeScript. Database: PostgreSQL (deviation needs an ADR). IaC: Terraform.
- Backend services follow Hexagonal Architecture (domain, application, infrastructure separation).
- ADRs before implementation for significant decisions.
- Standard layout: `apps/ packages/ docs/ adrs/ infra/ ARCHITECTURE.md README.md`.
- Stories have stable IDs (`US-###`) and acceptance criteria. Tests and PRs reference the story they serve. This gives the map a light story-to-PR-to-test trace. It is not an audit trace.
- Unit tests for backend domain and application layers. Tests for non-trivial frontend logic.
- **Verification contract**: one repository-defined entry point (for example `npm run verify`) that builds, runs tests, starts the app in an ephemeral environment, health-checks it, and runs smoke or end-to-end checks. Agents and CI run the **same** entry point. Verification scripts and CI configuration are protected paths. Deleting or skipping tests, or lowering thresholds, is a trigger.
- Agents declare assumptions (§5.3).

---

## 8. Roles and Checkpoints

### 8.1 Roles
| Role | Responsibility | Typical asks |
|---|---|---|
| Product Owner | Goals, scope, priorities, acceptance | Specs, scope questions, acceptance |
| Architect | System design, ADRs, major technical decisions | Design proposals, risk flags |
| Frontend Engineer | UI implementation and review | UI logic, design trade-offs, PR review |
| Backend Engineer | Services, APIs, data, and review | Complex logic, data modeling, PR review |
| QA / Tester | Quality strategy and triage | Persistent failures, test strategy |
| DevOps / Release | Pipelines, infrastructure, releases | Deploy plans, infrastructure and cost decisions |
| Security | Risk review | High-risk findings, exceptions |
| Platform Admin | Registry, Apps, budgets, rules | Configuration only. No approvals |

A person can wear several hats. The **release approver** is a hat held by the Product Owner or DevOps (configurable).

### 8.2 Checkpoints
The IDs `G0`–`G7` are kept from earlier drafts and the demos. They name checkpoint types and are not regulatory gates. By default only G1, G3, and G6 are active.

| ID | Checkpoint | Prepared by | Decided by | Default |
|---|---|---|---|---|
| G0 | Intake | Product Agent | Product Owner | Skipped (a form) |
| G1 | Spec and design | Product + Architect Agents | Product Owner (spec), Architect (design) | **Active** |
| G2 | Architecture baseline | Architect Agent | Architect | Merged into G1 |
| G3 | Change merge (per PR) | Engineer Agents | One peer engineer, or automatic for pre-approved types | **Active** |
| G4 | Verification | Tester Agent | QA | Optional per Initiative |
| G5 | Security review | Security Agent | Security | On triggers only |
| G6 | Release | DevOps Agent | Release approver | **Active** |
| G7 | Retrospective | Product Agent | Product Owner | Optional |

A **scope change** after G1 re-opens G1 for the affected stories only. A **hotfix** path lets a person ship an urgent fix with a single approval, followed by a review task within a set time.

---

## 9. High-Level Flow

```mermaid
flowchart LR
  A[Goal + repository] --> B[Product Agent: spec]
  B --> C[Architect Agent: design + ADRs]
  C --> G1{{G1 Spec and design}}
  G1 --> D[Engineer Agents build and verify]
  D --> G3{{G3 Change merge}}
  G3 --> E[Tester and Security Agents]
  E --> G6{{G6 Release}}
  G6 --> F[Feedback and bugs]
  F -. scope change .-> G1
```

1. A person creates an Initiative with a goal and selects a registered repository. Autonomy mode defaults to Balanced.
2. The Product Agent drafts stories. The Architect Agent drafts the design and ADRs. People answer questions as they arise, and approve at G1.
3. Engineer Agents implement in parallel sandboxes, **run the app and the verification contract**, and only then open PRs. CI re-runs verification independently.
4. G3: a peer reviews each PR, or it merges automatically if it is a pre-approved type. Triggered PRs always go to a human.
5. Tester and Security Agents add test and security results. QA or Security are asked only when optional checkpoints or triggers call for it.
6. The DevOps Agent prepares the release. A person approves production. The pipeline, not an agent, deploys.
7. Feedback and bug reports become new work. A rule can start a Bug Agent run automatically.

---

## 10. Functional Requirements

### 10.1 Workspace
- **Attention queue**: all asks for this person, ranked by what they block and by deadline, with the context card inline.
- **Review pack** per checkpoint: diff-focused view, story links, declared assumptions, test results, preview environment link, the trigger reasons, and the independent-review check.
- Join or observe a live run, pause it, steer it (§5.5).
- Hats, deputies, working hours, quiet hours, and out-of-office.
- Standing decisions and the assumptions list.
- Autonomy mode and rules editor, pre-approved change types, budgets, and interruption metrics (§5.7).
- Admin settings: Repository Registry, GitHub connection, Integration Register, Model Gateway status.

### 10.2 SDLC Map (React + xyflow)
- Pipeline per Initiative with status: Not started / In progress / Waiting on human / Blocked / Done.
- Shows who each waiting item is waiting on, and the exact point of **your** interaction.
- Clickable nodes open artifacts, PRs, previews, or live sessions.
- Portfolio view across Initiatives, with the release calendar.

### 10.3 Agent Behavior
- Agents work in the Initiative's registered repository and update platform state after significant actions.
- **Verify before proposing.** Before a PR, an Engineer Agent runs the verification contract in its sandbox, including starting the app. A PR opens only on a pass. After repeated failure the agent escalates to its sponsor with the report instead of opening a failing PR.
- **Verification report.** Commands, results, and commit SHA are attached to the PR. This is the agent's own report and is advisory. CI re-runs the contract on the PR head and that result is what gates the merge.
- **Verification environment.** In the sandbox, dependent services (for example PostgreSQL) run as sidecars. CI runs the same contract in a fuller ephemeral environment. Agents run targeted browser tests. CI runs the full suite. How a repository declares its sidecars is open (§19).- Agents attach story links to every change, declare assumptions, and never claim verification they did not perform.
- **Preview environments** per PR where the stack allows. How they are provisioned is open (§19).

### 10.4 Artifacts
Git is the source of truth for code and text artifacts. The platform database holds workflow, interactions, and run state, and indexes artifacts for linking.

### 10.5 Notifications and Integrations
Slack, Teams, and email with deep links and in-chat answers (§5.5). GitHub through the Apps. Later: GitLab, Jira link-out.

### 10.6 Activity log
An append-only log of agent actions, interactions, answers, and approvals, with who and when. It is for the team's own debugging and accountability, not external audit.

---

## 11. Agent Engines (Engine-Agnostic Design)

The platform owns the workflow, roles, interactions, routing, gates, and visibility. **Engines** do the coding work.

### 11.1 AgentEngine port
`start(run spec) → event stream`, `send(guidance)`, `pause`, `resume`, `stop`, and `collect(artifacts)`. A run spec contains the role, task, repository token, sandbox limits, model alias, and the platform tools. Events share one schema: messages, tool calls, file changes, interactions raised, cost.

### 11.2 Platform tools exposed to every engine (MCP)
The platform runs an MCP server that each run connects to, so any engine that supports MCP can collaborate the same way:
- `ask_human` (question or decision request, with options, recommendation, default, deadline)
- `request_checkpoint`, `declare_assumption`, `search_standing_decisions`
- `report_progress`, `register_artifact`, `get_integration_docs`
- `check_answers` (state of the interactions this run opened)

**Verified in spike 2** (`spikes/README.md`) with headless Claude Code:
- `ask_human` with `blocking=true` holds the tool call open until a person answers (tested to 142 s), or until its default applies, which is reported as `source: "default"`.
- With `blocking=false` the agent keeps working and collects the answer with `check_answers`.
- For long waits the run **parks**: the process ends and the platform **resumes** the same session with the answer (`--resume`). The session store must be saved and restored, with the same working directory path. This also avoids paying for an idle sandbox.
- Steering: a message sent over stream-json stdin is acted on at the next step. It is not preemptive. A hard stop is kill and resume.

### 11.3 Adapters
- **Claude Code** (headless): primary. Connects to the Model Gateway through its Anthropic-compatible settings. Its hooks can add in-engine guards (for example, block edits to protected paths), but the platform does not rely on them.
- **GitHub Copilot CLI**: **spiked 2026-10-18 and feasible** (`spikes/README.md`, spike 5). With its bring-your-own-key mode it uses the Model Gateway as its model provider, needs no GitHub sign-in or Copilot subscription, loads the platform MCP tools over HTTP, resumes by session id, and is metered and budgeted like Claude Code. Built and proven in the sandbox image (mvp-contract section 16, step 4). **OpenAI Codex**: planned, not spiked. An engine that cannot be pointed at the Model Gateway (for example, Copilot with its hosted models) runs outside the platform's cost controls, and the run record says so.
- **Gates are enforced outside the engine**: at the git boundary (protected paths, `branch_pr`, required CI), at merge (Gate identity), and at deploy (pipeline). That is what keeps behavior the same across engines.

---

## 12. Technical Architecture

### 12.1 Deployment
- **Single-tenant, deployable into your own AWS account** with Terraform. The same containers also run locally (§12.4).
- SPA served by the platform behind OIDC sign-in. No GitHub Pages hosting.

### 12.2 Components
- **Orchestrator**: workflow state, role routing, dependency tracking, timers.
- **Interaction Service**: creates and routes interactions, reminders, digests, defaults, standing decisions.
- **Rules**: triggers and pre-approved change types as versioned YAML.
- **Agent Runner**: ephemeral sandboxed containers that host an engine through its adapter.
- **Platform MCP server** (§11.2).
- **Model Gateway** (§12.3).
- **Git Integration**: Agent App and Gate App (§6.6).
- **Repository Registry**, **Integration Register**, **Docs fetcher**.
- **Identity**: OIDC (Dex locally, Amazon Cognito on AWS), hats, GitHub link.
- **Notification Service**: Slack, Teams, email, with reply handling.
- **Workspace and Map UI**: React, TypeScript, xyflow.
- **Data**: PostgreSQL for workflow, interactions, and the activity log. Object storage for run logs and artifacts.

### 12.3 Model Gateway
**One gateway for all LLM traffic** (decided 2026-10-16). Nothing in the platform calls a provider directly.
- **Callers.** Agent runs (through the engine) and **platform LLM services** (context-card drafting, summaries, spec drafts, bug triage, doc-snapshot summaries, impact checks). Their output is advisory.
- **Design.** A thin service. A sandbox gets a **per-run gateway token** and the gateway URL, never a provider key. The gateway checks the token, enforces the run's budget and model allowlist, maps **model aliases** to provider models, forwards the request with the real key from the secrets manager, and records tokens and cost.
- **Aliases.** Agent definitions use aliases (`agent-strong`, `agent-default`, `agent-fast`, `svc-default`). Each deployment maps them to models, so changing provider is a configuration change.
- **No silent fallback across providers.** If the provider is down, the run pauses and can resume.
- **OpenRouter is the default** in development (local, hybrid, and AWS-sandbox). Use two API keys with credit limits (agent runs, platform services). Claude Code uses OpenRouter's Anthropic-compatible endpoint with `ANTHROPIC_AUTH_TOKEN` set and `ANTHROPIC_API_KEY` blank, and Anthropic first-party as the top provider, because OpenRouter documents Claude Code as guaranteed only with it. Platform LLM services may use any OpenRouter model per alias, through its OpenAI-compatible endpoint. Environment variables for Claude Code must be real process environment or its settings file, because it does not read a project `.env`.
- **Bedrock and Vertex** are optional adapters for repositories with `model_policy: own-account`, which never use a third-party gateway such as OpenRouter.
- **Verified in spike 1** (`spikes/README.md`): streaming and tool use pass through a thin gateway unchanged. Aliases work with Claude Code. Per-request provider preferences are accepted and honored on the Anthropic-compatible endpoint. **Without preferences, OpenRouter routed to Bedrock**, so the gateway always injects `provider.order=["anthropic"]`, `allow_fallbacks=false`, and `data_collection="deny"` for agent runs. Token counts come from the stream. Cost does not, so the gateway keeps a price table.
- **Gateway details learned:** drop hop-by-hop headers (`expect`, `keep-alive`, `transfer-encoding`), answer `HEAD /`, and expect a baseline of about 30k to 40k input tokens per run for Claude Code's own prompt and tools.

### 12.4 Environments: local and AWS
One codebase and one set of container images. Infrastructure dependencies sit behind ports with two adapter sets, chosen by configuration.

| Port | Local (Docker Compose) | AWS |
|---|---|---|
| Services | Containers | ECS Fargate behind an Application Load Balancer |
| Database | PostgreSQL | Amazon RDS for PostgreSQL |
| Object storage | MinIO (S3 API) | Amazon S3 |
| Identity | Dex with static personas | Amazon Cognito |
| Secrets | Git-ignored local file | AWS Secrets Manager |
| Agent runner | Docker container per run, with sidecars and an egress proxy | ECS Fargate task per run in an isolated subnet, with sidecar containers and **no task role**. Egress goes only to a shared allowlist proxy (§12.4) |
| Model Gateway | Container. OpenRouter by default, Bedrock through the AWS profile as an opt-in | Fargate service. OpenRouter by default in dev, Bedrock through the task role where needed |
| Notifications | Log sink and mail catcher | SES, Slack, Teams |
| GitHub webhooks | Webhook proxy or polling | Public HTTPS endpoint |

- **Modes:** `local`, `hybrid` (local app with real Bedrock through your AWS profile), `aws-sandbox` (Terraform stack in your AWS account).
- **Parity.** Each port has contract tests that run against both adapter sets.
- **Fargate constraints** (checked against AWS documentation). No privileged containers and no Docker-in-Docker. A task can hold sidecar containers that share localhost, so the runner uses sidecars and never needs a Docker socket.
- **Runner network (verified in spike 3, `spikes/README.md`).** A proxy sidecar inside the runner task is advisory only: the agent shares the task's network, can ignore the proxy settings, and Fargate does not allow `NET_ADMIN`. Enforced egress uses: an **isolated subnet with no internet route**; a runner security group that allows only a **shared allowlist proxy**, the VPC endpoints for image pulls and logs, and S3; an **S3 endpoint policy** limited to the ECR layer bucket; and a **Route 53 Resolver DNS Firewall** allowlist, because the default VPC resolver is an exfiltration channel. Runners need no NAT gateway. The runner task has **no task role**, so the container holds no AWS credentials.- **One AWS account.** Use a single-AZ development stack, an account budget alert, and destroy or stop it when idle. The always-on parts (NAT gateway, load balancer, database) dominate idle cost.
- **Windows** development uses Docker Desktop with WSL 2 (enabled 2026-10-17: virtualization in the firmware, then WSL 2).
- **Local sandbox** (built and verified 2026-10-17, `mvp-contract.md` section 11). Each run is an unprivileged, read-only container on its own internal network, and the only way out is a small egress proxy that forwards two fixed ports to the platform and tunnels HTTPS to an allowlist. This closes the gap the process adapter left.

---

## 13. Agent Roster

| Agent | Main outputs | Asks | MVP |
|---|---|---|---|
| Product Agent | Stories, acceptance criteria, scope-change impact | Product Owner | Yes |
| Architect Agent | ADRs, diagrams, scaffolding, integration entries | Architect | Yes |
| Frontend / Backend Engineer Agents | Code, tests, PRs | Peer engineer | Yes |
| Tester Agent | Test plans, test code, results | QA | Yes |
| DevOps Agent | CI/CD, Terraform, release notes, canary plan | Release approver | Thin |
| Security Agent | Threat notes, scan results | Security | Thin |
| Bug Agent | Reproduces a reported bug, finds the cause, proposes a fix | Engineer | Later |

Agents never approve. Each agent definition (prompt, tools, model alias) is versioned in the repository.

---

## 14. Data Model (Sketch)

`Initiative`, `Story`, `Checkpoint`, `Interaction(type, state, due, default)`, `Assumption`, `StandingDecision`, `Person`, `Hat(role, deputy, hours)`, `AgentDefinition(version)`, `AgentRun(sponsor, contributors, engine, alias, cost)`, `Artifact(git_ref)`, `RepositoryEntry`, `IntegrationEntry`, `DocSnapshot(url, sha256)`, `GitHubLink`, `PreApprovedChangeType`, `Trigger`, `Release`, `CostRecord`, `ActivityEvent`, `SimulatedTeammate`.

---

## 15. Non-Functional Requirements (MVP)

- Least-privilege GitHub access, per-run tokens, protected paths.
- Secrets in a secrets manager, never in repositories, never in sandboxes (except per-run tokens).
- Full activity log of agent actions and human decisions.
- Any human can pause an agent and inject guidance.
- Cost and concurrency controls.
- Everything runs locally, and deploys to AWS from the same images.

---

## 16. Explicitly Out of Scope (MVP)

- Competing with other coding agents on raw coding performance, or building an agent loop from scratch.
- Regulated or audit-grade features: e-signatures, WORM or KMS evidence ledgers, compliance profiles (Appendix A).
- Backend languages other than Node.js and Python, and deviation from Hexagonal Architecture without an ADR.
- Multi-tenancy, enterprise SSO federation, SCIM.
- Release branches. GitLab, Jira sync, and an eQMS or ALM.
- Automatic autonomy tuning ("earned autonomy").

---

## 17. Build Plan and Success Measures

**Spikes done (2026-10-17):** Claude Code through a gateway to OpenRouter, `ask_human` over MCP, and a Fargate runner with a sidecar and enforced egress. All passed. Results are in `spikes/README.md`. Still unspiked: Copilot and Codex adapters.

**Interfaces to code against** (stack, repository layout, data model, state machines, run spec, event schema, MCP tool schemas, gateway and runner contracts, API, and per-step acceptance tests) are in [mvp-contract.md](./mvp-contract.md).
**Build order (cheapest feedback first):**
0. **Walking skeleton on both targets (first week or two).** The empty web, API, and database stack runs under Docker Compose and deploys to your AWS account with Terraform, behind OIDC sign-in.
1. **One engine, one loop.** Model Gateway with OpenRouter, Claude Code adapter, platform MCP server with `ask_human`, GitHub App, Repository Registry, one Initiative from goal to merged PR with verify-before-PR.
2. **Human-injection engine.** Interaction types, routing and hats, reminders, defaults after timeout, assumptions, standing decisions, Slack answers, attention queue, interruption metrics.
3. **SDLC map and checkpoints.** G1, G3, G6, pre-approved change types, Integration Register, previews.
4. **Second engine.** Copilot or Codex adapter, to prove the port.
5. **Portfolio, Bug Agent, cost views, autonomy modes polish.**

**Success measures (own use):**
- Time from goal to first reviewable PR, compared with using the engine directly.
- Questions per merged PR, share answered with the recommendation unchanged, share marked "didn't need to ask", and median time to answer. Targets to set after the first month.
- PR rework rate and cost per merged PR.
- A new teammate can open the map and see where they are needed in under 10 seconds.
- A second engine runs a full Initiative without workflow changes.

**Re-evaluate if:** after a few real Initiatives the team prefers using the engines directly, or interruptions per merged PR do not fall as standing decisions and rules accumulate.

---

## 18. Risks

| Risk | Mitigation |
|---|---|
| Interruption fatigue: the product becomes a notification firehose | Non-blocking asks, batching, standing decisions, defaults, "didn't need to ask" feedback, metrics (§5) |
| Too few interruptions: agents guess wrong | Triggers on risky areas, declared assumptions with a visible list, hard stops |
| Crowded market: GitHub, GitLab, and engine vendors add the same features | Built for own use. Compete on human-injection quality and engine neutrality. Re-evaluate rule above |
| Engine differences (tools, MCP support, headless modes, hosted models) | AgentEngine port, gates enforced outside the engine, adapter contract tests, spike per engine |
| Agents with repository write access (prompt injection, hostile content) | Registry allowlist, per-run single-repo tokens, protected paths, `branch_pr`, separate Gate identity, egress deny by default, docs treated as untrusted |
| Cost runaway | Per-run and monthly budgets, hard stop on overrun, gateway metering |
| OpenRouter is a third-party data hop and a leaked key drains credit | Per-run gateway tokens (sandboxes never hold the key), two keys with credit limits, `model_policy: own-account` for sensitive repositories |
| Developing on OpenRouter hides Bedrock differences | Gateway contract tests on both providers, aliases, hybrid mode |
| Scope creep back to compliance features | The positioning rule (§2). Parked in Appendix A |
| Solo-developer build size | Walking skeleton first, one engine first, defer second engine and portfolio features |

---

## 19. Open Decisions

- **Engines:** can Copilot and Codex run headless with MCP and a configurable model endpoint? Which to add second? Is a Copilot adapter possible without the Model Gateway?
- **Gateway price table and key limits:** the gateway meters tokens, but OpenRouter's stream carries no cost, so it needs a price table per model. The OpenRouter keys are now limited (two keys in the `autonomous-sdlc` workspace, $85 per day each, verified 2026-10-17).
- **Long waits in runs:** blocking `ask_human` was proven to 2.5 minutes. Decide the cut-off after which a run parks and resumes with the answer, and where the Claude Code session store is kept between runs (spike 2).
- **DNS and proxy logging:** the allowlist DNS firewall is in the spike design. Confirm the proxy's own allow and deny logging and how its allowlist is generated from the Integration Register.
- **Workflow engine:** a small state machine on PostgreSQL vs Temporal or AWS Step Functions.
- **Rules format:** plain YAML first. When does a policy engine become worth it?
- **Chat answers:** which interaction types may be approved from Slack or Teams, and how are replies authenticated?
- **Default-after-timeout:** per-team defaults for deadlines and quiet hours.
- **GitHub plan:** test repositories are private repositories on a personal account (decided 2026-10-16). Trying protected branches needs GitHub Pro, a free organization with public test repositories, or a paid organization.
- **Sidecar manifest:** how a repository declares the services its `verify` contract needs (PostgreSQL, MinIO or LocalStack, mocks), so the Fargate runner and the local Docker runner start the same set. Fargate has no Docker-in-Docker, so a Compose file cannot run as-is.
  - *Leading option:* a small repo-level file (for example `.sdlc/services.yaml`) listing, per service, the image, environment, ports, health check, and an optional seed step. The Fargate runner turns each entry into a sidecar container. The local runner turns the same entries into Compose services. Repositories that already use Compose can generate the file from it.
  - *Open points:* whether to accept a Compose subset directly, how images are pinned and allowed (registry allowlist, §6.7), and per-service CPU and memory limits against the per-run cap.
  - *Protection:* the manifest is a protected path like the verification scripts (§7), so an agent cannot weaken its own test environment without a trigger.
  - *Decide:* during the runner spike, using one real repository with a database and one with an object store.
- **Preview environments** *(partly decided 2026-10-18: the review pack shows the preview the repository's pipeline reports; a platform-run preview runs in Docker on the local machine, 2026-10-18; on Fargate it is later)*: how a per-PR preview environment is provisioned, and for which stacks. Agents have no AWS credentials (§12.4), so the repository's pipeline provisions it, not the agent.
  - *Option A:* an ephemeral Terraform stack per PR, created by the CI workflow on PR open and destroyed on merge or close. Most faithful, slowest, highest cost.
  - *Option B:* a shared preview cluster or namespace with one service and one schema per PR. Faster and cheaper, with weaker isolation.
  - *Option C:* no preview in the MVP. The review pack links the CI test run and recorded browser results instead.
  - *Open points:* who owns the pipeline role that may create resources, a TTL sweeper for orphaned stacks, a per-repository cost cap, and how the link reaches the review pack (§10.1).
  - *Leaning:* start with Option C, add Option B for web stacks, and keep Option A for repositories that need real infrastructure.
- **Cognito vs IAM Identity Center** as the AWS identity default.
- **Registry:** one active Initiative per repository vs several in a monorepo. Whether `direct` mode may target non-integration branches.
- **Earned autonomy:** when to try automatic tuning, and on what signals.

### Decided
| Date | Decision |
|---|---|
| 2026-10-15 | **Verification environment:** agents run dependent services as ephemeral sidecars. CI runs the same contract in a fuller environment and is authoritative (§10.3). |
| 2026-10-15 | **Frontend browser tests:** agents run targeted tests. CI runs the full suite (§10.3). |
| 2026-10-15 | **Release model (MVP):** release candidates are tags on the integration branch. Release branches are post-MVP (§6.5). |
| 2026-10-15 | **Integration branch:** configurable per registered repository, default `main` (§6.5). |
| 2026-10-16 | **Sign-in and GitHub link:** OIDC SSO only. People do not sign in with GitHub. They link their account for identity (§6.6). |
| 2026-10-16 | **GitHub Apps:** two Apps, Agent and Gate, registered by manifest flow and installed on registry repositories only (§6.6). |
| 2026-10-16 | **Test repositories:** private repositories on a personal GitHub account (§6.6, §19). |
| 2026-10-16 | **Integration Register:** Architect or Engineer confirms entries at the spec-and-design checkpoint, with the Architect Agent proposing. Later additions are reviewed (§6.7). |
| 2026-10-16 | **Sandbox network access:** deny by default, allowlist from the gateway, GitHub, registries, and approved hosts (§6.7). |
| 2026-10-16 | **AWS shape:** ECS Fargate, RDS PostgreSQL, S3, Cognito, Terraform, one AWS account (§12.4). |
| 2026-10-16 | **Local development:** Docker Compose with fakes, plus an opt-in hybrid mode with Bedrock through an AWS profile (§12.4). |
| 2026-10-16 | **OpenRouter is the default model provider in development** for all agents and all platform LLM processes, through one Model Gateway. Sandboxes get per-run tokens, never provider keys (§12.3). |
| 2026-10-16 | **Direction:** return to the original idea, a semi-autonomous, human-in-the-loop SDLC platform. Regulated features are parked (Appendix A). Purpose: a tool for the author's own team and projects. |
| 2026-10-16 | **Differentiators to pursue:** human-injection engine, engine-agnostic design, role-mirrored agents across the lifecycle, and the visual SDLC map. Earned autonomy is post-MVP (§3). |
| 2026-10-17 | **Gateway spike results:** streaming, tool use, aliases, per-request provider preferences, and first-party Anthropic with `data_collection: "deny"` all work. The gateway always sets provider preferences. Budgets are metered in the gateway, with no per-run OpenRouter keys at first (§12.3, `spikes/`). |
| 2026-10-17 | **Human-injection over MCP works headless:** blocking, default-after-timeout, non-blocking, park and resume, and mid-run guidance were all demonstrated (§11.2, `spikes/`). |
| 2026-10-17 | **Egress enforcement on Fargate:** isolated subnet, shared allowlist proxy, security groups, S3 endpoint policy, and DNS Firewall. No proxy sidecar as the control. Runner has no task role (§12.4, `spikes/`). |
| 2026-10-17 | **The Gate is an approving review by the Gate App.** An agent can merge its own PR when only a status check protects the branch, so protection also requires one approving review and dismisses stale approvals. Agents cannot approve their own PRs. Agents cannot change workflows or push to the protected branch (§6.5, `spikes/`). |
| 2026-10-17 | **GitHub Apps registered** through the manifest flow on `lrama1` and installed on `lrama1/sdlc-scratch` only. A local platform declares no webhook, because GitHub rejects a localhost hook URL even when inactive. The platform polls (§6.6). |
| 2026-10-17 | **Step 1 passed live** (real engine, gateway, OpenRouter, GitHub Apps): goal, question answered by a person, verification, push, pull request, independent human review, Gate approval and merge, activity log, cost records. See mvp-contract.md section 16. |
| 2026-10-17 | **A run lost while a person is being asked parks on that question** and resumes with its session when answered. It is not failed (pps/api/src/run-worker.ts). |
| 2026-10-17 | **The Gate merges only after a person approves and the required check is green**, on the commit that was reviewed. Automatic merge of pre-approved types is not built yet. |
| 2026-10-17 | **Runs execute in an isolated Docker sandbox** (`RUNNER_ADAPTER=docker`). One container, internal network, and volume per run. Egress only through a shared proxy to two fixed platform ports and an HTTPS allowlist. The sandbox is given the proxy's address, not its name (`mvp-contract.md` section 11). The full Step 1 acceptance passes inside it. |
| 2026-10-17 | **Step 2 built (human-injection engine).** Asks are handed to the holder of the role and escalate holder, deputy, then admins, skipping people who are away and anyone who may not review the run. A reminder never approves. Defaults apply after the deadline and are flagged. A standing decision answers a repeated question before anyone is asked or notified. Quiet hours and a daily digest hold low-priority messages, never hard stops. Chat answers need a signed request, a Slack user an admin linked to a person, an open ask, and a type the team allows in chat (questions and decisions by default; checkpoints and hard stops never). Attention queue, assumptions, standing decisions, and interruption measures are in the Workspace. Proven live with a real agent for routing and standing decisions. **Slack itself is proven only against a fake Slack.** See `mvp-contract.md` section 16. |
| 2026-10-18 | **Step 0 is complete on both targets.** Compose, and a Terraform stack in the AWS account (CloudFront for HTTPS, an ALB that accepts only CloudFront, Fargate, RDS, Cognito, Secrets Manager), were each brought up and checked, and the AWS stack was destroyed cleanly. Idle cost is about $70 a month by estimate. A fresh deployment has no admins, so the person at `BOOTSTRAP_ADMIN_EMAIL` becomes admin on first sign-in, and admins give out the other hats through the API. See `mvp-contract.md` section 16. |
| 2026-10-18 | **Step 3 built in part** (autonomy modes and automatic approval of pre-approved change types, the Integration Register with an egress allowlist and a hard stop for new systems, the G1 spec checkpoint with a Product agent, the SDLC map, and G6 releases published by the Gate App). A spec is always decided by a person, even in autopilot. A release is a hard stop and is never automatic. Previews, the Architect agent, and a second engine are not built. See `mvp-contract.md` section 16. |
| 2026-10-18 | **Architect agent and the design checkpoint built.** An Architect run writes `docs/design/<slug>.md` for an approved spec, ending in a machine-readable task list (a fenced `sdlc-tasks` YAML block). The pull request is always G1 for the Architect, even in autopilot. The runner checks the list before it opens the pull request and sends a list that does not read back to the agent. Engineer runs are not yet started from the list. See `mvp-contract.md` section 16. |
| 2026-10-18 | **Bug Agent added, fed by a form.** A bug report starts a fix run by the same rule as the other steps (automatic in balanced and autopilot, a click in guided or when the initiative's steps are off). The agent must reproduce the bug with a failing test before it fixes anything, and must stop and ask rather than guess when it cannot. The fix is an ordinary pull request that an engineer reviews. GitHub issues as a source are not built. |
| 2026-10-18 | **The spec and design steps start by themselves too.** Creating an initiative starts the spec from its goal, merging the approved spec starts the design, and merging the approved design starts the build. Guided mode waits for a click at each step; balanced and autopilot do not. Every step still ends at a checkpoint decided by a person, and the release is never automatic. Each run is sponsored by the person who started or approved the step before it, so nobody decides their own step's output. See `mvp-contract.md` section 16. |
| 2026-10-18 | **Cost views added, with a monthly budget that warns.** A Costs page shows spend by day, initiative, agent role and model. One platform-wide monthly budget is measured on it; at 80% it warns (a banner for admins and an activity event), and it never stops work. | Spend was only visible per initiative. A hard stop at the platform level could halt every team at once, so it warns first. | Slack delivery of the alert; per-team budgets |
| 2026-10-18 | **Portfolio view added.** One page lists every initiative with its stage, who it waits on, spend, last activity, build progress and open bugs, with those needing a person first, and a list of releases by month. It reuses the map's stage logic. | A lead needs one place to see what needs a person across all the work. | Filters, a calendar grid, planned release dates |
| 2026-10-18 | **A spec or design sent back with "changes requested" is redone automatically.** A new run of the same agent starts from the current main with the reviewer's words, the old pull request is closed, and the same person sponsors it. Three revisions, then a person takes over. "Rejected" still stops the chain. A build task that finds nothing to change fails with the agent's own explanation, for a person to skip or retry. |
| 2026-10-18 | **Copilot CLI terms checked.** Its license allows installing and running it, forbids modifying it or removing its notices, and allows redistribution only unmodified and inside an application that does more than the CLI. With a provider key, GitHub sign-in and a subscription are not required, but telemetry still goes to GitHub unless offline mode is on. Fine for our own sandboxes. Needs a second read before the platform is offered to other organisations. See `mvp-contract.md` section 16. |
| 2026-10-18 | **Parallel tasks that edit the same file.** Tasks that list the same file run one after another. If a pull request still conflicts with what merged meanwhile, the Gate stops at once (new state `conflict`) and the build plan redoes the task on the current main, up to three attempts, then asks a person. |
| 2026-10-18 | **Frontend Engineer agent added.** Same tools, budget and review rules as the Backend Engineer, with a prompt for UI work (existing patterns, no new UI dependencies without asking, accessibility, every state, escaping). The Architect assigns each task to one of the two roles, and a build plan runs each with its own agent. Browser tests are still not available in the sandbox. |
| 2026-10-18 | **Build starts from the approved design.** When a design is merged, its task list becomes a build plan. Tasks start in dependency order, each only after what it depends on is merged. A person starts it in guided mode; balanced and autopilot start it themselves. Up to 4 runs per initiative at once. A failed task waits for a person to retry, skip, or cancel. A design approved long ago always waits for a person. The Gate now brings a pull request that fell behind main up to date and merges it, since parallel tasks make that common. See `mvp-contract.md` section 16. |
| 2026-10-18 | **Previews, option 1 first.** The review pack reads what the repository's own pipeline reports to GitHub (a Deployment, or a commit status with "preview" in its name) and shows it with its state. A preview of an older commit is shown as out of date, never as ready. The platform does not run previewed code. A platform-run preview (a `.sdlc/preview.yaml` built and served in Docker, later on Fargate) is the plan for a repository with a UI that has no pipeline of its own. The Gate App now asks for `deployments: read`. |
| 2026-10-18 | **Platform previews (option 2) built for Docker.** A reviewer clicks "Run it here" and the platform runs the pull request's own code in a sandbox (own network, no secrets, no internet beyond the package registry, one local port), from a `.sdlc/preview.yaml` on the pull request's branch. In autopilot it starts by itself. At most 2 at once, 30 minutes each, stopped when the review is decided. | A repository with a UI and no pipeline of its own still needs something to look at before approving. The agent writes the start file, so the sandbox, not the file, is the control. | A Fargate host and a shareable link with sign-in; builds with several services |
| 2026-10-18 | **Fargate runner and Fargate previews are the next build, so that on AWS nothing runs locally.** Decided: a parked run keeps its files as an **S3 snapshot** reached by presigned URLs (the task has no credentials); the egress proxy takes its **allowlist from the API at run time**; the proxy resolves names itself, since the VPC resolver is firewalled; runners reach the API and gateway by **Cloud Map names**; previews on Fargate are built **together** with the runner, behind the existing `PreviewHost` interface, with a signed-in proxy. Spike 6 proved the network, the proxy, the snapshot and the reachable port on real AWS with the real image. | The AWS stack runs with `RUNNER_ADAPTER=none` today, so on AWS no agent can work. | EFS for state; a NAT gateway; a load balancer for runners |
| 2026-10-18 | **The Fargate runner is built and proven on AWS; the next piece is Fargate previews.** A real agent run, a stop and resume across two tasks (the files saved to S3, the same conversation), and a goal built as three parallel Fargate tasks all worked on both engines, with nothing running locally. A task that is told to stop now saves its files first. One setting (`AGENT_ENGINE`) moves every agent to the other engine. | The point of the AWS deploy is that nobody runs anything locally. | Fargate previews with a signed-in link; registering the GitHub Apps through the web on AWS; review by a second person on AWS |
| 2026-10-18 | **Fargate previews are built and proven on AWS, served from a second address.** A preview runs as a Fargate task in its own security group (no route to the API or gateway, no credentials), and a signed-in reviewer opens it through a link that goes to a different address, so the pull request's unreviewed code cannot act as the reviewer on the platform. | The code in a pull request is not reviewed yet, so it must not share an origin with the platform. | A custom domain with one address per preview (which would also let apps use absolute paths); WebSockets |
| 2026-10-18 | **The Copilot CLI is a viable second engine through the gateway** (bring your own key, no Copilot subscription, same MCP tools, resume by session id). **Built** (mvp-contract section 16, step 4) and run live in the Docker sandbox: full loop, kill and resume, and a standing decision. Still open: the terms of use for automated BYOK use, and quality on real tasks. |
| 2026-10-16 | **Agent models:** Claude Code uses Claude models through OpenRouter's Anthropic-compatible endpoint. Other engines use their own model families through the gateway (§11.3, §12.3). |

---

## Appendix A: Parked Compliance Pack

Not part of the product direction. Kept for reference in [spec.v0.5.3-regulated.md](./spec.v0.5.3-regulated.md), and could return later as an optional pack on top of the core:
- Strictness levels (Sandbox, Controlled, Regulated), deployment floor, and promotion by fork.
- Gates G0–G7 as regulatory gates, QRA and Release Approver roles with effective-dated authority, strict separation of duties with exceptions.
- E-signatures with step-up re-authentication, a KMS-signed hash-chained evidence ledger, WORM export, trusted time, audit mode, and evidence bundles.
- Baselines and change requests with formal impact analysis, deviations, SOUP records, SBOM per release, and requalification of agent models.
- IEC 62304 and SOX/SOC 2 overlays and the control mapping.
- A competitive scan (October 2026) concluded that the regulated wedge was unvalidated and had no verified regulatory pull, which is one more reason it is parked.

The core is designed so such a pack could attach later: checkpoints can be added, the activity log can be made tamper-evident, and the registry can carry a data class.

## Appendix B: Changes from v0.5.3

| Area | v0.5.3 | v0.6 | Reason |
|---|---|---|---|
| Direction | Regulated, compliance-grade | Semi-autonomous, human-in-the-loop, no regulation | Original idea |
| Purpose | Product for regulated buyers, design partners | Tool for the author's own team | Author's goal |
| Strictness | Sandbox, Controlled, Regulated | **Autonomy modes**: Guided, Balanced, Autopilot (§6.1) | Controls how often people are involved, not how audit-grade evidence is |
| Gates | G0–G7 with legal-style authority | Checkpoints, mostly G1, G3, G6 (§8.2) | Lightweight profile becomes the default |
| Human involvement | Escalation policy inside a compliance model | **Human-injection engine** as the core (§5) | The main differentiator |
| Evidence | Signed, hash-chained ledger | Plain activity log (§10.6) | No external audit |
| Agents | Claude Code primary | **AgentEngine port** with MCP tools (§11) | Engine-agnostic differentiator |
| Data class `regulated` | Controls model gateway | `model_policy: own-account` (§6.5) | Keeps the useful data-boundary idea without compliance |
| Kept unchanged | | Repository Registry, GitHub Apps and link, Integration Register, egress deny, Model Gateway, OpenRouter default, local and AWS environments, verify-before-PR, sidecars | Not regulatory |

Screens and videos (updated 2026-10-16):
- **Trailmates** is the main example and matches this spec: autonomy modes, three checkpoints, and a new journey 5 with the attention queue and context cards, Slack answers, assumptions and standing decisions, and interruption metrics. Journey 6 covers the GitHub connection, Integration Register, model gateway, and engine per role.
- **Kestrel Market** matches this spec: Balanced autonomy, payment-scope triggers, a QA checkpoint, a release calendar with a freeze, and a hotfix path.
- **Parked:** the medical-device story (screens 01 to 16), Harbor Retirement, and their videos (`demo/videos/_parked-compliance-pack/`) illustrate the compliance pack. Screens 02 and 16 still use compliance and strictness language.
- **Not designed yet:** Teams and email notification templates, a Trailmates hotfix follow-up screen, editing triggers as YAML, and empty and error states.
