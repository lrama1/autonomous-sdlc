"""Harbor Retirement example: five IRA journeys built with the SDLC platform.

Same conventions as storyboard.py. Pages live in designs/retirement/. Run with:  --set storyboard_retirement
"""
import re

BASE = "designs/retirement/"


def spoken(text):
    """Spell out terms the voice would otherwise mispronounce (captions keep the original text)."""
    for pat, rep in [(r"\bIRAs\b", "I R As"), (r"\bIRA\b", "I R A"), (r"\bACH\b", "A C H"), (r"\bRMDs\b", "R M Ds"),
                     (r"\bRMD\b", "R M D"), (r"\bQA\b", "Q A"), (r"\bSOX\b", "S O X"), (r"\bCIP\b", "C I P")]:
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
    "rintro",
    "This second walk-through uses a different example: Harbor Retirement, a digital provider of individual retirement "
    "accounts, or IRAs. A small team will build five customer journeys: opening an account, funding it, managing the "
    "portfolio, moving money, and managing the customer profile. AI agents draft, code and test. People in the right "
    "roles approve, and every decision leaves signed evidence. In a financial firm, the quality and regulatory role is "
    "played by compliance and risk. Everything shown is a design mockup with sample data, and regulatory references are "
    "illustrative, not legal advice.",
    "End-to-end demo · Harbor Retirement", "Building a retirement platform with AI agents",
    "Five journeys: open, fund, manage, move money, profile.",
    ["Example: a digital IRA provider", "Design mockups, sample data"])]


# ---------------------------------------------------------------- Journey 1: Account opening
def r1_1(r):
    r.goto(BASE + "j1-1-new-initiative.html")
    r.at(0.0); r.hl(hc("h2", "Goal and scope"))
    r.at(0.5); r.hl(".callout.warn")


def r1_2(r):
    r.at(0.0); r.hl(hc("h2", "Compliance profile"))
    r.at(0.35); r.hl(hc("h2", "Strictness level"))
    r.at(0.7); r.hl(hc("h2", "Repository"))


def r1_3(r):
    r.at(0.0); r.hl(".card.flush")
    r.at(0.4); r.hl(hc("h3", "SoD preflight"))
    r.at(0.92); r.click_nav("a.btn.primary:has-text('Create initiative')")


def r1_4(r):
    r.at(0.0); r.hl('.gnode[data-g="G1"]')
    r.at(0.45); r.click('.gnode[data-g="G1"]')
    r.at(0.55); r.hl("#detail")
    r.at(0.9); r.click_nav("#detail a.btn.primary")


def r1_5(r):
    r.at(0.0); r.hl('[data-pane="req"] .card.flush')
    r.at(0.28); r.hl('tr:has-text("REQ-102")')
    r.at(0.52); r.hl('tr:has-text("REQ-104")')
    r.at(0.76); r.hl('tr:has-text("REQ-105")')


def r1_6(r):
    r.at(0.0); r.click('[data-tab="map"]')
    r.at(0.08); r.hl('[data-pane="map"] .card.flush')
    r.at(0.55); r.click('[data-tab="asm"]')
    r.at(0.68); r.hl('[data-pane="asm"] .callout.warn')


def r1_7(r):
    r.at(0.0); r.select("#a3", "Accept")
    r.at(0.3); r.hl("#checks")
    r.at(0.58); r.hl(hc("h3", "Who must sign"))
    r.at(0.92); r.click_nav("#signBtn")


def r1_8(r):
    r.at(0.0); r.hl("#s1 dl.kv")
    r.at(0.28); r.hl("#s1 textarea")
    r.at(0.45); r.click("#next")
    r.at(0.5); r.hl("#s2 .callout")
    r.at(0.64); r.click("#next")
    r.at(0.7); r.hl("#s3 .callout")
    r.at(0.88); r.hl("#s3 dl.kv")


