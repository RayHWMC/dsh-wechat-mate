/**
 * im-wechat — DSH 插件：把「无头微信本机桥」接成 DSH 的一个通道。
 *
 * 入站：起一个子进程跑 scripts/wxwatch.py，它只在「私聊」或「群里 @我」时输出事件；
 *       事件文本用 agent.followup() 塞进本插件专属会话，唤醒 DSH。
 * 出站：监听该会话的 session/event，回合结束时把 assistant 的正文用 scripts/wxsend.py 发回微信。
 *
 * 依赖宿主服务：agents（创建/唤醒会话）。
 * 所有失败都吞掉并打日志 —— 绝不能因为本插件把整棵插件树弄挂。
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

function logger(ctx) {
  return ctx.logger ?? console;
}

/** 把一段文本发到微信当前会话 */
function sendToWeChat(cfg, text, log) {
  return new Promise((resolve) => {
    const args = [join(cfg.repo, 'scripts/wxsend.py'), '--text', text];
    execFile(cfg.python, args, {
      env: { ...process.env, WX_DISPLAY: cfg.display },
      timeout: 60_000,
    }, (err, stdout, stderr) => {
      if (err) log.warn?.(`[im-wechat] 发送失败: ${err.message} ${stderr ?? ''}`);
      else log.info?.(`[im-wechat] 已发送 ${text.slice(0, 40)}…`);
      resolve(!err);
    });
  });
}

export async function apply(ctx, config) {
  const log = logger(ctx);
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

  const agents = ctx.agents;
  if (!agents) {
    log.warn?.('[im-wechat] 宿主没有 agents 服务，跳过');
    return;
  }

  // ── 1. 拿一个专属会话（没有就建） ──
  let agent = null;
  try {
    agent = agents.get(cfg.sessionId);
  } catch { /* 没有就算了 */ }
  if (!agent) {
    const created = await agents.create({
      sessionId: cfg.sessionId,
      meta: { cwd: cfg.repo },
    });
    agent = created.agent;
  }
  if (!agent) {
    log.warn?.('[im-wechat] 建会话失败，跳过');
    return;
  }
  await loadUserMessageFactory(log);
  log.info?.(`[im-wechat] 会话就绪: ${cfg.sessionId}`);

  // ── 2. 出站：这个会话的回合结束时，把正文发回微信 ──
  let buf = '';
  let pending = 0;              // 由微信唤醒、还没回复的回合数
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
      if (pending > 0) {
        pending -= 1;
        if (cfg.sendReplies && text) {
          void sendToWeChat(cfg, text, log).then((ok) => {
            if (ok) log.info?.('[im-wechat] 回合回复已投递');
          });
        }
      }
    }
  });

  // ── 3. 入站：wxwatch 只在「私聊 / 群里 @我」时给事件 ──
  const child = spawn(cfg.python, [join(cfg.repo, 'scripts/wxwatch.py'), '--me', cfg.me.join(','), '--verbose'], {
    env: { ...process.env, WX_DISPLAY: cfg.display },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (d) => log.debug?.(`[im-wechat] watch: ${String(d).trim()}`));

  let rest = '';
  child.stdout.on('data', (chunk) => {
    rest += String(chunk);
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!ev?.wake || !ev.text) continue;
      log.info?.(`[im-wechat] 唤醒: ${ev.kind} ${ev.chat}: ${ev.text}`);
      pending += 1;
      try {
        agent.followup(makeUserMessage(ev));
      } catch (e) {
        pending -= 1;
        log.warn?.(`[im-wechat] 唤醒失败: ${e?.message || e}`);
      }
    }
  });

  child.on('exit', (code) => log.warn?.(`[im-wechat] wxwatch 退出 code=${code}`));
  ctx.on('dispose', () => { try { child.kill(); } catch { /* ignore */ } });
}

/** 构造一条「用户消息」。dsh-llm 拿不到就退化成纯对象（宿主大多只认 content/source）。 */
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
  const text = `[微信 ${ev.kind === 'dm' ? '私聊' : '群聊'} | ${ev.chat}] ${ev.text}\n\n` +
    '（这是微信里别人发来的消息，直接回复内容本身，不要解释；回复会由插件发回微信。）';
  const payload = { content: [{ type: 'text', text }], source: { kind: 'user' } };
  return userMessageFactory ? userMessageFactory(payload) : payload;
}
