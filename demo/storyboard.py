"""Narration and on-screen actions for each demo journey.

Each scene: narration text (also used as the on-screen caption) and a function that drives the mockups.
r.at(f) waits until fraction f of the way through that scene's narration, so actions land on the words.
"""


def scene(sid, text, run, say=None):
    return {"id": sid, "text": text, "say": say or text, "run": run, "card": False}


def card_scene(sid, text, tag, title, sub="", chips=()):
    return {"id": sid, "text": text, "say": text, "card": True,
            "run": lambda r: r.card(sid, tag, title, sub, chips)}


def hl_card(title_tag, heading):
    return f'.card:has({title_tag}:has-text("{heading}"))'


# ---------------------------------------------------------------- Intro
INTRO = [
    card_scene(
        "intro",
        "This is a walk-through of a platform where AI agents do the drafting, coding and testing, but only people "
        "in the right roles can approve. Every decision is signed, kept separate from the author, and traceable from "
        "requirement to release. So the audit evidence is a by-product of the work, not a project after it. "
        "The example is a medical-device team building a dose calculation service. Everything you will see is a "
        "design mockup with sample data.",
        "End-to-end demo", "Compliance-grade, role-mirrored SDLC",
        "AI agents draft. Humans in the right roles decide. Evidence is a by-product.",
        ["Example: a medical-device team", "Design mockups, sample data"]),
]


# ---------------------------------------------------------------- Journey A
def a1(r):
    r.goto("designs/01-sign-in.html")
    r.at(0.0); r.hl("a.btn.primary", scroll=False)
    r.at(0.5); r.hl(".callout.info", scroll=False)


def a2(r):
    r.goto("designs/02-new-initiative.html")
    r.at(0.1); r.hl('[data-step="1"] textarea', scroll=False)
    r.at(0.5); r.hl('[data-step="1"] .callout.warn', scroll=False)
    r.at(0.93); r.click('[data-step="1"] button:has-text("Continue")')


def a3(r):
    r.at(0.0); r.hl(hl_card("h2", "Compliance profile"))
    r.at(0.28); r.hl(hl_card("h2", "Strictness level"))
    r.at(0.6); r.hl(hl_card("h2", "Repository"))
    r.at(0.95); r.click('[data-step="2"] button:has-text("Continue")')


def a4(r):
    r.at(0.0); r.hl('[data-step="3"] .card.flush')
    r.at(0.5); r.hl('[data-step="3"] ' + hl_card("h3", "SoD preflight"))
    r.at(0.93); r.click_nav("a.btn.primary:has-text('Create initiative')")


def a5(r):
    r.at(0.0); r.select("#snap", "s1")
    r.at(0.35); r.hl('.gnode[data-g="G1"]')
    r.at(0.7); r.hl("#you")


def a6(r):
    r.goto("designs/03-inbox.html")
    r.at(0.0); r.hl(".card.flush")
    r.at(0.55); r.hl(".callout.info", scroll=False)
    r.at(0.92); r.click_nav("a.btn.primary.sm:has-text('Open review pack')")


def a7(r):
    r.at(0.0); r.hl('[data-pane="req"] .card.flush')
    r.at(0.5); r.click('[data-tab="asm"]')
    r.at(0.68); r.hl('[data-pane="asm"] .callout.warn')


def a8(r):
    r.at(0.0); r.select("#a3", "Accept")
    r.at(0.3); r.hl("#checks")
    r.at(0.58); r.hl(hl_card("h3", "Who must sign"))
    r.at(0.9); r.click_nav("#signBtn")


def a9(r):
    r.at(0.0); r.hl("#s1 dl.kv")
    r.at(0.55); r.hl("#s1 textarea")
    r.at(0.92); r.click("#next")


def a10(r):
    r.at(0.0); r.hl("#s2 .callout")
    r.at(0.65); r.click("#next")


def a11(r):
    r.at(0.0); r.hl("#s3 .callout")
    r.at(0.4); r.hl("#s3 dl.kv")


