"""Trailmates example: the core idea, a semi-autonomous SDLC with humans in the loop (spec v0.6).

Same conventions as storyboard.py. Pages live in designs/trailmates/. Run with:  --set storyboard_trailmates
"""
import re

BASE = "designs/trailmates/"


def spoken(text):
    """Spell out terms the voice would otherwise mispronounce (captions keep the original text)."""
    for pat, rep in [(r"\bQA\b", "Q A"), (r"\bSDLC\b", "S D L C"), (r"\bMCP\b", "M C P"), (r"\bAPI\b", "A P I")]:
        text = re.sub(pat, rep, text)
    return text


def scene(sid, text, run):
    return {"id": sid, "text": text, "say": spoken(text), "run": run, "card": False}


def card_scene(sid, text, tag, title, sub="", chips=()):
    return {"id": sid, "text": text, "say": spoken(text), "card": True,
            "run": lambda r: r.card(sid, tag, title, sub, chips)}


def hc(tag, heading):
    return f'.card:has({tag}:has-text("{heading}"))'


# ---------------------------------------------------------------- Intro
INTRO = [card_scene(
    "lintro",
    "This walk-through shows a semi-autonomous software lifecycle, where AI agents and people build together. The example "
    "is Trailmates, a small app for planning group hikes, built by a founder and two engineers. Agents do the drafting, "
    "coding and testing, in roles that mirror a real team. People are brought in only at the moments their judgment "
    "matters, and left alone the rest of the time. You will see three checkpoints instead of a long approval chain, "
    "routine changes merging on their own, and in journey five, the part we think matters most: a queue that asks the "
    "right person, with context and a recommendation. Everything you will see is a design mockup with sample data.",
    "End-to-end demo · Trailmates", "Agents and people, building together",
    "People are asked at the right moments, and left alone the rest of the time.",
    ["Example: a hiking-trip planning app", "Three checkpoints by default", "Humans in the loop", "Design mockups, sample data"])]


# ---------------------------------------------------------------- Journey 1: Idea to approved spec
def l1_1(r):
    r.goto(BASE + "n1-1-new-initiative.html")
    r.at(0.0); r.hl(hc("h2", "Goal"))
    r.at(0.35); r.hl(hc("h2", "Workflow"))
    r.at(0.65); r.hl(hc("h2", "Autonomy"))


def l1_2(r):
    r.at(0.0); r.hl(".card.flush")
    r.at(0.5); r.hl(hc("h3", "Preflight"))
    r.at(0.93); r.click_nav("a.btn.primary:has-text('Create initiative')")


def l1_3(r):
    r.at(0.0); r.hl("#flow")
    r.at(0.5); r.click('.gnode[data-g="G1"]')
    r.at(0.6); r.hl("#detail")
    r.at(0.92); r.click_nav("#detail a.btn.primary")


def l1_4(r):
    r.at(0.0); r.hl('[data-pane="stories"] .card.flush')


def l1_5(r):
    r.at(0.0); r.click('[data-tab="questions"]')
    r.at(0.15); r.select("#q1", "7 days")
    r.at(0.45); r.select("#q2", "Free tier, 3-day forecast")
    r.at(0.8); r.hl("#checks")


def l1_6(r):
    r.at(0.0); r.click('[data-tab="design"]')
    r.at(0.1); r.hl('[data-pane="design"] .card.flush')


def l1_7(r):
    r.at(0.0); r.hl(hc("h3", "Approvals"))
    r.at(0.3); r.click("#apSofia")
    r.at(0.5); r.click("#apBen")
    r.at(0.75); r.hl("#result")


