/**
 * im-wechat — a DSH plugin that turns the headless WeChat bridge into a DSH channel.
 *
 * Inbound:  spawns scripts/wxwatch.py, which only emits events for direct messages
 *           and for group messages that @mention us; each event is pushed into a
 *           dedicated session through agent.followup(), which wakes the agent.
 * Outbound: listens to session/event on that session and, at turn/end, sends the
 *           assistant text back to WeChat via scripts/wxsend.py.
 *
 * Notes:
 *   - The session is created lazily: when apply() runs, the agent-loop plugin may not
 *     be registered yet, and agents.create() throws "no agent factory registered".
 *   - A session needs an agent preset and a model route, otherwise the prompt variable
 *     {{model}} has no value and every turn fails with "this turn failed".
 *   - Everything is wrapped in try/catch: this plugin must never break the host.
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
  me: [],   // your own WeChat nickname(s); set it so group @mentions are detected
  sessionId: 'wechat',
  cwd: '/home/admin/dsh',
  preset: 'standard',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  sendReplies: true,
};

let userMessageFactory = null;

async function loadUserMessageFactory(log) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    if (typeof mod?.createUserMessage === 'function') userMessageFactory = mod.createUserMessage;
  } catch (e) {
    log.warn?.(`[im-wechat] could not load @deepseek-ai/dsh-llm, falling back to a plain object: ${e?.message || e}`);
  }
}

function makeUserMessage(ev) {
  const kind = ev.kind === 'dm' ? 'direct message' : 'group message';
  const text = `[WeChat ${kind} | ${ev.chat}] ${ev.text}\n\n` +
    '(This came from WeChat. Reply with the answer only; the plugin sends it back to WeChat.)';
  const payload = { content: [{ type: 'text', text }], source: { kind: 'user' } };
  return userMessageFactory ? userMessageFactory(payload) : payload;
}

function sendToWeChat(cfg, text, log) {
  return new Promise((resolve) => {
    execFile(cfg.python, [join(cfg.repo, 'scripts/wxsend.py'), '--text', text], {
      env: { ...process.env, WX_DISPLAY: cfg.display },
      timeout: 90_000,
    }, (err, _stdout, stderr) => {
      if (err) log.warn?.(`[im-wechat] send failed: ${err.message} ${stderr ?? ''}`);
      else log.info?.(`[im-wechat] sent to WeChat: ${text.slice(0, 30)}…`);
      resolve(!err);
    });
  });
}

export async function apply(ctx, config) {
  const log = ctx.logger ?? console;
  try {
    await start(ctx, { ...DEFAULTS, ...(config ?? {}) }, log);
  } catch (e) {
    log.error?.(`[im-wechat] startup failed (other plugins unaffected): ${e?.stack || e}`);
  }
}

async function start(ctx, cfg, log) {
  if (!existsSync(join(cfg.repo, 'scripts/wxwatch.py'))) {
    log.warn?.(`[im-wechat] ${cfg.repo}/scripts/wxwatch.py not found, skipping`);
    return;
  }
  await loadUserMessageFactory(log);

  const agents = ctx.agents;
  let agent = null;
  let turnFromWeChat = 0;

  /** Resolve the session on demand: creating it at apply() time races the agent-loop plugin. */
  async function ensureAgent() {
    if (agent) return agent;
    try {
      const existing = agents.get(cfg.sessionId);
      if (existing) { agent = existing; return agent; }
    } catch { /* not live, fall through */ }

    // The session may exist on disk only (it is not in memory after a restart):
    // try resume before create.
    try {
      const h = await agents.resume({
        resumeSessionId: cfg.sessionId,
        agentOptions: { provider: cfg.provider, model: cfg.model },
      }).catch(() => undefined);
      if (h?.agent) {
        agent = h.agent;
        log.info?.(`[im-wechat] session resumed: ${cfg.sessionId}`);
        return agent;
      }
    } catch (e) {
      log.warn?.(`[im-wechat] resume failed: ${e?.message || e}`);
    }

    // A new session must carry a preset, otherwise persona variables such as
    // {{model}} stay empty and every turn fails.
    let meta = { cwd: cfg.cwd };
    let setup;
    try {
      const presets = ctx.get?.('agentPresets');
      if (presets) {
        const resolved = await presets.resolve(cfg.preset);
        if (resolved?.id) {
          meta = { ...meta, agentPreset: resolved.id };
          setup = async (agentCtx) => { await presets.mount(agentCtx, resolved.id); };
        }
      } else {
        log.warn?.('[im-wechat] host has no agentPresets service; the session may lack a persona/model');
      }
    } catch (e) {
      log.warn?.(`[im-wechat] resolving preset ${cfg.preset} failed: ${e?.message || e}`);
    }

    for (let i = 0; i < 2; i += 1) {
      try {
        const created = await agents.create({
          sessionId: cfg.sessionId,
          meta,
          agentOptions: { provider: cfg.provider, model: cfg.model },
          ...(setup ? { setup } : {}),
        });
        if (created?.agent) {
          agent = created.agent;
          log.info?.(`[im-wechat] session created: ${cfg.sessionId}`);
          return agent;
        }
      } catch (e) {
        log.warn?.(`[im-wechat] create failed (${i + 1}/2): ${e?.message || e}`);
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    return null;
  }

  // ── Outbound: when a turn of our session ends, send the assistant text back ──
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

  // ── Inbound: kill any stale watcher first so only one process clicks the UI ──
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
      log.info?.(`[im-wechat] wake: ${ev.kind} ${ev.chat}: ${ev.text.slice(0, 40)}`);
      const a = await ensureAgent();
      if (!a) { log.warn?.('[im-wechat] no session available, dropping this event'); continue; }
      try {
        a.followup(makeUserMessage(ev));
        turnFromWeChat += 1;
      } catch (e) {
        log.warn?.(`[im-wechat] followup failed: ${e?.message || e}`);
      }
    }
  });

  child.on('exit', (code) => log.warn?.(`[im-wechat] wxwatch exited code=${code}`));
  ctx.on('dispose', () => { try { child.kill(); } catch { /* ignore */ } });
  log.info?.(`[im-wechat] ready: watching ${cfg.display}, session ${cfg.sessionId}`);
}