JOURNEY_A = [
    card_scene("a0",
               "Journey A. Meet Priya, the product owner. She wants a dose calculation service for an infusion pump. "
               "Let's follow her from stating the goal to signing the requirements.",
               "Journey A", "From goal to approved requirements", "Priya Nair · Product Owner · Day 1",
               ["Initiative setup", "Review pack", "Signed evidence"]),
    scene("a1", "Priya signs in through her company's single sign-on. Signing in does not give her approval power. "
                "Authority comes only from the role she has been assigned.", a1),
    scene("a2", "She creates an initiative and states the goal in plain language. The Product Agent suggests a software "
                "safety class, but that suggestion is only advisory. A quality and regulatory person must confirm it "
                "before it counts.", a2),
    scene("a3", "Next she chooses a compliance profile and a strictness level. This deployment's floor is Controlled, "
                "so the Sandbox level is not even offered. Agents may only work in repositories from an approved list, "
                "and here they can only propose changes through pull requests.", a3),
    scene("a4", "Roles are assigned up front, and the platform checks separation of duties before any work starts. "
                "Eight distinct people are assigned. The person who deploys cannot also approve releases, and "
                "administrators hold no approval power.", a4),
    scene("a5", "Everyone works from the same pipeline map. The first gate is signed. The Product Agent has drafted the "
                "requirements, so the next gate is waiting on a human, and the map shows exactly where Priya's "
                "interaction sits.", a5),
    scene("a6", "In her inbox, Priya sees only what needs her judgment: the requirements approval, and a question from "
                "the agent. Chat notifications only link here. Approvals are signed only inside the platform.", a6),
    scene("a7", "The review pack shows twelve requirements with acceptance criteria and links to hazards. The agent also "
                "declared four assumptions. Priya must decide on each one before she can sign.", a7),
    scene("a8", "She accepts the last open assumption. The gate checks turn green and the sign button unlocks. Priya may "
                "approve as the accountable owner, but a second, independent person from quality must also co-sign.", a8),
    scene("a9", "Before signing, she sees exactly what she is approving: the commit and a content hash. If any file "
                "changes, this review is invalidated. She confirms the meaning of her signature and records her "
                "rationale.", a9),
    scene("a10", "Signing needs a fresh two-factor check, separate from logging in.", a10),
    scene("a11", "The decision is written to a tamper-evident ledger. Each record includes the hash of the one before it "
                 "and is signed by the platform's key. Once the independent quality reviewer co-signs, the requirements "
                 "baseline freezes and the architecture agent can begin.", a11),
]


# ---------------------------------------------------------------- Journey B
def b1(r):
    r.goto("designs/06-sdlc-map.html")
    r.at(0.0); r.hl('.gnode[data-g="G3"]')
    r.at(0.6); r.hl("#bl", scroll=False)


def b2(r):
    r.goto("designs/07-agent-session.html")
    r.at(0.0); r.hl(hl_card("h3", "Progress"))
    r.at(0.7); r.hl(hl_card("h3", "Assumption declared"))


def b3(r):
    r.at(0.0); r.hl(hl_card("h3", "Run record"))


def b4(r):
    r.at(0.0); r.hl("li:has-text('Verify in sandbox')")


def b5(r):
    r.at(0.0); r.hl(hl_card("h3", "Steer this run"))
    r.at(0.5); r.hl(hl_card("h3", "Steer this run") + " .callout")


def b6(r):
    r.goto("designs/08-review-g3-pull-request.html")
    r.at(0.0); r.hl('[data-pane="diff"] .callout.warn')
    r.at(0.55); r.hl(".diff .flag")


def b7(r):
    r.at(0.0); r.click('[data-tab="tests"]')
    r.at(0.25); r.hl('[data-pane="tests"] .grid.g2')


def b8(r):
    r.at(0.0); r.select("#viewAs", "dana")
    r.at(0.35); r.hl("#sod")
    r.at(0.7); r.hl("#sign")


def b9(r):
    r.at(0.0); r.select("#viewAs", "ethan")
    for i in range(1, 5):
        r.click(f"#att li:nth-child({i}) input")
    r.hl("#sign")


def b10(r):
    r.goto("designs/09-traceability.html")
    r.at(0.0); r.hl('[data-pane="matrix"]')
    r.at(0.35); r.click('[data-tab="graph"]'); r.hl('[data-pane="graph"]')
    r.at(0.65); r.click('[data-tab="gaps"]'); r.hl('[data-pane="gaps"]')


