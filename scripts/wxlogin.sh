#!/usr/bin/env bash
# 冷启动后把微信从登录页点进去（需要手机确认时会提示）
set -uo pipefail
export DISPLAY="${WX_DISPLAY:-:99}"
DIR="$(cd "$(dirname "$0")" && pwd)"
WXCTL="${WXCTL:-$DIR/../wxctl}"

line=$("$WXCTL" find Weixin | head -1)
if [ -z "$line" ]; then echo "没有微信窗口（服务起来了吗？）"; exit 1; fi
win=$(echo "$line" | awk '{print $1}')
size=$(echo "$line" | awk '{print $2}')

if [ "$size" = "280x380" ]; then
    "$WXCTL" click "$win" 140 294   # Log In 按钮
    sleep 5
    echo "已点 Log In；如果卡在 Confirm on Phone，掏手机确认。"
fi

"$WXCTL" shot root /tmp/wxlogin.ppm >/dev/null
if command -v convert >/dev/null && convert /tmp/wxlogin.ppm /tmp/wxlogin.png 2>/dev/null; then
    echo "状态截图: /tmp/wxlogin.png"
else
    echo "状态截图: /tmp/wxlogin.ppm"
fi
