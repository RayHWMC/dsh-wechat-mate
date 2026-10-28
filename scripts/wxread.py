#!/usr/bin/env python3
"""wxread — read the currently open WeChat chat from a headless client (screenshot + OCR).

No database access, no protocol: it screenshots the window and OCRs it.

Output:
  {"chat": "Admin", "is_group": false, "messages": [{"dir": "in", "text": "Ping"}, ...]}

Heuristics:
  * chat title  = the topmost line inside the chat pane
  * group chat  = title ends with "(N)" (member count)
  * direction   = bubble background colour (own messages are green #95EC69)
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WXCTL = os.environ.get("WXCTL", os.path.join(HERE, "..", "wxctl"))

CHAT_X0 = 300          # left edge of the chat pane (window coordinates)
TITLE_Y_MAX = 80       # title row
MSG_Y0, MSG_Y1 = 90, 600
# Chinese UI strings that are not messages: "yesterday", weekday, full dates and
# system notices (recalled a message / joined the group / invited someone).
TS_LINE = re.compile(r"^(\d{1,2}:\d{2}|昨天(\s*\d{1,2}:\d{2})?|星期[一二三四五六日天].*|"
                     r"\d{4}年\d{1,2}月\d{1,2}日.*|.+(撤回了一条消息|加入了群聊|邀请.*加入).*)$")


def _env():
    return dict(os.environ, DISPLAY=os.environ.get("WX_DISPLAY", ":99"))


def shot(win, path):
    """Capture the root window and crop to the window rect.

    Capturing the window itself misses child windows (the chat pane is one),
    which show up as a black rectangle.
    """
    env = _env()
    out = subprocess.run([WXCTL, "geom", win], capture_output=True, text=True, env=env).stdout.split()
    if len(out) != 4:
        subprocess.run([WXCTL, "shot", win, path], check=True, env=env, stdout=subprocess.DEVNULL)
        return path
    x, y, w, h = map(int, out)
    raw = path + ".root.ppm"
    subprocess.run([WXCTL, "shot", "root", raw], check=True, env=env, stdout=subprocess.DEVNULL)
    from PIL import Image
    Image.open(raw).crop((x, y, x + w, y + h)).save(path)
    return path


def find_win():
    env = dict(os.environ, DISPLAY=os.environ.get("WX_DISPLAY", ":99"))
    out = subprocess.run([WXCTL, "find", "Weixin"], capture_output=True, text=True, env=env).stdout
    for line in out.splitlines():
        m = re.match(r"(0x[0-9a-f]+)\s+(\d+)x(\d+)", line)
        if m and int(m.group(2)) > 600 and int(m.group(3)) > 600:
            return m.group(1)
    sys.exit("WeChat main window not found")


def is_green(px):
    r, g, b = px[:3]
    return g > 190 and 110 < r < 190 and b < 160


def read_chat(win=None, verbose=False):
    from PIL import Image
    from rapidocr_onnxruntime import RapidOCR

    win = win or find_win()
    ppm = os.path.join(tempfile.gettempdir(), "wxread.ppm")
    shot(win, ppm)
    img = Image.open(ppm).convert("RGB")
    res, _ = RapidOCR()(ppm)
    if not res:
        return {"chat": "", "is_group": False, "messages": []}

    title, msgs = "", []
    for box, text, score in res:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        x0, y0 = int(min(xs)), int(min(ys))
        if x0 < CHAT_X0:
            continue
        if y0 <= TITLE_Y_MAX:
            if not title and text.strip():
                title = text.strip()
            continue
        if y0 < MSG_Y0 or y0 > MSG_Y1:
            continue
        if TS_LINE.match(text.strip()):      # timestamp / system notice, not a message
            continue
        # Direction: scan the middle of the text row for the green bubble colour.
        yc = int((min(ys) + max(ys)) / 2)
        outgoing = False
        for x in range(max(CHAT_X0 + 10, x0 - 30), min(img.width, x0 + 200), 4):
            if is_green(img.getpixel((x, yc))):
                outgoing = True
                break
        msgs.append({"dir": "out" if outgoing else "in", "text": text.strip(), "y": y0})

    msgs.sort(key=lambda m: m["y"])
    # Merge consecutive lines in the same direction (a wrapped message is split by OCR).
    merged = []
    for m in msgs:
        if merged and merged[-1]["dir"] == m["dir"] and m["y"] - merged[-1]["y"] < 30:
            merged[-1]["text"] += m["text"]
        else:
            merged.append(dict(m))
    is_group = bool(re.search(r"\(\d+\)\s*$", title))
    if verbose:
        print(json.dumps({"chat": title, "is_group": is_group, "messages": merged},
                         ensure_ascii=False, indent=2))
    return {"chat": title, "is_group": is_group,
            "messages": [{"dir": m["dir"], "text": m["text"]} for m in merged]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="print JSON only")
    ap.add_argument("--win", help="window id")
    args = ap.parse_args()
    out = read_chat(args.win, verbose=not args.json)
    if args.json:
        print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
