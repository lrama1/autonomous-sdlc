"""Kestrel Market example: an online store with customer and employee journeys (core idea, spec v0.6).

Same conventions as storyboard.py. Pages live in designs/kestrel/. Run with:  --set storyboard_kestrel
"""
import re

BASE = "designs/kestrel/"


def spoken(text):
    """Spell out terms the voice would otherwise mispronounce (captions keep the original text)."""
    for pat, rep in [(r"\bQA\b", "Q A"), (r"\bSDLC\b", "S D L C"), (r"\bPDF\b", "P D F"),
                     (r"\bZPL\b", "Z P L"), (r"\bAPI\b", "A P I")]:
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
def e0_2(r):
    r.goto(BASE + "portfolio.html")
    r.at(0.0); r.hl(".grid.g4")
    r.at(0.3); r.hl("#initiatives")
    r.at(0.72); r.hl("#calendar")


INTRO = [
    card_scene(
        "eintro",
        "This second walk-through shows the same platform on an online store: Kestrel Market. It has customers who "
        "browse, buy and return things, and employees who run merchandising, fulfillment and support. Agents do the "
        "work and people are asked at the right moments. Most of the product runs with Balanced autonomy, but the money "
        "path gets a closer look: payment code always brings in the architect and security, a Q A checkpoint is "
        "switched on, and the release calendar holds normal releases during the change freeze. Everything you will see "
        "is a design mockup with sample data.",
        "End-to-end demo · Kestrel Market", "An online store, built by agents",
        "Balanced autonomy, with a closer look where money moves.",
        ["Example: an online store", "Customer and employee work", "Design mockups, sample data"]),
    scene(
        "eintro_2",
        "This is the portfolio, as the product owner sees it. Four initiatives and one release are in flight: checkout, "
        "and orders and returns for customers, plus merchandising and fulfillment tools for employees. Nadia sees what "
        "is waiting on her, the agent spend against the budget, and the release calendar, including the change freeze "
        "that starts on November eighteenth, just before Black Friday.", e0_2),
]


# ---------------------------------------------------------------- Journey 1: Customer, browse and checkout
def e1_1(r):
    r.goto(BASE + "map.html?i=301&s=s1")
    r.at(0.0); r.hl("#flow")
    r.at(0.45); r.hl("#chips")
    r.at(0.72); r.hl("#you")
    r.at(0.93); r.click_nav("#detail a.btn.primary")


def e1_2(r):
    r.at(0.0); r.hl('[data-pane="stories"] .card.flush')
    r.at(0.5); r.hl('tr:has-text("US-104")', 'tr:has-text("US-105")')


def e1_3(r):
    r.at(0.0); r.click('[data-tab="design"]')
    r.at(0.12); r.hl('[data-pane="design"] .card.flush')


def e1_4(r):
    r.at(0.0); r.click('[data-tab="scope"]')
    r.at(0.12); r.hl('[data-pane="scope"] .callout.warn')
    r.at(0.45); r.hl('[data-pane="scope"] .card.flush')


def e1_5(r):
    r.at(0.0); r.hl(hc("h3", "Approvals"))
    r.at(0.3); r.click("#apN")
    r.at(0.5); r.click("#apO")
    r.at(0.68); r.click("#apV")
    r.at(0.85); r.hl("#result")


def e1_6(r):
    r.goto(BASE + "c1-2-pr.html")
    r.at(0.0); r.hl('[data-pane="diff"] .callout.warn')
    r.at(0.55); r.hl(".diff .flag")


def e1_7(r):
    r.at(0.0); r.click('[data-tab="tests"]')
    r.at(0.12); r.hl('[data-pane="tests"] .grid.g2')


def e1_8(r):
    r.at(0.0); r.select("#viewAs", "lena")
    r.at(0.1); r.hl("#sod")
    r.at(0.28); r.select("#viewAs", "victor")
    r.at(0.36)
    for i in range(1, 5):
        r.click(f"#att li:nth-child({i}) input")
    r.at(0.72); r.click("#sign")
    r.at(0.82); r.hl("#result")


