import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, start, sessionIdFor } from '../plugin/index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const event = (chat, text = '你好') => ({ kind: 'dm', chat, text, wake: true });

async function fixture(followup, admit = true) {
  const ctx = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  const calls = [], sends = [], warnings = [];
  ctx.get = service => service === 'agentPresets' ? {
    resolve: async () => ({ id: 'standard' }), mount: () => () => {},
  } : undefined;
  const turns = new Map();
  function admitMessage(sid, message) {
    const turn = (turns.get(sid) ?? 0) + 1;
    turns.set(sid, turn);
    ctx.emit('session/event', { id: sid }, { type: 'turn/start', data: { turn } });
    ctx.emit('session/event', { id: sid }, { type: 'user/message', data: message });
  }
  ctx.agents = {
    get: () => null, resume: async () => { throw Error('not saved'); },
    create: async ({ sessionId, setup }) => {
      // A mount disposer is not a valid setup commit object on the actual host.
      assert.equal(await setup?.({}), undefined);
      calls.push(['create', sessionId]);
      return { agent: { followup: async message => {
        calls.push(['followup', sessionId, message]);
        if (followup) await followup(sessionId);
        if (admit) admitMessage(sessionId, message);
      } } };
    },
  };
  const cfg = { ...DEFAULTS, me: ['Alice', '小王'] };
  const io = {
    spawn: (cmd, args) => {
      assert.notEqual(cmd, 'pkill', 'startup must never kill processes by name');
      child.args = args; return child;
    },
    execFile: (_cmd, args, _opts, callback) => {
      sends.push(args); queueMicrotask(() => callback(null));
      return new EventEmitter();
    },
  };
  const runtime = await start(ctx, cfg, { warn: m => warnings.push(m) }, io);
  const emit = value => child.stdout.write(Buffer.from(JSON.stringify(value) + '\n'));
  const end = (chat, text, reason = 'completed', interrupted = false) => {
    const sid = sessionIdFor(cfg, event(chat));
    const turn = turns.get(sid);
    ctx.emit('session/event', { id: sid }, { type: 'assistant/message', data: { turn, interrupted, message: { content: [{ type: 'text', text }] } } });
    ctx.emit('session/event', { id: sid }, { type: 'turn/end', data: { turn, reason: { kind: reason } } });
  };
  return { ctx, cfg, child, calls, sends, warnings, runtime, emit, end, admitMessage };
}

test('isolates chats, serializes each conversation, and targets verified destinations', async () => {
  const f = await fixture();
  f.emit(event('Alice')); f.emit(event('Alice', 'second')); f.emit(event('Bob'));
  await tick();
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 2);
  assert.equal(f.calls.filter(c => c[0] === 'followup').length, 2);
  f.end('Bob', 'reply B'); f.end('Alice', 'reply A');
  await tick(); await tick();
  assert.deepEqual(f.sends.map(args => args.slice(1)), [
    ['--to', 'Bob', '--expect-chat', 'Bob', '--text', 'reply B'],
    ['--to', 'Alice', '--expect-chat', 'Alice', '--text', 'reply A'],
  ]);
  assert.equal(f.calls.filter(c => c[0] === 'followup').length, 3);
  assert.deepEqual(f.child.args.slice(1), ['--parent-pid', String(process.pid), '--me', 'Alice', '--me', '小王']);
  f.runtime.dispose();
});

test('preserves split UTF-8 and ignores malformed and non-waking events', async () => {
  const f = await fixture();
  const bytes = Buffer.from(JSON.stringify(event('中文')) + '\n');
  const index = bytes.indexOf(Buffer.from('中')) + 1;
  f.child.stdout.write(bytes.subarray(0, index));
  f.child.stdout.write(bytes.subarray(index));
  f.child.stdout.write('not json\n');
  f.emit({ ...event('ignored'), wake: false });
  f.emit({ ...event('ignored'), chat: 5 });
  await tick();
  assert.equal(f.calls.filter(c => c[0] === 'followup').length, 1);
  assert.match(f.calls[1][2].content[0].text, /中文/);
  f.runtime.dispose();
});

