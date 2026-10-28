import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

export const name = 'im-wechat';
export const inject = ['agents'];
export const DEFAULTS = {
  repo: fileURLToPath(new URL('../', import.meta.url)),
  python: 'python3', display: ':99', me: [], sessionId: 'wechat',
  cwd: process.cwd(), preset: 'standard', provider: 'deepseek-account',
  model: 'deepseek-flash', sendReplies: true,
};

export function sessionIdFor(cfg, event) {
  const key = JSON.stringify([event.kind === 'dm' ? 'dm' : 'group', event.chat]);
  return `${cfg.sessionId}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

export function validEvent(event) {
  return event?.wake === true && ['dm', 'group_mention'].includes(event.kind)
    && typeof event.chat === 'string' && !!event.chat.trim()
    && typeof event.text === 'string' && !!event.text.trim();
}

export async function apply(ctx, config) {
  const log = ctx.logger ?? console;
  try { return await start(ctx, { ...DEFAULTS, ...config }, log); }
  catch (error) { log.error?.(`[im-wechat] startup failed: ${error.message}`); }
}

// Process adapters let regression tests exercise the real event pipeline.
export async function start(ctx, cfg, log, io = { spawn, execFile }) {
  cfg = { ...cfg, repo: resolve(cfg.repo) };
  if (!Array.isArray(cfg.me) || cfg.me.some(n => typeof n !== 'string')) {
    throw new TypeError('me must be an array of nicknames');
  }
  if (!existsSync(join(cfg.repo, 'scripts/wxwatch.py'))) {
    throw new Error(`${cfg.repo}/scripts/wxwatch.py not found`);
  }
  let createUserMessage = payload => payload;
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    if (typeof mod.createUserMessage === 'function') createUserMessage = mod.createUserMessage;
  } catch { log.debug?.('[im-wechat] using plain user message payload'); }

  let disposed = false;
  const sessions = new Map();
  const pending = new Map();
  const queue = [];
  const outgoing = new Set();
  let draining = false;
  let sends = Promise.resolve();

  async function ensureAgent(sid) {
    if (sessions.has(sid)) return sessions.get(sid);
    let agent;
    try { agent = ctx.agents.get(sid); } catch { /* Not live. */ }
    if (!agent) {
      try {
        agent = (await ctx.agents.resume({ resumeSessionId: sid,
          agentOptions: { provider: cfg.provider, model: cfg.model } }))?.agent;
      } catch { /* A new conversation has no session to resume. */ }
    }
    if (!agent) {
      const presets = ctx.get?.('agentPresets');
      const preset = presets ? await presets.resolve(cfg.preset) : null;
      agent = (await ctx.agents.create({ sessionId: sid,
        meta: { cwd: cfg.cwd, ...(preset?.id ? { agentPreset: preset.id } : {}) },
        agentOptions: { provider: cfg.provider, model: cfg.model },
        ...(preset?.id ? { setup: agentCtx => presets.mount(agentCtx, preset.id) } : {}),
      }))?.agent;
    }
    if (!agent) throw new Error(`no agent available for ${sid}`);
    sessions.set(sid, agent);
    return agent;
  }

  function send(chat, text) {
    sends = sends.then(() => new Promise(resolveSend => {
      if (disposed) return resolveSend();
      const proc = io.execFile(cfg.python,
        [join(cfg.repo, 'scripts/wxsend.py'), '--to', chat, '--expect-chat', chat, '--text', text],
        { env: { ...process.env, WX_DISPLAY: cfg.display }, timeout: 90_000 },
        err => {
          if (err) log.warn?.(`[im-wechat] send failed: ${err.message}`);
          resolveSend();
        });
      outgoing.add(proc);
      proc?.once?.('close', () => outgoing.delete(proc));
    })).catch(error => log.warn?.(`[im-wechat] send failed: ${error.message}`));
  }
  const unsubscribe = ctx.on('session/event', (session, raw) => {
    const sid = String(session?.id ?? session?.sessionId ?? session);
    const request = pending.get(sid);
    if (!request || disposed) return;
    if (raw?.type === 'assistant/message') {
      const blocks = raw?.data?.message?.content;
      if (Array.isArray(blocks)) request.text += blocks
        .filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
    } else if (raw?.type === 'turn/end') {
      pending.delete(sid);
      if (cfg.sendReplies && request.text.trim()) send(request.chat, request.text.trim());
      void drain();
    }
  }, { global: true });

  async function drain() {
    if (draining || disposed) return;
    draining = true;
    try {
      while (!disposed) {
        const index = queue.findIndex(ev => !pending.has(sessionIdFor(cfg, ev)));
        if (index < 0) break;
        const ev = queue.splice(index, 1)[0];
        const sid = sessionIdFor(cfg, ev);
        const request = { chat: ev.chat, text: '' };
        try {
          const agent = await ensureAgent(sid);
          if (disposed) break;
          pending.set(sid, request);
          const kind = ev.kind === 'dm' ? 'direct message' : 'group message';
          await agent.followup(createUserMessage({
            content: [{ type: 'text', text: `[WeChat ${kind} | ${ev.chat}] ${ev.text}\n\nReply with the answer only; the plugin sends it to the source chat.` }],
            source: { kind: 'user' },
          }));
        } catch (error) {
          if (pending.get(sid) === request) pending.delete(sid);
          sessions.delete(sid);
          log.warn?.(`[im-wechat] followup failed: ${error.message}`);
        }
      }
    } finally { draining = false; }
  }

  const child = io.spawn(cfg.python,
    [join(cfg.repo, 'scripts/wxwatch.py'), ...cfg.me.filter(n => n.trim()).flatMap(n => ['--me', n])],
    { env: { ...process.env, WX_DISPLAY: cfg.display }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => log.warn?.(`[im-wechat] watcher failed: ${error.message}`));
  child.on('exit', code => { if (!disposed) log.warn?.(`[im-wechat] watcher exited: ${code}`); });
  child.stderr.on('data', data => log.debug?.(`[im-wechat] ${String(data).trim()}`));
  const decoder = new StringDecoder('utf8');
  let rest = '';
  let discard = false;
  child.stdout.on('data', chunk => {
    if (disposed) return;
    rest += decoder.write(chunk);
    let end;
    while ((end = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, end);
      rest = rest.slice(end + 1);
      if (discard) { discard = false; continue; }
      if (line.length > 1_048_576) continue;
      try {
        const ev = JSON.parse(line);
        if (validEvent(ev)) {
          if (queue.length < 100) queue.push(ev);
          else log.warn?.('[im-wechat] inbound queue full; event dropped');
        }
      } catch { /* Only complete, valid JSON events enter the queue. */ }
    }
    if (rest.length > 1_048_576) { rest = ''; discard = true; }
    void drain();
  });
  function dispose() {
    if (disposed) return;
    disposed = true;
    queue.length = 0;
    pending.clear();
    sessions.clear();
    child.kill();
    for (const proc of outgoing) proc?.kill?.();
    if (typeof unsubscribe === 'function') unsubscribe();
  }
  ctx.on('dispose', dispose);
  log.info?.(`[im-wechat] watcher started on ${cfg.display}`);
  return { dispose };
}