JOURNEY_L1 = [
    card_scene("l1_0",
               "Journey one. From idea to approved spec. Sofia is a founder with an idea for a hiking app and no "
               "process to speak of. Let's see how little ceremony the platform needs.",
               "Journey 1", "From idea to approved spec", "Sofia Alvarez · Founder and Product Owner",
               ["Default workflow", "Autonomy modes", "One-click approvals"]),
    scene("l1_1", "Sofia describes the idea in plain words. She keeps the default workflow, which has three checkpoints: "
                  "spec and design, change merge, and release. And she picks Balanced autonomy. People approve the spec, "
                  "the design and the release, plus any pull request a trigger flags, while routine changes merge on "
                  "green checks. Guided and Autopilot are one click away, and some stops, like production deploys, never "
                  "change in any mode.", l1_1),
    scene("l1_2", "Three people cover every role. Sofia is product owner and release approver. Ben is tech lead, "
                  "architect and backend engineer. Mina is frontend engineer and QA. The setup lets people wear several "
                  "hats, as long as at least two different people take part in every change, and nobody reviews work "
                  "from an agent run they started.", l1_2),
    scene("l1_3", "The map shows only the checkpoints this setup uses. Five are switched off by default. The first "
                  "decision is a combined approval of the spec and the design, and it waits on Sofia and Ben.", l1_3),
    scene("l1_4", "The Product Agent drafted six user stories with acceptance criteria. Sofia reads them like any "
                  "product document: create a trip, invite friends with a link, see who is coming, check the weather, "
                  "get reminders.", l1_4),
    scene("l1_5", "The agents also asked two questions they could not answer themselves: how long invite links should "
                  "last, and which weather provider to start with. Sofia answers both in a click, and the checks "
                  "update.", l1_5),
    scene("l1_6", "Meanwhile the Architect Agent proposed a simple design: a modular backend with ports for weather and "
                  "email, a managed PostgreSQL database, magic-link sign-in, and a preview environment for every pull "
                  "request. Only decisions that are hard to undo get a written note.", l1_6),
    scene("l1_7", "Sofia approves the spec as the owner, and Ben approves the design as tech lead. Each approval is one "
                  "click, recorded in the activity log. The agents can start building.", l1_7),
]


# ---------------------------------------------------------------- Journey 2: Build a feature
def l2_1(r):
    r.goto(BASE + "map.html?i=202&s=g3&u=mina")
    r.at(0.0); r.hl('.gnode[data-g="G3"]')
    r.at(0.55); r.hl("#you")


def l2_2(r):
    r.goto(BASE + "n2-1-agent-runs.html")
    r.at(0.0); r.hl("#runBE", "#runFE")


def l2_3(r):
    r.at(0.0); r.hl("#e2e")


def l2_4(r):
    r.goto(BASE + "n2-2-review-pr.html")
    r.at(0.0); r.hl('[data-pane="diff"] .callout.ok')
    r.at(0.4); r.hl(".diff")
    r.at(0.7); r.click('[data-tab="preview"]')
    r.at(0.78); r.hl('[data-pane="preview"] .browser')


def l2_5(r):
    r.at(0.0); r.click('[data-tab="checks"]')
    r.at(0.12); r.hl('[data-pane="checks"] .grid.g2')
    r.at(0.5); r.select("#viewAs", "mina")
    r.at(0.6); r.hl("#sod")
    r.at(0.86); r.select("#viewAs", "ben")


def l2_6(r):
    r.at(0.0)
    for i in range(1, 4):
        r.click(f"#att li:nth-child({i}) input")
    r.at(0.55); r.click("#sign")
    r.at(0.7); r.hl("#result")


JOURNEY_L2 = [
    card_scene("l2_0",
               "Journey two. Build a feature. The team wants a shared packing list, so friends stop bringing three "
               "tents and no stove.",
               "Journey 2", "Build a feature with agents", "Mina Park and Ben Carter",
               ["Parallel agent runs", "Verify in a browser", "Preview environment"]),
    scene("l2_1", "The spec is approved, so the active checkpoint is change merge. In this setup, one reviewer is "
                  "enough.", l2_1),
    scene("l2_2", "Mina starts two agent runs side by side: a Backend Engineer Agent for the claim-an-item API, and a "
                  "Frontend Engineer Agent for the packing list screen. Each works in its own sandbox, and writes "
                  "tests first.", l2_2),
    scene("l2_3", "Before opening a pull request, each agent runs the app. The frontend agent drives a headless browser "
                  "through the real flow: create a trip, add an item, claim it, and check that a second member sees "
                  "the claim within a second. It even tests two people claiming at once.", l2_3),
    scene("l2_4", "Ben gets one pull request, with a live preview environment created just for it. The platform checked "
                  "for sensitive paths and found none, so one reviewer is enough. He reads the diff, then clicks "
                  "through the feature in the preview.", l2_4),
    scene("l2_5", "The agents' own test report is advisory. Continuous integration re-runs everything, and that "
                  "independent result gates the merge. Mina started the runs, so the platform will not let her "
                  "review them. Ben can.", l2_5),
    scene("l2_6", "Ben ticks his checklist and approves. Once the checks are green, the Gate identity merges the pull "
                  "request and deletes the preview. No ceremony, but the review, the checks, and the separation of "
                  "roles are all still there.", l2_6),
]


# ---------------------------------------------------------------- Journey 3: Everyday changes on autopilot
def l3_1(r):
    r.goto(BASE + "n3-1-autopilot.html")
    r.at(0.0); r.hl(hc("h2", "Pre-approved change types"))
    r.at(0.65); r.hl(hc("h3", "Why this is safe"))


