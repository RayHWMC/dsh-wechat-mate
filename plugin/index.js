/**
 * im-wechat — DSH 插件：把「无头微信本机桥」接成 DSH 的一个通道。
 *
 * 入站：起子进程跑 scripts/wxwatch.py（只在「私聊」或「群里 @我」时输出事件），
 *       事件文本用 agent.followup() 塞进专属会话，唤醒 DSH。
 * 出站：监听该会话的 session/event，回合结束时把 assistant 正文用 wxsend.py 发回微信。
 *
 * 设计要点：
 *   · 会话是**懒创建**的 —— 插件 apply 时 agent-loop 可能还没注册，
 *     直接 agents.create() 会报 "no agent factory registered"。
 *   · 所有失败都吞掉并打日志，绝不影响宿主启动。
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'im-wechat';
export const inject = ['agents'];

const DEFAULTS = {
  repo: '/home/admin/Dev/dsh-wechat-mate',
  python: '/home/admin/.local/opt/wxbot/venv/bin/python',
  display: ':99',
  me: ['肥鱼'],
  sessionId: 'wechat-mate',
  sendReplies: true,
};

let userMessageFactory = null;

async function loadUserMessageFactory(log) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    if (typeof mod?.createUserMessage === 'function') userMessageFactory = mod.createUserMessage;
  } catch (e) {
    log.warn?.(`[im-wechat] 没加载到 @deepseek-ai/dsh-llm，退化使用纯对象: ${e?.message || e}`);
  }
}

function makeUserMessage(ev) {
  const kind = ev.kind === 'dm' ? '私聊' : '群聊';
  const text = `[微信 ${kind} | ${ev.chat}] ${ev.text}\n\n` +
    '（这是微信里别人发来的消息，直接回复内容本身，不要解释；回复会由插件发回微信。）';
  const payload = { content: [{ type: 'text', text }], source: { kind: 'user' } };
  return userMessageFactory ? userMessageFactory(payload) : payload;
}

function sendToWeChat(cfg, text, log) {
  return new Promise((resolve) => {
    execFile(cfg.python, [join(cfg.repo, 'scripts/wxsend.py'), '--text', text], {
      env: { ...process.env, WX_DISPLAY: cfg.display },
      timeout: 90_000,
    }, (err, _stdout, stderr) => {
      if (err) log.warn?.(`[im-wechat] 发送失败: ${err.message} ${stderr ?? ''}`);
      else log.info?.(`[im-wechat] 已回微信: ${text.slice(0, 30)}…`);
      resolve(!err);
    });
  });
}

export async function apply(ctx, config) {
  const log = ctx.logger ?? console;
  try {
    await start(ctx, { ...DEFAULTS, ...(config ?? {}) }, log);
  } catch (e) {
    log.error?.(`[im-wechat] 启动失败（不影响其他插件）: ${e?.stack || e}`);
  }
}

async function start(ctx, cfg, log) {
  if (!existsSync(join(cfg.repo, 'scripts/wxwatch.py'))) {
    log.warn?.(`[im-wechat] 找不到 ${cfg.repo}/scripts/wxwatch.py，跳过`);
    return;
  }
  await loadUserMessageFactory(log);

  const agents = ctx.agents;
  let agent = null;
  let turnFromWeChat = 0;

  /** 懒取会话：第一次要唤醒的时候才建，避免和 agent-loop 的加载顺序打架 */
  async function ensureAgent() {
    if (agent) return agent;
    try {
      const existing = agents.get(cfg.sessionId);
      if (existing) { agent = existing; return agent; }
    } catch { /* 没有就算了 */ }
    for (let i = 0; i < 3; i += 1) {
      try {
        const created = await agents.create({ sessionId: cfg.sessionId, meta: { cwd: cfg.repo } });
        if (created?.agent) {
          agent = created.agent;
          log.info?.(`[im-wechat] 会话已创建: ${cfg.sessionId}`);
          return agent;
        }
      } catch (e) {
        log.warn?.(`[im-wechat] 建会话失败(${i + 1}/3): ${e?.message || e}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    return null;
  }

  // ── 出站 ──
  let buf = '';
  ctx.on('session/event', (session, raw) => {
    const sid = session?.id ?? session?.sessionId ?? session;
    if (String(sid) !== String(cfg.sessionId)) return;
    const type = raw?.type;
    if (type === 'assistant/message') {
      const blocks = raw?.data?.message?.content;
      if (Array.isArray(blocks)) {
        buf += blocks.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('');
      }
    } else if (type === 'turn/end') {
      const text = buf.trim();
      buf = '';
      if (turnFromWeChat > 0) {
        turnFromWeChat -= 1;
        if (cfg.sendReplies && text) void sendToWeChat(cfg, text, log);
      }
    }
  });

  // ── 入站：先杀掉可能残留的 watcher，避免多份同时点界面 ──
  try { spawn('pkill', ['-f', 'dsh-wechat-mate/scripts/wxwatch.py'], { stdio: 'ignore' }); } catch { /* ignore */ }

  const child = spawn(cfg.python,
    [join(cfg.repo, 'scripts/wxwatch.py'), '--me', cfg.me.join(','), '--verbose'], {
      env: { ...process.env, WX_DISPLAY: cfg.display },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  child.stderr.on('data', (d) => log.debug?.(`[im-wechat] watch: ${String(d).trim()}`));

  let rest = '';
  child.stdout.on('data', async (chunk) => {
    rest += String(chunk);
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!ev?.wake || !ev.text) continue;
      log.info?.(`[im-wechat] 唤醒: ${ev.kind} ${ev.chat}: ${ev.text.slice(0, 40)}`);
      const a = await ensureAgent();
      if (!a) { log.warn?.('[im-wechat] 没有可用会话，跳过这条'); continue; }
      try {
        a.followup(makeUserMessage(ev));
        turnFromWeChat += 1;
      } catch (e) {
        log.warn?.(`[im-wechat] 唤醒失败: ${e?.message || e}`);
      }
    }
  });

  child.on('exit', (code) => log.warn?.(`[im-wechat] wxwatch 退出 code=${code}`));
  ctx.on('dispose', () => { try { child.kill(); } catch { /* ignore */ } });
  log.info?.(`[im-wechat] 就绪：监听 ${cfg.display}，会话 ${cfg.sessionId}`);
}
