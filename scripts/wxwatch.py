#!/usr/bin/env python3
"""wxwatch — poll the headless WeChat client and decide whether to wake the agent.

Same rule as the QQ bot:
  * direct message        -> wake
  * group message @me     -> wake
  * other group messages  -> ignore
  * our own messages      -> ignore

Implementation: a cheap change detector (pixel hash of the chat list) gates the OCR,
so the steady state costs almost nothing.

Usage:
  ~/.local/opt/wxbot/venv/bin/python scripts/wxwatch.py --me <nickname>
  ... --exec ./on-wake.sh        # run a command on wake, event JSON on stdin
  ... --verbose                  # also print non-waking events
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wxread  # noqa: E402

WXCTL = os.environ.get("WXCTL", os.path.join(HERE, "..", "wxctl"))
DISPLAY = os.environ.get("WX_DISPLAY", ":99")
TOP_ROW = (150, 110)          # first row of the chat list (window coordinates)
LIST_REGION = (60, 85, 300, 560)
# Timestamp-only lines (Chinese and English locale) are not messages.
TS_RE = re.compile(r"^\s*(\d{1,2}:\d{2}|昨天|星期.|周.|[A-Z][a-z]{2} \d+|\d{4}年.*)\s*$")


def sh(*args):
    env = dict(os.environ, DISPLAY=DISPLAY)
    return subprocess.run([WXCTL, *map(str, args)], capture_output=True, text=True, env=env)


def list_hash(win):
    ppm = "/tmp/wxwatch.ppm"
    sh("shot", win, ppm)
    from PIL import Image
    img = Image.open(ppm).convert("L").crop(LIST_REGION)
    # Binarise: keep ink only, ignore background changes such as the selection
    # highlight. Otherwise opening a chat re-triggers the detector and we end up
    # in an open/close loop.
    img = img.point(lambda p: 255 if p < 140 else 0)
    return hashlib.md5(img.tobytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--me", action="append", default=[], help="own nickname(s) used to detect @mentions")
    ap.add_argument("--exec", dest="cmd", help="run this command on wake; event JSON on stdin")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--interval", type=float, default=1.5, help="poll interval in seconds")
    ap.add_argument("--probe", type=float, help="exit after N seconds")
    args = ap.parse_args()

    me = args.me or [os.environ.get("WX_ME", "")]
    win = wxread.find_win()
    seen = {}
    last = list_hash(win)
    started = time.time()
    print(f"[wxwatch] watching {win}, polling every {args.interval}s", file=sys.stderr, flush=True)

    while True:
        if args.probe and time.time() - started > args.probe:
            break
        time.sleep(args.interval)
        cur = list_hash(win)
        if cur == last:
            continue
        last = cur
        time.sleep(0.8)                       # let the UI settle
        sh("activate", win)
        try:
            chat = wxread.read_chat(win)
            if not chat.get("chat"):          # no chat open: click the newest row
                sh("click", win, *TOP_ROW)
                time.sleep(1.2)
                chat = wxread.read_chat(win)
        except Exception as e:                # noqa: BLE001
            print(f"[wxwatch] read failed: {e}", file=sys.stderr, flush=True)
            last = list_hash(win)
            continue
        last = list_hash(win)                 # re-baseline (selection changes the list)

        if args.verbose:
            print(f"[wxwatch] read {chat.get('chat')!r}: {len(chat.get('messages', []))} messages",
                  file=sys.stderr, flush=True)
        is_group = chat.get("is_group")
        for m in chat.get("messages", []):
            if m["dir"] != "in":
                continue
            text = m["text"].strip()
            if not text or TS_RE.match(text):
                continue
            key = (chat.get("chat"), text)
            now = time.time()
            if now - seen.get(key, 0) < 30:   # do not fire twice for the same message
                continue
            seen[key] = now

            mentioned = any(("@" + n) in text for n in me)
            kind = "dm" if not is_group else ("group_mention" if mentioned else "group_other")
            ev = {"ts": round(now, 3), "kind": kind, "chat": chat.get("chat"),
                  "text": text, "wake": kind in ("dm", "group_mention")}
            if ev["wake"] or args.verbose:
                print(json.dumps(ev, ensure_ascii=False), flush=True)
            if ev["wake"] and args.cmd:
                subprocess.run(args.cmd, shell=True, input=json.dumps(ev, ensure_ascii=False),
                               text=True, check=False)


if __name__ == "__main__":
    main()
