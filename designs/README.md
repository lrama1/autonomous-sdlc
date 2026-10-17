# Screen designs

Clickable HTML mockups of the semi-autonomous, human-in-the-loop SDLC platform described in [../spec.md](../spec.md) (v0.6). No build step, no dependencies, sample data only.

**Start here:** open [index.html](./index.html) in a browser (double-click works). Each screen shows a `Story · Day · time` tag, and most have a persona switcher in the top bar.

## Core examples

### Trailmates (a small team's hiking app)
[trailmates/index.html](./trailmates/index.html) is the main example. A founder, a tech lead and a frontend engineer build with agents, with three checkpoints by default, people wearing several hats, and routine changes on autopilot.

| Journey | Screens | Shows |
|---|---|---|
| N1 Idea to approved spec | New initiative, SDLC map, spec and design review | Workflow, autonomy modes (Guided, Balanced, Autopilot), repository, hats |
| N2 Build a feature | Agent runs, PR review | Parallel agents that run the app before opening a PR, preview, independent review |
| N3 Everyday changes | Autopilot, bug triage | Pre-approved change types, what stays held, bug report to fix |
| N4 Ship and tune | Release, autonomy and cost | One-approval release, canary, budgets, triggers |
| **N5 Humans in the loop** | Attention queue, Slack view, assumptions and decisions, interruption metrics | Ranked asks with context and a recommendation, answers from chat, standing decisions, tuning |
| N6 Connections | GitHub, integrations, repositories and models | Two GitHub Apps, outside services and the agent allowlist, model gateway and aliases, engine per role |

### Kestrel Market (an online store)
[kestrel/index.html](./kestrel/index.html) shows customer and employee work in one portfolio: payment-scope triggers that always bring in Architect and Security, an optional QA verification checkpoint, business rules traced to tests, a scope change with impact analysis, a release calendar with a change freeze, and a hotfix path.

## Parked: compliance pack

Not part of the product direction. These came from the earlier regulated version (signed evidence, separation of duties by role, audit mode, strictness levels) and are kept for reference. See the spec's Appendix A.

- **Main set, screens 01 to 16** (medical-device story): [01 Sign in](./01-sign-in.html), [02 New initiative](./02-new-initiative.html), [03 Inbox](./03-inbox.html), [04 G1 review pack](./04-review-g1-requirements.html), [05 Sign & evidence](./05-sign-evidence.html), [06 SDLC map](./06-sdlc-map.html), [07 Agent session](./07-agent-session.html), [08 G3 PR review](./08-review-g3-pull-request.html), [09 Traceability](./09-traceability.html), [10 Release G6](./10-release-authorization.html), [11 Evidence record](./11-evidence-record.html), [12 Audit mode](./12-audit-mode.html), [13 Agent governance](./13-agent-governance.html), [14 Roles & SoD](./14-roles-and-sod.html), [15 Emergency change](./15-emergency-change.html), [16 Strictness & repositories](./16-strictness-and-repos.html).
- **Harbor Retirement**: [retirement/index.html](./retirement/index.html), five IRA journeys on the same compliance pack.

## Structure

- `assets/styles.css`: design tokens and components.
- `assets/app.js`: shared shell (sidebar, top bar, persona switcher) and tab helper. A folder can define `window.SDLC_CAST` (people, navigation, tenant) before loading it.
- `trailmates/`, `kestrel/`, `retirement/`: one folder per example, each with `cast.js` and `index.html`.
- Each screen is a standalone HTML file with its content inside `<div id="content">`.
- The narrated videos are described in [../demo/README.md](../demo/README.md).

## Not designed yet

- Notification templates for Teams and email (the Slack view is designed).
- Empty, error and loading states. Accessibility pass. Small-screen layout.
- A hotfix follow-up review screen for Trailmates (Kestrel has one).
- Editing triggers and pre-approved change types as YAML.
