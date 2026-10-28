import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { createPanelHost } from './panel.js';

export const name = '@rayhwmc/dsh-wechat-mate';
export const inject = ['agents', 'webServer'];
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
  try { return await createPanelHost(ctx, { ...DEFAULTS, enabled: true, ...config }, log, start); }
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
  let createUserMessage = payload => ({ ...payload, role: 'user', id: randomUUID() });
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    if (typeof mod.createUserMessage === 'function') createUserMessage = mod.createUserMessage;
  } catch { log.debug?.('[im-wechat] using plain user message payload'); }

  let disposed = false;
  const sessions = new Map();
  const pending = new Map();
  const currentTurns = new Map();
  const queue = [];
  const outgoing = new Set();
  const ownedAgents = new Set();
  let draining = false;
  let sends = Promise.resolve();
  const health = { phase: 'starting', lastError: null, received: 0, sent: 0 };
  function failure(error) {
    health.lastError = String(error?.message ?? error);
    log.warn?.(`[im-wechat] ${health.lastError}`);
  }

  async function ensureAgent(sid) {
    if (sessions.has(sid)) return sessions.get(sid);
    let agent;
    try { agent = ctx.agents.get(sid); } catch { /* Not live. */ }
    if (!agent) {
      try {
        const handle = await ctx.agents.resume({ resumeSessionId: sid,
          agentOptions: { provider: cfg.provider, model: cfg.model } });
        agent = handle?.agent;
        if (handle?.dispose) ownedAgents.add(handle);
      } catch { /* A new conversation has no session to resume. */ }
    }
    if (!agent) {
      const presets = ctx.get?.('agentPresets');
      const preset = presets ? await presets.resolve(cfg.preset) : null;
      const handle = await ctx.agents.create({ sessionId: sid,
        meta: { cwd: cfg.cwd, ...(preset?.id ? { agentPreset: preset.id } : {}) },
        agentOptions: { provider: cfg.provider, model: cfg.model },
        ...(preset?.id ? { setup: agentCtx => presets.mount(agentCtx, preset.id) } : {}),
      });
      agent = handle?.agent;
      if (handle?.dispose) ownedAgents.add(handle);
    }
    if (disposed) {
      await Promise.allSettled([...ownedAgents].map(handle => handle.dispose()));
      ownedAgents.clear();
      throw Error('plugin disposed during session creation');
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
          if (err) failure(err);
          else health.sent += 1;
          resolveSend();
        });
      outgoing.add(proc);
      proc?.once?.('close', () => outgoing.delete(proc));
    })).catch(error => log.warn?.(`[im-wechat] send failed: ${error.message}`));
  }
  const unsubscribe = ctx.on('session/event', (session, raw) => {
    const sid = String(session?.id ?? session?.sessionId ?? session);
    if (disposed) return;
    if (raw?.type === 'turn/start' && sessions.has(sid)) {
      currentTurns.set(sid, raw.data?.turn);
      const request = pending.get(sid);
      if (request && request.turn === null) request.candidateTurn = raw.data?.turn;
      return;
    }
    const request = pending.get(sid);
    if (!request) return;
    if (raw?.type === 'user/message') {
      const messageId = raw.data?.id ?? raw.data?.message?.id;
      if (messageId === request.id && Number.isInteger(currentTurns.get(sid))) request.turn = currentTurns.get(sid);
      return;
    }
    if (raw?.type === 'turn/end' && request.turn === null && request.candidateTurn === raw.data?.turn) {
      pending.delete(sid);
      currentTurns.delete(sid);
      failure(`request was not admitted before turn ended (${raw.data?.reason?.kind ?? 'unknown'})`);
      void drain();
      return;
    }
    if (request.turn === null || raw?.data?.turn !== request.turn) return;
    if (raw.type === 'assistant/message') {
      if (raw.data.interrupted) request.interrupted = true;
      const blocks = raw?.data?.message?.content;
      if (Array.isArray(blocks)) request.text += blocks
        .filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
    } else if (raw?.type === 'turn/end') {
      pending.delete(sid);
      currentTurns.delete(sid);
      const reason = raw.data.reason?.kind;
      if (reason === 'completed' && !request.interrupted) {
        if (cfg.sendReplies && request.text.trim()) send(request.chat, request.text.trim());
      } else failure(`reply suppressed: turn ${reason ?? 'unknown'}${request.interrupted ? ' (interrupted)' : ''}`);
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
        const request = { chat: ev.chat, text: '', turn: null, candidateTurn: null, interrupted: false };
        try {
          const agent = await ensureAgent(sid);
          if (disposed) break;
          pending.set(sid, request);
          const kind = ev.kind === 'dm' ? 'direct message' : 'group message';
          const message = createUserMessage({
            content: [{ type: 'text', text: `[WeChat ${kind} | ${ev.chat}] ${ev.text}\n\nReply with the answer only; the plugin sends it to the source chat.` }],
            source: { kind: 'user' },
          });
          request.id = message.id;
          await agent.followup(message);
          health.received += 1;
        } catch (error) {
          if (pending.get(sid) === request) pending.delete(sid);
          sessions.delete(sid);
          failure(error);
        }
      }
    } finally { draining = false; }
  }

  const child = io.spawn(cfg.python,
    [join(cfg.repo, 'scripts/wxwatch.py'), ...cfg.me.filter(n => n.trim()).flatMap(n => ['--me', n])],
    { env: { ...process.env, WX_DISPLAY: cfg.display }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { health.phase = 'error'; failure(error); });
  child.on('exit', code => {
    health.phase = disposed ? 'stopped' : 'exited';
    if (!disposed) failure(`watcher exited: ${code}`);
  });
  let stderrTail = '';
  child.stderr.on('data', data => {
    stderrTail = (stderrTail + String(data)).slice(-4096);
    if (stderrTail.includes('[wxwatch] watching')) health.phase = 'running';
    log.debug?.(`[im-wechat] ${String(data).trim()}`);
  });
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
  let stopPromise;
  function dispose() {
    if (disposed) return;
    disposed = true;
    queue.length = 0;
    pending.clear();
    currentTurns.clear();
    sessions.clear();
    const processStopped = new Promise(resolveStop => {
      if (child.exitCode !== null && child.exitCode !== undefined) return resolveStop();
      child.once('close', resolveStop);
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolveStop(); }, 3000);
      timer.unref?.();
      child.once('close', () => clearTimeout(timer));
      child.kill();
    });
    for (const proc of outgoing) proc?.kill?.();
    stopPromise = Promise.allSettled([processStopped, ...[...ownedAgents].map(handle => handle.dispose())]);
    ownedAgents.clear();
    if (typeof unsubscribe === 'function') unsubscribe();
    if (typeof unsubscribeDispose === 'function') unsubscribeDispose();
    health.phase = 'stopped';
    return stopPromise;
  }
  const unsubscribeDispose = ctx.on('dispose', dispose);
  log.info?.(`[im-wechat] watcher started on ${cfg.display}`);
  return { dispose, status: () => ({ ...health, queued: queue.length, active: pending.size }) };
}
