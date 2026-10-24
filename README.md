# Autonomous SDLC

A semi-autonomous software development platform where AI agents and people collaborate, and people are brought in at the right moments (human-in-the-loop).

- **[spec.md](./spec.md)**: what and why (v0.6).
- **[mvp-contract.md](./mvp-contract.md)**: the interfaces to code against for the MVP.
- **[spikes/README.md](./spikes/README.md)**: results of the risk spikes (model gateway, MCP `ask_human`, Fargate runner).
- **[designs/](./designs/README.md)** and **[demo/](./demo/README.md)**: clickable mockups and narrated demo videos.

## Local development (no Docker needed)

Requirements: Node 22 or newer, pnpm 9. Docker Desktop is needed only for the isolated runner (see below).

```powershell
pnpm install
pnpm dev          # PostgreSQL, dev identity provider, API, gateway, and web
```

Then open <http://localhost:5173> and sign in as one of the dev people (Alice is the Product Owner, Bob a Backend and Frontend Engineer, Cara the Architect, and a Platform Admin).

| Part                  | Local                                                                   | URL                   |
| --------------------- | ----------------------------------------------------------------------- | --------------------- |
| Web (Vite)            | proxies `/api` and `/auth` to the API, so the browser sees one origin   | http://localhost:5173 |
| API (Fastify)         |                                                                         | http://localhost:8080 |
| Gateway               | skeleton only (step 1 builds it)                                        | http://localhost:8787 |
| Dev identity provider | `oidc-provider` with static people, real code + PKCE flow               | http://localhost:9000 |
| Database              | real PostgreSQL 16 started by `embedded-postgres`, data in `.dev-data/` | localhost:54329       |

Delete `.dev-data/` to start again from an empty database.

## Commands

| Command                                     | What it does                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                  | Start everything for local work.                                                                                                                                                                                                                                                            |
| `pnpm dev:demo`                             | Start the stack in `.dev-demo/` with demo data (open asks, assumptions, a month of history). Sign in as Bob to see the attention queue. It never touches `.dev-data/`.                                                                                                                      |
| `pnpm dev:check`                            | Start the stack on spare ports, sign in through the OIDC flow, check `/api/me`, stop.                                                                                                                                                                                                       |
| `pnpm verify`                               | Typecheck, lint, format check, and unit and integration tests. This is the repository's verification contract.                                                                                                                                                                              |
| `pnpm test:e2e`                             | Playwright tests (sign-in, attention queue, assumptions, interruption metrics) in the system Edge (Windows) or Chrome. Starts the stack itself.                                                                                                                                             |
| `pnpm --filter @sdlc/dev-runner accept all` | Live acceptance for steps 1 to 3 (`happy`, `resume`, `standing`, `autopilot`, `release`, `both`, `all`): a real agent and real GitHub, merging a small change into the scratch repository. Add `docker` to run the agent in the isolated sandbox. Costs a few cents. Stop `pnpm dev` first. |
| `pnpm --filter @sdlc/runner image`          | Builds the sandbox image `sdlc-runner:dev` (about 826 MB). Rebuild it after changing `apps/runner`.                                                                                                                                                                                         |
| `pnpm format`                               | Format with Prettier.                                                                                                                                                                                                                                                                       |

## Layout

See [mvp-contract.md](./mvp-contract.md) section 2. Built so far (steps 0 and 1):

```text
apps/api         Fastify API: sign-in, registry, initiatives and runs, interactions, platform MCP server, GitHub Apps, Gate, run worker
apps/gateway     Model Gateway: run-token auth, aliases, provider pinning, streaming, cost metering
apps/runner      Runner: clone, run Claude Code, verify, push, ask the API to open the PR
apps/web         React shell: status, sign-in, hats
packages/schemas zod schemas shared by API, runner and UI
packages/core    Pure domain code: interaction state machine, trigger rules, pricing, tokens
packages/db      Drizzle schema and SQL migrations
tools/dev-db     Embedded PostgreSQL for local mode
tools/dev-idp    Development OIDC provider
tools/dev-runner Starts the whole local stack
e2e/             Playwright tests
```

## Reaching people in Slack (optional)

