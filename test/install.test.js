import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_EXTENSION_ID, HOST_NAME } from '../src/constants.js';
import { checkManifest, install, launcherScript, uninstall } from '../src/install.js';

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
  assert.match(fs.readFileSync(manifest.path, 'utf8'), new RegExp(`exec '${process.execPath}'`));
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
