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
import tempfile
from collections import OrderedDict
from wxlock import display_lock, watcher_lock

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
    return subprocess.run([WXCTL, *map(str, args)], capture_output=True, text=True, env=env, check=True, timeout=15)


def list_hash(win):
    from PIL import Image
    with tempfile.TemporaryDirectory(prefix="wxwatch-") as directory:
        ppm = os.path.join(directory, "list.ppm")
        wxread.shot(win, ppm)
        with Image.open(ppm) as image:
            img = image.convert("L").crop(LIST_REGION)
    # Binarise: keep ink only, ignore background changes such as the selection
    # highlight. Otherwise opening a chat re-triggers the detector and we end up
    # in an open/close loop.
    img = img.point(lambda p: 255 if p < 140 else 0)
    return hashlib.md5(img.tobytes()).hexdigest()


def mentioned_me(text, names):
    return any(re.search(r"@" + re.escape(name.strip()) + r"(?=$|\s|[，。！？,!?;；:：])", text)
               for name in names if name.strip())


class SnapshotTracker:
    """Diff visible OCR rows without replaying a whole conversation every 30s."""

    def __init__(self):
        self.chats = OrderedDict()

    def update(self, chat, baseline=False):
        key = (bool(chat.get("is_group")), chat.get("chat"))
        rows = [(m["dir"], m["text"].strip()) for m in chat.get("messages", [])]
        previous = self.chats.pop(key, None)
        self.chats[key] = rows
        if len(self.chats) > 128:
            self.chats.popitem(last=False)
        if baseline or not rows:
            return []
        if previous is None:
            # There is no evidence that older visible rows arrived since startup.
            return rows[-1:]
        for overlap in range(min(len(previous), len(rows)), 0, -1):
            if previous[-overlap:] == rows[:overlap]:
                return rows[overlap:]
        # No overlap may mean scrolling or an OCR correction; do not replay history.
        return []


def events_for(chat, rows, captures, names, timestamp=None):
    """Apply the same DM/group mention policy to text and verified images."""
    if not chat.get('chat'):
        return []
    now = round(time.time() if timestamp is None else timestamp, 3)
    group = bool(chat.get('is_group'))
    incoming = [text for direction, text in rows if direction == 'in' and text and not TS_RE.match(text)]
    mentioned = any(mentioned_me(text, names) for text in incoming)
    if captures and (not group or mentioned):
        return [{'ts': now, 'kind': 'image', 'chat': chat['chat'], 'chatType': 'group' if group else 'dm',
                 'path': path, 'text': '\n'.join(incoming), 'wake': True} for path in captures]
    events = []
    for text in incoming:
        kind = 'dm' if not group else ('group_mention' if mentioned_me(text, names) else 'group_other')
        events.append({'ts': now, 'kind': kind, 'chat': chat['chat'], 'text': text,
                       'wake': kind in ('dm', 'group_mention')})
    return events


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--me", action="append", default=[], help="own nickname(s) used to detect @mentions")
    ap.add_argument("--exec", dest="cmd", help="run this command on wake; event JSON on stdin")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--interval", type=float, default=1.5, help="poll interval in seconds")
    ap.add_argument("--probe", type=float, help="exit after N seconds")
    ap.add_argument("--parent-pid", type=int, help="exit when this owning host is no longer the parent")
    args = ap.parse_args()
    if args.parent_pid is not None and args.parent_pid != os.getppid():
        return
    if args.interval <= 0 or (args.probe is not None and args.probe <= 0):
        ap.error("interval and probe must be positive")
    with watcher_lock(__file__):
        watch(args)


def watch(args):
    from wxmedia import MediaTracker, capture_preview

    me = args.me or [os.environ.get("WX_ME", "")]
    win = wxread.find_win()
    tracker = SnapshotTracker()
    media_tracker = MediaTracker()
    with display_lock():
        baseline = wxread.read_chat(win, media=True)
        tracker.update(baseline, baseline=True)
        media_tracker.update(baseline, baseline=True)
        last = list_hash(win)
    started = time.time()
    print(f"[wxwatch] watching {win}, polling every {args.interval}s", file=sys.stderr, flush=True)

    while True:
        if args.parent_pid is not None and args.parent_pid != os.getppid():
            print('[wxwatch] owning host exited; stopping', file=sys.stderr, flush=True)
            break
        if args.probe and time.time() - started > args.probe:
            break
        time.sleep(args.interval)
        cur = list_hash(win)
        if cur == last:
            continue
        last = cur
        time.sleep(0.8)                       # let the UI settle
        try:
            with display_lock():
                sh("activate", win)
                # A changed list can belong to another chat even when a chat is open.
                sh("click", win, *TOP_ROW)
                time.sleep(1.2)
                chat = wxread.read_chat(win, media=True)
                rows = tracker.update(chat)
                images = media_tracker.update(chat)
                captures = []
                mention = any(mentioned_me(text, me) for direction, text in rows if direction == 'in')
                if chat.get('chat') and (not chat.get('is_group') or mention):
                    for bubble in images:
                        try:
                            captures.append(capture_preview(win, bubble))
                        except Exception as error:
                            print(f'[wxwatch] image capture failed: {error}', file=sys.stderr, flush=True)
        except Exception as e:                # noqa: BLE001
            print(f"[wxwatch] read failed: {e}", file=sys.stderr, flush=True)
            last = list_hash(win)
            continue
        last = list_hash(win)                 # re-baseline (selection changes the list)

        if args.verbose:
            print(f"[wxwatch] read {chat.get('chat')!r}: {len(chat.get('messages', []))} messages",
                  file=sys.stderr, flush=True)
        for ev in events_for(chat, rows, captures, me):
            if ev["wake"] or args.verbose:
                print(json.dumps(ev, ensure_ascii=False), flush=True)
            if ev["wake"] and args.cmd:
                subprocess.run(args.cmd, shell=True, input=json.dumps(ev, ensure_ascii=False),
                               text=True, check=False)


if __name__ == "__main__":
    main()
