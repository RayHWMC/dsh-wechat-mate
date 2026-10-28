import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { DEFAULTS, apply } from '../plugin/index.js';
import { API, createPanelHost, validateSettings } from '../plugin/panel.js';

test('validates settings and rejects unknown keys or wrong types', () => {
  assert.deepEqual(validateSettings({ me: ['Alice', '', ' Alice '], enabled: false }), { me: ['Alice'], enabled: false });
  for (const patch of [{ enabled: 'false' }, { python: '' }, { me: 'Alice' }, { unknown: 1 }, []]) {
    assert.throws(() => validateSettings(patch));
  }
});

test('host apply resolves to undefined, as required by Cordis effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-apply-'));
  try {
    const ctx = new EventEmitter();
    ctx.get = () => undefined;
    ctx.logger = {};
    assert.equal(await apply(ctx, { enabled: false, settingsFile: join(directory, 'settings.json') }), undefined);
    ctx.emit('dispose');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('persists settings, reloads them, and removes the API on disposal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-panel-'));
  try {
    let route, removed = false;
    const ctx = new EventEmitter();
    ctx.get = () => ({ register: value => { route = value; return () => { removed = true; }; } });
    const cfg = { ...DEFAULTS, enabled: false, settingsFile: join(directory, 'settings.json') };
    const host = await createPanelHost(ctx, cfg, {}, () => assert.fail('disabled watcher started'));
    await host.save({ me: ['Test'], model: 'test-model' });
    assert.equal(JSON.parse(await readFile(cfg.settingsFile, 'utf8')).model, 'test-model');
    const restored = await createPanelHost(new EventEmitter(), cfg, {}, () => {});
    assert.equal(restored.status().settings.model, 'test-model');
    const request = Readable.from([Buffer.from('{"enabled":false}')]);
    Object.assign(request, { url: `${API}/settings`, method: 'POST',
      headers: { host: 'localhost:1234', origin: 'https://untrusted.example', 'content-type': 'application/json' } });
    let code;
    await route.handler(request, { writeHead: value => { code = value; }, end() {} });
    assert.equal(code, 403);
    ctx.emit('dispose');
    assert.equal(removed, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('client bundle reloads and registers a scoped standard settings section', async () => {
  const script = await readFile(new URL('../plugin/client.js', import.meta.url), 'utf8');
  const registrations = [];
  const sandbox = { window: { __ModuleLoader__: { load: value => registrations.push(value) } } };
  vm.runInNewContext(script, sandbox); vm.runInNewContext(script, sandbox);
  assert.equal(registrations.length, 2);
  const plugin = registrations[0].factory(id => { assert.equal(id, 'react'); return {}; });
  assert.equal(plugin.name, '@rayhwmc/dsh-wechat-mate');
  assert.deepEqual([...plugin.inject], ['slots']);
  let descriptor, Component, cleanup = false;
  plugin.apply({ effect: callback => callback(), slots: {
    inject: (slot, callback) => { assert.equal(slot, 'settings.section'); return callback(); },
    register: (value, component) => { descriptor = value; Component = component; return () => { cleanup = true; }; },
  } });
  assert.equal(descriptor.id, 'wechat-mate');
  assert.equal(typeof Component, 'function');
  // The disposer returned by register is the one returned from the effect.
  const stop = plugin.apply({ effect: callback => { callback()(); }, slots: {
    inject: (_slot, callback) => callback(), register: () => () => { cleanup = true; },
  } });
  assert.equal(cleanup, true);
  assert.equal(stop, undefined);
});
