#!/usr/bin/env python3
"""wxsend —— 通过本机已登录的微信客户端发消息（本机桥：不碰协议、不注入、不读凭据）

原理：直接驱动正在运行的官方客户端
    XTEST 注入键鼠 + 自建 X11 剪贴板（中文必须 paste）+ 截图留证
默认作用于 Xvfb 上的无头实例（systemd: wechat-headless.service）。

用法：
  ./wxsend.py --text "你好"                 # 发给当前打开的会话
  ./wxsend.py --to "张三" --text "在吗"      # 先搜索再发（尽力而为，见 README）
  ./wxsend.py --text "测试" --dry-run       # 只填输入框，不发送
  ./wxsend.py --text "测试" --shot out.png  # 结束时截图
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

# 窗口内相对坐标（微信 4.1 Linux 主窗口 880x640）
SEARCH_BOX = (127, 57)
INPUT_BOX = (590, 565)


def sh(*args, check=True):
    env = dict(os.environ, DISPLAY=DISPLAY)
    r = subprocess.run([WXCTL, *map(str, args)], capture_output=True, text=True, env=env)
    if check and r.returncode != 0:
        sys.exit(f"wxctl {args[0]} failed: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout


def find_win():
    """微信主窗口：名字含 Weixin、尺寸 > 600x600（避开「搜一搜」面板和登录框）"""
    for line in sh("find", "Weixin").splitlines():
        m = re.match(r"(0x[0-9a-f]+)\s+(\d+)x(\d+)", line)
        if m and int(m.group(2)) > 600 and int(m.group(3)) > 600:
            return m.group(1)
    sys.exit("找不到微信主窗口（systemctl --user status wechat-headless 看看）")


def screenshot(win, path):
    ppm = os.path.join(tempfile.gettempdir(), "wxsend-%d.ppm" % os.getpid())
    sh("shot", win, ppm)
    if shutil.which("convert") or shutil.which("magick"):
        conv = shutil.which("convert") or shutil.which("magick")
        subprocess.run([conv, ppm, path], check=False)
        return path
    try:
        from PIL import Image
        Image.open(ppm).save(path)
        return path
    except Exception:
        actual = path.rsplit(".", 1)[0] + ".ppm"
        os.replace(ppm, actual)
        print("没有 convert/Pillow，截图存成 .ppm 了", file=sys.stderr)
        return actual


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", help="目标会话名（走搜索框；微信 4.1 Linux 的搜索是「搜一搜」，不稳）")
    ap.add_argument("--text", required=True, help="要发送的文本")
    ap.add_argument("--dry-run", action="store_true", help="只填到输入框，不发送")
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
    print(f"{'filled' if args.dry_run else 'sent'} -> {args.to or '当前会话'}  (screenshot: {shot})")


if __name__ == "__main__":
    main()
