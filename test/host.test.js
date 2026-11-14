// Runs the real native host as a child process, playing the part of Chrome on
// its stdin/stdout, and talks to it through the Unix socket like the CLI does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { connect, NotConnectedError } from '../src/client.js';
import { NativeDecoder, encodeNative } from '../src/framing.js';

const ORIGIN = 'chrome-extension://fafpncbnpnoipmnfnpcpaopookpogfii/';

async function startHost() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-host-'));
  process.env.AGENT_TABS_RUN_DIR = runDir;
  const child = spawn(process.execPath, ['bin/agent-tabs.js', 'host', ORIGIN], {
    env: { ...process.env, AGENT_TABS_RUN_DIR: runDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const socketPath = path.join(runDir, `host-${child.pid}.sock`);
  // Fake extension: answer every request after a short delay.
  const decoder = new NativeDecoder((msg) => {
    const reply = msg.method === 'echo' ? { id: msg.id, result: msg.params }
      : msg.method === 'fail' ? { id: msg.id, error: { message: 'nope' } }
      : null;
    if (reply) setTimeout(() => child.stdin.write(encodeNative(reply)), 5);
  });
  child.stdout.on('data', (d) => decoder.push(d));
  child.stdin.write(encodeNative({ type: 'hello', version: '9.9.9', userAgent: 'FakeChrome' }));
  for (let i = 0; i < 100 && !fs.existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 20));
  return { child, runDir, socketPath };
}

test('host relays requests, serves status, and cleans up on stdin close', async () => {
  const { child, runDir, socketPath } = await startHost();
  try {
    assert.equal(fs.statSync(runDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

    const conn = await connect();
    const status = await conn.request('host.status');
    assert.equal(status.origin, ORIGIN);
    assert.equal(status.extension.userAgent, 'FakeChrome');

    // Concurrent requests are correlated by id.
    const results = await Promise.all([1, 2, 3].map((n) => conn.request('echo', { n })));
    assert.deepEqual(results, [{ n: 1 }, { n: 2 }, { n: 3 }]);
    await assert.rejects(conn.request('fail'), /nope/);
    await assert.rejects(conn.request('never', {}, { timeoutMs: 100 }), /timed out/);
    conn.close();

    const exited = new Promise((r) => child.on('exit', r));
    child.stdin.end(); // Chrome disconnects
    assert.equal(await exited, 0);
    assert.equal(fs.existsSync(socketPath), false);
    await assert.rejects(connect(), NotConnectedError);
  } finally {
    child.kill();
  }
});

test('stale sockets from crashed hosts are skipped and removed', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-stale-'));
  process.env.AGENT_TABS_RUN_DIR = runDir;
  const stale = path.join(runDir, 'host-999999.sock');
  // A listener killed with SIGKILL leaves its socket file behind.
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(stale)}, () => console.log('up'))`]);
  await new Promise((r) => child.stdout.once('data', r));
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  assert.ok(fs.existsSync(stale));
  await assert.rejects(connect(), (err) => err instanceof NotConnectedError && /Run `agent-tabs doctor`/.test(err.message));
  assert.equal(fs.existsSync(stale), false);
});