JOURNEY_R1 = [
    card_scene("r1_0",
               "Journey one. Account opening. Maya, the product owner, wants customers to open a Traditional, Roth or "
               "Rollover IRA online, in one sitting.",
               "Journey 1", "Account opening", "Traditional, Roth and Rollover IRAs · Maya Patel, Product Owner",
               ["Initiative setup", "Requirements review", "Signed evidence"]),
    scene("r1_1", "Maya creates an initiative and states the goal in plain language. The Product Agent notes that this "
                  "touches customer identification, tax rules that differ by account type, and electronic disclosures, "
                  "and it flags that compliance must confirm that classification.", r1_1),
    scene("r1_2", "She selects the financial-services profile, a preview aimed at SOX and SOC 2 change control, and the "
                  "retirement controls pack. Because this handles identity and money, she sets the strictness level to "
                  "Regulated. Agents can only work in the approved repository, and only through pull requests.", r1_2),
    scene("r1_3", "Before any work starts, the platform checks separation of duties. Compliance is independent from "
                  "engineering and product, the person who deploys cannot approve releases, and nine distinct people "
                  "are assigned.", r1_3),
    scene("r1_4", "The map shows the first gate signed, and the Product Agent has drafted requirements for all three "
                  "account types. The next decision waits on Maya, and the map shows exactly where.", r1_4),
    scene("r1_5", "The review pack lists twelve requirements, and each one maps to a control. Identity must be verified "
                  "before an account activates. Roth eligibility is checked against income limits that come from "
                  "tax-year configuration, so they are never hard-coded. And rollovers capture the source plan, and "
                  "start a sixty-day tracker for indirect moves.", r1_5),
    scene("r1_6", "A compliance map ties each control to the requirements that implement it and to the rule behind it, "
                  "so Elena can review intent, not just wording. The agent also declared four assumptions, and Maya "
                  "must decide each one before she can sign.", r1_6),
    scene("r1_7", "She defers spousal and inherited IRAs, and accepts that assumption. The gate checks turn green and "
                  "signing unlocks. Maya can approve as the accountable owner, but a second, independent signature "
                  "from compliance is still required.", r1_7),
    scene("r1_8", "Before signing, Maya sees exactly what she is approving: the commit and a content hash. She records "
                  "her rationale, passes a fresh two-factor check, and the decision lands in a tamper-evident ledger. "
                  "When Elena co-signs, the requirements baseline freezes and architecture begins.", r1_8),
]


# ---------------------------------------------------------------- Journey 2: Account funding
def r2_1(r):
    r.goto(BASE + "map.html?i=102&s=g3&u=carlos")
    r.at(0.0); r.hl('.gnode[data-g="G3"]')
    r.at(0.6); r.hl("#chips", scroll=False)


def r2_2(r):
    r.goto(BASE + "j2-1-agent-session.html")
    r.at(0.0); r.hl(hc("h3", "Progress"))


def r2_3(r):
    r.at(0.0); r.hl('li:has-text("Declared assumption A-6")')
    r.at(0.55); r.hl(hc("h3", "Assumption declared"))


def r2_4(r):
    r.at(0.0); r.hl(".stream")
    r.at(0.5); r.hl(hc("h3", "Run record"))


def r2_5(r):
    r.at(0.0); r.hl('li:has-text("Verify in sandbox")')


def r2_6(r):
    r.goto(BASE + "j2-2-review-pr.html")
    r.at(0.0); r.hl('[data-pane="diff"] .callout.warn')
    r.at(0.5); r.hl(".diff .flag")


def r2_7(r):
    r.at(0.0); r.click('[data-tab="tests"]')
    r.at(0.25); r.hl('[data-pane="tests"] .grid.g2')


def r2_8(r):
    r.at(0.0); r.select("#viewAs", "carlos")
    r.at(0.2); r.hl("#sod")
    r.at(0.45); r.select("#viewAs", "hannah")
    for i in range(1, 5):
        r.click(f"#att li:nth-child({i}) input")
    r.hl("#sign")


