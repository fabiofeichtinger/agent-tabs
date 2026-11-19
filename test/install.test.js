import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEFAULT_EXTENSION_ID, HOST_NAME } from '../src/constants.js';
import { assertExecutableNode, checkManifest, install, launcherScript, stableNodePath, uninstall } from '../src/install.js';

test('install writes an executable launcher and a valid manifest into --target-dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-install-'));
  process.env.AGENT_TABS_HOME = path.join(tmp, 'home');
  const target = path.join(tmp, 'NativeMessagingHosts');

  const res = install({ targetDirs: [target] });
  const file = path.join(target, `${HOST_NAME}.json`);
  assert.deepEqual(res.written, [{ target: 'custom', file }]);

  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, 'stdio');
  assert.ok(path.isAbsolute(manifest.path));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${DEFAULT_EXTENSION_ID}/`]);
  assert.ok(fs.statSync(manifest.path).mode & 0o100);
  assert.match(fs.readFileSync(manifest.path, 'utf8'), new RegExp(`exec '${stableNodePath()}'`));
  assert.equal(checkManifest(file).ok, true);
  assert.equal(checkManifest(file, 'abcdefghijklmnopabcdefghijklmnop').ok, false);

  assert.deepEqual(uninstall({ targetDirs: [target] }).removed, [file, manifest.path]);
  assert.equal(fs.existsSync(file), false);
});

test('install validates extension IDs and browser names', () => {
  assert.throws(() => install({ extensionIds: ['not-an-id'], dryRun: true }), /invalid extension ID/);
  assert.throws(() => install({ browsers: ['netscape'], dryRun: true }), /unknown browser/);
});

test('launcher script quotes paths safely', () => {
  const s = launcherScript("/opt/no'de/bin/node", '/x y/cli.js');
  assert.match(s, /^#!\/bin\/sh/);
  assert.ok(s.includes(`exec '/opt/no'\\''de/bin/node' '/x y/cli.js' host "$@"`));
});

// Fake Homebrew prefix: <prefix>/Cellar/node@24/24.14.0_1/bin/node, plus an
// opt/node@24 symlink to `optTarget` (relative to the prefix) unless null.
function fakeBrew(optTarget) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-brew-'));
  for (const v of ['24.14.0_1', '24.15.0']) {
    fs.mkdirSync(path.join(prefix, 'Cellar/node@24', v, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(prefix, 'Cellar/node@24', v, 'bin/node'), '');
  }
  if (optTarget) {
    fs.mkdirSync(path.join(prefix, 'opt'));
    fs.symlinkSync(path.join('..', optTarget), path.join(prefix, 'opt/node@24'));
  }
  return { prefix, cellarNode: path.join(prefix, 'Cellar/node@24/24.14.0_1/bin/node') };
}

test('stableNodePath prefers the Homebrew opt link when it resolves to the same node', () => {
  const { prefix, cellarNode } = fakeBrew('Cellar/node@24/24.14.0_1');
  assert.equal(stableNodePath(cellarNode), path.join(prefix, 'opt/node@24/bin/node'));
});

test('stableNodePath keeps the Cellar path when the opt link is missing', () => {
  const { cellarNode } = fakeBrew(null);
  assert.equal(stableNodePath(cellarNode), cellarNode);
});

test('stableNodePath keeps the Cellar path when the opt link points elsewhere', () => {
  const { cellarNode } = fakeBrew('Cellar/node@24/24.15.0');
  assert.equal(stableNodePath(cellarNode), cellarNode);
});

test('stableNodePath leaves non-Homebrew paths unchanged', () => {
  assert.equal(stableNodePath('/usr/local/bin/node'), '/usr/local/bin/node');
  assert.equal(stableNodePath('/home/u/.nvm/versions/node/v24.14.0/bin/node'), '/home/u/.nvm/versions/node/v24.14.0/bin/node');
});

test('install bakes nodePath into the launcher', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-install-'));
  process.env.AGENT_TABS_HOME = path.join(tmp, 'home');
  const res = install({ targetDirs: [path.join(tmp, 'NMH')], nodePath: '/custom/bin/node' });
  assert.ok(fs.readFileSync(res.launcher, 'utf8').includes(`exec '/custom/bin/node' `));
});

test('install --node fails clearly when PATH is missing, not a file, or not executable', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-node-'));
  const missing = path.join(tmp, 'nope/node');
  const notExec = path.join(tmp, 'node-noexec');
  fs.writeFileSync(notExec, '');
  fs.chmodSync(notExec, 0o644);

  assert.throws(() => assertExecutableNode(missing), /--node .*nope\/node: no such file/);
  assert.throws(() => assertExecutableNode(tmp), /not a regular file/);
  assert.throws(() => assertExecutableNode(notExec), /node-noexec: not executable/);
  assert.equal(assertExecutableNode(process.execPath), process.execPath);

  const cli = fileURLToPath(new URL('../bin/agent-tabs.js', import.meta.url));
  const env = { ...process.env, AGENT_TABS_HOME: path.join(tmp, 'home') };
  for (const [arg, re] of [[missing, /no such file/], [notExec, /not executable/]]) {
    const r = spawnSync(process.execPath, [cli, 'install', '--node', arg, '--target-dir', path.join(tmp, 'NMH')], { env, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /^agent-tabs: --node /);
    assert.match(r.stderr, re);
    assert.equal(fs.existsSync(path.join(tmp, 'home')), false, 'nothing written on failure');
  }

  const ok = spawnSync(process.execPath, [cli, 'install', '--node', process.execPath, '--target-dir', path.join(tmp, 'NMH')], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});