def l3_2(r):
    r.at(0.0); r.hl(hc("h3", "Always held"))


def l3_3(r):
    r.at(0.0); r.hl("#activity")


def l3_4(r):
    r.goto(BASE + "n3-2-bug-triage.html")
    r.at(0.0); r.hl(hc("h2", "what the user wrote"))
    r.at(0.3); r.hl(hc("h2", "What the Bug Agent did"))


def l3_5(r):
    r.at(0.0); r.hl(hc("h2", "PR #58"))
    r.at(0.6); r.click("#approve")
    r.at(0.75); r.hl("#result")


JOURNEY_L3 = [
    card_scene("l3_0",
               "Journey three. Everyday changes on autopilot. Most changes in a healthy codebase are small and "
               "routine. People should not have to click approve on every one.",
               "Journey 3", "Everyday changes on autopilot", "Ben Carter · Tech Lead",
               ["Pre-approved change types", "Held for a person", "Bug triage"]),
    scene("l3_1", "Ben defines pre-approved change types: documentation, interface copy, patch-level dependency "
                  "updates, and staging feature flags. If a pull request matches one of these types and continuous "
                  "integration is green, the platform merges it. Each standing rule is Ben's decision, with an owner "
                  "and a review date.", l3_1),
    scene("l3_2", "The guardrails are fixed rules, not an AI judgment call. Anything touching authentication or "
                  "infrastructure, database migrations, new dependencies, major version bumps, or more than two "
                  "hundred lines is held for a person.", l3_2),
    scene("l3_3", "Last week fourteen changes merged on their own, and three were held for review, each with its reason. "
                  "Every one is recorded in the activity log, so you can always see what the autopilot did.", l3_3),
    scene("l3_4", "Now a bug. A user reports that packing list items vanish when two people edit at once. A rule starts "
                  "a Bug Agent run. It reproduces the problem with a failing test, finds the cause, which is that the "
                  "last save overwrites the other person's items, fixes it by saving each item separately, and proves "
                  "the fix by running the app.", l3_4),
    scene("l3_5", "The fix touches shared data handling, so it is held for review. Ben reads the summary, sees the "
                  "failing test turn green, and merges. From report to fix in about fifteen minutes of agent work, "
                  "with a person making the call.", l3_5),
]


# ---------------------------------------------------------------- Journey 4: Ship and tune
def l4_1(r):
    r.goto(BASE + "n4-1-release.html")
    r.at(0.0); r.hl(".grid.g4")
    r.at(0.35); r.hl(hc("h2", "Release notes"))
    r.at(0.7); r.hl(hc("h3", "Canary plan"))


def l4_2(r):
    r.at(0.0); r.hl(hc("h3", "Checks"))
    r.at(0.45); r.click("#approve")
    r.at(0.65); r.hl("#result")


def l4_3(r):
    r.goto(BASE + "n4-2-settings.html")
    r.at(0.0); r.hl("#mode")
    r.at(0.55); r.hl(hc("h2", "When agents should ask"))


def l4_4(r):
    r.at(0.0); r.hl(hc("h2", "Budget and limits"))
    r.at(0.6); r.hl(hc("h3", "Spend by agent"))


JOURNEY_L4 = [
    card_scene("l4_0",
               "Journey four. Ship and tune. Release version zero point three, then adjust how often the agents ask, "
               "and what they cost.",
               "Journey 4", "Ship and tune", "Sofia Alvarez · Ben Carter",
               ["One-approval release", "Canary and rollback", "Autonomy and cost"]),
    scene("l4_1", "Release day. The DevOps Agent prepared release zero point three: forty-six merged changes, release "
                  "notes written for users, a canary plan, and an automatic rollback rule. Only one approval is "
                  "needed, from the release approver.", l4_1),
    scene("l4_2", "The pipeline, not a person, runs the deploy, so the approver and the deployer are separate by "
                  "design. Sofia checks the list, approves, and the canary starts at ten percent while the platform "
                  "watches errors and latency.", l4_2),
    scene("l4_3", "Afterwards Ben tunes the autonomy. The team runs in Balanced mode, and Guided and Autopilot are one "
                  "click away. Some stops never change in any mode: production deploys, protected paths, new outside "
                  "services, and budget overruns. Below those, triggers say when agents must ask. Agents can always "
                  "ask for more than the policy requires, but never less.", l4_3),
    scene("l4_4", "Costs stay visible too. There is a monthly budget, a cap per run, and a limit on concurrent runs. "
                  "This month the agents have used less than half the budget, and an alert fires at eighty "
                  "percent.", l4_4),
]


