import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, sessionIdFor, validEvent, eventText } from '../plugin/index.js';

const imageEvent = path => ({ kind: 'image', chatType: 'dm', chat: 'Alice', path, wake: true });

test('images use their source DM/group session and require an absolute PNG path', () => {
  const image = imageEvent(join(tmpdir(), 'photo.png'));
  assert.equal(validEvent(image), true);
  assert.equal(sessionIdFor(DEFAULTS, image), sessionIdFor(DEFAULTS, { kind:'dm', chat:'Alice' }));
  assert.equal(sessionIdFor(DEFAULTS, { ...image, chatType:'group' }), sessionIdFor(DEFAULTS, { kind:'group_mention', chat:'Alice' }));
  for (const invalid of [{ path:'relative.png' }, { path:join(tmpdir(),'photo.dat') }, { chatType:'unknown' }, { wake:false }]) {
    assert.equal(validEvent({ ...image, ...invalid }), false);
  }
});

test('the agent receives a readable PNG reference, while missing or bogus files are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-image-'));
  try {
    const path = join(directory, 'captured image.png');
    await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'));
    const text = await eventText({ ...imageEvent(path), text:'look at this' });
    assert.ok(text.includes(JSON.stringify(path)));
    assert.match(text, /Open this PNG/);
    assert.match(text, /look at this/);
    await writeFile(path, 'not a PNG'.repeat(10));
    await assert.rejects(eventText(imageEvent(path)), /does not point to a PNG/);
    await assert.rejects(eventText(imageEvent(join(directory, 'missing.png'))), /ENOENT/);
  } finally { await rm(directory, { recursive:true, force:true }); }
});