test('handles asynchronous followup rejection and process errors; disposal stops intake', async () => {
  const f = await fixture(async () => { throw Error('followup rejected'); });
  f.emit(event('Alice')); await tick();
  f.child.emit('error', Error('ENOENT'));
  assert.ok(f.warnings.some(m => m.includes('followup rejected')));
  assert.ok(f.warnings.some(m => m.includes('ENOENT')));
  f.runtime.dispose(); f.emit(event('Bob')); await tick();
  assert.equal(f.child.killed, true);
  assert.equal(f.calls.filter(c => c[0] === 'followup').length, 1);
});

test('waits for the exact message admission and ignores a previous desktop turn', async () => {
  const f = await fixture(null, false);
  f.emit(event('Alice')); await tick();
  const [, sid, message] = f.calls.find(c => c[0] === 'followup');
  f.ctx.emit('session/event', { id: sid }, { type: 'assistant/message', data: {
    turn: 99, message: { content: [{ type: 'text', text: 'unrelated desktop output' }] },
  } });
  f.ctx.emit('session/event', { id: sid }, { type: 'turn/end', data: { turn: 99, reason: { kind: 'completed' } } });
  await tick(); assert.equal(f.sends.length, 0);
  f.admitMessage(sid, message); f.end('Alice', 'correct reply'); await tick();
  assert.equal(f.sends[0].at(-1), 'correct reply');
  f.runtime.dispose();
});

test('suppresses aborted, failed, blocked and interrupted output, and unblocks the queue', async () => {
  for (const [reason, interrupted] of [['error', false], ['aborted', false], ['blocked', false], ['completed', true]]) {
    const f = await fixture();
    f.emit(event('Alice')); f.emit(event('Alice', 'next')); await tick();
    f.end('Alice', 'partial text', reason, interrupted); await tick();
    assert.equal(f.sends.length, 0);
    assert.ok(f.warnings.some(m => m.includes('reply suppressed')));
    assert.equal(f.calls.filter(c => c[0] === 'followup').length, 2);
    f.end('Alice', 'next reply'); await tick();
    assert.equal(f.sends[0].at(-1), 'next reply');
    f.runtime.dispose();
  }
});

test('a turn blocked before user-message admission releases the next request', async () => {
  const f = await fixture(null, false);
  f.emit(event('Alice')); f.emit(event('Alice', 'next')); await tick();
  const [, sid] = f.calls.find(c => c[0] === 'followup');
  f.ctx.emit('session/event', { id: sid }, { type: 'turn/start', data: { turn: 1 } });
  f.ctx.emit('session/event', { id: sid }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } });
  await tick();
  assert.equal(f.calls.filter(c => c[0] === 'followup').length, 2);
  assert.ok(f.warnings.some(m => m.includes('not admitted')));
  assert.equal(f.sends.length, 0);
  f.runtime.dispose();
});

test('a verified image reaches the existing DM session and replies to the same chat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-pipeline-image-'));
  const f = await fixture();
  try {
    const path = join(directory, 'photo.png');
    await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'));
    const received = new Promise(resolve => {
      const previous = f.ctx.agents.create;
      f.ctx.agents.create = async options => {
        const handle = await previous(options);
        const followup = handle.agent.followup;
        handle.agent.followup = async message => { await followup(message); resolve(message); };
        return handle;
      };
    });
    f.emit({ kind:'image', chatType:'dm', chat:'Alice', path, wake:true });
    const message = await received;
    assert.ok(message.content[0].text.includes(JSON.stringify(path)));
    assert.equal(f.calls[0][1], sessionIdFor(f.cfg, event('Alice')));
    f.end('Alice', 'I can see the image'); await tick();
    assert.deepEqual(f.sends[0].slice(1,5), ['--to','Alice','--expect-chat','Alice']);
  } finally { f.runtime.dispose(); await rm(directory, { recursive:true, force:true }); }
});
