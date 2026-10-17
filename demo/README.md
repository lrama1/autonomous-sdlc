# Narrated demo videos

Videos that walk through the platform using the clickable mockups in [../designs](../designs). Browser recording and encoding run locally. The default narration voice is **edge-tts** (Microsoft Edge neural voice `en-US-AndrewNeural`), which sends only the narration text to Microsoft's online service. Use `--engine piper` for a fully local voice instead.

Each video has a title card, burned-in captions that match the narration, an on-screen cursor, and highlights on what is being discussed.

## What the product is

A semi-autonomous SDLC platform where AI agents and people build software together, and people are brought in only at the moments their judgment matters ([spec v0.6](../spec.md)). The two **core** examples show that. The regulated examples from the earlier direction are **parked**.

```
videos/
├── trailmates/                 CORE   Example 1: a small team's hiking app (6 journeys, incl. humans in the loop)
├── kestrel/                    CORE   Example 2: an online store with customer and employee work (5 journeys)
└── _parked-compliance-pack/    PARKED Regulated examples from spec v0.5 (not the current direction)
    ├── medical-device/
    └── retirement/
```

Start with `00-end-to-end-demo.mp4` in a core folder.

> **Not in git.** The MP4s (about 480 MB), the `_work/` scratch folder, the `.venv/` tooling and the optional Piper `voices/` model are listed in [../.gitignore](../.gitignore). A fresh clone has no videos. Rebuild them with the commands under [Regenerate](#regenerate). To share the videos through git instead, use Git LFS (`git lfs track "demo/videos/**/*.mp4"`) and remove `demo/videos/` from `.gitignore`.

## Core examples

### 1. Trailmates: [videos/trailmates/](videos/trailmates)

A founder and two engineers build a hiking-trip planning app. Three checkpoints by default, people wearing several hats, routine changes on autopilot. Screens: [../designs/trailmates](../designs/trailmates/index.html). Storyboard: `storyboard_trailmates.py`.

| Video | Journey | Persona(s) |
|---|---|---|
| [00-end-to-end-demo.mp4](videos/trailmates/00-end-to-end-demo.mp4) | Intro + journeys 1 to 6 | all |
| [01-idea-to-approved-spec.mp4](videos/trailmates/01-idea-to-approved-spec.mp4) | Default workflow, autonomy mode, roles with overlapping hats, spec and design approved in a click | Sofia (Founder, Product Owner), Ben (Tech Lead) |
| [02-build-a-feature.mp4](videos/trailmates/02-build-a-feature.mp4) | Two agents in parallel, headless-browser check, preview environment, independent review | Mina (Frontend, QA), Ben |
| [03-everyday-changes-on-autopilot.mp4](videos/trailmates/03-everyday-changes-on-autopilot.mp4) | Pre-approved change types, rules that hold risky changes, bug report to fix | Ben |
| [04-ship-and-tune.mp4](videos/trailmates/04-ship-and-tune.mp4) | One-approval release with canary and rollback, autonomy modes, budgets | Sofia, Ben |
| [05-humans-in-the-loop.mp4](videos/trailmates/05-humans-in-the-loop.mp4) | **The core idea:** attention queue, context and a recommendation, standing decisions, Slack answers, assumptions, interruption metrics | Ben, Sofia |
| [06-connections-and-setup.mp4](videos/trailmates/06-connections-and-setup.mp4) | Two GitHub Apps, outside services and the agent allowlist, model gateway, engine per role | Ben |

### 2. Kestrel Market: [videos/kestrel/](videos/kestrel)

An online store with customer and employee journeys. Balanced autonomy, with a closer look where money moves: payment-scope triggers that bring in the Architect and Security, a QA checkpoint, business rules traced to tests, a scope change with impact analysis, a release calendar with a change freeze, and a hotfix path. Screens: [../designs/kestrel](../designs/kestrel/index.html). Storyboard: `storyboard_kestrel.py`.

| Video | Journey | Persona(s) |
|---|---|---|
| [00-end-to-end-demo.mp4](videos/kestrel/00-end-to-end-demo.mp4) | Intro + journeys 1 to 5 | all |
| [01-customer-browse-and-checkout.mp4](videos/kestrel/01-customer-browse-and-checkout.mp4) | Payment-scope triggers, hosted card fields, retry-safe orders, Security review, sponsor blocked from reviewing | Nadia (Product Owner), Owen (Architect), Victor (Security) |
| [02-customer-orders-and-returns.mp4](videos/kestrel/02-customer-orders-and-returns.mp4) | Order tracking and returns, headless-browser check, QA checkpoint with a browser matrix and a defect found | Marcus (Frontend), Chloe (QA Lead) |
| [03-employee-merchandising.mp4](videos/kestrel/03-employee-merchandising.mp4) | Business rules as product controls, fake-clock testing of promotions, pilot rollout with a kill switch | Nadia, Lena (Backend) |
| [04-employee-fulfillment-and-support.mp4](videos/kestrel/04-employee-fulfillment-and-support.mp4) | Refund, personal-data and inventory rules, carrier label change as a scope change with impact analysis | Aisha (Ops), Nadia, Owen |
| [05-peak-season-release-and-incident.mp4](videos/kestrel/05-peak-season-release-and-incident.mp4) | Peak-load test, freeze calendar, canary with business-metric rollback, hotfix inside the freeze | Dmitri (Release Manager), Aisha |

## Parked: compliance pack

[videos/_parked-compliance-pack/](videos/_parked-compliance-pack) holds the regulated examples from the earlier direction (spec v0.5): a medical-device story (`medical-device/`, storyboard `storyboard.py`) and Harbor Retirement (`retirement/`, storyboard `storyboard_retirement.py`). They show signed evidence, separation of duties by role, audit mode and strictness levels, which are no longer part of the product. They are kept only for reference and can be deleted to save about 150 MB.

## How it works

1. A storyboard file holds the narration and the actions for each scene. `r.at(0.5)` means "wait until halfway through this scene's narration", so actions land on the words.
2. `build_demo.py` generates speech with [edge-tts](https://github.com/rany2/edge-tts) (default) or [Piper](https://github.com/OHF-Voice/piper1-gpl) (local), drives headless Chromium with Playwright while recording, then muxes video and audio with ffmpeg.
3. Each storyboard sets `VIDEO_DIR`, so output lands in `videos/<VIDEO_DIR>/`.

## Regenerate

Requirements: Python 3.11+, ffmpeg on PATH. One-time setup from this folder:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install playwright edge-tts
.\.venv\Scripts\python.exe -m playwright install chromium
```

Optional, only for the fully local voice (`--engine piper`):

```powershell
.\.venv\Scripts\python.exe -m pip install piper-tts
mkdir voices
.\.venv\Scripts\python.exe -m piper.download_voices en_US-ryan-high --data-dir voices
```

Build:

```powershell
# Trailmates (core) -> videos/trailmates/
.\.venv\Scripts\python.exe build_demo.py --set storyboard_trailmates L1 L2 L3 L4 L5 L6 lintro full

# Kestrel Market (core) -> videos/kestrel/
.\.venv\Scripts\python.exe build_demo.py --set storyboard_kestrel E1 E2 E3 E4 E5 eintro full

# Rebuild only one journey, then the combined video (reuses journeys already built in _work)
.\.venv\Scripts\python.exe build_demo.py --set storyboard_trailmates L5
.\.venv\Scripts\python.exe build_demo.py --set storyboard_trailmates full

# Rebuild the MP4 from the saved recording (no re-record)
.\.venv\Scripts\python.exe build_demo.py --set storyboard_trailmates L5 --remux

# Parked examples -> videos/_parked-compliance-pack/
.\.venv\Scripts\python.exe build_demo.py A B C D intro full                                       # medical-device
.\.venv\Scripts\python.exe build_demo.py --set storyboard_retirement R1 R2 R3 R4 R5 rintro full   # retirement
```

Recording runs in real time, so each journey takes about as long as the finished video.

## Editing tips

- Change wording in the storyboard and rebuild that journey. Narration length drives scene length.
- If you change a mockup in `../designs`, re-run the journeys that show it.
- Tuning knobs in `build_demo.py`: `EDGE_VOICE` and `EDGE_RATE` (edge-tts voice and speed), `LENGTH_SCALE` (Piper speed, higher is slower), `AV_OFFSET` (audio/video sync), `PAD` (pause after each scene).
- Other edge-tts voices to try: `en-US-AriaNeural`, `en-US-GuyNeural`, `en-US-BrianNeural`, `en-US-JennyNeural`, `en-US-AvaNeural`. Changing the voice changes narration length, so re-record (not `--remux`).
- To add another example, copy `storyboard_trailmates.py`, set a new `VIDEO_DIR` and unique journey keys, and run with `--set <module name>`.
- To use another Piper voice, download it with `piper.download_voices` and change `VOICE_FILE`.

## Folders

- `videos/<example>/`: finished MP4s, one folder per example.
- `_work/`: intermediate recordings, WAVs, cards, and the timeline for each journey. Safe to delete.
- `.venv/`: tooling (about 270 MB). `voices/`: the optional Piper model (about 115 MB). Safe to delete if you will not regenerate.
