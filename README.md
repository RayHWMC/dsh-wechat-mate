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

Dependencies: Linux + X11 with XTEST + Rust 1.75 or later (Cargo and a system linker);
WeChat Linux client installed. The native helper uses `x11rb` and needs no Xlib
development headers. The installer uses `apt-get download` and `dpkg` to unpack Xvfb.
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

## DSH desktop plugin

The plugin connects the bridge as a DSH channel. Install the repository root package
with your profile's plugin manager (or add the local root package to that profile).
The root `package.json` supplies the host entry, client entry and `dsh.bundle` patch.
Do not install the `plugin/` subdirectory as a separate package.

Open **Settings → WeChat Mate** to configure the bridge directory, Python interpreter,
X11 display, nicknames, workspace and model. **Save settings** persists the values and
restarts the owned watcher. The bundled patch starts disabled until you enable it.
The status card shows whether the watcher is starting, receiving, stopped or failed,
plus accepted/sent/queued counts and the last error. A Linux host is required for the
bridge; on Windows/macOS the panel remains available and reports that requirement.

Settings live under `$DSH_HOME/storages/dsh-wechat-mate/` (default `~/.dsh`), in a file
derived from the initial repository path and session prefix. Saved values override
the loader config on restart. Use a distinct initial session prefix for each plugin
instance. This local settings endpoint uses DSH's web server; keep that server bound
to loopback or protected by your own authenticated proxy.

```text
wxwatch.py ──event──► ensureAgent() ──followup──► DSH agent ──turn/end──► wxsend.py ──► WeChat
```

Register it in the profile (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- insert:
    - id: '@rayhwmc/dsh-wechat-mate'
      name: '@rayhwmc/dsh-wechat-mate'
      config:
        repo: '/path/to/dsh-wechat-mate'
        python: '/path/to/venv/bin/python'   # interpreter with rapidocr-onnxruntime
        display: ':99'
        me: ['your-nickname']                # used to detect group @mentions
        sessionId: 'wechat'                  # session that gets woken
        cwd: '/path/to/workspace'
        preset: 'standard'
        provider: 'deepseek-account'         # agent.options.model must be set,
        model: 'deepseek-flash'              # otherwise {{model}} is empty and turns fail
```

Notes:

* The session is created lazily, because `agents.create()` races the agent-loop plugin at startup.
* `resume` is tried before `create` (a session may exist on disk but not in memory).
* Each conversation has a separate session derived from `sessionId`; messages in one
  chat wait for its current turn to finish. The queue holds at most 100 events.
* Replies use `--to` and `--expect-chat`. OCR must confirm the exact chat title before
  pasting and before pressing Enter. An uncertain destination fails without sending.
* All cooperating watchers/senders share a per-display Linux file lock. One watcher
  owns each display; the plugin only terminates processes it started.
* Watcher startup errors and rejected followups are logged. A failed watcher requires
  restarting the plugin; it is not silently reported as receiving messages.
* A startup OCR snapshot establishes a baseline. Visible history is not replayed
  every 30 seconds. For a previously unseen chat only the last visible row is eligible;
  OCR changes/scrolling without an overlapping snapshot are ignored conservatively.

## Development checks

```bash
node --test tests/*.test.js
python3 -m unittest discover -s tests -p 'test_*.py'
bash -n scripts/install.sh scripts/wxlogin.sh
cargo test --locked
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
# Native integration test in a disposable display (requires Xvfb and xauth):
xvfb-run -a -s '-screen 0 800x600x24 -nolisten tcp' cargo test --locked --test x11 -- --ignored --test-threads=1
```

These tests use simulated process and OCR results. Sending still depends on the
Linux WeChat UI layout, exact OCR titles, and an already logged-in client. Chat titles
are not unique account identifiers: avoid duplicate contact/group display names.

## Rust native helper

`wxctl` is implemented in safe Rust (`#![forbid(unsafe_code)]`) using the X11/XTEST
protocol through `x11rb`. `cargo build --release --locked` builds it; the installer
copies the result to the existing `./wxctl` path, so Python callers and the `WXCTL`
override keep working. `Cargo.lock` fixes the dependency versions.

The CLI preserves `find`, `activate`, `key`, `type`, `clip`, `click`, `geom`, and
`shot`. `type` accepts ASCII; Unicode uses `clip` plus `key ctrl+v`. Clipboard ownership
lasts 1–3600 seconds and is ready before `clip` returns; a newer owner ends the old
process. Screenshots are binary PPM on TrueColor displays (including 16/24/32-bit pixel
storage), with X11 byte order, color masks and row padding respected. Invalid inputs,
unavailable keys/windows, and output errors exit nonzero.

The Xvfb test creates a mock window and verifies discovery, geometry, keyboard and
mouse events, released modifiers, screenshot RGB bytes, and Unicode clipboard transfer.
It does not use an actual WeChat account. Python remains for RapidOCR and UI policy;
JavaScript remains for DSH's host and browser plugin contracts.

## License

MIT
