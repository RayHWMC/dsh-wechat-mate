# dsh-wechat-mate

# **当前仍处于测试阶段**

给 **DSH** 用的微信「本机桥」：不登录协议、不注入进程、不读取凭据，直接驱动本机已登录的官方微信客户端收发消息。

微信客户端跑在虚拟显示器（Xvfb）上，**你的桌面/远程会话完全不用开**，SSH 里也能发。

```
wxsend.py ──► wxctl (C: XTEST 键鼠 + 自建 X11 剪贴板) ──► 微信 Linux 客户端 ──► 微信服务器
                    ▲                                            │
                    └──────────── Xvfb :99 ◄─────────────────────┘
                                    ▲
                               systemd --user
```

## 当前状态

| 能力 | 状态 | 说明 |
|---|---|---|
| 发文本（任意会话） | ✅ 可用 | `wxsend.py --text "..."`，中文走剪贴板粘贴 |
| 发到指定会话 | ⚠️ 尽力而为 | 顶栏搜索框是「搜一搜」（网页搜索），回车可能弹内嵌浏览器 |
| 收消息 | ⚠️ 只能看 | 客户端能收，但程序不会自动读；靠截图+人眼/OCR |
| 无头运行 | ✅ | Xvfb + systemd，开机自启，崩了重启 |
| 账号风险 | 低 | 不碰登录态，就是「替人点鼠标」；但自动化本身仍可能触发风控 |

**已知代价**：客户端冷启动后要**手机确认一次**（服务重启、重启机器都算）。之后长期挂着没问题。

## 安装

依赖：Linux + X11 + gcc + `libX11`/`libXtst` 开发头、已安装的微信 Linux 客户端（`/usr/bin/wechat`）。
**不需要 root**。

```bash
./scripts/install.sh
```

它做四件事：编译 `wxctl` → `apt-get download xvfb` 解包到 `~/.local/opt/wxbot`（免 root）→ 渲染并安装
两个 systemd --user 单元 → 启动。首次登录：

```bash
./scripts/wxlogin.sh     # 点 Log In；要手机确认时会提示
```

## 用法

```bash
./scripts/wxsend.py --text "晚上回家吃饭吗"        # 发给当前打开的会话
./scripts/wxsend.py --to "某人" --text "在吗"      # 先搜索再发（不稳，见下）
./scripts/wxsend.py --text "测试" --dry-run       # 只填输入框，不发送
./scripts/wxsend.py --text "测试" --shot out.png  # 结束时截图

./wxctl shot root /tmp/s.ppm                      # 截整个虚拟屏
./wxctl find Weixin                               # 找窗口
```

环境变量：`WX_DISPLAY`（默认 `:99`）、`WXCTL`（wxctl 路径）。

## 踩过的坑

1. **截图必须截 root，不能截窗口本身**。微信的面板（联系人列表、搜索下拉）是子窗口，对父窗口
   `XGetImage` 会得到一块黑。
2. **窗口标题会变**：主窗口有时叫 `Weixin`、有时只有 `WM_CLASS=wechat`。`wxctl find` 同时按标题和
   class 匹配；`wxsend.py` 只认名字含 `Weixin` 且尺寸 > 600×600 的窗口（避开 922×892 的「搜一搜」
   面板和 280×380 登录框）。
3. **顶栏搜索框是「搜一搜」**，不是会话搜索。回车会打开内嵌浏览器面板。指定会话更可靠的做法是点会话
   列表里那一行。
4. **中文必须走剪贴板**：`wxctl clip` 会 fork 一个常驻进程持有 `CLIPBOARD`（默认 60–90 秒），
   键盘直接打字过不了输入法。
5. **Xvfb 没有窗口管理器**：没有标题栏、没有焦点转移，焦点靠 `XSetInputFocus` 硬设。
6. 目标机上常常没有 `xclip`/`xdotool`/`sudo`，所以这些轮子是自己写的；`Xvfb` 用 `dpkg -x` 解包。

## 为什么不走别的路

| 路线 | 结论 |
|---|---|
| 协议库（模拟客户端登录） | 开源个人号协议 2017 年后基本死光，现存 pad/ipad 全是付费闭源 + 封号风险 |
| 注入原生 Linux 客户端 | 客户端 174MB、stripped、静态链接自有 UI 框架，无导出符号，逆向周期以周计 |
| 官方 ClawBot / iLink（腾讯 2026-03，MIT） | 只能回复「先给 bot 发过消息的人」，不能主动发给任意联系人 |
| Wine 跑 Windows 微信 + WeChatFerry | ARM64 上能用 Hangover 11.16 + FEX 跑起来（3.9.12.51 能显示二维码），但转译开销大、内存吃紧 |
| 官方公众号/企业微信 | 普通号发不了，且只能被动回 |

## Roadmap

- [ ] `wxread.py`：截图 + OCR（tesseract chi_sim）识别当前会话新消息，轮询触发
- [ ] `wxwatch.py`：像素变化检测 → 新消息回调
- [ ] DSH 插件：把收发包装成 `wechat_send` / `wechat_read` 工具，接 LLM 做自动回复
- [ ] 会话定位改成点会话列表（`--chat-index`），摆脱不靠谱的搜索框

## License

MIT
