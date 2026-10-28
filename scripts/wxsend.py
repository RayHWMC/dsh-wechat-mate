#!/usr/bin/env python3
"""wxsend — send a WeChat message through the locally logged-in client.

A local bridge: no protocol login, no process injection, no credentials. It drives
the running official client via XTEST key/mouse events, a self-hosted X11 clipboard
(Chinese text must be pasted) and a screenshot for the record.

By default it targets the headless instance on Xvfb (systemd: wechat-headless.service).

Usage:
  ./wxsend.py --text "hi"                    # send to the currently open chat
  ./wxsend.py --to "Alice" --text "you there?" # search first, then send (best effort)
  ./wxsend.py --text "test" --dry-run        # fill the input box only
  ./wxsend.py --text "test" --shot out.png   # screenshot when done
"""
import argparse
import os
import re
import shutil
import tempfile
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WXCTL = os.environ.get("WXCTL", os.path.join(HERE, "..", "wxctl"))
WXCTL = os.path.abspath(WXCTL)
DISPLAY = os.environ.get("WX_DISPLAY", ":99")

# Coordinates relative to the WeChat 4.1 Linux main window (880x640).
SEARCH_BOX = (127, 57)
INPUT_BOX = (590, 565)


def sh(*args, check=True):
    env = dict(os.environ, DISPLAY=DISPLAY)
    r = subprocess.run([WXCTL, *map(str, args)], capture_output=True, text=True, env=env)
    if check and r.returncode != 0:
        sys.exit(f"wxctl {args[0]} failed: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout


def find_win():
    """The main window is titled Weixin and is larger than 600x600
    (this skips the 922x892 built-in browser panel and the 280x380 login box)."""
    for line in sh("find", "Weixin").splitlines():
        m = re.match(r"(0x[0-9a-f]+)\s+(\d+)x(\d+)", line)
        if m and int(m.group(2)) > 600 and int(m.group(3)) > 600:
            return m.group(1)
    sys.exit("WeChat main window not found (systemctl --user status wechat-headless)")


def screenshot(win, path):
    ppm = os.path.join(tempfile.gettempdir(), "wxsend-%d.ppm" % os.getpid())
    sh("shot", win, ppm)
    conv = shutil.which("convert") or shutil.which("magick")
    if conv:
        subprocess.run([conv, ppm, path], check=False)
        return path
    try:
        from PIL import Image
        Image.open(ppm).save(path)
        return path
    except Exception:
        actual = path.rsplit(".", 1)[0] + ".ppm"
        os.replace(ppm, actual)
        print("no convert/Pillow available, screenshot saved as .ppm", file=sys.stderr)
        return actual


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", help="target chat name (uses the search box; WeChat 4.1's search is a web search, so this is best effort)")
    ap.add_argument("--text", required=True, help="message text")
    ap.add_argument("--dry-run", action="store_true", help="fill the input box but do not send")
    ap.add_argument("--shot", default="/tmp/wxsend-last.png")
    args = ap.parse_args()

    win = find_win()
    sh("activate", win)
    time.sleep(0.3)

    if args.to:
        sh("click", win, *SEARCH_BOX)
        time.sleep(0.3)
        sh("key", "ctrl+a")
        sh("key", "BackSpace")
        sh("clip", 90, args.to)
        time.sleep(0.3)
        sh("key", "ctrl+v")
        time.sleep(1.0)
        sh("key", "Return")
        time.sleep(1.5)

    sh("click", win, *INPUT_BOX)
    time.sleep(0.3)
    sh("clip", 90, args.text)
    time.sleep(0.3)
    sh("key", "ctrl+v")
    time.sleep(0.6)

    if not args.dry_run:
        sh("key", "Return")
        time.sleep(0.8)

    shot = screenshot(win, args.shot)
    print(f"{'filled' if args.dry_run else 'sent'} -> {args.to or 'current chat'}  (screenshot: {shot})")


if __name__ == "__main__":
    main()