# ---------------------------------------------------------------- Journey 5: Humans in the loop
def l5_1(r):
    r.goto(BASE + "n5-1-attention-queue.html")
    r.at(0.0); r.hl("#cnt")
    r.at(0.3); r.hl("#q1")
    r.at(0.7); r.hl(hc("h3", "Blocked work"))


def l5_2(r):
    r.at(0.0); r.hl("#q1 .ctx")
    r.at(0.35); r.hl("#q1 .opts")
    r.at(0.75); r.hl("#q1 .row .chip.right")


def l5_3(r):
    r.at(0.0); r.click("#std1")
    r.at(0.35); r.click("#ans1")
    r.at(0.6); r.hl("#r1")


def l5_4(r):
    r.at(0.0); r.hl("#q2")
    r.at(0.4); r.hl("#q3")
    r.at(0.75); r.click("#dnta3")
    r.at(0.85); r.hl("#r3")


def l5_5(r):
    r.goto(BASE + "n5-3-chat-answers.html")
    r.at(0.0); r.hl("#slack")
    r.at(0.35); r.click("#sA")
    r.at(0.5); r.hl("#reply")
    r.at(0.75); r.hl(hc("h3", "What can be answered in chat"))


def l5_6(r):
    r.goto(BASE + "n5-2-assumptions.html")
    r.at(0.0); r.hl("#assumptions")
    r.at(0.4); r.click('tr[data-a="A-12"] .acc')
    r.at(0.6); r.click('tr[data-a="A-14"] .rej')
    r.at(0.8); r.hl("#result")


def l5_7(r):
    r.at(0.0); r.click('[data-tab="standing"]')
    r.at(0.15); r.hl('[data-pane="standing"] .card.flush')


def l5_8(r):
    r.goto(BASE + "n5-4-interruptions.html")
    r.at(0.0); r.hl("#tiles")
    r.at(0.35); r.hl("#suggestions")
    r.at(0.65); r.click('tr[data-s="UI copy changes"] .apply')
    r.at(0.8); r.hl("#applied")


JOURNEY_L5 = [
    card_scene("l5_0",
               "Journey five. Humans in the loop. This is the part that matters most. Agents will need people all the "
               "time, so the platform has to make those moments cheap, well timed, and rare. Here is a morning for "
               "Ben, and for Sofia.",
               "Journey 5", "Humans in the loop", "Ben Carter · Sofia Alvarez",
               ["Ranked attention queue", "Context and a recommendation", "Answer from Slack", "Standing decisions"]),
    scene("l5_1", "Ben opens his attention queue. Asks are ranked by what they block, then by deadline. Four are "
                  "waiting. No agent is idle: the Backend Agent is building invite emails while it waits on the weather "
                  "question, and nothing else is blocked.", l5_1),
    scene("l5_2", "Every ask is a card with its context: what the agent was doing, why it needs a person, and what is "
                  "waiting. The weather question lists three options with a recommendation, and a default that applies "
                  "in a few hours if nobody answers, because this one is safe to default. Ben can answer in a minute "
                  "without opening anything else.", l5_2),
    scene("l5_3", "Ben agrees with the recommendation, ticks use this answer from now on, and answers. The Backend Agent "
                  "continues with the free tier. The answer is saved as a standing decision, so agents will not ask "
                  "about the weather provider again, and the outside service is confirmed in the register.", l5_3),
    scene("l5_4", "The second ask is a review, because a new dependency fired a trigger. It blocks a merge, so it opens "
                  "the review pack. The third is only a question. The Frontend Agent is already using a sensible default "
                  "and declared it as an assumption, so nothing waits. Ben marks it as not needed, which teaches the "
                  "team where agents are too chatty.", l5_4),
    scene("l5_5", "Not everything needs the Workspace. In Slack, the same decision request shows up with its options as "
                  "buttons. Ben taps the recommended one, the reply is checked against his linked identity, and the ask "
                  "closes everywhere. Reviews and checkpoints that need real reading still open the Workspace, and quiet "
                  "hours hold everything except hard stops until morning.", l5_5),
    scene("l5_6", "Sofia reviews what agents assumed. Each assumption says who made it, how risky it is, and where it is "
                  "used. She accepts the invite expiry, which becomes a requirement, and rejects the temperature unit, "
                  "which sends that work back to the Frontend Agent. Nobody had to stop the agents to find out.", l5_6),
    scene("l5_7", "Standing decisions are the other half. Ben's date library choice has already answered nine questions "
                  "that agents would otherwise have asked. A decision can have an end date or a condition, so it does "
                  "not go stale.", l5_7),
    scene("l5_8", "After a month, the numbers show whether the platform is helping or nagging. Questions per merged pull "
                  "request are falling, and most answers match the recommendation. A few asks were marked unnecessary, "
                  "and the platform suggests making interface copy changes a pre-approved type. Ben applies it. Nothing "
                  "changes on its own, so people stay in control of how often agents interrupt.", l5_8),
]


