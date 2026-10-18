# Spikes (2026-10-17)

Three throwaway experiments that test the riskiest assumptions in `spec.md` (§11, §12.3, §12.4). The code is disposable. The findings are what matter.

| Spike | What it tested | Result |
|---|---|---|
| [s1-claude-openrouter](./s1-claude-openrouter) | Claude Code headless through a thin gateway to OpenRouter | **Pass** |
| [s2-mcp-ask-human](./s2-mcp-ask-human) | `ask_human` over MCP from a headless run: block, default, non-blocking, park and resume, steering | **Pass** |
| [s5 (below)](#spike-5-the-github-copilot-cli-as-a-second-engine-2026-10-18) | Copilot CLI as a second engine, through our gateway with BYOK | **Pass on this machine** (not yet in the sandbox image) |
| [s3-fargate](./s3-fargate) | Fargate runner with a PostgreSQL sidecar, egress control, no AWS credentials | **Pass** (with one gap closed by DNS Firewall) |

All AWS resources were created with Terraform and destroyed afterwards. The account was verified clean (the default VPC only). Total cost is a few cents.

## Spike 1: Claude Code through the Model Gateway

Setup: `gateway.mjs` (about 120 lines, no dependencies) sits between Claude Code and `https://openrouter.ai/api`.

| Question (§19) | Finding |
|---|---|
| Does streaming plus tool use pass through unchanged? | **Yes.** A multi-turn run with 30 tools, file writes, and streamed partial messages worked. |
| Can the gateway map aliases? | **Yes.** Claude Code accepts `--model agent-default`. The gateway maps it to `anthropic/claude-haiku-4.5`. |
| Per-run token check, alias allowlist | **Yes.** Bad token gives 401. Disallowed alias gives 403. |
| Are per-request provider preferences accepted on the Anthropic-compatible endpoint? | **Yes, and honored.** `order`, `only`, `allow_fallbacks`, `zdr`, and `data_collection` all work. The message id prefix shows the provider: `msg_01…` is Anthropic first-party, `msg_bdrk_…` is Bedrock, `msg_vrtx_…` is Vertex. An impossible provider returns an error. |
| Does first-party Anthropic stay eligible with `data_collection: "deny"`? | **Yes.** |
| **Surprise:** without preferences, OpenRouter routed to **Bedrock**. | The gateway must inject `provider.order=["anthropic"]` or Claude Code runs on a provider OpenRouter does not guarantee for it. |
| Per-run cost metering | Token counts arrive in `message_start` (input) and `message_delta` (output). **There is no cost field**, so the gateway needs a price table. Gateway-side budgets work. A per-run OpenRouter key needs a management key, so use gateway metering first. |

Other findings:
- A fresh `claude -p "PONG"` sends about 28k to 40k tokens of system prompt and tool definitions. Budget for it in cost estimates.
- The gateway must drop hop-by-hop headers (`expect`, `keep-alive`, `transfer-encoding`). A client that sent `Expect: 100-continue` crashed the first version.
- Claude Code probes `HEAD /`. Return 200 for it.
- This workstation's `~/.claude/settings.json` already points Claude Code at OpenRouter with `z-ai/glm-5.2`. Spikes used `--setting-sources project` to avoid it.
- **The OpenRouter key in use has no credit limit** (`limit: null`). The §12.3 plan for two limited keys is not in place yet.

## Spike 2: `ask_human` over MCP

Setup: a Streamable HTTP MCP server (`@modelcontextprotocol/sdk` 1.32) with `ask_human`, `check_answers`, and `declare_assumption`.

| Test | Result |
|---|---|
| T1 Blocking ask, human answers after 142 s | **Pass.** The tool call stayed open, then the agent continued. A blocking wait beyond 2.5 minutes works. Not tested beyond that. |
| T2 Default after timeout (8 s, nobody answers) | **Pass.** Returns `source: "default"`, so the platform can flag it. |
| T3 Non-blocking ask, agent keeps working | **Pass.** The agent did four independent steps, then called `check_answers`, and used the answer that arrived mid-work. |
| T4 Kill the runner mid-wait, answer later, `--resume <session>` | **Pass.** Context was kept (it recalled "ZEBRA-42"). The dangling tool call did not break the resume. |
| T5 Inject guidance into a running session (stream-json on stdin) | **Pass.** The message queued and was acted on at the next step. It is not preemptive. A hard stop means kill and resume. |

Design consequences:
- Use **both** patterns. Short waits block. Long waits (hours, reviews) end the run and **resume with the answer**, which also stops paying for an idle Fargate task.
- Resume needs the Claude Code session store (`~/.claude/projects/<cwd>/*.jsonl`) and the **same working directory path**. On Fargate, save it to S3 when a run parks and restore it before resuming.
- Agents followed the tool descriptions well, even on Haiku 4.5.

## Spike 3: Fargate runner

Setup: a VPC with an isolated subnet (no internet route) for the runner and a public subnet for a shared egress proxy. The runner task has a `postgres:16-alpine` sidecar, a `dependsOn: HEALTHY` condition, and **no task role**. Images came through an ECR pull-through cache of `public.ecr.aws`, so no local Docker was needed.

| Check | Result |
|---|---|
| Sidecar reachable on `localhost:5432`, started before the runner | **Pass** |
| Docker socket | Absent, as expected |
| Capabilities | `NET_ADMIN` and `SYS_ADMIN` absent. `NET_RAW` present. |
| AWS credentials inside the container | **None** (no task role). Container metadata endpoint is present. |
| HTTPS to an allowed host through the proxy | 200 |
| HTTPS to a denied host through the proxy | 403 from the proxy |
| Direct internet access, ignoring the proxy | **Blocked** (network unreachable) |
| Another S3 bucket through the S3 gateway endpoint | **Blocked** (403) by the endpoint policy, which allows only the ECR layer bucket |
| DNS to arbitrary external names, default VPC resolver | **Open.** `example.com` resolved. This is an exfiltration channel. |
| DNS after a Route 53 Resolver DNS Firewall allowlist | **Blocked** for anything outside `amazonaws.com`, `openrouter.ai`, `github.com` |
| First task start in the isolated subnet | About 2 minutes (cold pull-through import). Second start: 70 seconds in total. |

Design consequences (resolves the §19 "egress enforcement" question):
- **A proxy sidecar inside the runner task is advisory only.** The agent shares its network namespace, can ignore the proxy variables, and Fargate does not allow `NET_ADMIN` to add firewall rules.
- **What works:** an isolated subnet with no route out, a runner security group that allows only the shared proxy, VPC endpoints for image pulls and logs, an S3 endpoint policy, **and** a DNS allowlist.
- Fixed cost while the stack is up: three interface endpoints (about $0.03/hour) plus the proxy task. A NAT gateway is not needed for runners.
- The proxy does not need AWS credentials. Give it the allowlist from the Integration Register.
- Not tested: a real PostgreSQL query (only the protocol handshake), a seed step, Compose-style service lists, the proxy's own logging (ALLOW lines did not appear in CloudWatch, so verify before relying on it), and large images.

## Not covered

- Real Copilot or Codex adapters (§19 "Engines"). No spike was run.
- Slack or Teams answer handling.
- Preview environments and the sidecar manifest format. Spike 3 shows a sidecar works, not how a repository declares one.

## Spike 5: the GitHub Copilot CLI as a second engine (2026-10-18)

**Question.** Can the Copilot CLI (version 1.0.100-1 here, a pre-release build; the stable npm tag was 1.0.98) sit behind the same engine port as Claude Code, with the same gateway, the same MCP tools, and the same resume? **Answer: yes, on this machine, and more cheaply than Claude Code.** Scripts: `tools/dev-runner/src/copilot-spike.ts` and `copilot-spike2.ts` (throwaway). They start the dev stack, create a run with a run token, and drive the CLI.

**The key finding: bring your own key (BYOK).** With `COPILOT_PROVIDER_TYPE=anthropic`, `COPILOT_PROVIDER_BASE_URL=<gateway>`, `COPILOT_PROVIDER_BEARER_TOKEN=<run token>` and `COPILOT_MODEL=<alias>`, the CLI uses **our gateway as its model provider**. It needs **no GitHub sign-in and no Copilot subscription**, bills **no premium requests** (`usage.premiumRequests` is 0), and every call is metered and budgeted by the gateway like Claude Code's. This removes the two unknowns I expected (billing and routing).

| Question | Finding |
|---|---|
| Headless run | `copilot -p "<prompt>" --allow-all-tools --output-format json`. Exit code 0 on success, 1 on a failed model call. `--log-level error` keeps stderr empty. |
| Through the gateway | Pass. The alias `agent-fast` went through the existing Anthropic endpoint, with the injected provider preference. Cost records were written (13 k input tokens for the first test, 3.5 k for a one-line prompt in a clean home, against about 30 k to 40 k for Claude Code). |
| Edits and git | Pass. It created a file and committed it through its shell tool. |
| Platform MCP tools | Pass. `--additional-mcp-config` with an `http` server and an `Authorization: Bearer <run token>` header loaded all 10 platform tools. Tools are named **`platform-<tool>`** (for example `platform-ask_human`). A call raised the interaction with the right topic and recommendation. |
| Blocking ask answered in flight | Pass. The call stayed open, the answer arrived 6 s later, and the model wrote it into a file (13 s in all). |
| Blocking ask not answered | The platform parked it after `BLOCKING_MAX_S` and returned `status: parked`. The CLI did not time out earlier. Its next model call then got **403, because the run was parked**: this is the platform working as designed (the runner must stop the engine when the run parks, as it does for Claude Code). |
| Resume | Pass. `--session-id <uuid>` names a new session and `--resume <uuid>` continues it with full memory (the codename survived, in both the plain case and after a park with the run set back to running). The session id appears in every `result` event. Sessions live under `COPILOT_HOME`, so a per-run volume keeps them. |
| Tool limits | `--deny-tool 'shell(git push)'` blocked a push (the remote stayed empty). `--available-tools` and `--excluded-tools` limit what the model sees. `--deny-url` exists for web access. These map onto the agent definition's `denied` list. |
| What it contacts | With a **clean home** (no stored login) and BYOK, **nothing** went through the proxy: no `api.github.com`, no telemetry. Without a clean home it contacted `api.github.com` (my stored login). `COPILOT_OFFLINE=true` also worked with BYOK. Set `COPILOT_AUTO_UPDATE=false` and `--disable-client-telemetry` as well. The sandbox allowlist needs nothing extra beyond the gateway. |
| Event stream | JSONL, one object per line. Types seen: `assistant.message` (and `_delta`), `assistant.tool_call_delta`, `tool.execution_start` (tool name and arguments), `tool.execution_complete` (success and result), `tool.shell_output`, `session.mcp_server_tools_loaded`, `session.warning`, and a final `result` with `sessionId`, `exitCode`, and usage. These map onto the engine-neutral run events in `mvp-contract.md` section 7. |
| System prompt | There is no `--append-system-prompt`. Put the agent's prompt at the start of `-p`, or point `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` at a folder with an `AGENTS.md` kept outside the repository. Use `--no-custom-instructions` if the repository's own `AGENTS.md` must not apply. |

**Gaps and risks.**
- **Not tried inside the Docker sandbox or on Linux.** The CLI is a Node package (`@github/copilot`), so it needs adding to the runner image, and its size and start-up in a read-only image are unmeasured.
- **A home directory leaks on Windows.** Overriding `HOME` and `USERPROFILE` did not stop it loading skills from the real user profile. In a container the home is the container's, so this should not apply there, but it is untested.
- **`--allow-all-tools` is safe only because the sandbox is the boundary.** The tool allowlist is a second layer, not the first.
- **It is a pre-1.1 tool** (1.0.100, with its own auto-update). Pin the version in the image. Whether using the CLI in automation against a self-chosen model provider is within GitHub's terms was **not checked**.
- **No turn limit** other than the wall-clock timeout and the gateway's budget (`--max-autopilot-continues` applies to autopilot mode only).
- Model quality was tested only on Haiku 4.5 through the alias, as for Claude Code. The CLI's prompts and tools differ, so results on real tasks may differ.

**What the adapter would be.** A new engine id `copilot-cli` beside `claude-code` in `apps/runner/src`: the same `RunSpec`, the same MCP URL and token, spawn `copilot` with the arguments and environment above, read its JSONL, translate to run events, store the session id from the first `result` event, and resume with `--resume`. The Dockerfile gets the CLI at a pinned version. About a day of work including tests, with the risks above to check first.

## Spike 4: what the two GitHub Apps can really do (2026-10-17)

Run live against `lrama1/sdlc-scratch` with installation tokens from the registered Agent and Gate Apps. The probe scripts were throwaway and are removed. All probe branches were deleted. A few `probe*.txt` files remain on `main`.

| Check | Result |
|---|---|
| Agent token permissions | `contents: write`, `pull_requests: write`, `metadata: read`. Limited to the one repository when asked. |
| Agent pushes a normal branch, opens a PR | Works |
| Agent pushes a change to `.github/workflows/ci.yml` | **Refused** by GitHub (no `workflows` permission) |
| Agent pushes straight to `main` (protected) | **Refused** |
| Agent merges while the required check is pending | Refused (405) |
| **Agent merges its own PR after the check is green, with only the required check as protection** | **Allowed.** Both Apps hold `contents` and `pull_requests` write, so GitHub cannot separate "push and open PR" from "merge". The Gate role is not enforced by permissions alone. |
| Protection with **one required approving review** | Agent cannot merge its own PR (405). |
| Agent approves its own PR | Refused (422) |
| **Gate App approves the PR** | Works, and **counts** toward the required review. The PR becomes `clean` and mergeable. |

Design consequences:
- The Gate is **the Gate App's approving review**. Branch protection on every registry repository: the required `verify` check, **one approving review**, and **dismiss stale approvals when new commits are pushed**, so an agent cannot push more code after the Gate has approved.
- The Gate App approves only when the platform says so: a person approved at G3 (or the change type is pre-approved), CI is green, and no trigger fired. After approval, either App can perform the merge. The approval is what matters.
- Without branch protection (no GitHub Pro on a private repository), the Gate role cannot be enforced against a determined agent. This is a limit of the platform on that repository.
- Not tested: whether a human admin bypasses protection (`enforce_admins` is off, so the repository owner can).