JOURNEY_R2 = [
    card_scene("r2_0",
               "Journey two. Account funding. Carlos and Hannah, two backend engineers, build how customers put money "
               "into an IRA.",
               "Journey 2", "Account funding", "Carlos Diaz and Hannah Wright · Backend Engineers",
               ["ACH funding", "Annual limits", "Safe retries"]),
    scene("r2_1", "Requirements and architecture are baselined, so engineering can start. The active gate is change "
                  "merge, and this initiative runs at the Regulated level.", r2_1),
    scene("r2_2", "Carlos asks the Backend Engineer Agent to build two requirements: reject any contribution that would "
                  "exceed the annual IRA limit, and make funding requests safe to retry, so a customer is never "
                  "debited twice.", r2_2),
    scene("r2_3", "The agent writes its tests first, and declares an assumption: the annual limit counts contributions "
                  "across all of a customer's IRAs, using the contribution tax year. That goes into a register for a "
                  "human to decide.", r2_3),
    scene("r2_4", "It works in an isolated sandbox with test data only and a token for a single repository, and it "
                  "cannot merge. The platform has already flagged this as money-movement code, so the architect and "
                  "security will be required reviewers, and the new payments library needs evaluation.", r2_4),
    scene("r2_5", "Before it opens a pull request, the agent has to prove its own work. It runs the tests, starts the "
                  "app against a throwaway database and a simulated bank, sends the same request twice, and tries an "
                  "over-limit deposit.", r2_5),
    scene("r2_6", "Hannah reviews the pull request. Because it touches money movement, the architect and security must "
                  "approve too. The platform points her at what matters: the limit applies per customer across all "
                  "accounts, and by contribution tax year, not by the date the request arrives.", r2_6),
    scene("r2_7", "The agent's own report is labelled advisory. Continuous integration re-runs the same checks in a "
                  "fuller environment, and that independent result is the evidence that counts.", r2_7),
    scene("r2_8", "Carlos started this agent run, so the platform will not let him approve it, even though he wrote the "
                  "task. Hannah is eligible. She attests to what she reviewed and signs, while the architect and "
                  "security sign separately.", r2_8),
]


# ---------------------------------------------------------------- Journey 3: Portfolio management
def r3_1(r):
    r.goto(BASE + "map.html?i=103&s=g4&u=tessa")
    r.at(0.0); r.hl('.gnode[data-g="G4"]')


def r3_2(r):
    r.goto(BASE + "j3-1-traceability.html")
    r.at(0.0); r.hl('[data-pane="matrix"]')


def r3_3(r):
    r.at(0.0); r.click('[data-tab="graph"]')
    r.at(0.1); r.hl('[data-pane="graph"]')


def r3_4(r):
    r.at(0.0); r.click('[data-tab="gaps"]')
    r.at(0.1); r.hl('[data-pane="gaps"]')


def r3_5(r):
    r.at(0.0); r.click("#askTester")
    r.at(0.4); r.click('[data-tab="matrix"]')
    r.at(0.5); r.hl("#rowReq304")
    r.at(0.72); r.hl(".grid.g4")


JOURNEY_R3 = [
    card_scene("r3_0",
               "Journey three. Portfolio management. Customers see their holdings, choose a target mix, and approve "
               "rebalancing. Tessa, the QA lead, makes sure it is proven before release.",
               "Journey 3", "Portfolio management", "Tessa Moore · QA / Tester",
               ["Holdings and allocation", "Rebalancing", "Best-interest records"]),
    scene("r3_1", "The build is done, and verification is the active gate. Every earlier gate already has its signed "
                  "evidence.", r3_1),
    scene("r3_2", "Tessa opens traceability. It is built from requirement and test identifiers in the repository, not "
                  "typed in by hand. Each requirement links to a design decision, the code change, tests, results, and "
                  "the control it supports.", r3_2),
    scene("r3_3", "Rebalancing is where the stakes are. A customer must approve a trade before it is placed. Here is "
                  "that requirement, followed from the decision to the code, the tests, and the passing result on the "
                  "exact commit.", r3_3),
    scene("r3_4", "The platform found gaps. The rule that excludes restricted securities has no test. One test has no "
                  "requirement, and one change has no requirement link. These block verification until they are "
                  "fixed.", r3_4),
    scene("r3_5", "Tessa asks the Tester Agent to write the missing test. It writes it, runs it, and attaches the result "
                  "to the same commit. The matrix turns green, coverage reaches a hundred percent, and Tessa can "
                  "review and sign the verification gate.", r3_5),
]