JOURNEY_B = [
    card_scene("b0",
               "Journey B. Now the engineers, Dana and Ethan, and the AI agents that do the building. The requirements "
               "and architecture are approved, so implementation can start.",
               "Journey B", "Building under control", "Dana Okafor and Ethan Brooks · Backend Engineers · Day 3",
               ["Agent sandbox", "Verify before PR", "Separation of duties"]),
    scene("b1", "Engineering is under way. The change-merge gate is active. The map shows how much evidence each gate has "
                "collected, and the baselines that are already frozen behind us.", b1),
    scene("b2", "Dana asks the Backend Engineer Agent to implement two requirements, and she can watch it work. It reads "
                "the requirements and the architecture decision, writes tests first, and declares an assumption for a "
                "human to resolve.", b2),
    scene("b3", "The agent runs in an isolated sandbox with a short-lived access token for a single repository, and it "
                "cannot merge. Every run is recorded, including the agent version, the pinned model, and the cost.", b3),
    scene("b4", "Before opening a pull request, the agent has to prove its own work. It runs the tests, starts the "
                "application, checks that it is healthy, and runs smoke tests. Only if all of that passes does it open "
                "a pull request against the main branch.", b4),
    scene("b5", "Dana can steer the agent, but there is a catch. Steering makes her a contributor, and contributors are "
                "later barred from approving that change.", b5),
    scene("b6", "Now Ethan reviews the pull request. The platform has flagged two things automatically: a "
                "safety-relevant code path that needs the architect's review, and a new dependency that needs "
                "evaluation.", b6),
    scene("b7", "The agent's own verification report is shown, but marked advisory. The platform also re-runs the same "
                "checks independently in continuous integration, and that independent result is the evidence that "
                "counts.", b7),
    scene("b8", "Now watch what happens if Dana, who started this agent run, tries to approve it. The platform blocks "
                "her. A different engineer must review.", b8),
    scene("b9", "Ethan is eligible. He ticks his review attestations and signs, using the same step-up signing flow.", b9),
    scene("b10", "Meanwhile, quality assurance sees traceability built automatically from identifiers in the repository. "
                 "Requirements link to design decisions, code, tests, results and risk controls. The platform found "
                 "gaps: one requirement has no test, and two items have no requirement. Those block the verification "
                 "and release gates until they are fixed.", b10),
]


# ---------------------------------------------------------------- Journey C
def c1(r):
    r.goto("designs/10-release-authorization.html")
    r.at(0.0); r.hl(".grid.g4")
    r.at(0.5); r.hl(".card.flush")


def c2(r):
    r.at(0.0); r.hl(hl_card("h3", "policy checks"))
    r.at(0.7); r.hl(".callout.info.small")


def c3(r):
    r.goto("designs/11-evidence-record.html")
    r.at(0.0); r.hl(hl_card("h2", "Decision"))
    r.at(0.55); r.hl(hl_card("h3", "Chain"))


def c4(r):
    r.at(0.0); r.hl(hl_card("h3", "Integrity"))
    r.at(0.5); r.hl(hl_card("h3", "Verify independently"))


def c5(r):
    r.goto("designs/12-audit-mode.html")
    r.at(0.0); r.hl(hl_card("h2", "Decision timeline"))
    r.at(0.3); r.slide("#slider", 12, 5, step=-1, delay=0.2)
    r.at(0.55); r.slide("#slider", 5, 12, step=1, delay=0.12)
    r.at(0.8); r.hl(hl_card("h3", "Control summary"))


def c6(r):
    r.at(0.0); r.click("#exportBtn")
    r.at(0.3); r.hl("#exp")


JOURNEY_C = [
    card_scene("c0",
               "Journey C. It is day nine. The work is done and it is time to release. Afterwards, an auditor looks at "
               "everything.",
               "Journey C", "Release and audit", "Rita Haddad · Sam Ivanova · Alex Morgan · Day 9 to 12",
               ["Release gate", "Evidence chain", "Auditor view"]),
    scene("c1", "The DevOps Agent has assembled release candidate two: evidence from every gate, the software bill of "
                "materials, and a complete traceability matrix. The release needs two signatures, one from the release "
                "approver and one from quality.", c1),
    scene("c2", "The platform checks separation of duties. The release approver is not the person who deploys. Neither "
                "approver authored any change in this release. And there are no open deviations. Only after both sign "
                "does the deploy action unlock, and only for the deployer.", c2),
    scene("c3", "Every signature becomes an evidence record: who signed, in which role, which exact files by hash, their "
                "rationale, and which AI runs contributed. Records are chained together, so changing one would break "
                "the chain.", c3),
    scene("c4", "An auditor can verify a bundle offline with a command-line tool, without trusting the platform's user "
                "interface.", c4),
    scene("c5", "Alex, the auditor, has read-only access. He can replay the state of the initiative as of any day with "
                "the slider, and see every decision with its signer and role. The control summary shows no "
                "separation-of-duties violations and no bypasses of the git gate.", c5),
    scene("c6", "One click exports an evidence bundle: the records and chain proof, the traceability matrix, the "
                "artifacts at the signed commits, and the verifier tool.", c6),
]


