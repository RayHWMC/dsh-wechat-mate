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
| Receiving messages |  |  |

## License

MIT
