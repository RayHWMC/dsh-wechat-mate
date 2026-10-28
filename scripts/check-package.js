import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Call npm's JS entry directly so Windows does not need a shell to execute npm.cmd.
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run with npm run check:package');
const output = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--dry-run', '--json'], { encoding: 'utf8' }));
const pack = Array.isArray(output) ? output[0] : Object.values(output)[0];
const files = new Set(pack.files.map(file => file.path));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const file of [pkg.main, 'plugin/client.js', 'plugin/panel.js', 'cordis.patch.yml', 'scripts/wxwatch.py', 'scripts/wxsend.py', 'scripts/wxread.py', 'scripts/wxlock.py']) {
  assert.ok(files.has(file), `Missing package file: ${file}`);
}
for (const file of files) assert.ok(!/node_modules|__pycache__|\.pyc$|\.ppm$|\.png$|^target\//.test(file), `Unexpected artifact: ${file}`);
console.log(`Package verified: ${files.size} files; host, client, patch, and bridge included.`);
