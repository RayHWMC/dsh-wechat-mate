import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const API = '/.dsh-wechat-mate';
const STRINGS = ['repo', 'python', 'display', 'sessionId', 'cwd', 'preset', 'provider', 'model'];
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('settings must be an object');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (STRINGS.includes(key)) {
      if (typeof item !== 'string' || !item.trim() || item.length > 4096) throw Error(`invalid ${key}`);
      result[key] = item.trim();
    } else if (['enabled', 'sendReplies'].includes(key)) {
      if (typeof item !== 'boolean') throw Error(`invalid ${key}`);
      result[key] = item;
    } else if (key === 'me') {
      if (!Array.isArray(item) || item.length > 50 || item.some(n => typeof n !== 'string' || n.length > 100)) throw Error('invalid me');
      result.me = [...new Set(item.map(n => n.trim()).filter(Boolean))];
    } else throw Error(`unknown setting: ${key}`);
  }
  return result;
}

async function saveFile(path, settings) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, path);
  } finally { await unlink(tmp).catch(() => {}); }
}

export async function createPanelHost(ctx, cfg, log, start) {
  const key = createHash('sha256').update(`${cfg.repo}\0${cfg.sessionId}`).digest('hex').slice(0, 16);
  const stateFile = cfg.settingsFile ?? join(resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')),
    'storages', 'dsh-wechat-mate', `${key}.json`);
  const { settingsFile: _path, ...initial } = cfg;
  let settings = validateSettings(initial);
  let lastError = null;
  try { settings = { ...settings, ...validateSettings(JSON.parse(await readFile(stateFile, 'utf8'))) }; }
  catch (error) {
    if (error.code !== 'ENOENT') { lastError = `Settings could not be loaded: ${error.message}`; log.warn?.(lastError); }
  }
  let runtime;
  let disposed = false;
  let work = Promise.resolve();
  async function restart() {
    await runtime?.dispose();
    runtime = undefined;
    if (!disposed && settings.enabled && process.platform === 'linux') {
      try {
        runtime = await start(ctx, settings, log);
        if (disposed) { await runtime.dispose(); runtime = undefined; }
      }
      catch (error) { lastError = error.message; log.warn?.(lastError); }
    }
  }
  const status = () => ({
    settings: { ...settings, me: [...settings.me] }, stateFile,
    health: runtime?.status() ?? { phase: settings.enabled ? (process.platform === 'linux' ? 'error' : 'unsupported') : 'stopped' },
    lastError,
  });
  function save(patch) {
    const checked = validateSettings(patch);
    const operation = work.then(async () => {
      if (disposed) throw Error('plugin disposed');
      const next = { ...settings, ...checked };
      await saveFile(stateFile, next);
      settings = next;
      lastError = null;
      await restart();
      return status();
    });
    work = operation.catch(() => {});
    return operation;
  }
  const server = ctx.get?.('webServer');
  const removeRoute = server?.register({ kind: 'prefix', path: API, handler: async (req, res) => {
    const json = (code, data) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === `${API}/status` && req.method === 'GET') return json(200, status());
      if (path !== `${API}/settings` || req.method !== 'POST') return json(404, { error: 'not found' });
      if (req.headers['sec-fetch-site'] === 'cross-site' ||
          (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) return json(403, { error: 'cross-origin request rejected' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'JSON required' });
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) return json(413, { error: 'settings too large' });
        chunks.push(chunk);
      }
      const patch = validateSettings(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return json(200, await save(patch));
    } catch (error) { return json(400, { error: error.message }); }
  } });
  if (!server) log.warn?.('[im-wechat] webServer unavailable; desktop panel API is pending until plugin reload');
  ctx.on('dispose', async () => { disposed = true; removeRoute?.(); await work; await runtime?.dispose(); });
  await restart();
  return { status, save };
}