JOURNEY_E1 = [
    card_scene(
        "e1_0",
        "Journey one. Browse and checkout. Kestrel's customers search, fill a cart and pay. Checkout is where money "
        "moves, so this journey shows where the platform looks closer, even though most of the product runs with a "
        "light touch.",
        "Journey 1", "Customer: browse, cart and checkout", "Nadia Rahman · Owen Brooks · Victor Santos",
        ["Payment-scope triggers", "Security joins the review", "No auto-merge on payment paths"]),
    scene("e1_1", "Nadia opens the new checkout initiative. The map shows the four decisions this setup uses: spec and "
                  "design, change merge, verification, and release. The other four are greyed out as not required. A "
                  "chip at the top shows that payment-scope triggers are on, so the platform already knows the first "
                  "decision needs three people, including Victor from Security.", e1_1),
    scene("e1_2", "The Product Agent wrote seven stories, for shoppers and for support staff. Two are special: paying "
                  "without Kestrel ever seeing a card number, and placing an order safely even if the shopper "
                  "double-clicks. Those two are tagged as payment scope.", e1_2),
    scene("e1_3", "The Architect Agent wrote four short design notes, only for decisions that are hard to undo. Card "
                  "details go through the payment provider's hosted fields, so Kestrel stores only a token. The provider "
                  "sits behind a port, so it can be swapped. And orders carry idempotency keys, which is what makes "
                  "retries safe.", e1_3),
    scene("e1_4", "Then the payment-scope triggers come in. The paths where code handles payments are marked. "
                  "Changes there always need the Architect and Security, and are never merged automatically. Ordinary "
                  "checkout screens and the catalog follow the lighter rule: one peer reviewer.", e1_4),
    scene("e1_5", "Three people approve. Nadia as owner of the spec, Owen for the design, and Victor because the design "
                  "touches payment scope. Each approval is one click, recorded in the activity log. The "
                  "payment-scope triggers are now active on the repository, and the agents can start "
                  "building.", e1_5),
    scene("e1_6", "Skip ahead to the pull request. The agents ran the app against the provider's sandbox before opening "
                  "it. The platform's deterministic checks then spotted two things: a payment-scope path and a new "
                  "dependency. So auto-merge is off, and both the Architect and Security must review. A reviewer flag "
                  "points straight at what matters: no card data in logs, and no charge without an order.", e1_6),
    scene("e1_7", "The agents' report says a headless browser bought a product with a test card, and that clicking Pay "
                  "twice produced one order and one charge. That report is advisory. Continuous integration re-ran the "
                  "same checks in a fresh environment, and that independent result is what counts.", e1_7),
    scene("e1_8", "Lena started both agent runs, so the platform will not let her review this change. Victor can. He "
                  "ticks the security checklist: only a token is stored, retries cannot double charge, errors do not "
                  "leak details, and the tests cover both stories. Then he approves as Security. The Architect and a "
                  "peer engineer still have to approve before the Gate identity merges the change.", e1_8),
]


# ---------------------------------------------------------------- Journey 2: Customer, orders and returns
def e2_1(r):
    r.goto(BASE + "c2-1-agent-runs.html")
    r.at(0.0); r.hl("#runBE", "#runFE")


def e2_2(r):
    r.at(0.0); r.hl("#verify")


def e2_3(r):
    r.goto(BASE + "map.html?i=302&s=g4&u=chloe")
    r.at(0.0); r.hl('.gnode[data-g="G4"]')
    r.at(0.5); r.hl("#you")
    r.at(0.92); r.click_nav("#detail a.btn.primary")


def e2_4(r):
    r.at(0.0); r.hl(".grid.g4")
    r.at(0.4); r.hl("#browsers")


def e2_5(r):
    r.at(0.0); r.hl("#found")


def e2_6(r):
    r.at(0.0); r.hl(hc("h3", "Accessibility"), hc("h3", "Performance"))
    r.at(0.4); r.hl(hc("h3", "Checks"))
    r.at(0.68); r.click("#approve")
    r.at(0.82); r.hl("#result")


