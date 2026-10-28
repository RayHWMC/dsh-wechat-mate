#!/usr/bin/env python3
"""wxread —— 把无头微信当前会话「读」出来（截图 + OCR，不碰数据库、不碰协议）。

输出 JSON：
  {"chat": "Admin", "is_group": false, "messages": [{"dir": "in", "text": "Ping"}, ...]}

判定：
  * 会话标题 = 聊天区最上面那行
  * 组聊判定 = 标题里带 "(N)" 成员数
  * 消息方向 = 气泡底色（微信自己发的绿 #95EC69；收到的浅灰/白）
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

CHAT_X0 = 300          # 聊天区左边界（窗口坐标）
TITLE_Y_MAX = 80       # 标题行
MSG_Y0, MSG_Y1 = 90, 600
TS_LINE = re.compile(r"^(\d{1,2}:\d{2}|昨天(\s*\d{1,2}:\d{2})?|星期[一二三四五六日天].*|"
                     r"\d{4}年\d{1,2}月\d{1,2}日.*|.+(撤回了一条消息|加入了群聊|邀请.*加入).*)$")


def shot(win, path):
    env = dict(os.environ, DISPLAY=os.environ.get("WX_DISPLAY", ":99"))
    subprocess.run([WXCTL, "shot", win, path], check=True, env=env,
                   stdout=subprocess.DEVNULL)


def find_win():
    env = dict(os.environ, DISPLAY=os.environ.get("WX_DISPLAY", ":99"))
    out = subprocess.run([WXCTL, "find", "Weixin"], capture_output=True, text=True, env=env).stdout
    for line in out.splitlines():
        m = re.match(r"(0x[0-9a-f]+)\s+(\d+)x(\d+)", line)
        if m and int(m.group(2)) > 600 and int(m.group(3)) > 600:
            return m.group(1)
    sys.exit("找不到微信主窗口")


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
        if TS_LINE.match(text.strip()):      # 时间戳/系统提示，不是消息
            continue
        # 气泡底色判定方向：在文字行中间扫一段，看有没有绿色
        yc = int((min(ys) + max(ys)) / 2)
        outgoing = False
        for x in range(max(CHAT_X0 + 10, x0 - 30), min(img.width, x0 + 200), 4):
            if is_green(img.getpixel((x, yc))):
                outgoing = True
                break
        msgs.append({"dir": "out" if outgoing else "in", "text": text.strip(), "y": y0})

    msgs.sort(key=lambda m: m["y"])
    # 相邻同方向的短行合并（一条消息换行会被 OCR 拆开）
    merged = []
    for m in msgs:
        if merged and merged[-1]["dir"] == m["dir"] and m["y"] - merged[-1]["y"] < 30:
            merged[-1]["text"] += m["text"] if merged[-1]["text"].endswith(("-", "/")) else m["text"]
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
    ap.add_argument("--json", action="store_true", help="只输出 JSON")
    ap.add_argument("--win", help="窗口 id")
    args = ap.parse_args()
    out = read_chat(args.win, verbose=not args.json)
    if args.json:
        print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