# ---------------------------------------------------------------- Journey 4: Move money
def r4_1(r):
    r.goto(BASE + "map.html?i=104&s=g5&u=tariq")
    r.at(0.0); r.hl('.gnode[data-g="G5"]')


def r4_2(r):
    r.goto(BASE + "j4-1-security-review.html")
    r.at(0.0); r.hl(".grid.g4")
    r.at(0.45); r.hl(hc("h2", "Threat model"))


def r4_3(r):
    r.at(0.0); r.hl('tr:has-text("Account takeover")')
    r.at(0.5); r.hl('tr:has-text("Bank detail change")')


def r4_4(r):
    r.at(0.0); r.hl(hc("h2", "Findings"))
    r.at(0.55); r.hl(hc("h3", "Risk acceptance"))


def r4_5(r):
    r.goto(BASE + "j4-2-release.html")
    r.at(0.0); r.hl(".grid.g4")
    r.at(0.3); r.hl(".card.flush")
    r.at(0.6); r.hl('tr:has-text("change freeze")')
    r.at(0.82); r.hl(hc("h3", "Deployment plan"))


def r4_6(r):
    r.at(0.0); r.hl(hc("h3", "policy checks"))
    r.at(0.6); r.hl(".callout.info.small")


def r4_7(r):
    r.goto(BASE + "j4-3-emergency.html")
    r.at(0.0); r.hl(".callout.dev")
    r.at(0.45); r.hl(hc("h2", "What happened"))


def r4_8(r):
    r.at(0.0); r.hl(hc("h2", "Deviation DEV-014"))
    r.at(0.5); r.hl(hc("h3", "Post-hoc review tasks"))


JOURNEY_R4 = [
    card_scene("r4_0",
               "Journey four. Move money. Distributions, transfers, required minimum distributions, and rollovers out. "
               "This is the highest-risk journey, so the platform adds a security review, release approval, and an "
               "emergency path.",
               "Journey 4", "Move money", "Tariq Ahmed · Grace Lin · Elena Rossi",
               ["Distributions and RMDs", "Fraud protections", "Release approval", "Break-glass"]),
    scene("r4_1", "Verification is complete. Moving money is the highest-risk journey, so the next gate is a security "
                  "review.", r4_1),
    scene("r4_2", "Tariq reviews what the Security Agent prepared: a threat model, scan results and findings. Its output "
                  "is advisory. Every threat is tied to a requirement and a passing test, and Tariq makes the "
                  "decision.", r4_2),
    scene("r4_3", "Take account takeover. Withdrawals need step-up authentication, a first-time destination is held, "
                  "and every contact channel is notified. And if someone changes bank details and withdraws "
                  "immediately, a three-day cooling-off period blocks it.", r4_3),
    scene("r4_4", "The scans found one high finding, a missing rate limit on the quote endpoint. It was fixed and "
                  "re-tested. One low residual risk is proposed for acceptance with a compensating control, and "
                  "accepting it is itself a signed decision with its own evidence.", r4_4),
    scene("r4_5", "Release day. The DevOps Agent assembled the package: evidence from every gate, the software bill of "
                  "materials, a complete traceability matrix, and a rollout plan with a canary and automatic "
                  "rollback. The platform even checks the calendar, so a release cannot land inside the tax-deadline "
                  "change freeze.", r4_5),
    scene("r4_6", "Two signatures are required, the release approver and compliance. Luis, who deploys, cannot "
                  "approve. Deployment unlocks only after both have signed, and only for him.", r4_6),
    scene("r4_7", "Then the unexpected. After release, a retry following a bank timeout debited twelve customers "
                  "twice. The break-glass path lets one named approver authorize an urgent fix, and Grace did, at two "
                  "forty-one in the morning.", r4_7),
    scene("r4_8", "The shortcut has a price. A deviation opens automatically, every release is blocked until it is "
                  "closed, and compliance, the architect and QA must review within twenty-four hours, while customer "
                  "remediation is tracked alongside.", r4_8),
]


