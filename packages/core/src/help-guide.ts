// The help guide the in-app assistant uses to explain each screen of the web app. Plain data and two small functions.
// It describes apps/web/src as it is today: when a screen changes, change its entry here too.
//
// Words used below:
//  - initiative: one goal that goes from idea to release. A run is one agent working on a task.
//  - ask: something an agent needs a person for (a question, a decision, a review, a checkpoint, a notice).
//  - hard stop: an ask that only a person can settle. It is never answered by a default, a rule or autopilot.
//  - autonomy mode: guided (a person reviews every pull request), balanced (pre-approved change types merge),
//    autopilot (anything no trigger fired on merges once the checks are green).
//  - build plan: the approved design's task list T1, T2, ... Each task is built in a sandbox and opened as a pull request.
//  - smoke test, security review, preview: the checks and the running copy shown next to a pull request.
//  - release: a tagged version, always approved by a person (checkpoint G6).

export const HELP_PAGES = [
  'home',
  'portfolio',
  'map',
  'queue',
  'assumptions',
  'autopilot',
  'interruptions',
  'bugs',
  'costs',
  'integrations',
  'repositories',
  'settings',
] as const;

export type HelpPage = (typeof HELP_PAGES)[number];

export interface HelpElement {
  /** The visible label, or a short description of the element. */
  name: string;
  /** What it does or shows, in plain words, including when it is enabled or disabled and who may use it. */
  what: string;
}

export interface HelpScreen {
  page: HelpPage;
  /** The label in the navigation. */
  title: string;
  /** What the screen is for and when a person uses it. */
  purpose: string;
  /** Every visible control, panel, chip, column, badge and link. */
  elements: HelpElement[];
  /** Who can use the controls. */
  roles?: string;
  /** Common questions and gotchas. */
  tips?: string[];
}

const el = (name: string, what: string): HelpElement => ({ name, what });

/** What is on every page once someone is signed in (and the little that shows before). */
export const SHELL_HELP: HelpElement[] = [
  el(
    'Top bar title "Autonomous SDLC"',
    'The product name, always at the top. Everything else sits below it.',
  ),
  el(
    'Left navigation',
    'Shown only when signed in. It lists the 12 screens in this order: Home, Portfolio, Map, Attention queue, Assumptions and decisions, Autopilot, Interruptions, Bugs, Costs, Integrations, Repositories, Settings. The screen you are on is highlighted. On a narrow window it is hidden behind the menu button at the left of the top bar.',
  ),
  el(
    'Attention badge (on "Attention queue")',
    'A number on the Attention queue entry: how many asks are waiting on you right now. Amber normally, red when at least one of them is a hard stop. An ask you snoozed is not counted until its snooze ends. It refreshes about every 8 seconds and when you return to the browser window. No badge means nothing is waiting.',
  ),
  el(
    'Menu button with a dot (narrow windows)',
    'Opens the navigation on a small screen. The dot on it means something is waiting on you (red for a hard stop, amber otherwise).',
  ),
  el(
    'Browser tab title',
    'Reads "(3) Autonomous SDLC" when 3 asks wait on you, so you can see it from another window.',
  ),
  el(
    'Your name chip',
    'Top right, wide windows only. Shows who you are signed in as. It is only a label, not a button.',
  ),
  el(
    'Sign out',
    'Top right when signed in. Ends your session and returns you to the signed-out home page.',
  ),
  el(
    'Sign in',
    'Shown only on the signed-out home page (a card beside the introduction). It goes to the sign-in page. Access is by invitation: if you cannot sign in, ask the platform administrator.',
  ),
  el(
    'Budget banner',
    'Shown only to a Platform Admin, above the page content on every page, and only when this month\'s model spend is close to or over the monthly budget. Amber: "Close to the monthly model budget: $x of $y (n%)." Red: "The monthly model budget is used up: ...". It has a "See the costs" link to the Costs page. It is a warning, not a limit: nothing stops at the budget. It is checked about once a minute.',
  ),
  el('"Loading..." bar', 'Shown for a moment while the page asks the platform who you are.'),
  el(
    '"Could not reach the platform" alert',
    'A red alert that replaces the page when the platform cannot be reached. Reload the page; if it stays, tell an administrator.',
  ),
  el('"Sign in to see this page."', 'What a signed-out visitor sees on any page other than Home.'),
];

