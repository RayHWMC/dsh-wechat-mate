#!/usr/bin/env python3
"""wxwatch —— 轮询无头微信，发现新消息就判定「要不要叫醒 agent」。

逻辑（和 QQ 机器人一致）：
  * 私聊            -> wake
  * 群里 @我        -> wake
  * 群里普通消息    -> 忽略
  * 自己发的        -> 忽略

实现：便宜的变化检测（对会话列表区域做像素哈希）-> 有变化才 OCR 一次当前会话，
所以常态零 OCR 开销。

用法：
  ~/.local/opt/wxbot/venv/bin/python scripts/wxwatch.py --me 肥鱼
  ... --exec ./on-wake.sh        # 命中时执行命令，事件 JSON 从 stdin 进
  ... --verbose                  # 不命中的也打印
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
TOP_ROW = (150, 110)          # 会话列表第一行的相对坐标
LIST_REGION = (60, 85, 300, 560)
TS_RE = re.compile(r"^\s*(\d{1,2}:\d{2}|昨天|星期.|周.|[A-Z][a-z]{2} \d+|\d{4}年.*)\s*$")


def sh(*args):
    env = dict(os.environ, DISPLAY=DISPLAY)
    return subprocess.run([WXCTL, *map(str, args)], capture_output=True, text=True, env=env)


def list_hash(win):
    ppm = "/tmp/wxwatch.ppm"
    sh("shot", win, ppm)
    from PIL import Image
    img = Image.open(ppm).convert("L").crop(LIST_REGION)
    # 二值化：只保留文字笔画，忽略「选中高亮/未读底色」这类背景变化，
    # 否则点开会话造成的底色变化会自己触发自己，形成点开-关闭的死循环
    img = img.point(lambda p: 255 if p < 140 else 0)
    return hashlib.md5(img.tobytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--me", action="append", default=[], help="自己的昵称，可多次给")
    ap.add_argument("--exec", dest="cmd", help="命中时执行，事件 JSON 从 stdin 进")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--interval", type=float, default=1.5, help="轮询间隔秒")
    ap.add_argument("--probe", type=float, help="跑 N 秒后退出")
    args = ap.parse_args()

    me = args.me or ["肥鱼"]
    win = wxread.find_win()
    seen = {}
    last = list_hash(win)
    started = time.time()
    print(f"[wxwatch] 监听 {win}，每 {args.interval}s 检查一次", file=sys.stderr, flush=True)

    while True:
        if args.probe and time.time() - started > args.probe:
            break
        time.sleep(args.interval)
        cur = list_hash(win)
        if cur == last:
            continue
        last = cur
        time.sleep(0.8)                       # 等界面稳定
        sh("activate", win)
        try:
            chat = wxread.read_chat(win)
            if not chat.get("chat"):          # 聊天区没开，点开最新会话
                sh("click", win, *TOP_ROW)
                time.sleep(1.2)
                chat = wxread.read_chat(win)
        except Exception as e:                # noqa: BLE001
            print(f"[wxwatch] 读取失败: {e}", file=sys.stderr, flush=True)
            last = list_hash(win)
            continue
        last = list_hash(win)                 # 读完后重新基线（选中态会改列表）

        if args.verbose:
            print(f"[wxwatch] 读到会话 {chat.get('chat')!r}：{len(chat.get('messages', []))} 条",
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
            if now - seen.get(key, 0) < 30:   # 同一条消息 30 秒内不重复触发
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