# ---------------------------------------------------------------- Journey 5: User profile management
def r5_1(r):
    r.goto(BASE + "j5-1-strictness-promotion.html")
    r.at(0.0); r.hl("#banner")
    r.at(0.4); r.hl(hc("h2", "Repository registry"))
    r.at(0.7); r.hl(hc("h3", "Model gateways"))


def r5_2(r):
    r.at(0.0); r.hl(hc("h2", "requirements (sandbox draft)"))


def r5_3(r):
    r.at(0.0); r.hl(hc("h2", "Promote to Controlled"))
    r.at(0.6); r.hl(".callout.info.small")
    r.at(0.82); r.hl(".btn.primary.disabled")


def r5_4(r):
    r.goto(BASE + "j5-2-audit.html")
    r.at(0.0); r.hl(hc("h2", "Decision timeline"))
    r.at(0.3); r.slide("#slider", 16, 6, step=-1, delay=0.18)
    r.at(0.62); r.slide("#slider", 6, 16, step=1, delay=0.1)


def r5_5(r):
    r.at(0.0); r.hl(hc("h3", "Control summary"))
    r.at(0.5); r.click("#exportBtn")
    r.at(0.65); r.hl("#exp")


JOURNEY_R5 = [
    card_scene("r5_0",
               "Journey five. User profile management. Personal details, contact information, beneficiaries and "
               "security settings. Small screens, but sensitive actions. This journey also shows how a team "
               "prototypes cheaply, then promotes.",
               "Journey 5", "User profile management", "Kevin Park · Rachel Stone",
               ["Sensitive-change protections", "Sandbox to Controlled", "Audit trail"]),
    scene("r5_1", "The team starts in a sandbox. Agents work in a test repository with no real data, they can commit "
                  "directly, and they use the company's OpenRouter subscription through a dedicated key with a "
                  "spending cap. Everything produced here is watermarked as not compliance evidence.", r5_1),
    scene("r5_2", "The requirements are protective by design. Changing an address, email, phone number or bank link "
                  "needs step-up authentication, notifies both the old and the new contact details, and holds "
                  "withdrawals to a new bank destination. A multi-factor reset needs re-verification and a notice "
                  "period.", r5_2),
    scene("r5_3", "When the prototype proves out, the team promotes it to Controlled. That means a production repository "
                  "that takes pull requests only, models from the company's own cloud account, and a re-signing of "
                  "the earlier gates on the exact same files, with compliance as the second authorizer. The sandbox "
                  "records stay as history, labelled non-compliant.", r5_3),
    scene("r5_4", "Rachel, from internal audit, has read-only access. She can replay the initiative as of any day. The "
                  "sandbox work appears watermarked, and the promotion on day eight marks where valid evidence "
                  "begins.", r5_4),
    scene("r5_5", "The control summary shows what an auditor needs: the sensitive-change protections are verified, "
                  "there are no separation-of-duties violations, and no sandbox records are in the audit bundle. One "
                  "click exports it.", r5_5),
    card_scene("r5_6",
               "Five journeys, one platform. Agents draft. Humans decide. Evidence is a by-product.",
               "Summary", "Agents draft. Humans decide.", "Evidence is a by-product.",
               ["Account opening", "Funding", "Portfolio", "Move money", "Profile"]),
]


VIDEO_DIR = "_parked-compliance-pack/retirement"   # output folder under videos/
FULL_ORDER = ["rintro", "R1", "R2", "R3", "R4", "R5"]
FULL_FILE = "00-end-to-end-demo.mp4"

JOURNEYS = {
    "rintro": {"file": None, "scenes": INTRO},
    "R1": {"file": "01-account-opening.mp4", "scenes": JOURNEY_R1},
    "R2": {"file": "02-account-funding.mp4", "scenes": JOURNEY_R2},
    "R3": {"file": "03-portfolio-management.mp4", "scenes": JOURNEY_R3},
    "R4": {"file": "04-move-money.mp4", "scenes": JOURNEY_R4},
    "R5": {"file": "05-user-profile-management.mp4", "scenes": JOURNEY_R5},
}