Without Slack, asks are in the attention queue and the notifier writes to the API log. To use Slack, create an app from `integrations/slack/app-manifest.yaml`, set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` for the API, and have an admin link each person: `PUT /api/people/:id/slack` with `{ "slackUserId": "U0123ABCD" }`. Slack must reach `/slack/interactions` over public HTTPS. How people are reached (reminder and escalation timing, working hours, the digest, what chat may settle) is in `rules/attention.yaml`. This part has been tested against a fake Slack only.

## Compose

`docker compose up --build` runs the same stack in containers (PostgreSQL, the API serving the web app, the gateway, and the dev identity provider). Open http://localhost:8080 and sign in as "Dev Admin". `docker compose down -v` removes it.

## Deploying to AWS

The stack (VPC, RDS PostgreSQL, three ECS Fargate services, CloudFront, Cognito, Secrets Manager) is deployed and destroyed from the **`deploy` GitHub workflow** — nothing runs on a developer's machine. It is proven: a stack was deployed, checked and destroyed this way on real AWS.

**Copying this repository for your own team? Start with the step-by-step checklist in [docs/ADOPTING.md](./docs/ADOPTING.md).** The sections below are the reference.

### Prerequisites

- An AWS account (the stack is deployed to `us-east-1`).
- This repository on GitHub, with `main` protected: a pull request with the `verify` check passing, no bypass. This matters because the deploy role has `AdministratorAccess` — **anyone who can push to `main` can administer the AWS account**.
- Terraform 1.6+ and the AWS CLI on one machine, for the one-time bootstrap below.
- An OpenRouter API key for the agents' model calls.
- Optional: a domain in a Route 53 hosted zone (e.g. `app.example.com` and `previews.example.com`). Without it, the platform gets its CloudFront addresses.

### 1. One-time bootstrap (by an AWS administrator)

```powershell
cd infra/bootstrap
terraform init
terraform apply -var repository=repo:OWNER@ID/REPO@ID   # read it with: gh api repos/OWNER/NAME/actions/oidc/customization/sub  (use sub_claim_prefix)
```

This creates the Terraform state bucket (`sdlc-tfstate-<account>`) and the `sdlc-github-deploy` role, which only this repository's workflows on `main` can assume. Note the two outputs: `deploy_role_arn` and `state_bucket`.

### 2. Repository variables and secrets

| Name                    | Kind               | Value                                                                                                              |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `AWS_DEPLOY_ROLE_ARN`   | variable           | the bootstrap's `deploy_role_arn` output                                                                           |
| `TF_STATE_BUCKET`       | variable           | the bootstrap's `state_bucket` output                                                                              |
| `BOOTSTRAP_ADMIN_EMAIL` | variable           | the person who signs in first; gets the platform admin hat                                                         |
| `OPENROUTER_KEY_AGENTS` | secret             | the OpenRouter key for agent runs                                                                                  |
| `APP_DOMAIN`            | variable, optional | e.g. `app.example.com`                                                                                             |
| `PREVIEW_DOMAIN`        | variable, optional | e.g. `previews.example.com` — must differ from `APP_DOMAIN`, so previewed code never shares the platform's cookies |
| `HOSTED_ZONE_ID`        | variable, optional | the Route 53 hosted zone holding both names                                                                        |

Set the three domain variables together, or none of them. With all three, Terraform creates one ACM certificate for both names, the Route 53 records, and the Cognito callback addresses follow.

### 3. Deploy

Start the **`deploy`** workflow from the Actions tab (it only runs from `main`, one run at a time). Inputs:

| Input                | Meaning                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `action`             | `deploy` (default) or `destroy`                                                                     |
| `confirm_destroy`    | to destroy, type `destroy` here; anything else refuses                                              |
| `independent_review` | require a second person to approve (turn off to work alone)                                         |
| `security_review`    | `on`: a pull request needs a security review before it can be approved; `off`: it does not          |
| `agent_engine`       | `claude-code` or `copilot-cli` moves every agent to that engine; empty leaves each agent on its own |

The run builds and pushes the platform and runner images (tagged with the commit), applies `infra/aws`, and waits for `/readyz`. A full deploy takes about 11 minutes; the step summary prints the platform and previews URLs.

### 4. After the deploy (by hand)

1. **Create the first sign-in user.** People cannot sign themselves up (Cognito is invite-only, 12-character minimum password, MFA off). From `infra/aws`, with the AWS CLI configured:

   ```powershell
   ./create-user.ps1 -Email you@example.com
   ```

   It prints a password that works at once. Sign in with it; the `BOOTSTRAP_ADMIN_EMAIL` person gets the platform admin hat.

2. **Register the GitHub Apps.** As the admin, open `/admin/github` on the platform and register and install the two Apps (Agent and Gate), then install them on only the repositories the agents may work in. The platform stores the App keys in Secrets Manager itself.
3. **Register each repository the agents may use** in the platform. There is no page for this yet: while signed in as the admin, run the one-line request in step 9 of [docs/ADOPTING.md](./docs/ADOPTING.md) in the browser console. Initiatives can only be created on registered repositories.

### Destroying the stack

Start the **`deploy`** workflow again with `action` = `destroy` and `confirm_destroy` = `destroy`. It removes the ECS cluster, load balancer, RDS, CloudFront distributions, VPC, Cognito pool, and every secret the stack made (including the GitHub App keys the platform wrote at run time).

What destroy leaves behind, and how to remove it:

| Leftover                                                 | Remove it with                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Terraform state bucket and the `sdlc-github-deploy` role | `cd infra/bootstrap; terraform destroy` (the bucket has `prevent_destroy`, so this is the only way) |
| Your Route 53 hosted zone                                | delete it in Route 53 if you no longer need it (about $0.50 a month)                                |

### Costs and caveats

- **Idle cost is about $3.30 a day (roughly $100 a month)** from us-east-1 list prices: load balancer, three Fargate tasks, RDS, VPC interface endpoints, public IPv4 addresses, and misc. Agent runs add model fees on top (a small app build cost about $2) plus a few cents of Fargate. To measure it: leave the stack up two days, then read Cost Explorer filtered on the tag `Stack=sdlc-dev`.
- **After a destroy, a redeploy starts fresh.** The Cognito pool is gone (create a new user), and the GitHub Apps and repository registrations must be redone at `/admin/github`.
- **Security.** The platform is invite-only and every API route requires sign-in; this is a prototype, not a hardened product. The deploy role has `AdministratorAccess`, so protect `main` and keep write access to yourself; MFA is off for the first admin by default; and previews are served from a sibling domain of the platform, not an isolated one. Treat it accordingly.
- **The AWS cost alarm is not wired up yet**: the deploy workflow never passes `budget_email`, so the AWS Budgets alert is not created. The platform's own Costs page still tracks model spend against `MONTHLY_BUDGET_USD`.
- The architecture is drawn in [infra/aws/architecture.md](./infra/aws/architecture.md) (with the diagram).