export const HELP_GUIDE: Record<HelpPage, HelpScreen> = {
  home: {
    page: 'home',
    title: 'Home',
    purpose:
      'The front page. Signed out, it explains what the platform does and offers the sign-in button. Signed in, it is a short status page: whether the platform is healthy, who you are and which roles ("hats") you hold, and a diagram of how work moves between agents and people. Day-to-day work happens on the other screens.',
    elements: [
      el(
        'Status line "API: ... database: ... v..."',
        "Shown to everyone. The platform's health (for example ok), whether its database is reachable, and the version number. Useful when something seems down.",
      ),
      el(
        'Heading "Ship software with AI agents, and keep people in charge"',
        'Signed-out view only. A short introduction: agents do the heavy lifting, people make the decisions that matter at clear checkpoints, and every step is recorded (who approved what, what it cost, what the agents assumed).',
      ),
      el(
        'Sign in card',
        'Signed-out view only, beside the introduction. Says "You are not signed in" and has a Sign in button. Access is by invitation.',
      ),
      el(
        'How work flows (diagram)',
        'Both views. A read-only diagram from a goal to a release: a person gives a goal; the Product agent drafts the spec; a person approves the spec and design review; the Architect agent designs it and plans the tasks; Engineer agents build one task each in parallel; the pull request gets CI, a smoke test and a security review; a person reviews (approve, or send changes back to the engineers); the Gate merges when CI passes; a person approves the release. The Bug agent reproduces and fixes reported bugs and joins at the pull request. Orange steps are where people decide. The mouse wheel scrolls the page rather than zooming the diagram.',
      ),
      el(
        'From idea to release (4 step cards)',
        'Signed-out view only: Start an initiative, Agree the spec and design, Build in tasks, Review and release.',
      ),
      el(
        'What you get (8 cards)',
        'Signed-out view only: Agents do the work, People decide, Checks before merge, Autopilot on your terms, Costs you can see, Assumptions and bugs, Runs where you want (Docker locally or your own AWS account), Works with your tools (GitHub, an AI gateway, chat notifications).',
      ),
      el(
        '"Signed in as <name> (<email>)"',
        'Signed-in view. Confirms which account you are using.',
      ),
      el(
        'Hats',
        'Signed-in view. Your roles, for example Product Owner, Architect, Backend Engineer, Platform Admin, or "none yet". Roles decide which asks reach you and which buttons work. If it says "none yet", ask an administrator to give you a hat.',
      ),
      el(
        'GitHub setup button',
        'Shown only to a Platform Admin. Opens the GitHub App setup page, where the platform is connected to GitHub.',
      ),
      el(
        'Note "Access is by invitation"',
        'Signed-out view only, at the bottom. If you cannot sign in, ask your platform administrator.',
      ),
    ],
    roles:
      'Anyone can see the signed-out page. Everyone signed in sees the same status page; only a Platform Admin sees the GitHub setup button.',
    tips: [
      'If other screens are missing, you are probably signed out: the navigation appears only after sign-in.',
      'The orange steps in the diagram are the points where a person must decide. Those decisions reach people through the Attention queue.',
    ],
  },

  portfolio: {
    page: 'portfolio',
    title: 'Portfolio',
    purpose:
      'One list of every initiative with where it stands, how far the build has got, what it has cost, and its open bugs, plus the releases that went out. Use it for a quick overview across initiatives, to see which ones need a person, and to jump into one on the Map. It is read-only and refreshes about every 15 seconds.',
    elements: [
      el('Tile "initiatives"', 'How many initiatives exist.'),
      el(
        'Tile "need a person"',
        'How many initiatives have a stage that is Waiting on a person or Blocked.',
      ),
      el('Tile "spent in all"', 'Total model spend across all initiatives, all time, in dollars.'),
      el('Tile "open bugs"', 'Total reported bugs not yet fixed across all initiatives.'),
      el(
        'Initiative column',
        'The initiative title (a link that opens it on the Map) with a line under it: its repository and its autonomy mode (guided, balanced or autopilot).',
      ),
      el(
        'Where it is column',
        'A status chip and the current stage name. Chips: Not started, In progress, Waiting on a person, Blocked, Done. Under it "Waiting on <roles>" says whose turn it is. A green "Released" chip means every stage is finished.',
      ),
      el(
        'Build column',
        'Build plan progress as "<merged> of <total>" tasks, with ", <n> failed" when some failed. A dash means there is no build plan yet.',
      ),
      el(
        'Spent column',
        'Model spend on that initiative, with "of $x" under it when the initiative has a budget.',
      ),
      el('Bugs column', 'Open bugs on that initiative, or a dash for none.'),
      el(
        'Last activity column',
        'How long ago anything happened on the initiative, for example "2 h 10 m ago".',
      ),
      el('Released column', 'The version number of the latest release, or a dash if none.'),
      el(
        '"No initiatives yet." row',
        'Shown instead of rows when no initiative exists. Create one on the Map.',
      ),
      el(
        'Releases card',
        'Every release that went out, grouped by month, newest first: the day, the initiative, the version, and a "release notes" link to GitHub when there is one. "Nothing has been released yet." when empty.',
      ),
    ],
    roles: 'Anyone signed in can read it. There are no buttons that change anything.',
    tips: [
      'To act on an initiative, click its title to open it on the Map.',
      '"Need a person" counts initiatives, not asks. The Attention queue lists the actual asks.',
    ],
  },

  map: {
    page: 'map',
    title: 'Map',
    purpose:
      'The working view of one initiative: where it is on the way from spec and design, through build and review, to release, and whose turn it is. Here people start the spec, design and build steps, retry or skip failed build tasks, preview the built app, prepare a release, and create new initiatives. Choose an initiative at the top; the page refreshes about every 5 seconds.',
    elements: [
      el(
        'Initiative picker (top right)',
        'Switches which initiative you are looking at. With none chosen, the Map opens the initiative you last viewed or, otherwise, the one in progress; finished or cancelled ones are never picked for you but you can choose them by hand. Shows "No initiatives yet" when there are none.',
      ),
      el(
        'Green or amber message bar',
        'A green bar confirms what a button just did (for example "The build has started."). An amber bar shows a problem, such as a button refused because of your role.',
      ),
      el(
        'Initiative summary',
        'Below the picker: the initiative title, its autonomy mode in a chip (guided, balanced or autopilot), its goal, and any "Reference links" it was given.',
      ),
      el(
        'Stage diagram (three stage cards)',
        'Read-only diagram of the stages in order: Spec and design (checkpoint G1), Build and review (G3), Release (G6). The mouse wheel scrolls the page; it does not zoom the diagram. Each card shows the checkpoint code, the stage name, a status chip, who it is waiting on, a one-line reason, and its buttons.',
      ),
      el(
        'Stage status chip',
        'Not started, In progress, Waiting on a person, Blocked, or Done. Blue top edge is in progress, orange waiting, red blocked, green done.',
      ),
      el(
        '"Waiting on <roles>"',
        'On a stage card: which roles the stage needs next, for example Product Owner or Architect.',
      ),
      el(
        'Stage detail line',
        'Why the stage has its status, for example "The spec is approved. A person starts the design." or "3 of 5 build tasks merged. The next ones start as their dependencies merge."',
      ),
      el(
        'Stage items (up to four per card)',
        'Links and runs behind the stage. An ask is a link that opens it in the Attention queue; an agent run shows as "<Agent> run: <state>".',
      ),
      el(
        'Red notes on a stage',
        'Why something cannot start or what failed: for example "T2 failed: <reason>", a spec or design step that cannot start, or "The preview did not start: <reason>".',
      ),
      el(
        'Start the spec / Start the design',
        'On the Spec and design card, when a step is waiting for a person (in guided mode, or when automatic stages were switched off). Starts the Product agent (spec) or Architect agent (design). The spec comes first; after the spec is approved the design waits for its own click. Product Owner, Architect or Platform Admin only; others do not see the button.',
      ),
      el(
        'Skip (on a waiting spec or design step)',
        'Drops that waiting step without running it. You can still start that run by hand later. Same roles as Start.',
      ),
      el(
        'Run the spec again / Run the design again',
        'On the Spec and design card when the newest spec or design run failed, was cancelled, ran out of budget or timed out, and nothing is running or waiting. Runs it again. Product Owner, Architect or Platform Admin only.',
      ),
      el(
        'Start the build',
        'On the Build and review card once the design is approved and its build plan is waiting ("awaiting start"). Starts the build: the tasks begin as their dependencies merge. Product Owner, Architect or Platform Admin only.',
      ),
      el(
        'Retry T1 / Skip T1 (on the stage card)',
        'Shown when a build task failed while the plan is waiting or active. The stage also says "T1 failed: <why>". Retry runs the task again; Skip marks it skipped so tasks that waited for it can start. Product Owner, Architect or Platform Admin only.',
      ),
      el(
        'Preview the built app / Preview the built app again',
        'On the Build and review card once at least one task has merged and the platform can run previews (it needs the Docker runner). Starts the built app in a sandbox. It is the filled (primary) button when the whole plan is done. The "again" wording appears after an earlier preview ended or failed. Anyone who holds a role may start it.',
      ),
      el(
        'Starting the preview...',
        'A greyed-out button while the sandbox is starting. A link appears on the Build and review box when it is ready.',
      ),
      el(
        'Open the built app',
        'Appears when the preview is ready. Opens the running app in a new browser tab.',
      ),
      el(
        'Stop the preview',
        'Appears next to Open the built app. Stops the sandbox. Anyone who holds a role may use it.',
      ),
      el(
        'Build plan card',
        'Shown once the approved design has a build plan. It says where the plan came from (the design file), a status sentence, and holds the task graph and task list below. A yellow warning list names problems that make the design unbuildable as written.',
      ),
      el(
        'Task graph',
        'A diagram with one box per task, "T1 - title", its state, its pull request number and its attempt number, and arrows from a task to the ones that wait for it. Zoom buttons appear when there are more than 8 tasks.',
      ),
      el(
        'Task row',
        'Task key and title (T1, T2, ...), a state chip (Waiting, Running, In review, Merged, Failed, Skipped, Cancelled), "after T1, T2" for what it waits on, "PR #n" once a pull request exists, "attempt n" from the second try, and a detail line.',
      ),
      el(
        'Activity note under a running task',
        'Says how recently the agent reported anything: "Working. Last heard from the agent ... ago." under 3 minutes; "Quiet for ..." from 3 minutes (long installs and checks can be silent); "Nothing heard for ... It is probably stuck." from 10 minutes. The platform closes a run that stays silent, and then you can retry the task.',
      ),
      el('"Stuck behind T2."', 'Under a task: the earlier tasks that failed or are blocking it.'),
      el(
        'Retry / Skip (in the task row)',
        'Retry appears only on a failed task; Skip on a failed or waiting task. Only while the plan is waiting or active. Retry runs the task again; Skip lets what waits for it start. Product Owner, Architect or Platform Admin only.',
      ),
      el(
        'Send back to the Architect',
        'Under the build plan when the plan is invalid (the approved design cannot be built as written). Asks the Architect for a revised design. Product Owner, Architect or Platform Admin only.',
      ),
      el(
        'Cancel the plan',
        'Under the build plan while it is waiting or active. Cancels the whole build plan. Product Owner, Architect or Platform Admin only.',
      ),
      el(
        'Start a run by hand (collapsed section)',
        'For one-off work the stage buttons do not cover. Choose an Agent (Product: draft the spec; Architect: design it and list the tasks; Backend Engineer: build and open a PR; Frontend Engineer: build a page or component and open a PR), describe the Task, and press Start. The run is queued with a $1 budget, and its questions and reviews arrive in the Attention queue.',
      ),
      el(
        'Releases card',
        'Lists releases of this initiative: the version, a "published" link once released (otherwise a chip with the state), a detail line, and a "decide" link to the Attention queue while a release is waiting for approval. "None yet." when empty.',
      ),
      el(
        'Version field and Prepare a release',
        'Type a version like 1.2.0 (three numbers) and press Prepare a release. This does not publish anything: it creates a release approval (checkpoint G6) in the Attention queue for the approver. Shown only to Product Owner, DevOps / Release or Platform Admin. Releases are never automatic.',
      ),
      el(
        'New initiative form (bottom of the page)',
        'Starts a new initiative: Title; Repository (from the registered list; "No repository is registered" with a note to ask a Platform Admin to add one on the Repositories page when empty); "How much runs on its own" (Guided: a person reviews every PR; Balanced: pre-approved types merge; Autopilot: no trigger, no review); a checkbox "Draft the spec now, then design and build after each approval (guided mode waits for a click)"; Goal, in a few sentences; and optional Reference links (documentation for any outside system the work must call, one https link per line - agents ask for it if it is missing). Create is disabled until a repository exists. Afterwards the Map opens the new initiative.',
      ),
    ],
    roles:
      'Anyone signed in can look and can create an initiative. Start, skip, run again, retry, start the build, send back and cancel the plan need Product Owner, Architect or Platform Admin. Prepare a release needs Product Owner, DevOps / Release or Platform Admin. Starting or stopping a preview needs any role.',
    tips: [
      'A stage "Waiting on a person" with no button for you usually means the next step is for a different role. Check "Waiting on" on the card.',
      'In guided mode each step (spec, design, build) waits for a click. With the "Draft the spec now..." box ticked in another mode, the next step starts by itself after each approval.',
      'A Retry on a task that keeps failing is rarely the answer. Read the failure on the Attention queue (it explains each attempt) before retrying again.',
      'The Preview the built app button is missing when no task has merged yet or the platform has no preview runner.',
      'Creating an initiative on an empty repository (no commits) is refused with a message; the Repositories page offers to make the first commit.',
    ],
  },

  queue: {
    page: 'queue',
    title: 'Attention queue',
    purpose:
      'Everything that is waiting on you. An agent that needs a person (a question, a decision, a pull request review, a spec checkpoint, a notice) creates an ask here, ranked by what it blocks and then by deadline. Use it daily: answer questions, approve or send back pull requests after looking at their checks, and decide agent assumptions. It refreshes about every 5 seconds.',
    elements: [
      el(
        'Count chip beside the title',
        'Orange "N waiting on you" or green "All clear". Counts asks you can act on now; snoozed ones are left out until their time comes.',
      ),
      el(
        'Ask card',
        'One card per ask, numbered by rank (the circled number): the most blocking first, then by deadline. Opened from a link (for example from the Map), the card is outlined and scrolled into view.',
      ),
      el(
        'Type chip (Question, Decision request, Review, Checkpoint, Notice)',
        'What kind of ask it is. A Question or Decision request is answered with an option or text. A Review is a pull request. A Checkpoint is a spec, design or release approval.',
      ),
      el(
        'Agent chip "<Role> - RUN-XXXX"',
        'Which agent raised it and the last four characters of the run id, to tell runs apart.',
      ),
      el(
        'Waiting chip',
        '"Blocks the merge" on a review. "Hard stop" (red, with a red left edge) when only a person can let it through. "Blocks N run(s)" when that many agent runs are paused until you answer. "Not blocking" when the agent carries on without you.',
      ),
      el(
        'Hard stop',
        'A red chip and red edge. A hard stop is never answered by a default, a rule or autopilot, and cannot be snoozed. Typical cases: a change to a protected path, a new outside system an agent needs, a release approval, and a failed build task (that one goes to a Platform Admin).',
      ),
      el(
        'Escalated to you',
        'A red chip meaning it was not answered in time by the person first asked, so it moved to you (the next person, usually a deputy or an admin).',
      ),
      el(
        'Snoozed for <time>',
        'A chip shown while a snooze is active. A snoozed ask drops out of the list and the badge until the snooze ends.',
      ),
      el(
        'Default in <time> / Default being applied',
        'Shown at the right only when the ask has a deadline and a default answer. If nobody answers by then, the recommended option is applied automatically.',
      ),
      el('Title and initiative', 'What is being asked, and which initiative it belongs to.'),
      el(
        'What it was doing',
        'Questions: what the agent was working on. For a protected-path ask it shows the paths and the patch the agent wants to apply, in a scrollable code box.',
      ),
      el(
        'Why it needs you',
        'The reason a person must answer (for example the trigger that fired).',
      ),
      el('What happened', 'Reviews and checkpoints: a summary of the change or document.'),
      el(
        'Why a person reviews it',
        'Reviews: why this change was not merged automatically (the autonomy mode, or a trigger).',
      ),
      el(
        'Checks',
        "Reviews: whether the agent's own checks passed before the pull request opened, and how many files and lines changed.",
      ),
      el('Pull request link', 'Reviews: "#n on GitHub", opens the pull request in a new tab.'),
      el(
        'Documentation (new outside system)',
        'On an ask to confirm a new outside system: the documentation links the agent found, or "None yet. The agent had no link it was sure of."',
      ),
      el(
        'Why it failed (failed build task)',
        'On an ask about a failed build task: one line per attempt, "Attempt 1: <reason>". The options are "Try again" (starts a new attempt that is told why the earlier ones failed and what you write) and "Skip it" (drops the task so the ones behind it can start). It is a hard stop addressed to a Platform Admin.',
      ),
      el(
        'What is waiting',
        'Questions: how many runs are paused for this answer, or "Nothing. The agent continues without it." For a failed task: the task and every task that needs it.',
      ),
      el(
        'Assumptions made in this work (n undecided)',
        'On a review or checkpoint, when the run behind it made calls without asking: each assumption with Accept and Reject. Accept records that you agree, and later runs on the initiative are told. Reject asks whoever started the run what to redo. Approving the change does NOT decide them; the note under the buttons says so.',
      ),
      el(
        'What stands between this pull request and a merge (flow diagram)',
        'On a pull request review: Agent checks (Passed / Did not pass), Smoke test and Security review (only if this repository requires them; colour shows where each stands), Your decision (Waiting for you, or "Held by a check"), CI ("Checked at approval"), Merge ("The Gate merges"). Read-only; the buttons are in the panels below.',
      ),
      el(
        'Preview panel',
        'On a pull request review. Title: Preview, Preview (building), Preview (failed), Preview (out of date) or No preview. A link ("Open the preview" or the pipeline\'s own label) opens a preview the repository\'s pipeline published, with a short status line. A change that only touches documentation shows "No preview" and says why. If GitHub cannot be asked it says "Could not ask GitHub just now."',
      ),
      el(
        'Run it here / Run it again (preview)',
        'In the Preview panel when the platform can run previews. Runs this pull request\'s own code in a sandbox for a limited time (the panel says how many minutes; no secrets, almost no network). "Run it again" appears after an earlier one ended or failed. Any role may press it. A failure shows an amber message with the reason.',
      ),
      el(
        'Stop the preview',
        'Replaces Run it here while the platform preview is starting or running. "The platform stops it at <time>" says when it ends by itself.',
      ),
      el(
        'Smoke test panel',
        'On a pull request review, only if the repository lists smoke checks (the design asked for them). Title "Smoke test" and a state chip: Not run on this commit, Running, Passed (x of y), Failed (x of y), Could not run, or Overridden. Beneath it each check with a tick or cross and its detail. If the checks cannot be read, an amber note says why.',
      ),
      el(
        'Run the smoke test / Run the smoke test again',
        'Starts the smoke checks against the commit under review. Disabled while one is running. Any role may press it. It is the filled button when the smoke test is required and has not run or could not run.',
      ),
      el(
        'Override with a reason (smoke test)',
        'Visible while the smoke test has not passed and is not running. Opens a text box: "Why can this merge without a passing smoke test? (10 characters or more)", with Override and Cancel. Override stays disabled until the reason is 10+ characters. The reason is kept with the pull request. Only someone who may approve this review can override; it is refused for your own work (see independent review).',
      ),
      el(
        'Explain why it failed',
        "Appears under a failed or could-not-run smoke test. An AI reads the failure and says what to do; it costs a few cents. Any role may ask. Needs the platform's Security agent to be switched on.",
      ),
      el(
        'AI reading, not verified (smoke diagnosis)',
        'The AI\'s answer: a verdict chip (Likely a bug in the code; Likely out-of-date smoke checks; Likely a problem with the preview, not the code; Not clear from what the platform can see), a summary, and "Suggested next step". It only advises; a person decides.',
      ),
      el(
        'Ask the engineer to fix the code / Ask the engineer to update the smoke checks',
        "Appears only for the code or checks verdicts. It is the same as Request changes with the failed checks and the AI's reading in the message. For the checks verdict the engineer edits .sdlc/preview.yaml, and you are asked to allow that protected file before anything is pushed. Disabled if you may not decide this review.",
      ),
      el(
        'Security review panel',
        'On a pull request review, only if the repository requires a security review. State chip: Not run on this commit, Reading the change, Finished (no findings or n findings), Could not finish. Shows the review summary and each finding.',
      ),
      el(
        'Run the security review / Run the security review again',
        'Starts the Security agent on the commit under review. Disabled while it is reading. Any role may press it. Filled when the review is required and has not run or failed to finish.',
      ),
      el(
        'Security finding',
        'A severity chip (critical, high, medium, low, info), an id and title, the file and line, why it matters, and "Fix: ...". High and critical findings hold the approval until they are sent back to the engineer or dismissed with a reason.',
      ),
      el(
        'Dismiss <F-id> with a reason',
        'Under an open finding. Opens a text box (10 characters or more) with Dismiss and Cancel. A dismissed finding shows "Dismissed by <name>: <reason>". Only someone who may approve this review can dismiss.',
      ),
      el(
        'Send findings back to the engineer',
        'Appears after a finished review that has open findings of medium severity or higher. Sends them to the engineer as a change request and the ask is settled.',
      ),
      el(
        'Required before you can approve',
        'An amber chip and left edge on a Smoke test or Security review panel: this check stands in the way of the Approve button and must be passed, overridden or dismissed first.',
      ),
      el(
        'Comment (optional)',
        'Reviews and checkpoints: a text box. What you write goes with your decision to the agent or engineer.',
      ),
      el(
        'Approve',
        'Reviews and checkpoints. Records approval; a pull request then merges once CI is green (the Gate merges). Disabled while a check is blocking (hover shows the first reason) or if you may not decide this one.',
      ),
      el(
        'Request changes',
        'Sends the change back to the agent with your comment. Needs no checks to have run, so it stays enabled when Approve is held by a check. Disabled only if you may not decide this one.',
      ),
      el('Reject', 'Rejects the change. Same availability as Request changes.'),
      el(
        'Approve is waiting on (amber note)',
        'Appears under the buttons while something blocks Approve. Lists each reason (for example "the smoke test has not passed", "a high security finding is open") with a "Go to it" link that scrolls to that panel and focuses its button. Clears itself when the checks are settled.',
      ),
      el(
        'You cannot decide this one (amber note)',
        'Shown instead when independent review is on and you started or steered this run: "You started or steered this run, so someone else must review it." Approve, Request changes and Reject are all disabled for you.',
      ),
      el(
        'Undecided assumptions note',
        'Under the buttons: "n assumption(s) the agent made in this work are still undecided. Approving does not accept them." Never blocks anything.',
      ),
      el(
        'Option list with "recommended" chip',
        'Questions and decision requests with options: one radio option per choice ("A - label"), its impact, and a green "recommended" chip on the agent\'s suggestion, pre-selected.',
      ),
      el(
        'Your answer',
        'A text box shown instead of options when the question is free text. Answer stays disabled until you type something.',
      ),
      el(
        'Documentation links to add',
        "Only on an ask to confirm a new outside system: https links, one per line, for the system's API documentation. Required when the system has none yet.",
      ),
      el(
        'What the next attempt should do differently (optional)',
        'Only on a failed build task when "Try again" is chosen: guidance for the next attempt.',
      ),
      el(
        'Answer',
        'Sends your choice or text to the agent, which then continues. Disabled until an option is chosen or text typed. If it is refused (not addressed to you, already answered, unknown option) a yellow message appears on the card.',
      ),
      el(
        '"If nobody answers, <option> is applied."',
        'Shown when there is a recommendation and a default: what happens at the deadline.',
      ),
      el(
        'Use this answer from now on',
        'A checkbox beside Answer. Ticked, your answer becomes a standing decision so agents stop asking about it. After ticking, an "Applies to" menu appears: for this initiative, for this repository, or everywhere. Saved decisions are listed (and can be retired) on Assumptions and decisions.',
      ),
      el(
        'Snooze 2 h',
        'Hides the ask from your list and badge for two hours. Not offered on a hard stop. The agent keeps waiting meanwhile.',
      ),
      el(
        "Didn't need to ask",
        'A small underlined link at the bottom of an ask card. Tells the platform the agent should not have asked; it feeds the Interruptions screen so rules can be tuned. After pressing it, it reads "Marked: didn\'t need to ask" and is disabled. It does not answer or remove the ask.',
      ),
      el(
        '"Done." card',
        'After you answer, the ask turns into a green "Done." card saying what happens next. It stays until you leave the page.',
      ),
      el(
        'Assumptions to review',
        'Below the asks when agents declared assumptions: a "Notice" chip, the agent, "Assumption declared: <text>", the initiative, and Accept / Reject (the first five, then a link "See all assumptions and standing decisions").',
      ),
      el(
        'Blocked work (right column)',
        'Lists, with an orange dot, the asks that are holding up agents or pull requests, or "No agent is waiting on you."',
      ),
      el(
        'How you are reached (right column)',
        'Your contact settings: Chat (Slack: working, set up but your account not linked - ask an admin, or not set up), Digest (the time low-priority items are batched, or "Sent as they come"), Reminders (after how long you are reminded and when the next person gets it), and for each hat your deputy or "No deputy. Admins are next."',
      ),
      el(
        'What makes a good ask (right column)',
        'A reminder that each ask should say what the agent was doing, why it needs a person, what is waiting, the options, a recommendation and what happens if nobody answers.',
      ),
      el(
        '"Nothing is waiting on you." card',
        'Shown when the list is empty, with "n snoozed." when some are hidden.',
      ),
    ],
    roles:
      'You see asks addressed to you or to a role you hold (an escalated ask moves to the next person). You can only answer what is addressed to you. Approve, Request changes and Reject apply to reviews and checkpoints and are blocked for runs you started or steered when independent review is on. Accept and Reject on assumptions need any role. Running previews, smoke tests and security reviews needs any role; overriding a smoke test or dismissing a finding needs the right to approve that review.',
    tips: [
      'Why is Approve greyed out? A check is blocking it: usually a required smoke test that has not passed or a high or critical security finding. The amber "Approve is waiting on" note lists the reasons with Go to it links. Pass the check, override the smoke test with a reason, or send the findings back / dismiss them with a reason.',
      'Why can I not approve at all? If independent review is on and you started or steered the run, the note says someone else must review it. Request changes and Reject are disabled too.',
      'Why is there no Snooze 2 h button? Hard stops cannot be snoozed.',
      'Why is there no Smoke test or Security review panel? The repository has no smoke checks or does not require a security review, or the platform is not set up to run them.',
      'Approving a pull request does not merge it immediately: the Gate merges when CI is green.',
      'Answer with "Use this answer from now on" when you are sure; the same question will not be asked again within the scope you chose.',
      'The badge in the navigation and the count chip here may differ for a moment: the badge refreshes about every 8 seconds, this page about every 5.',
    ],
  },

  assumptions: {
    page: 'assumptions',
    title: 'Assumptions and decisions',
    purpose:
      'Two lists that cut down how often agents ask. Assumptions are small calls an agent made without asking and said so; you accept or reject them. Standing decisions are answers you saved so agents stop asking the same question. Use it to clear assumptions, add a rule of thumb (for example "use date-fns for dates"), or retire a standing decision that is out of date.',
    elements: [
      el(
        'Count chip "n to review"',
        'Beside the title, only when assumptions are waiting for a decision.',
      ),
      el(
        'Assumptions tab',
        'Shows the assumptions waiting for a decision, with a count in the tab label.',
      ),
      el('Standing decisions tab', 'Shows the saved decisions, with a count in the tab label.'),
      el('Assumption column', 'The text of what the agent assumed.'),
      el('Declared by column', 'The agent that made the call, for example Backend Engineer.'),
      el('Initiative column', 'Which initiative it belongs to.'),
      el(
        'Accept',
        'Records that you agree. Later runs on that initiative are told. The green result bar says it is accepted. Needs a role.',
      ),
      el(
        'Reject',
        'Records that you disagree. The person who started the run is asked what to redo, so nothing is forgotten. Needs a role.',
      ),
      el('"Nothing to review." row', 'Shown when there are no undecided assumptions.'),
      el(
        'Green result bar',
        'Confirms your last decision: "<assumption> is accepted." or "... is rejected. The person who started the run has been asked what to redo."',
      ),
      el(
        'Topic column (standing decisions)',
        'The key an agent uses when it asks, for example date-library.',
      ),
      el('Decision column', 'The saved answer, for example "Use date-fns for dates and times".'),
      el(
        'Applies to column',
        'Everywhere, A repository, or An initiative: how far the decision reaches.',
      ),
      el('Set by column', 'Who saved it.'),
      el(
        'Answered since column',
        'How many asks this decision has answered on its own since it was saved. A high number means it is saving people time.',
      ),
      el(
        'Retire',
        'Stops the decision from being used; agents will ask again. Only the person who set it or a Platform Admin may retire it.',
      ),
      el(
        'Add a standing decision form',
        'Fields: Topic (required), Decision (required), Applies to (Everywhere, or one initiative from the list), and Save. Needs a role. Agents search these before they ask. To scope a decision to a repository, tick "Use this answer from now on" on a question in the Attention queue instead.',
      ),
      el(
        '"None yet" message',
        'On the Standing decisions tab when empty: answer an ask and tick "Use this answer from now on".',
      ),
    ],
    roles:
      'Anyone signed in can read. Accepting, rejecting and adding a standing decision need at least one role (hat). Retiring is for the person who set it or a Platform Admin.',
    tips: [
      'Approving a pull request never accepts its assumptions. Decide them here or in the review itself.',
      'The same undecided assumptions also appear on the Attention queue (the first five) and next to the review they came from.',
      'A decision saved with "Use this answer from now on" appears on the Standing decisions tab.',
    ],
  },

  autopilot: {
    page: 'autopilot',
    title: 'Autopilot',
    purpose:
      "Shows what may merge without a review, what did, and what was held for a person, and lets a Product Owner or Platform Admin set how much each initiative runs on its own. A trigger always sends a change to a person in every mode, and hard stops are never automatic. Use it to check that automation is behaving and to change an initiative's autonomy mode.",
    elements: [
      el(
        'Tile "Approved by rule"',
        'How many pull requests were approved automatically because their change type is pre-approved.',
      ),
      el('Tile "Reviewed by a person"', 'How many pull requests a person reviewed.'),
      el(
        'Tile "Held for a person"',
        'How many pull requests are waiting for a person to review them right now.',
      ),
      el(
        'Recent pull requests table',
        'The latest pull requests: Pull request (number as a link to GitHub, title, initiative), Decision, Why, Outcome. "No pull requests in this period." when empty.',
      ),
      el(
        'Decision chip',
        'Approved by rule (green), Reviewed by a person (outlined), or Held for a person (amber).',
      ),
      el(
        'Why column',
        'The reason for that decision, for example the pre-approved type that matched or the trigger that forced a person to review.',
      ),
      el(
        'Outcome column',
        'What happened to the pull request, for example merged (shown with spaces).',
      ),
      el(
        'Pre-approved change types',
        'The rules that allow automatic approval: the rule id, the paths it covers, its owner, and either "Review by <date>", "No review date", or an amber chip "review date <date> has passed: not applied" (an expired rule is not used). "None." when there are no rules.',
      ),
      el(
        '"Rules are edited by hand in rules/triggers.yaml"',
        'A note: rules cannot be changed from this screen. They are edited in a file in the repository.',
      ),
      el(
        'How each initiative runs - Autonomy mode',
        'One menu per initiative: Guided, Balanced or Autopilot. Changing it saves immediately. A line below explains the mode: Guided: a person reviews every pull request. Balanced: pre-approved change types merge when the checks are green, a person reviews the rest. Autopilot: anything no trigger fired on merges when the checks are green.',
      ),
      el(
        'Amber message under the modes',
        'Shown when a change is refused, for example because of your role.',
      ),
    ],
    roles:
      'Anyone signed in can read everything. Only a Product Owner or Platform Admin can change an autonomy mode; for others the menu is shown but the change is refused with a message.',
    tips: [
      'A trigger (for example a protected path, or a risky change) always sends the pull request to a person, even in Autopilot mode.',
      'Hard stops are never approved automatically in any mode.',
      'Rules marked "not applied" because their review date has passed need their owner to review and update them in rules/triggers.yaml.',
    ],
  },

  interruptions: {
    page: 'interruptions',
    title: 'Interruptions',
    purpose:
      'Measures how often agents interrupt people, and how useful those interruptions were, so the rules can be tuned. It is read-only: it suggests things, and you change rules or standing decisions by hand. Use it when the Attention queue feels too noisy.',
    elements: [
      el(
        'Last 7 / 30 / 90 days (toggle, top right)',
        'Chooses the period all figures cover. 30 days is the default.',
      ),
      el(
        'Tile "Questions per merged PR"',
        'Asks divided by pull requests merged, with a note "n asks, m merged". A green "falling" or amber "not falling" chip compares the last week to the first.',
      ),
      el(
        'Tile "Answered with the recommendation unchanged"',
        "The share of asks where a person just accepted the agent's recommendation. A high number suggests the ask could be a standing decision or a default.",
      ),
      el(
        'Tile "Marked didn\'t need to ask"',
        'The share of asks a person marked "Didn\'t need to ask" in the Attention queue.',
      ),
      el(
        'Tile "Median time to answer"',
        'How long people took, in the middle, with "agent time blocked n%" - the share of agent time spent waiting for people.',
      ),
      el(
        'Summary line',
        'How many asks were answered by a default after the deadline, and how many never reached a person because a standing decision answered them.',
      ),
      el(
        'Where asks come from (table)',
        "One row per situation: Situation, Asked, Unchanged, Didn't need to ask, and a Suggestion chip. Nothing is applied for you.",
      ),
      el(
        'Suggestion chip',
        'Covered by a standing decision; "Always answered with the recommendation. Make it a standing decision."; "Often marked didn\'t need to ask. Consider a rule or a prompt change."; or Keep asking.',
      ),
      el(
        'Questions per merged PR (weekly bars)',
        'A bar for each week ("Week of MM-DD") with the figure at the right. It should fall as standing decisions pile up; if it stops falling the rules need work.',
      ),
      el(
        'By agent',
        'For each agent role: asks per merged pull request, the number of asks and merges, and the share answered unchanged. "No data yet." when empty.',
      ),
    ],
    roles: 'Anyone signed in can read it. There is nothing to change here.',
    tips: [
      'To act on a suggestion: save a standing decision on Assumptions and decisions, or edit rules by hand.',
      '"n/a" means there was not enough data in the period.',
    ],
  },

  bugs: {
    page: 'bugs',
    title: 'Bugs',
    purpose:
      'Where anyone reports what is wrong and follows each bug from the report to a merged fix. The Bug agent reproduces a reported bug with a failing test, finds the cause and opens a fix pull request for an engineer to review. The list refreshes about every 5 seconds.',
    elements: [
      el(
        'Report a bug (form)',
        'The form on the left. Report is disabled until an initiative exists.',
      ),
      el('Initiative', 'Which initiative the bug is in. Required.'),
      el('Title', 'What is wrong, in a line. At least 3 characters.'),
      el(
        'What happens, and what should happen',
        'A description of the problem and the expected behaviour. Required, at least 10 characters.',
      ),
      el('Steps to reproduce (optional)', 'How to see the bug.'),
      el(
        'Severity',
        'Low: a nuisance. Medium: something does not work. High: users are blocked or data is wrong. Medium is the default.',
      ),
      el(
        'Report',
        'Records the bug. A green message says "Thank you. The report is recorded." The form clears the text fields.',
      ),
      el(
        'Reported bugs list',
        'Each bug: title, a state chip (Reported, Being fixed, Fixed, Needs a person), a severity chip (Low, Medium, High), the initiative, who reported it, "PR #n" once a fix pull request exists, and a detail line. "None yet." when empty.',
      ),
      el(
        'Start the fix',
        'Under a bug whose fix is waiting for a person to start it. Starts the Bug agent. The green bar says "The fix is starting." Backend Engineer, Frontend Engineer or Platform Admin only; others do not see it.',
      ),
      el(
        'Drop',
        'Next to Start the fix: drops that fix attempt ("The fix was dropped."). Same roles.',
      ),
    ],
    roles:
      'Anyone signed in can report bugs and read the list. Start the fix and Drop are for Backend Engineer, Frontend Engineer or Platform Admin.',
    tips: [
      '"Needs a person" means the fix could not finish by itself; check the detail line and the Attention queue.',
      'Bug counts also show on Portfolio under "open bugs".',
    ],
  },

  costs: {
    page: 'costs',
    title: 'Costs',
    purpose:
      "What the AI models cost, taken from the gateway's record of every call: this month against the budget, and where the spend goes by day, initiative, agent, model and individual run. Use it to see whether spend is on track and what is expensive. It refreshes about every 15 seconds.",
    elements: [
      el(
        'Initiative filter',
        'All initiatives (default) or one initiative. Changes every figure on the page.',
      ),
      el(
        'Period filter',
        'Last 7, 30 or 90 days. Applies to everything except the "This month" card.',
      ),
      el(
        'This month card',
        'Spend so far this month with a status chip: No budget set, Within budget, Close to the budget, or Over the budget. With a budget it shows "$x of $y (n%)", the percentage at which admins are warned, and a progress bar. It says "Nothing stops at the budget: it is a warning, not a limit." With no budget it says the platform setting MONTHLY_BUDGET_USD is not set.',
      ),
      el('Tile "spent in the period"', 'Total model spend in the chosen period.'),
      el('Tile "runs"', 'How many agent runs.'),
      el('Tile "model calls"', 'How many calls were made to models.'),
      el(
        'Tile "of the prompt read from cache"',
        'The share of input read from the cache, which is cheaper. Higher is better.',
      ),
      el(
        'Tile "tokens in / out"',
        'Tokens sent to and received from the models, abbreviated (k, M).',
      ),
      el(
        'By day',
        'A bar chart of spend per day. Hover a bar for the day, its cost and number of calls.',
      ),
      el(
        'By initiative',
        "Initiative (a link to its Map), Period spend, All time spend, and Of budget (the share of that initiative's budget, or a dash if it has none).",
      ),
      el('By agent', 'Spend by agent role: Spent, Runs, and Per run (the average).'),
      el(
        'By model',
        'Alias (the name agents ask for), Model (the real model), Spent, Calls and Cached tokens.',
      ),
      el(
        'Most expensive runs',
        "The costliest runs: cost, role, title, the initiative (a link) and the run's state.",
      ),
      el(
        'Budget banner (all pages)',
        'The same warning appears at the top of every page for a Platform Admin when spend is close to or over the budget.',
      ),
    ],
    roles:
      'Anyone signed in can open the page. Only a Platform Admin sees the budget banner on other pages. The budget itself is a platform setting, not editable here.',
    tips: [
      'The budget is a warning, not a limit: agents are not stopped when it is passed. A single run has its own budget.',
      'To change which model an agent uses (and so its cost), see Settings.',
    ],
  },

  integrations: {
    page: 'integrations',
    title: 'Integrations',
    purpose:
      "The register of outside systems agents may call (a vendor API, another team's service), where to read about them and how to test them safely. A sandbox can reach only the hosts of confirmed entries, plus GitHub and the package registries. Use it to confirm a new system, refresh its documentation, or retire one.",
    elements: [
      el(
        'Systems table',
        'One row per system. "None yet. Agents may reach GitHub and the package registries only." when empty.',
      ),
      el(
        'System column',
        'The name in bold, with "Third party" or "Second party" and the owner if any.',
      ),
      el('Hosts column', 'The hostnames the sandbox may connect to, or "none".'),
      el(
        'Test with column',
        'How to test it: Vendor sandbox, Mock, Recorded responses, or "None (a trigger)". A confirmed system with no safe way to test gets an amber chip "no way to test it safely".',
      ),
      el(
        'Documentation column',
        'Each documentation link with a chip: green "saved <date>" (the platform has a copy), amber "could not read" (hover for the error), or "not fetched". "no links" when none.',
      ),
      el(
        'Status chip',
        'Confirmed (green), Waiting for confirmation (amber), Rejected, or Retired.',
      ),
      el(
        'Refresh docs',
        'On a confirmed system. Reads its documentation links again and saves a fresh copy.',
      ),
      el(
        'Retire',
        'On a confirmed system. Retires it and closes its hosts: agents can no longer reach them.',
      ),
      el(
        'Add an external system (form)',
        'Name, Hosts (plain hostnames, no wildcard or path, e.g. api.weather.example.com), Documentation links (https, separated by spaces), Kind (Third party or Second party), How to test (Test with: Vendor sandbox / Mock / Recorded responses / None), Authentication (No authentication, API key, OAuth, Basic), Credential name (the test credential\'s name in the secrets store), Owner, and "Add and confirm". Adding confirms it straight away.',
      ),
      el(
        'Green and amber message bars',
        'Green confirms Refresh docs or Retire; amber shows a refusal or error.',
      ),
    ],
    roles:
      'Anyone signed in can read the register. Adding, refreshing and retiring need Architect, Backend Engineer, Frontend Engineer or Platform Admin; others get a refusal message.',
    tips: [
      'A new outside system an agent needs arrives in the Attention queue as a hard stop. Confirming it there adds it here.',
      'A system waiting for confirmation has no hosts open yet.',
    ],
  },

  repositories: {
    page: 'repositories',
    title: 'Repositories',
    purpose:
      'The GitHub repositories agents may work on. A new initiative picks one of these. A Platform Admin adds repositories, checks whether each is ready for the platform, and edits how agents work in it. Everyone else sees a short read-only list.',
    elements: [
      el(
        'Blue note "Only a Platform Admin adds or changes repositories"',
        "Shown to everyone who is not a Platform Admin. Those people see only each repository's name, branch and verify command.",
      ),
      el(
        'Add a repository card (Platform Admin)',
        'A list of the repositories both GitHub Apps are installed on and that are not yet registered. Choose one and press Add repository. To offer another, add it to both Apps on GitHub, then choose Check GitHub again.',
      ),
      el('Repository menu', 'The repositories waiting to be added. Disabled when there are none.'),
      el(
        'Add repository',
        'Registers the chosen repository. A green bar says to use Check readiness to see what it still needs.',
      ),
      el('Check GitHub again', 'Looks at GitHub again for newly installed repositories.'),
      el(
        'Open GitHub setup',
        'A link inside an amber warning when GitHub cannot be read (for example the Apps are not set up). Opens the GitHub setup page.',
      ),
      el(
        '"No repository is waiting to be added."',
        'Shown when every available repository is already registered.',
      ),
      el(
        'Repository card',
        'One per registered repository (Platform Admin): its name, chips for the integration branch, access (Read and write / Read only) and delivery (pull requests / direct push), and a summary of Verify command, Required CI check, Protected paths and Model policy.',
      ),
      el(
        'Check readiness',
        "Runs the platform's checks on the repository and lists them. Each has a chip (Ready, Needs attention, Could not tell), a name and a detail line.",
      ),
      el(
        'Create the first commit',
        'Appears on a readiness check for an empty repository. Shows the one file the Agent App will add and the commit message; "Make the commit" does it, Cancel backs out.',
      ),
      el(
        'Readiness how-to steps',
        'Numbered steps for a check the platform cannot fix itself, with a button such as "Open the rule form on GitHub".',
      ),
      el(
        'Edit / Close',
        "Opens or closes the edit form: Integration branch (where finished work merges), Verify command (agents run it before opening a pull request), Required CI check (must be green before the Gate merges), Protected paths (one per line; an agent may not change these without a person saying yes), How agents deliver (branch and pull request, or push straight to the integration branch), Access (Read and write, or Read only), Model policy (any model account, or only the owner's). Save changes or Cancel.",
      ),
      el(
        'Remove, then "Yes, remove it" / Keep',
        'Takes the repository out of the registry after a confirmation click. The repository on GitHub is untouched.',
      ),
      el('"No repository is registered yet."', 'Shown when the registry is empty.'),
    ],
    roles:
      'Only a Platform Admin can add, check, edit or remove repositories. Everyone else can only see the list.',
    tips: [
      'A repository must be in the registry before an initiative can use it.',
      'A repository with no commits fails readiness; use Create the first commit.',
    ],
  },

  settings: {
    page: 'settings',
    title: 'Settings',
    purpose:
      'Which AI model each agent thinks with. Agents ask for a model by alias, and the choice here decides which model answers. A Platform Admin can test and change the model behind each alias; everyone else can see what is in use.',
    elements: [
      el(
        'Blue notes',
        'One says only Claude models are offered (the agents run on Claude Code, which needs a model that speaks the Anthropic protocol with tool use, and the gateway sends every call to Anthropic with no fallback) and that a change reaches the next model call, including runs already in progress. Another says only a Platform Admin changes these.',
      ),
      el(
        'Alias card',
        "One card per alias (a name such as an agent's model tier). It shows the alias, its purpose, and the agents that use it.",
      ),
      el(
        '"changed from the default" chip',
        'Shown when the alias no longer uses its default model.',
      ),
      el('Used by chips', 'Which agents ask for this alias, or "no agent directly".'),
      el(
        'In use now',
        'The model currently behind the alias and its price in dollars per million tokens, in and out, with who changed it and when.',
      ),
      el(
        'Model menu (Platform Admin)',
        'Choose a different model. The default is marked "(default)". Under it, a note about the model, its price, and how output cost compares (a dearer model reaches a run\'s budget sooner).',
      ),
      el(
        'Test model',
        'Sends the chosen model a tiny request and shows whether it answered, how long it took and about what it cost. A failed test says not to save that model.',
      ),
      el(
        'Save',
        'Makes the chosen model the one in use. Disabled until you choose something different. A green bar says "<alias> now uses <model>."',
      ),
      el(
        'Reset to default',
        'Appears only when the alias has been changed: puts the default model back.',
      ),
    ],
    roles:
      'Anyone signed in can see what is in use. Only a Platform Admin sees the Model menu, Test model, Save and Reset to default.',
    tips: [
      'Test a model before saving it.',
      'Changing the model affects agents already running; their next call uses the new model.',
      'To see what the models cost, use the Costs screen.',
    ],
  },
};

/** The guide for a page, or undefined when there is none for that name. */
export function helpFor(page: string): HelpScreen | undefined {
  return (HELP_PAGES as readonly string[]).includes(page)
    ? HELP_GUIDE[page as HelpPage]
    : undefined;
}

const lines = (elements: HelpElement[]) => elements.map((x) => `- ${x.name}: ${x.what}`);

/** The guide for one page as plain text for a model prompt. Empty when the page is unknown. */
export function helpAsText(page: string): string {
  const s = helpFor(page);
  if (!s) return '';
  return [
    `Screen: ${s.title}`,
    `Purpose: ${s.purpose}`,
    ...(s.roles ? [`Who can use the controls: ${s.roles}`] : []),
    'What is on the screen:',
    ...lines(s.elements),
    ...(s.tips && s.tips.length > 0 ? ['Tips:', ...s.tips.map((t) => `- ${t}`)] : []),
  ].join('\n');
}

/** What is on every page (navigation, attention badge, sign-in, banners) as plain text for a model prompt. */
export function shellHelpAsText(): string {
  return ['Every page:', ...lines(SHELL_HELP)].join('\n');
}
