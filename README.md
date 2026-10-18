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

| Command                                     | What it does                                                                                                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                  | Start everything for local work.                                                                                                                                                                                                                                     |
| `pnpm dev:demo`                             | Start the stack in `.dev-demo/` with demo data (open asks, assumptions, a month of history). Sign in as Bob to see the attention queue. It never touches `.dev-data/`.                                                                                               |
| `pnpm dev:check`                            | Start the stack on spare ports, sign in through the OIDC flow, check `/api/me`, stop.                                                                                                                                                                                |
| `pnpm verify`                               | Typecheck, lint, format check, and unit and integration tests. This is the repository's verification contract.                                                                                                                                                       |
| `pnpm test:e2e`                             | Playwright tests (sign-in, attention queue, assumptions, interruption metrics) in the system Edge (Windows) or Chrome. Starts the stack itself.                                                                                                                      |
| `pnpm --filter @sdlc/dev-runner accept all` | Live acceptance for steps 1 and 2 (`happy`, `resume`, `standing`, `both`, `all`): a real agent and real GitHub, merging a small change into the scratch repository. Add `docker` to run the agent in the isolated sandbox. Costs a few cents. Stop `pnpm dev` first. |
| `pnpm --filter @sdlc/runner image`          | Builds the sandbox image `sdlc-runner:dev` (about 826 MB). Rebuild it after changing `apps/runner`.                                                                                                                                                                  |
| `pnpm format`                               | Format with Prettier.                                                                                                                                                                                                                                                |

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

## Compose and AWS

- `docker compose up --build` runs the same stack in containers (PostgreSQL, the API serving the web app, the gateway, and the dev identity provider). Open http://localhost:8080 and sign in as "Dev Admin". `docker compose down -v` removes it.
- `infra/aws` deploys to your AWS account: set `TF_VAR_bootstrap_admin_email`, run `./deploy.ps1`, then `./create-user.ps1 -Email you@example.com`, and `./destroy.ps1` when you are done. It costs about $2.30 a day while up (see `mvp-contract.md` section 16). It needs Terraform, Docker, and the AWS CLI.
