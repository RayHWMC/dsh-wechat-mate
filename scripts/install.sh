#!/usr/bin/env bash
# One-shot installer for the headless WeChat bridge: builds wxctl, fetches Xvfb and
# installs the systemd --user units.
# No root required: Xvfb is fetched with `apt-get download` and unpacked with `dpkg -x`
# into ~/.local/opt/wxbot.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${WXBOT_PREFIX:-$HOME/.local/opt/wxbot}"
UNIT_DIR="$HOME/.config/systemd/user"
DISPLAY_NUM="${WX_DISPLAY_NUM:-99}"
RES="${WX_RESOLUTION:-1440x900}"

echo "==> 1/4 building wxctl"
gcc -O2 -o "$ROOT/wxctl" "$ROOT/wxctl.c" -lX11 -lXtst

echo "==> 2/4 preparing Xvfb (no root) -> $PREFIX"
mkdir -p "$PREFIX"
if [ ! -x "$PREFIX/usr/bin/Xvfb" ]; then
    tmp=$(mktemp -d)
    ( cd "$tmp" && apt-get download xvfb >/dev/null && dpkg -x ./*.deb "$PREFIX" )
    rm -rf "$tmp"
fi
test -x "$PREFIX/usr/bin/Xvfb"

echo "==> 3/4 installing systemd --user units"
mkdir -p "$UNIT_DIR"
sed -e "s|@PREFIX@|$PREFIX|g" -e "s|@DISPLAY@|$DISPLAY_NUM|g" -e "s|@RES@|$RES|g" \
    "$ROOT/systemd/xvfb-wx.service" > "$UNIT_DIR/xvfb-wx.service"
sed -e "s|@WECHAT@|$(command -v wechat || echo /usr/bin/wechat)|g" -e "s|@DISPLAY@|$DISPLAY_NUM|g" \
    "$ROOT/systemd/wechat-headless.service" > "$UNIT_DIR/wechat-headless.service"

echo "==> 4/4 starting"
systemctl --user daemon-reload
systemctl --user enable --now xvfb-wx.service
systemctl --user enable --now wechat-headless.service
sleep 5
echo
echo "done. For a first login run: $ROOT/scripts/wxlogin.sh"
echo "afterwards:                 $ROOT/scripts/wxsend.py --text 'hello'"
