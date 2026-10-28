import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DEFAULTS, start, sessionIdFor } from '../plugin/index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const event = (chat, text = '你好') => ({ kind: 'dm', chat, text, wake: true });

async function fixture(followup) {
  const ctx = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  const calls = [], sends = [], warnings = [];
  ctx.agents = {
    get: () => null, resume: async () => { throw Error('not saved'); },
    create: async ({ sessionId }) => {
      calls.push(['create', sessionId]);
      return { agent: { followup: async message => {
        calls.push(['followup', sessionId, message]);
        if (followup) await followup(sessionId);
      } } };
    },
  };
  const cfg = { ...DEFAULTS, me: ['Alice', '小王'] };
  const io = {
    spawn: (_cmd, args) => { child.args = args; return child; },
    execFile: (_cmd, args, _opts, callback) => {
      sends.push(args); queueMicrotask(() => callback(null));
      return new EventEmitter();
    },
  };
  const runtime = await start(ctx, cfg, { warn: m => warnings.push(m) }, io);
  const emit = value => child.stdout.write(Buffer.from(JSON.stringify(value) + '\n'));
  const end = (chat, text) => {
    const sid = sessionIdFor(cfg, event(chat));
    ctx.emit('session/event', { id: sid }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
    ctx.emit('session/event', { id: sid }, { type: 'turn/end' });
  };
  return { ctx, child, calls, sends, warnings, runtime, emit, end };
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
  assert.deepEqual(f.child.args.slice(1), ['--me', 'Alice', '--me', '小王']);
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