# ---------------------------------------------------------------- Journey D
def d1(r):
    r.goto("designs/13-agent-governance.html")
    r.at(0.0); r.hl(".card.flush")
    r.at(0.4); r.hl(hl_card("h2", "MCR-0008"))
    r.at(0.8); r.hl(".btn.primary.disabled")


def d2(r):
    r.goto("designs/14-roles-and-sod.html")
    r.at(0.0); r.hl(hl_card("h2", "Pending change"))
    r.at(0.6); r.hl(".card.flush")


def d3(r):
    r.goto("designs/16-strictness-and-repos.html")
    r.at(0.0); r.hl(hl_card("h3", "Deployment floor"))
    r.at(0.35); r.hl(".card.flush")
    r.at(0.7); r.hl(hl_card("h3", "Model gateways"))


def d4(r):
    r.at(0.0); r.select("#dep", "sbx")
    r.at(0.3); r.hl("#banner")
    r.at(0.55); r.hl(".card.flush")
    r.at(0.78); r.hl(hl_card("h3", "Model gateways"))


def d5(r):
    r.goto("designs/15-emergency-change.html")
    r.at(0.0); r.hl(".callout.dev")
    r.at(0.55); r.hl(hl_card("h2", "Deviation DEV-009"))


JOURNEY_D = [
    card_scene("d0",
               "Journey D. The platform also governs the agents themselves, who is allowed to approve, which "
               "repositories agents may touch, and what happens in an emergency.",
               "Journey D", "Governing agents and exceptions", "Sam Ivanova · Jordan Lee",
               ["Agent governance", "Strictness levels", "Break-glass"]),
    scene("d1", "AI agents are controlled items. Every agent definition has an approved version, and the model it uses "
                "is pinned. A proposed model upgrade must pass a requalification suite. Here the candidate fails two "
                "cases, so approval is blocked until they are fixed.", d1),
    scene("d2", "Role assignments are controlled too. Someone is trying to make the deployer a release approver. The "
                "platform blocks it because it breaks separation of duties. An exception would need a second "
                "authorizer, and it would appear in the audit summary.", d2),
    scene("d3", "Now strictness and repositories. In the production deployment the floor is Controlled. Agents can only "
                "touch registered repositories, each with a data class and a write mode. Models come from the "
                "customer's own cloud account. OpenRouter is not available.", d3),
    scene("d4", "For testing, switch to the sandbox deployment. The floor is Sandbox. Agents may commit directly to "
                "registered test repositories, and OpenRouter is enabled with a dedicated, capped key. Everything "
                "produced here is labelled as not compliance evidence, is watermarked, and can never be used to "
                "release to production.", d4),
    scene("d5", "Finally, emergencies. The break-glass path lets one named approver authorize an urgent fix. But it "
                "automatically opens a deviation, blocks future releases until that is closed, and requires a "
                "post-hoc review within twenty-four hours.", d5),
    card_scene("d6",
               "Agents draft. Humans decide. Evidence is a by-product. That is the platform: the speed of AI, with "
               "accountability that stands up to an audit.",
               "Summary", "Agents draft. Humans decide.", "Evidence is a by-product.",
               ["Separation of duties", "Signed, chained evidence", "Controlled agents", "Strictness you can dial"]),
]


VIDEO_DIR = "_parked-compliance-pack/medical-device"   # output folder under videos/
FULL_ORDER = ["intro", "A", "B", "C", "D"]
FULL_FILE = "00-end-to-end-demo.mp4"

JOURNEYS = {
    "intro": {"file": None, "scenes": INTRO},
    "A": {"file": "01-journey-a-goal-to-approved-requirements.mp4", "scenes": JOURNEY_A},
    "B": {"file": "02-journey-b-building-under-control.mp4", "scenes": JOURNEY_B},
    "C": {"file": "03-journey-c-release-and-audit.mp4", "scenes": JOURNEY_C},
    "D": {"file": "04-journey-d-governing-agents-and-exceptions.mp4", "scenes": JOURNEY_D},
}
