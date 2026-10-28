# dsh-wechat-mate

# **⚠️⚠️Still in Test Phase⚠️⚠️**

A WeChat native bridge skill for DSH: It does not require logging in via a separate protocol, does not inject code into processes, and does not access stored credentials; instead, it directly interfaces with an already-logged-in official WeChat desktop client to send and receive messages.
The WeChat client runs on a virtual display (Xvfb), so you don’t need to have a desktop or remote session open at all—you can even send messages via SSH.

```
wxsend.py ──► wxctl ──► WeChat Linux Client ──► WeChat Server
               ▲                       │
               └───── Xvfb :99 ◄───────┘
                          ▲
                   systemd --user
```

## Declaration

Using this project carries the risk of your WeChat account being banned; you must bear any consequences yourself.

## Installation

Dependencies: Linux + X11 + gcc + `libX11`/`libXtst` development headers; WeChat Linux client installed.
For receiving: Python 3 + `rapidocr-onnxruntime` (see below).

```bash
./scripts/install.sh
```

```bash
./scripts/wxlogin.sh
```

## Usages

| Ability | Usage | Notes |
|---|---|---|
| Sending text | `wxsend.py --text "..."` | Send to the currently open conversation |
| Sending to a specific chat | `./scripts/wxsend.py --to "Someone" --text "..."` | Search, then send |
|   | `./scripts/wxsend.py --text "Test" --dry-run` | Fill the input box without sending |
|   | `./scripts/wxsend.py --text "Test" --shot out.png` | Take a screenshot upon completion |
|   | `./wxctl shot root /tmp/s.ppm` | Capture the entire virtual screen |
|   | `./wxctl find Weixin` | Locate a window |
| Receiving messages | `python3 scripts/wxread.py --json` | Screenshot + OCR of the **currently open** chat; splits in/out and DM/group |
| Wake-on-message | `python3 scripts/wxwatch.py --me <your-nickname> --exec ./on-wake.sh` | DM or group @me → wake; other group chatter → ignore |

## Receiving: how it works

```
wxwatch.py ──(pixel hash of the chat list, ~1.5s)──► changed ──► open newest chat
                                                        │
                                              wxread.py: screenshot + OCR
                                                        │
                                DM? / @me in a group? ──► wake (--exec)
```

```bash
# OCR deps (pure pip, no root)
python3 -m venv ~/.local/opt/wxbot/venv
~/.local/opt/wxbot/venv/bin/pip install rapidocr-onnxruntime

# inspect the currently open chat
~/.local/opt/wxbot/venv/bin/python scripts/wxread.py --json

# watch: wake only on DM / group @me
~/.local/opt/wxbot/venv/bin/python scripts/wxwatch.py --me <your-nickname> --exec ./on-wake.sh
```

Event format (JSON Lines):

```json
{"ts": 1793150000.1, "kind": "dm", "chat": "Alice", "text": "you there?", "wake": true}
{"ts": 1793150001.2, "kind": "group_mention", "chat": "Family", "text": "@me dinner?", "wake": true}
{"ts": 1793150002.3, "kind": "group_other", "chat": "Family", "text": "chit chat", "wake": false}
```

OCR costs ~6–7 s per read on a 4-core ARM board, so it only runs when the chat list actually changes;
the steady state is a cheap pixel hash.

> **Why not desktop notifications?** Tested: WeChat 4.1 for Linux never emits
> `org.freedesktop.Notifications.Notify` on incoming messages (the strings are in the binary, but the call
> is not made), so listening on D-Bus does not work. OCR is the fallback that actually works.

## License

MIT
