#!/usr/bin/env bash
# 一键安装「无头微信本机桥」：编译 wxctl、取 Xvfb、装 systemd --user 单元
# 不需要 root：Xvfb 用 apt-get download + dpkg -x 解包到 ~/.local/opt/wxbot
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${WXBOT_PREFIX:-$HOME/.local/opt/wxbot}"
UNIT_DIR="$HOME/.config/systemd/user"
DISPLAY_NUM="${WX_DISPLAY_NUM:-99}"
RES="${WX_RESOLUTION:-1440x900}"

echo "==> 1/4 编译 wxctl"
gcc -O2 -o "$ROOT/wxctl" "$ROOT/wxctl.c" -lX11 -lXtst

echo "==> 2/4 准备 Xvfb（免 root）-> $PREFIX"
mkdir -p "$PREFIX"
if [ ! -x "$PREFIX/usr/bin/Xvfb" ]; then
    tmp=$(mktemp -d)
    ( cd "$tmp" && apt-get download xvfb >/dev/null && dpkg -x ./*.deb "$PREFIX" )
    rm -rf "$tmp"
fi
test -x "$PREFIX/usr/bin/Xvfb"

echo "==> 3/4 安装 systemd --user 单元"
mkdir -p "$UNIT_DIR"
sed -e "s|@PREFIX@|$PREFIX|g" -e "s|@DISPLAY@|$DISPLAY_NUM|g" -e "s|@RES@|$RES|g" \
    "$ROOT/systemd/xvfb-wx.service" > "$UNIT_DIR/xvfb-wx.service"
sed -e "s|@WECHAT@|$(command -v wechat || echo /usr/bin/wechat)|g" -e "s|@DISPLAY@|$DISPLAY_NUM|g" \
    "$ROOT/systemd/wechat-headless.service" > "$UNIT_DIR/wechat-headless.service"

echo "==> 4/4 启动"
systemctl --user daemon-reload
systemctl --user enable --now xvfb-wx.service
systemctl --user enable --now wechat-headless.service
sleep 5
echo
echo "已启动。如果是第一次登录，跑： $ROOT/scripts/wxlogin.sh"
echo "之后： $ROOT/scripts/wxsend.py --text '你好'"
