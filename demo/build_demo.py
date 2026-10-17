#!/usr/bin/env python
"""Builds narrated demo videos from the HTML mockups in ../designs.

Pipeline per journey:
  1. Text-to-speech turns each scene's narration into a WAV. Default engine: edge-tts (Microsoft Edge neural voices,
     sends the narration text to Microsoft's online service). Alternative: --engine piper (fully local).
  2. Playwright drives the mockups in headless Chromium (cursor, highlights, captions) and records video.
     Actions are paced to the narration with r.at(fraction).
  3. ffmpeg places each narration clip at its scene start and muxes video + audio into MP4.

Usage:  python build_demo.py A B C D full      (any subset; 'full' concatenates intro + A..D)
Browser recording and encoding run locally. Only the narration text goes out, and only with --engine edge (default).
"""
import argparse
import atexit
import importlib
import json
import socket
import subprocess
import sys
import time
import wave
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
storyboard = None  # chosen at runtime with --set
PROJECT = ROOT.parent
WORK = ROOT / "_work"
OUT = ROOT / "videos"  # set per storyboard in main(): videos/<VIDEO_DIR>
PORT = 8765
BASE = f"http://127.0.0.1:{PORT}/"
W, H = 1280, 720
VOICE_FILE = ROOT / "voices" / "en_US-ryan-high.onnx"   # Piper voice (--engine piper)
LENGTH_SCALE = 1.12   # Piper: >1 slows speech
EDGE_VOICE = "en-US-AndrewNeural"   # edge-tts voice. Others: AriaNeural, GuyNeural, BrianNeural, JennyNeural, AvaNeural
EDGE_RATE = "-4%"     # edge-tts speaking rate
ENGINE = "edge"
CARD_LEAD = 1.2       # narration delay on title cards
SCENE_LEAD = 0.45     # narration delay on normal scenes
PAD = 0.9             # silence after narration ends
AV_OFFSET = 0.22      # recorded video runs ~0.2 s ahead of the driver clock; shift audio earlier to match

INIT_JS = r"""
(() => {
  if (window.__demoInit) return; window.__demoInit = true;
  const CSS = `
    #demo-cursor{position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;opacity:0;transform:translate(-100px,-100px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
    .demo-ripple{position:fixed;z-index:2147483646;pointer-events:none;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:3px solid #2b59e0;animation:demoRip .55s ease-out forwards}
    @keyframes demoRip{to{transform:scale(4);opacity:0}}
    .demo-hl{position:fixed;z-index:2147483645;pointer-events:none;border:3px solid #ff3d71;border-radius:12px;box-shadow:0 0 0 6px rgba(255,61,113,.22);animation:demoPulse 1.4s ease-in-out infinite}
    @keyframes demoPulse{50%{box-shadow:0 0 0 12px rgba(255,61,113,.08)}}
    #demo-caption{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);max-width:84%;z-index:2147483647;pointer-events:none;background:rgba(15,23,41,.93);color:#fff;font:500 20px/1.4 system-ui,"Segoe UI",sans-serif;padding:10px 22px;border-radius:12px;text-align:center;display:none;box-shadow:0 8px 30px rgba(0,0,0,.35)}
    #demo-caption.top{bottom:auto;top:68px}
  `;
  function setup(){
    const st = document.createElement('style'); st.textContent = CSS; document.documentElement.appendChild(st);
    const c = document.createElement('div'); c.id = 'demo-cursor';
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2v17l4.5-4.2 3 6.7 2.6-1.2-3-6.5L18 11z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const cap = document.createElement('div'); cap.id = 'demo-caption'; document.documentElement.appendChild(cap);
    addEventListener('mousemove', e => { c.style.opacity = 1; c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    addEventListener('mousedown', e => { const r = document.createElement('div'); r.className = 'demo-ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.documentElement.appendChild(r); setTimeout(() => r.remove(), 600); }, true);
    addEventListener('scroll', () => window.__demoClearHL(), true);
  }
  function place() {
    const cap = document.getElementById('demo-caption');
    if (!cap || cap.style.display === 'none') return;
    const hls = [...document.querySelectorAll('.demo-hl')].map(e => e.getBoundingClientRect());
    const cur = document.getElementById('demo-cursor');
    if (cur && cur.style.opacity === '1') {
      const c = cur.getBoundingClientRect();
      for (let i = 0; i < 6; i++) hls.push({ left: c.left - 40, right: c.right + 40, top: c.top - 40, bottom: c.bottom + 40 });
    }
    const overlap = r => hls.reduce((s, h) => s + Math.max(0, Math.min(h.right, r.right) - Math.max(h.left, r.left)) * Math.max(0, Math.min(h.bottom, r.bottom) - Math.max(h.top, r.top)), 0);
    cap.classList.remove('top');
    const bottomOv = overlap(cap.getBoundingClientRect());
    cap.classList.add('top');
    if (overlap(cap.getBoundingClientRect()) >= bottomOv) cap.classList.remove('top');
  }
  window.__demoPlace = place;
  window.__demoCaption = t => { const el = document.getElementById('demo-caption'); if (!el) return; el.textContent = t || ''; el.style.fontSize = (t || '').length > 300 ? '16.5px' : (t || '').length > 230 ? '18px' : '20px'; el.style.display = t ? 'block' : 'none'; place(); };
  window.__demoClearHL = () => { document.querySelectorAll('.demo-hl').forEach(e => e.remove()); place(); };
  window.__demoHL = rects => { window.__demoClearHL(); rects.forEach(r => { const d = document.createElement('div'); d.className = 'demo-hl'; d.style.cssText = `left:${r.x - 6}px;top:${r.y - 6}px;width:${r.w + 12}px;height:${r.h + 12}px`; document.documentElement.appendChild(d); }); place(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup); else setup();
})();
"""