JOURNEY_E2 = [
    card_scene(
        "e2_0",
        "Journey two. Orders, tracking and returns. After buying, customers want to know where their order is, and to "
        "send things back without calling anyone. This journey shows the optional Q A checkpoint that Kestrel turned on: "
        "independent verification by a QA lead.",
        "Journey 2", "Customer: orders, tracking and returns", "Marcus Webb · Chloe Tan",
        ["Parallel agent runs", "Verify in a browser", "QA checkpoint"]),
    scene("e2_1", "Marcus starts two agent runs side by side: a Backend agent for tracking events and return "
                  "authorizations, and a Frontend agent for the order timeline and the return flow. Each agent works in "
                  "its own sandbox, with a token for just this repository, and writes the tests first.", e2_1),
    scene("e2_2", "Before opening a pull request, the frontend agent runs the real app in a headless browser, on a desktop "
                  "and on a small phone. It places an order, replays simulated carrier events, and checks that the return "
                  "button appears only inside the thirty-day window. This report is advisory.", e2_2),
    scene("e2_3", "Once the changes are merged, the initiative reaches the checkpoint that Kestrel added on top of the default "
                  "profile: verification. The map shows change merge done, and verification waiting on Chloe, the QA "
                  "Lead.", e2_3),
    scene("e2_4", "The QA Agent built a preview environment from the exact commit, then tested all six stories in five "
                  "browsers and devices. One hundred forty-two checks passed. Chloe sees a matrix, not a pile of "
                  "logs.", e2_4),
    scene("e2_5", "It also found a real defect. On a very small phone, a long product name pushed the Start a return "
                  "button off screen. The Frontend agent fixed it, and the QA Agent re-tested all five browsers. The "
                  "before and after screenshots are attached.", e2_5),
    scene("e2_6", "Accessibility and performance results are here too. Chloe did not write or start any of these "
                  "changes, so she can sign. One click, and the result is bound to the exact commit. The preview "
                  "environment is destroyed after sign-off, and the release manager can now include these changes.", e2_6),
]


# ---------------------------------------------------------------- Journey 3: Employee, merchandising
def e3_1(r):
    r.goto(BASE + "map.html?i=303&s=g3")
    r.at(0.0); r.hl("#flow")
    r.at(0.4); r.click('.gnode[data-g="G1"]')
    r.at(0.5); r.hl("#detail")
    r.at(0.93); r.click_nav("#detail a.btn.primary")


def e3_2(r):
    r.at(0.0); r.hl("#rows")


def e3_3(r):
    r.at(0.0); r.hl("#tiles")
    r.at(0.35); r.click("#rows tr:nth-child(3)")
    r.at(0.5); r.hl("#bc")


def e3_4(r):
    r.goto(BASE + "e1-1-merch-agent.html")
    r.at(0.0); r.hl("#runBE", "#runFE")


def e3_5(r):
    r.at(0.0); r.hl("#verify ul.checks")
    r.at(0.65); r.hl("#ui")


def e3_6(r):
    r.at(0.0); r.hl("#rollout .stage.now")
    r.at(0.5); r.hl("#rollout .callout")


JOURNEY_E3 = [
    card_scene(
        "e3_0",
        "Journey three. Merchandising. Not every product serves customers. This journey follows an internal tool: a "
        "promotions scheduler for the merchandising team. Here the platform's job is to turn the company's own "
        "business rules into something that is tested and traceable.",
        "Journey 3", "Employee: merchandising", "Nadia Rahman · Lena Fischer",
        ["Business rules as controls", "Fake-clock testing", "Pilot rollout"]),
    scene("e3_1", "The initiative has the same four decisions as the customer work, but its first checkpoint carries the "
                  "business rules the merchandising team cares about. The first decision is already done, and Nadia "
                  "opens the product controls it produced.", e3_1),
    scene("e3_2", "Five rules, written in the team's own words. A discount over forty percent needs a second approver. No "
                  "product is priced below cost. Promotions cannot overlap. Every price change is logged. And a "
                  "promotion can be previewed before it goes live. They are the rules the team decided matter.", e3_2),
    scene("e3_3", "Each rule has an owner, a story, tests tagged with the rule's number, and a verified sandbox "
                  "run. Open the overlap rule and you see where it is enforced, how many tests protect it, and the "
                  "run that verified it. If a rule ever has no test, it shows up here as a gap.", e3_3),
    scene("e3_4", "Lena starts a Backend and a Frontend agent. They read the five rules first and write thirty-eight "
                  "tests, each tagged with the rule it protects. Then they build the scheduler.", e3_4),
    scene("e3_5", "A promotion can start next Friday at midnight, and an agent cannot wait a week. So it uses a fake "
                  "clock. It checks that the sale price is not active one second before midnight, goes live at midnight, "
                  "ends on Sunday night, and ignores daylight saving. It also confirms that a forty-five percent "
                  "discount waits for a second approver.", e3_5),
    scene("e3_6", "The rollout plan limits the blast radius. First a pilot with three merchandisers, while the old manual "
                  "process stays available. Then all twelve. And a kill switch turns the scheduler off in one click, with "
                  "no deploy. Internal tools get the same care as customer features, scaled to their risk.", e3_6),
]


