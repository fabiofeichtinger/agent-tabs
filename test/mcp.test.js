import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NOT_CONNECTED_MESSAGE } from '../src/constants.js';
import { createMcpServer } from '../src/mcp.js';

function harness(call) {
  const sent = [];
  const server = createMcpServer({ write: (s) => sent.push(JSON.parse(s)), call });
  return { sent, rpc: async (msg) => { await server.handle({ jsonrpc: '2.0', ...msg }); return sent.at(-1); } };
}

test('initialize negotiates the protocol version', async () => {
  const { rpc } = harness();
  let r = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.equal(r.result.serverInfo.name, 'grok-tabs');
  assert.ok(r.result.capabilities.tools);
  r = await rpc({ id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.match(r.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
});

test('notifications get no response; ping and unknown methods do', async () => {
  const { sent, rpc } = harness();
  await rpc({ method: 'notifications/initialized' });
  assert.equal(sent.length, 0);
  assert.deepEqual((await rpc({ id: 'a', method: 'ping' })).result, {});
  assert.equal((await rpc({ id: 3, method: 'resources/list' })).error.code, -32601);
});

test('tools/list exposes all operations with schemas', async () => {
  const { rpc } = harness();
  const { tools } = (await rpc({ id: 1, method: 'tools/list' })).result;
  const names = tools.map((t) => t.name);
  for (const n of ['list_tabs', 'list_groups', 'group_tabs', 'update_group', 'ungroup', 'move_tabs', 'open_url', 'focus_tab', 'close_tabs']) {
    assert.ok(names.includes(n), n);
  }
  assert.equal(tools.find((t) => t.name === 'close_tabs').annotations.destructiveHint, true);
});

test('tools/call forwards validated arguments and wraps results', async () => {
  const calls = [];
  const { rpc } = harness(async (name, args) => { calls.push([name, args]); return { tabs: [] }; });
  const r = await rpc({ id: 1, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } });
  assert.deepEqual(calls, [['list_tabs', {}]]);
  assert.deepEqual(r.result.structuredContent, { tabs: [] });
  assert.equal(r.result.isError, undefined);
});

test('invalid arguments and backend failures are isError results', async () => {
  const { rpc } = harness(async () => { throw new Error('boom'); });
  let r = await rpc({ id: 1, method: 'tools/call', params: { name: 'open_url', arguments: { url: 'javascript:alert(1)' } } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /refusing/);
  r = await rpc({ id: 2, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } });
  assert.equal(r.result.isError, true);
  assert.equal(r.result.content[0].text, 'boom');
  r = await rpc({ id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(r.error.code, -32602);
});

test('close_tabs without confirm passes confirm through as absent and labels the dry run', async () => {
  const calls = [];
  const { rpc } = harness(async (name, args) => {
    calls.push(args);
    return { dryRun: true, wouldClose: [{ id: 5, title: 't', url: 'https://example.com/' }] };
  });
  const r = await rpc({ id: 1, method: 'tools/call', params: { name: 'close_tabs', arguments: { tabIds: [5] } } });
  assert.deepEqual(calls, [{ tabIds: [5] }]);
  assert.match(r.result.content[0].text, /^Dry run: nothing was closed/);
});

test('real `grok-tabs mcp` process reports not-connected as a tool error', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mcp-'));
  const child = spawn(process.execPath, ['bin/grok-tabs.js', 'mcp'], {
    env: { ...process.env, GROK_TABS_RUN_DIR: runDir, GROK_TABS_SOCKET: '' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } });
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].result.isError, true);
  assert.equal(lines[1].result.content[0].text, NOT_CONNECTED_MESSAGE);
});