CARD_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>__TITLE__</title><style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;color:#fff;font-family:system-ui,"Segoe UI",sans-serif;
background:radial-gradient(1200px 600px at 20% 10%,#2b3f9c 0,transparent 60%),linear-gradient(135deg,#0b1224,#1b2a66 60%,#3a1f6e)}
.wrap{max-width:1000px;padding:0 60px;animation:in .9s ease-out both}@keyframes in{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
.tag{display:inline-block;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);border-radius:99px;padding:4px 16px;font-size:20px;letter-spacing:.04em;margin-bottom:22px}
h1{font-size:60px;line-height:1.08;margin:0 0 18px}.sub{font-size:28px;color:#cdd7ff;margin:0 0 30px;line-height:1.35}
.chips{display:flex;gap:12px;flex-wrap:wrap}.chips span{background:rgba(255,255,255,.1);border-radius:10px;padding:8px 16px;font-size:20px;color:#e6ebff}
</style></head><body><div class="wrap"><div class="tag">__TAG__</div><h1>__TITLE__</h1><p class="sub">__SUB__</p><div class="chips">__CHIPS__</div></div></body></html>"""


class Rec:
    """Drives the page: smooth cursor, highlights, captions, and narration-paced waits."""

    def __init__(self, page):
        self.p = page
        self.x, self.y = W / 2, H / 2
        self.cap = ""
        self.scene_t0 = 0.0
        self.scene_dur = 0.0
        self.scene_lead = SCENE_LEAD
        self.first_loaded_at = None
        self.t0 = time.monotonic()

    def now(self):
        return time.monotonic() - self.t0

    def wait(self, s):
        self.p.wait_for_timeout(int(s * 1000))

    def at(self, frac):
        """Wait until `frac` of the way through this scene's narration."""
        target = self.scene_t0 + self.scene_lead + frac * self.scene_dur
        remaining = target - self.now()
        if remaining > 0:
            self.wait(remaining)

    def _after_nav(self, restore_mouse=True):
        self.p.wait_for_load_state("load")
        if self.first_loaded_at is None:
            self.first_loaded_at = self.now()
        self.wait(0.35)
        self.p.evaluate("t=>window.__demoCaption(t)", self.cap)
        if restore_mouse:
            self.p.mouse.move(self.x, self.y)

    def goto(self, path, restore_mouse=True):
        self.p.goto(BASE + path)
        self._after_nav(restore_mouse)

    def caption(self, text):
        self.cap = text
        self.p.evaluate("t=>window.__demoCaption&&window.__demoCaption(t)", text)

    def card(self, key, tag, title, sub="", chips=()):
        path = WORK / "cards" / f"{key}.html"
        path.parent.mkdir(parents=True, exist_ok=True)
        chip_html = "".join(f"<span>{c}</span>" for c in chips)
        html = (CARD_HTML.replace("__TITLE__", title).replace("__TAG__", tag)
                .replace("__SUB__", sub).replace("__CHIPS__", chip_html))
        path.write_text(html, encoding="utf-8")
        self.goto(f"demo/_work/cards/{key}.html", restore_mouse=False)

    def _loc(self, sel):
        loc = self.p.locator(sel).first
        loc.wait_for(state="visible", timeout=8000)
        return loc

    def _box(self, sel):
        return self._loc(sel).bounding_box()

    def scroll_to(self, sel):
        self._loc(sel).evaluate(
            "el=>{const r=el.getBoundingClientRect();el.style.scrollMarginTop='80px';"
            "el.scrollIntoView({behavior:'smooth',block:r.height>500?'start':'center'});}")
        self.wait(0.9)

    def _in_view(self, sel):
        return self._loc(sel).evaluate("el=>{const r=el.getBoundingClientRect();return r.top>70&&r.bottom<innerHeight-70}")

    def hl(self, *sels, scroll=True):
        if scroll and not self._in_view(sels[0]):
            self.scroll_to(sels[0])
        rects = []
        for s in sels:
            b = self._box(s)
            rects.append({"x": b["x"], "y": b["y"], "w": b["width"], "h": b["height"]})
        self.p.evaluate("r=>window.__demoHL(r)", rects)

    def clear(self):
        self.p.evaluate("window.__demoClearHL()")

    def move_to(self, sel):
        if not self._in_view(sel):
            self.scroll_to(sel)
        b = self._box(sel)
        tx, ty = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
        sx, sy, n = self.x, self.y, 24
        for i in range(1, n + 1):
            t = i / n
            e = t * t * (3 - 2 * t)
            self.p.mouse.move(sx + (tx - sx) * e, sy + (ty - sy) * e)
            self.p.wait_for_timeout(16)
        self.x, self.y = tx, ty
        self.p.evaluate("window.__demoPlace&&window.__demoPlace()")

    def click(self, sel):
        self.clear()
        self.move_to(sel)
        self.wait(0.25)
        self.p.mouse.down()
        self.wait(0.08)
        self.p.mouse.up()
        self.wait(0.35)

    def click_nav(self, sel):
        self.clear()
        self.move_to(sel)
        self.wait(0.25)
        with self.p.expect_navigation():
            self.p.mouse.down()
            self.wait(0.08)
            self.p.mouse.up()
        self._after_nav()

    def select(self, sel, value):
        self.clear()
        self.move_to(sel)
        self.wait(0.3)
        self.p.select_option(sel, value)
        self.wait(0.4)

    def slide(self, sel, a, b, step=1, delay=0.12):
        self.clear()
        self.move_to(sel)
        rng = range(a, b + (1 if step > 0 else -1), step)
        for v in rng:
            self.p.eval_on_selector(sel, "(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));}", v)
            self.wait(delay)


def start_server():
    proc = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", str(PROJECT)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    atexit.register(proc.terminate)
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", PORT), timeout=0.2).close()
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("local web server did not start")


def wav_seconds(path):
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def synth(voice, text, path):
    """Write narration for `text` to a WAV at `path` and return its length in seconds."""
    if ENGINE == "piper":
        from piper import SynthesisConfig
        with wave.open(str(path), "wb") as w:
            voice.synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=LENGTH_SCALE))
        return wav_seconds(path)
    import asyncio
    import edge_tts
    mp3 = path.with_suffix(".mp3")
    for attempt in range(3):
        try:
            asyncio.run(edge_tts.Communicate(text, EDGE_VOICE, rate=EDGE_RATE).save(str(mp3)))
            break
        except Exception as exc:  # network hiccup: retry
            if attempt == 2:
                raise
            print(f"edge-tts retry after error: {exc}")
            time.sleep(2)
    run(["ffmpeg", "-y", "-i", str(mp3), "-ar", "24000", "-ac", "1", str(path)])
    mp3.unlink()
    return wav_seconds(path)


def run(cmd):
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode:
        print(res.stderr[-2500:])
        raise SystemExit(f"command failed: {cmd[0]}")
    return res


def mux(wd, scenes, starts, trim, video):
    out = wd / "final.mp4"
    cmd = ["ffmpeg", "-y", "-ss", f"{trim:.3f}", "-i", str(video)]
    for i in range(len(scenes)):
        cmd += ["-i", str(wd / f"{i:02d}.wav")]
    fc = []
    for i, t in enumerate(starts):
        d = max(0, int((t - trim - AV_OFFSET) * 1000))
        fc.append(f"[{i + 1}:a]adelay={d}|{d}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(scenes)))
    fc.append(f"{mix}amix=inputs={len(scenes)}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,apad[aout]")
    cmd += ["-filter_complex", ";".join(fc), "-map", "0:v", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium",
            "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-ar", "44100", "-b:a", "160k",
            "-movflags", "+faststart", "-shortest", str(out)]
    run(cmd)
    return out


def build_journey(key, voice, remux=False):
    j = storyboard.JOURNEYS[key]
    wd = WORK / key
    wd.mkdir(parents=True, exist_ok=True)
    scenes = j["scenes"]
    if remux:
        tl = json.loads((wd / "timeline.json").read_text(encoding="utf-8"))
        video = next((wd / "vid").glob("*.webm"))
        out = mux(wd, scenes, tl["starts"], tl["trim"], video)
        print(f"[{key}] remuxed -> {out.name}")
        return out
    durs = []
    for i, s in enumerate(scenes):
        durs.append(synth(voice, s["say"], wd / f"{i:02d}.wav"))
    print(f"[{key}] narration {sum(durs):.0f}s across {len(scenes)} scenes")

    vdir = wd / "vid"
    starts = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": W, "height": H}, record_video_dir=str(vdir),
                                  record_video_size={"width": W, "height": H})
        ctx.add_init_script(INIT_JS)
        page = ctx.new_page()
        r = Rec(page)
        for i, s in enumerate(scenes):
            is_card = s.get("card", False)
            r.scene_lead = CARD_LEAD if is_card else SCENE_LEAD
            r.scene_t0 = r.now()
            r.scene_dur = durs[i]
            r.caption(s["text"])
            s["run"](r)
            starts.append(r.scene_t0 + r.scene_lead)
            end = r.scene_t0 + r.scene_lead + durs[i] + PAD
            if r.now() < end:
                r.wait(end - r.now())
        video = Path(page.video.path())
        ctx.close()
        browser.close()

    trim = max(0.0, r.first_loaded_at or 0)
    (wd / "timeline.json").write_text(json.dumps({"first_loaded_at": r.first_loaded_at, "trim": trim, "starts": starts,
                                                  "durs": durs}, indent=1), encoding="utf-8")
    out = mux(wd, scenes, starts, trim, video)
    print(f"[{key}] -> {out.name} ({out.stat().st_size / 1e6:.1f} MB)")
    return out


def concat(files, dest):
    lst = WORK / "concat.txt"
    lst.write_text("".join(f"file '{f.as_posix()}'\n" for f in files), encoding="utf-8")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(dest)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("targets", nargs="+", help="journey keys from the storyboard, or 'full'")
    ap.add_argument("--set", default="storyboard", help="storyboard module: storyboard (medical device) or storyboard_retirement")
    ap.add_argument("--remux", action="store_true", help="skip recording, rebuild MP4 from saved video and timeline")
    ap.add_argument("--engine", choices=["edge", "piper"], default="edge",
                    help="edge: edge-tts online neural voices (default). piper: fully local")
    args = ap.parse_args()
    global ENGINE, storyboard, OUT
    ENGINE = args.engine
    storyboard = importlib.import_module(args.set)
    order = storyboard.FULL_ORDER
    OUT = ROOT / "videos" / storyboard.VIDEO_DIR   # one folder per example
    OUT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(exist_ok=True)
    start_server()
    voice = None
    if ENGINE == "piper":
        from piper import PiperVoice
        voice = PiperVoice.load(str(VOICE_FILE))
    keys = [k for k in args.targets if k != "full"]
    built = {}
    need = set(keys)
    if "full" in args.targets:
        need |= set(order)
    for k in order:
        if k in need:
            existing = WORK / k / "final.mp4"
            if k not in keys and existing.exists():
                built[k] = existing  # reuse a journey built earlier
            else:
                built[k] = build_journey(k, voice, remux=args.remux)
    for k in keys:
        fname = storyboard.JOURNEYS[k]["file"]
        if fname:
            dest = OUT / fname
            dest.write_bytes(built[k].read_bytes())
            print("wrote", dest)
    if "full" in args.targets:
        dest = OUT / storyboard.FULL_FILE
        concat([built[k] for k in order], dest)
        print("wrote", dest)


if __name__ == "__main__":
    main()
