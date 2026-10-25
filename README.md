# Autonomous SDLC

**AI agents build. People decide.** A semi-autonomous software delivery platform that runs in your own AWS account. You describe what you want; agents write the spec, design the solution, split it into tasks, build each task in an isolated sandbox and open pull requests. People make the decisions that matter, and nothing merges until the checks pass and a person has approved.

- **One idea in.** A brief in plain words (plus links to any API documentation) becomes a spec, a design, a task plan and pull requests.
- **Easy to follow.** One map shows every initiative, stage and task, and who each is waiting on. One queue holds everything that needs a person.
- **Humans in the loop by design.** Agents stop at hard stops: a new outside system, a protected file, a risky change. Only a person can let them through, and every answer is recorded with who and why.
- **Review goes beyond the diff.** A security review reads the change, a smoke test starts the real app, the design's own checks must pass, and one click runs the pull request as a live, isolated copy of the app (with its own database table) before you approve it.
- **Features compound.** A new initiative on the same repository builds on the code that already merged.
- **Yours.** It runs in your AWS account with invite-only sign-in. The agents use your OpenRouter key.

**Status: a working prototype.** Two apps were built on it end to end (a habit tracker, and a support ticket tracker on DynamoDB built in two stages). Those runs found real platform bugs, which were fixed. It is not a hardened product: read [Costs and caveats](#costs-and-caveats) before you put sensitive code through it.

- **[spec.md](./spec.md)**: what and why (v0.6).
- **[mvp-contract.md](./mvp-contract.md)**: the interfaces to code against for the MVP.
- **[docs/ADOPTING.md](./docs/ADOPTING.md)**: the same AWS setup as a checkbox list, with the extra steps (hats, other users).
- **[spikes/README.md](./spikes/README.md)**: results of the risk spikes (model gateway, MCP `ask_human`, Fargate runner).
- **[designs/](./designs/README.md)** and **[demo/](./demo/README.md)**: clickable mockups and narrated demo videos.

## Use it: make your own copy, then deploy it to your AWS account

You do not install this repository, and nobody but its owner can change it. `main` here is protected (a pull request with a passing `verify` check is required), the owner is the only person with write access, and the deploy workflow runs only for the owner and only into the owner's AWS account. Your route is to **make your own copy and change that**:

| Way                   | What you get                                                                                            | Choose it when                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Use this template** | A fresh copy with no link to this repository. Can be private.                                           | You are adopting it for a team, with private infrastructure code. |
| **Fork**              | A linked copy. A fork of a public repository is public. You can pull in updates and offer changes back. | You want updates from here, or you want to contribute.            |

On a free GitHub plan, a private copy cannot enforce rulesets or required reviewers (they need a paid plan). Use a public copy, or a paid plan, if you want the protections in steps 2 and 5.

Your copy is yours to modify: change agents' prompts in `agents/`, the rules in `rules/`, the model aliases in `apps/gateway/src/settings.ts`, the infrastructure in `infra/`. To get later changes from here into a fork, use GitHub's "Sync fork" button; into a template copy, `git remote add upstream https://github.com/lrama1/autonomous-sdlc.git`, then `git fetch upstream` and merge. To offer a change back, open a pull request from your fork. The owner reviews and merges it.

## Run it on your own AWS account, step by step

Plan on one to two hours of work and about 20 minutes of waiting for the first deploy. The stack costs about $3.30 a day while it is up (roughly $100 a month), plus model fees for every agent run.

### Before you start

- An **AWS account** where you have administrator rights, and the **AWS CLI** signed in to it. The stack deploys to `us-east-1`.
- **Terraform 1.6 or later**, **Git**, and the **GitHub CLI** (`gh`), signed in.
- A **GitHub account or organization** for your copy of the platform, and a **separate repository** for the agents to work on (it can start nearly empty; see step 9).
- An **OpenRouter API key** for the agents' model calls. Give it a daily credit limit.
- Optional: a domain in a **Route 53 hosted zone** (for example `app.example.com` and `previews.example.com`). Without it the platform uses its CloudFront addresses.

### 1. Make your copy

On GitHub, press **Use this template** (or **Fork**) on this repository, and name your copy. Clone it. Then, in the copy, open Settings, Actions, General and allow Actions.

### 2. Protect `main` in your copy

The deploy role is an AWS administrator, so **anyone who can push to `main` and run the workflow can administer your AWS account**. In Settings, Rules, Rulesets, protect `main`: require a pull request, require the `verify` status check, require at least one approving review, and allow no bypass. Keep the list of people with write access short.

### 3. Bootstrap AWS (once)

This creates the Terraform state bucket and the `sdlc-github-deploy` role that your workflow assumes. No AWS keys are ever stored in GitHub.

```bash
# the sign-in subject GitHub puts in tokens for your copy, e.g. repo:OWNER@123/REPO@456
gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix
# your numeric GitHub user id
gh api users/OWNER --jq .id

cd infra/bootstrap
terraform init
terraform apply \
  -var repository=repo:OWNER@123/REPO@456 \
  -var actor_id=YOUR_NUMERIC_GITHUB_ID \
  -var workflow_ref=OWNER/REPO/.github/workflows/deploy.yml@refs/heads/main
```

`actor_id` and `workflow_ref` are optional but recommended: AWS then accepts only your runs of that one workflow file. Write down the two outputs, `deploy_role_arn` and `state_bucket`. Keep `infra/bootstrap/terraform.tfstate` (it is local and gitignored).

### 4. Set the repository variables and secret

In your copy, Settings, Secrets and variables, Actions:

| Name                    | Kind               | Value                                                                                                             |
| ----------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`   | variable           | the bootstrap's `deploy_role_arn` output                                                                          |
| `TF_STATE_BUCKET`       | variable           | the bootstrap's `state_bucket` output                                                                             |
| `BOOTSTRAP_ADMIN_EMAIL` | variable           | the email of the first person to sign in; they become the platform admin                                          |
| `OPENROUTER_KEY_AGENTS` | secret             | your OpenRouter key                                                                                               |
| `APP_DOMAIN`            | variable, optional | e.g. `app.example.com`                                                                                            |
| `PREVIEW_DOMAIN`        | variable, optional | e.g. `previews.example.com`; must differ from `APP_DOMAIN`, so previewed code never shares the platform's cookies |
| `HOSTED_ZONE_ID`        | variable, optional | the Route 53 hosted zone holding both names                                                                       |

Set the three domain variables together, or none of them. With all three, Terraform creates one certificate for both names and the DNS records.

### 5. Create the `production` environment

Settings, Environments, New environment, named exactly `production`. Add yourself as a required reviewer and allow deployments from the `main` branch only. The deploy job runs in this environment and the AWS role trusts only it, so every deploy needs your approval click. (Required reviewers on a private repository need a paid GitHub plan.)

### 6. Deploy

Actions, **deploy**, Run workflow, on `main`. Inputs:

| Input                | Meaning                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `action`             | `deploy` (default) or `destroy`                                                                     |
| `confirm_destroy`    | to destroy, type `destroy` here; anything else refuses                                              |
| `independent_review` | require a second person to approve (turn off to work alone)                                         |
| `security_review`    | `on`: a pull request needs a security review before it can be approved; `off`: it does not          |
| `agent_engine`       | `claude-code` or `copilot-cli` moves every agent to that engine; empty leaves each agent on its own |

The run stops at "Review deployments": open the run and approve it. It then builds and pushes the platform and runner images (tagged with the commit), applies `infra/aws`, and waits for `/readyz`. A full deploy takes about 11 minutes (more with a custom domain, because of certificate validation). The run summary prints the platform and previews addresses. Deploying again later updates the same stack in place; it does not create a second one.

### 7. Create the first sign-in

People cannot sign themselves up. An admin creates each sign-in in Amazon Cognito. Make the first one for the person in `BOOTSTRAP_ADMIN_EMAIL`, using the AWS CLI signed in to the same account (nothing else to install, and no Terraform needed):

```bash
POOL_ID=$(aws cognito-idp list-user-pools --max-results 20 --region us-east-1 \
  --query "UserPools[?Name=='sdlc-dev'].Id" --output text)

aws cognito-idp admin-create-user --region us-east-1 --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password --region us-east-1 --user-pool-id "$POOL_ID" \
  --username you@example.com --password 'A-long-password-1' --permanent
```

In PowerShell, write the first line as `$POOL_ID = aws cognito-idp list-user-pools ...` and use `$POOL_ID` in place of `"$POOL_ID"`. Passwords need 12 or more characters.

Then sign in at the platform address, which is printed in the deploy run's summary (or is your `APP_DOMAIN`). The `BOOTSTRAP_ADMIN_EMAIL` person gets the platform admin hat on first sign-in. Repeat the two commands for each other person. Signing in gives them no hats: [docs/ADOPTING.md](./docs/ADOPTING.md) step 6 shows how an admin gives them roles.

Optional, with PowerShell and Terraform installed: `infra/aws/create-user.ps1 -Email you@example.com` does the same and generates a password. It reads the pool id from the stack's Terraform state, so run `. ./tf-init.ps1; Initialize-Terraform 'us-east-1'` once in `infra/aws` first.

### 8. Register the two GitHub Apps

As the admin, open `<platform address>/admin/github`. Register the **Agent** App, then the **Gate** App, signed in to GitHub as the account that should own them. Install each on **only the repositories the agents may use**. The platform stores the App keys in Secrets Manager itself.

### 9. Prepare and register the repository the agents will work on

This is a different repository from your copy of the platform.

- It needs an `npm run verify` script that fails when something is wrong (a new repository can start with `"verify": "node --test"`), and a GitHub Actions workflow with a job named `verify` that runs it on pull requests. Agents cannot edit `.github/workflows/**`.
- Protect its `main`: require the `verify` check, require one approving review, and dismiss stale approvals. The Gate App's approving review is what allows a merge.
- Register it in the platform. There is no page for this yet. Signed in as the admin, run this in the browser console on the platform:

```js
await fetch('/api/repositories', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fullName: 'OWNER/REPO' }),
}).then((r) => r.json());
```

### 10. Build something

Open the **Map** tab, create an initiative on your repository with a brief (and links to any API documentation), and start the spec. Approve the spec in the **Attention queue**, then start the design, approve it, and start the build. Expect a few hard stops the first time: agents that write `.sdlc/preview.yaml` stop at a protected path and ask you to allow it, and a new outside system asks you to confirm it. That is by design. After the first run, look at the **Costs** tab.

### 11. Stop paying for it

Run the **deploy** workflow with `action` = `destroy` and `confirm_destroy` = `destroy` (and approve it). It removes the cluster, load balancer, database, CloudFront, VPC, Cognito pool and every secret the stack made, including the GitHub App keys the platform stored. A redeploy afterwards starts fresh: create a new user (step 7) and register the Apps and repositories again (steps 8 and 9).

What destroy leaves behind:

| Leftover                                                 | Remove it with                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Terraform state bucket and the `sdlc-github-deploy` role | `cd infra/bootstrap; terraform destroy` (the bucket has `prevent_destroy`, so this is the only way) |
| Your Route 53 hosted zone                                | delete it in Route 53 if you no longer need it (about $0.50 a month)                                |

## Run it on your machine (for development)

### Local development (no Docker needed)

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
| Gateway               | Model Gateway: aliases, metering, run tokens                            | http://localhost:8787 |
| Dev identity provider | `oidc-provider` with static people, real code + PKCE flow               | http://localhost:9000 |
| Database              | real PostgreSQL 16 started by `embedded-postgres`, data in `.dev-data/` | localhost:54329       |

Delete `.dev-data/` to start again from an empty database.

### Commands

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

### Layout

See [mvp-contract.md](./mvp-contract.md) section 2. Main parts:

```text
apps/api         Fastify API: sign-in, registry, initiatives and runs, interactions, platform MCP server, GitHub Apps, Gate, run worker
apps/gateway     Model Gateway: run-token auth, aliases, provider pinning, streaming, cost metering
apps/runner      Runner: clone, run Claude Code, verify, push, ask the API to open the PR
apps/web         React web app (Material UI): map, attention queue, costs, integrations
packages/schemas zod schemas shared by API, runner and UI
packages/core    Pure domain code: interaction state machine, trigger rules, pricing, tokens
packages/db      Drizzle schema and SQL migrations
tools/dev-db     Embedded PostgreSQL for local mode
tools/dev-idp    Development OIDC provider
tools/dev-runner Starts the whole local stack
e2e/             Playwright tests
```

### Reaching people in Slack (optional)

Without Slack, asks are in the attention queue and the notifier writes to the API log. To use Slack, create an app from `integrations/slack/app-manifest.yaml`, set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` for the API, and have an admin link each person: `PUT /api/people/:id/slack` with `{ "slackUserId": "U0123ABCD" }`. Slack must reach `/slack/interactions` over public HTTPS. How people are reached (reminder and escalation timing, working hours, the digest, what chat may settle) is in `rules/attention.yaml`. This part has been tested against a fake Slack only.

### Compose

`docker compose up --build` runs the same stack in containers (PostgreSQL, the API serving the web app, the gateway, and the dev identity provider). Open http://localhost:8080 and sign in as "Dev Admin". `docker compose down -v` removes it.

## Costs and caveats

- **Idle cost is about $3.30 a day (roughly $100 a month)** from us-east-1 list prices: load balancer, three Fargate tasks, RDS, VPC interface endpoints, public IPv4 addresses, and misc. Agent runs add model fees on top (the two-stage DynamoDB ticket tracker demo cost about $6 in model fees with Claude Sonnet 5.5) plus a few cents of Fargate. To measure it: leave the stack up two days, then read Cost Explorer filtered on the tag `Stack=sdlc-dev`.
- **Security.** The platform is invite-only and every API route requires sign-in; this is a prototype, not a hardened product. The deploy role has `AdministratorAccess`, so protect `main` and keep write access to yourself; MFA is off for the first admin by default; and previews are served from a sibling domain of the platform, not an isolated one. Treat it accordingly.
- **The AWS cost alarm is not wired up yet**: the deploy workflow never passes `budget_email`, so the AWS Budgets alert is not created. The platform's own Costs page still tracks model spend against `MONTHLY_BUDGET_USD`.
- The architecture is drawn in [infra/aws/architecture.md](./infra/aws/architecture.md) (with the diagram).