# ---------------------------------------------------------------- Journey 4: Employee, fulfillment and support
def e4_1(r):
    r.goto(BASE + "controls.html?i=304")
    r.at(0.0); r.hl("#rows")
    r.at(0.7); r.hl("#tiles")


def e4_2(r):
    r.at(0.0); r.hl("#bc")
    r.at(0.9); r.click_nav("#bc a")


def e4_3(r):
    r.at(0.0); r.hl(".callout.warn")
    r.at(0.3); r.hl("#impact")


def e4_4(r):
    r.at(0.0); r.hl("#diff")


def e4_5(r):
    r.at(0.0); r.hl(hc("h3", "Approvals"))
    r.at(0.35); r.click("#apNadia")
    r.at(0.55); r.click("#apOwen")
    r.at(0.75); r.hl("#result")


def e4_6(r):
    r.at(0.0); r.hl(hc("h3", "Schedule check"))


JOURNEY_E4 = [
    card_scene(
        "e4_0",
        "Journey four. Fulfillment and support. Warehouse staff and support agents use tools that handle customer data "
        "and money. And requirements here can change from the outside. This journey shows what happens when a shipping "
        "carrier changes its label format in the middle of the project.",
        "Journey 4", "Employee: fulfillment and support", "Aisha Khan · Nadia Rahman · Owen Brooks",
        ["Business rules", "Scope change", "Impact analysis"]),
    scene("e4_1", "These tools have their own rules. A refund over two hundred dollars needs a second person. Customer "
                  "details are masked, and every reveal is logged. The scanned item must match the order line. Each "
                  "shipment gets one label. Large inventory adjustments need a second person. Four rules are verified. "
                  "One is flagged.", e4_1),
    scene("e4_2", "The flagged rule is one label per shipment. The carrier switches its label format on November "
                  "twelfth, and the rule's code and tests are built around the old format. The platform shows that this "
                  "rule needs a change request, instead of letting someone quietly edit the code.", e4_2),
    scene("e4_3", "Aisha, from Operations, raised the change request. The Product Agent prepared an impact analysis from "
                  "the traceability graph. One requirement changes. One business rule keeps its meaning, but four tests "
                  "need new expected output. One file changes. And returns are unaffected, because their labels "
                  "already arrive as PDF.", e4_3),
    scene("e4_4", "Here is the spec diff. The requirement said labels print in ZPL format. The proposed wording says "
                  "PDF, four by six inches, on the thermal printers and the desktop printer. The approved spec "
                  "changes only where the change request says so. Everything else stays approved.", e4_4),
    scene("e4_5", "Nadia approves as the owner of the requirement, and Owen approves the design impact. Aisha raised the "
                  "request, so she cannot approve it herself. Both approvals are recorded, a new spec version is saved, "
                  "and the Backend agent starts the change.", e4_5),
    scene("e4_6", "The schedule check confirms the change fits before the November tenth release and the carrier's "
                  "deadline. It re-enters the flow at change merge, then verification, then release. Anything it did not "
                  "touch stays approved as it was.", e4_6),
]


# ---------------------------------------------------------------- Journey 5: Peak season
def e5_1(r):
    r.goto(BASE + "map.html?i=R42&s=g6&u=dmitri")
    r.at(0.0); r.hl("#flow")
    r.at(0.6); r.hl("#you")
    r.at(0.93); r.click_nav("#detail a.btn.primary")


def e5_2(r):
    r.at(0.0); r.hl(".grid.g4")
    r.at(0.4); r.hl("#load")


def e5_3(r):
    r.at(0.0); r.hl("#checklist")


def e5_4(r):
    r.at(0.0); r.hl("#canary")


def e5_5(r):
    r.at(0.0); r.hl(hc("h3", "Your approval"))
    r.at(0.45); r.click("#approve")
    r.at(0.65); r.hl("#result")


