#!/usr/bin/env bash
# Click through the login screen after a cold start (prompts you when the phone
# confirmation is required).
set -uo pipefail
export DISPLAY="${WX_DISPLAY:-:99}"
DIR="$(cd "$(dirname "$0")" && pwd)"
WXCTL="${WXCTL:-$DIR/../wxctl}"

line=$("$WXCTL" find Weixin | head -1)
if [ -z "$line" ]; then echo "no WeChat window found (is the service running?)"; exit 1; fi
win=$(echo "$line" | awk '{print $1}')
size=$(echo "$line" | awk '{print $2}')

if [ "$size" = "280x380" ]; then
    "$WXCTL" click "$win" 140 294   # the "Log In" button
    sleep 5
    echo "clicked Log In; if it is stuck on 'Confirm on Phone', confirm on your phone."
fi

"$WXCTL" shot root /tmp/wxlogin.ppm >/dev/null
if command -v convert >/dev/null && convert /tmp/wxlogin.ppm /tmp/wxlogin.png 2>/dev/null; then
    echo "status screenshot: /tmp/wxlogin.png"
else
    echo "status screenshot: /tmp/wxlogin.ppm"
fi