# ---------------------------------------------------------------- Journey 6: Connections and setup
def l6_1(r):
    r.goto(BASE + "n6-1-github-connection.html")
    r.at(0.0); r.hl("#apps")
    r.at(0.45); r.hl("#inst")
    r.at(0.75); r.hl("#links")


def l6_2(r):
    r.at(0.0); r.hl("#planNote")
    r.at(0.55); r.select("#acct", "org")
    r.at(0.7); r.hl("#planNote")
    r.at(0.9); r.select("#acct", "personal")


def l6_3(r):
    r.goto(BASE + "n6-2-integrations.html")
    r.at(0.0); r.hl("#rows")
    r.at(0.3); r.hl("#entry")
    r.at(0.65); r.click("#confirm")
    r.at(0.8); r.hl("#egress")


def l6_4(r):
    r.goto(BASE + "n6-3-repos-and-gateway.html")
    r.at(0.0); r.hl("#registry")
    r.at(0.3); r.hl("#gateway")
    r.at(0.5); r.hl("#aliases")
    r.at(0.7); r.hl("#engines")


JOURNEY_L6 = [
    card_scene("l6_0",
               "Journey six. Connections and setup. The last piece is how the platform reaches your repositories, "
               "outside services, models and coding engines.",
               "Journey 6", "Connections and setup", "Ben Carter · Tech Lead",
               ["GitHub Apps", "Outside services", "Model gateway", "Engine per role"]),
    scene("l6_1", "Ben connects GitHub once. He registers two Apps through GitHub's manifest flow, and GitHub sends the "
                  "keys straight back to the platform. The agent App writes code to one repository at a time, with a "
                  "one-hour token. The gate App merges, and its key never enters a sandbox, so agents can never merge "
                  "or change branch protection. People still sign in with single sign-on, and link their GitHub account "
                  "once, so the platform knows who wrote or reviewed a commit.", l6_1),
    scene("l6_2", "This team is on a personal GitHub account with the free plan, and the platform says plainly what that "
                  "means. Direct mode works in private repositories. Protected branches need a paid plan. And the gate "
                  "App merges only when its own required check passes.", l6_2),
    scene("l6_3", "Agents also need to know about outside services. Each entry has the docs link, the hosts it may call, "
                  "what data is sent, and how to test it. The platform fetches the docs itself and saves a snapshot, and "
                  "treats them as untrusted text. Until Ben confirms the email provider, its host is not on the agent "
                  "allowlist, because a new host is always a hard stop.", l6_3),
    scene("l6_4", "Last, repositories, models and engines. Agents can touch only registered repositories. All model "
                  "traffic goes through one gateway. In development it uses OpenRouter, with separate keys for agents "
                  "and platform services, and sandboxes never see a key. Agents use aliases, so changing provider is a "
                  "configuration change. And the coding engine is a setting per role. Claude Code is active, Codex and "
                  "Copilot are planned, and the rules sit outside the engine, so every engine behaves the same.", l6_4),
    card_scene("l6_5",
               "Same platform, lighter touch. Agents draft and verify. People decide what ships, and they are asked at "
               "the right moments, with context and a recommendation. Routine changes flow on their own. And the whole "
               "thing runs on your laptop and in your own AWS account.",
               "Summary", "Agents do the work. People decide what matters.", "Asked at the right moment, with context.",
               ["Three checkpoints", "Humans in the loop", "Routine changes on autopilot", "Any engine, one workflow"]),
]


VIDEO_DIR = "trailmates"
FULL_ORDER = ["lintro", "L1", "L2", "L3", "L4", "L5", "L6"]
FULL_FILE = "00-end-to-end-demo.mp4"

JOURNEYS = {
    "lintro": {"file": None, "scenes": INTRO},
    "L1": {"file": "01-idea-to-approved-spec.mp4", "scenes": JOURNEY_L1},
    "L2": {"file": "02-build-a-feature.mp4", "scenes": JOURNEY_L2},
    "L3": {"file": "03-everyday-changes-on-autopilot.mp4", "scenes": JOURNEY_L3},
    "L4": {"file": "04-ship-and-tune.mp4", "scenes": JOURNEY_L4},
    "L5": {"file": "05-humans-in-the-loop.mp4", "scenes": JOURNEY_L5},
    "L6": {"file": "06-connections-and-setup.mp4", "scenes": JOURNEY_L6},
}