def e5_6(r):
    r.goto(BASE + "r-2-incident.html")
    r.at(0.0); r.hl(".callout.dev")
    r.at(0.55); r.hl(".page-head")


def e5_7(r):
    r.at(0.0); r.hl("#what")


def e5_8(r):
    r.at(0.0); r.hl("#dev")
    r.at(0.65); r.hl("#posthoc")


JOURNEY_E5 = [
    card_scene(
        "e5_0",
        "Journey five. Peak season. For an online store, the weeks around Black Friday are when mistakes cost the most. "
        "This journey shows a release with business-aware safety checks, and then a real emergency that happens inside "
        "the change freeze.",
        "Journey 5", "Peak-season release and incident", "Dmitri Volkov · Aisha Khan",
        ["Load test", "Change-freeze calendar", "Business-metric rollback", "Hotfix path"]),
    scene("e5_1", "Release four point two bundles sixty-three changes from the four initiatives. Every earlier decision "
                  "is done. The last one is the release, and it waits on Dmitri, the Release Manager.", e5_1),
    scene("e5_2", "The DevOps Agent prepared the readiness pack. Sixty-three changes, twenty-one of them routine and "
                  "pre-approved, no failing checks, and eight days until the freeze. Traffic at three times last year's "
                  "Black Friday peak ran against a copy of production, and checkout stayed well inside its limits.", e5_2),
    scene("e5_3", "The checklist includes the freeze calendar. November tenth is before the freeze starts on the "
                  "eighteenth. After that, only security fixes and hotfixes may ship. Kill switches are ready, "
                  "the rollback was rehearsed, and the payment-scope change had its extra approvals.", e5_3),
    scene("e5_4", "The canary goes to five percent of shoppers, then twenty-five, then everyone. And it rolls back "
                  "automatically on business signals, not only on errors: conversion dropping more than three percent "
                  "against a control group, payment failures above one and a half percent, or slow checkout.", e5_4),
    scene("e5_5", "Dmitri did not write or start any change in this release, so he can approve. One click approves the "
                  "release, and the pipeline starts the canary. Dmitri never deploys by hand.", e5_5),
    scene("e5_6", "Now fast forward to the Tuesday before Black Friday, inside the freeze. The tax provider starts timing "
                  "out, and six percent of checkouts fail. Waiting for the next release is not an option, so Aisha "
                  "declares a hotfix.", e5_6),
    scene("e5_7", "The platform allows it, with conditions. Dmitri approves as the named hotfix approver, a single "
                  "approval. The fix is one file: a circuit breaker, and cached tax rates behind a flag. It rolls out "
                  "as a five percent canary, and the error rate falls to point two percent.", e5_7),
    scene("e5_8", "A follow-up is opened automatically. It records which checks were skipped, which safeguards were "
                  "used, and what is needed to close it, including finance reconciling the estimated tax. Normal "
                  "releases are held until it is closed. The hotfix path is a fast path with a paper trail, "
                  "not a loophole.", e5_8),
    card_scene(
        "e5_9",
        "Same platform, tuned to the business. A light process for most of the work. A closer look where money moves. "
        "Independent verification before release. And a hotfix path that stays accountable. Everything is "
        "recorded.",
        "Summary", "Light where it can be, closer where money moves.", "One platform, tuned to the business.",
        ["Payment-scope triggers", "Business rules as controls", "Freeze calendar and hotfix path", "Everything recorded"]),
]


VIDEO_DIR = "kestrel"
FULL_ORDER = ["eintro", "E1", "E2", "E3", "E4", "E5"]
FULL_FILE = "00-end-to-end-demo.mp4"

JOURNEYS = {
    "eintro": {"file": None, "scenes": INTRO},
    "E1": {"file": "01-customer-browse-and-checkout.mp4", "scenes": JOURNEY_E1},
    "E2": {"file": "02-customer-orders-and-returns.mp4", "scenes": JOURNEY_E2},
    "E3": {"file": "03-employee-merchandising.mp4", "scenes": JOURNEY_E3},
    "E4": {"file": "04-employee-fulfillment-and-support.mp4", "scenes": JOURNEY_E4},
    "E5": {"file": "05-peak-season-release-and-incident.mp4", "scenes": JOURNEY_E5},
}
