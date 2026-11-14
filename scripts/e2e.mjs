#!/usr/bin/env node
// End-to-end test against a real browser.
//
//   CHROME_BIN=/path/to/chromium-or-chrome-for-testing node scripts/e2e.mjs
//
// Branded Google Chrome >= 137 ignores --load-extension; use Chromium or
// Chrome for Testing (npx @puppeteer/browsers install chrome@stable).
// Everything (profile, launcher, socket dir) lives in a temp dir. On Linux the
// browser runs under xvfb-run when it is available.
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'agent-tabs.js');
const EXTENSION_ID = 'fafpncbnpnoipmnfnpcpaopookpogfii';
const NOT_CONNECTED = 'agent-tabs: Chrome extension not connected. Is Chrome running with the agent-tabs extension installed? Run `agent-tabs doctor`.';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tabs-e2e-'));
const profile = path.join(tmp, 'profile');
const nmhDir = path.join(profile, 'NativeMessagingHosts');
const env = { ...process.env, AGENT_TABS_HOME: path.join(tmp, 'home'), AGENT_TABS_RUN_DIR: path.join(tmp, 'run') };
delete env.AGENT_TABS_SOCKET;

const transcript = [];
const log = (s = '') => {
  console.log(s);
  transcript.push(s);
};
const abridge = (s, max = 40) => {
  const lines = s.trimEnd().split('\n');
  return lines.length > max ? [...lines.slice(0, max), `... (${lines.length - max} more lines)`].join('\n') : lines.join('\n');
};

function findBrowser() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ['chromium', 'chromium-browser']) {
    const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.trim();
  }
  throw new Error('No Chromium found. Set CHROME_BIN (Chromium or Chrome for Testing; branded Chrome ignores --load-extension).');
}

function cli(args, { quiet = false } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, timeout: 30000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      if (!quiet) {
        log(`$ agent-tabs ${args.join(' ')}`);
        if (stdout.trim()) log(abridge(stdout));
        if (stderr.trim()) log(`[stderr] ${abridge(stderr)}`);
        log(`[exit ${code}]\n`);
      }
      let json;
      try { json = JSON.parse(stdout); } catch {}
      resolve({ code, stdout, stderr, json });
    });
  });
}

async function ok(args) {
  const r = await cli(args);
  assert.equal(r.code, 0, `agent-tabs ${args.join(' ')} failed: ${r.stderr}`);
  return r.json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

const steps = [];
async function step(name, fn) {
  log(`=== ${name}`);
  await fn();
  steps.push(name);
  log(`--- PASS: ${name}\n`);
}

let browser;
let browserExited;

function launchBrowser(bin) {
  const flags = [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    // Chromium 137+ only honors --load-extension with this feature disabled.
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--load-extension=${path.join(ROOT, 'extension')}`,
    // Test-only independent oracle: DevTools /json/list shows real page targets,
    // so tab changes are checked without trusting the extension's own list.
    '--remote-debugging-port=0',
    ...(process.env.E2E_BROWSER_FLAGS ? process.env.E2E_BROWSER_FLAGS.split(' ') : []),
    'about:blank',
  ];
  const useXvfb = process.platform === 'linux' && !process.env.E2E_NO_XVFB &&
    spawnSync('sh', ['-c', 'command -v xvfb-run']).status === 0;
  const [cmd, args] = useXvfb ? ['xvfb-run', ['-a', bin, ...flags]] : [bin, flags];
  log(`$ ${cmd} ${args.join(' ')}`);
  // detached: own process group, so we can kill xvfb-run, Xvfb and the browser together.
  browser = spawn(cmd, args, { env, detached: true, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'browser.log'), 'w')] });
  browserExited = new Promise((r) => browser.on('exit', r));
}

async function killBrowser() {
  if (!browser || browser.exitCode !== null) return;
  try { process.kill(-browser.pid, 'SIGTERM'); } catch {}
  const t = setTimeout(() => { try { process.kill(-browser.pid, 'SIGKILL'); } catch {} }, 5000);
  await browserExited;
  clearTimeout(t);
}

// URLs of real page targets according to the browser itself (not agent-tabs).
async function oracleUrls() {
  const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return targets.filter((t) => t.type === 'page').map((t) => t.url);
}

async function tabs() {
  return (await cli(['list-tabs', '--json'], { quiet: true })).json.tabs;
}

async function main() {
  const bin = findBrowser();
  log(`agent-tabs e2e  ${new Date().toISOString()}`);
  log(`node ${process.version}, browser ${bin}`);
  log(`browser version: ${spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim()}`);
  log(`temp dir ${tmp}\n`);

  let A, B, C, groupId;

  await step('install native host manifest into the profile dir', async () => {
    const res = await ok(['install', '--target-dir', nmhDir, '--json']);
    assert.equal(res.written[0].file, path.join(nmhDir, 'com.agenttabs.host.json'));
    assert.deepEqual(res.manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
    log(fs.readFileSync(res.written[0].file, 'utf8'));
    log(fs.readFileSync(res.launcher, 'utf8'));
  });

  await step('not connected before the browser starts', async () => {
    const r = await cli(['status']);
    assert.equal(r.code, 3);
    assert.equal(r.stderr.trim(), NOT_CONNECTED);
  });

  await step('launch browser and wait for `agent-tabs status`', async () => {
    launchBrowser(bin);
    const s = await waitFor('extension to connect', async () => {
      const r = await cli(['status', '--json'], { quiet: true });
      return r.code === 0 && r.json?.connected ? r.json : null;
    });
    assert.equal(s.origin, `chrome-extension://${EXTENSION_ID}/`);
    await ok(['status']);
    const sock = fs.statSync(s.socket);
    assert.equal(sock.mode & 0o777, 0o600, 'socket mode');
    assert.equal(fs.statSync(path.dirname(s.socket)).mode & 0o777, 0o700, 'socket dir mode');
    log(`socket ${s.socket} mode ${(sock.mode & 0o777).toString(8)}, dir mode 700\n`);
  });

  await step('doctor', async () => {
    const r = await cli(['doctor', '--target-dir', nmhDir]);
    assert.equal(r.code, 0);
  });

  await step('open_url x3 (+ javascript: rejected)', async () => {
    A = (await ok(['open-url', 'https://example.com', '--json'])).tab;
    B = (await ok(['open-url', 'https://example.org', '--json'])).tab;
    C = (await ok(['open-url', 'about:blank', '--background', '--json'])).tab;
    assert.ok(A.id && B.id && C.id);
    assert.equal(C.active, false);
    const bad = await cli(['open-url', 'javascript:alert(1)']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /refusing to open javascript: URL/);
  });

  await step('list_tabs', async () => {
    await waitFor('pages to load', async () => {
      const t = await tabs();
      return t.find((x) => x.id === A.id)?.title === 'Example Domain' || null;
    }, 15000).catch(() => log('(example.com did not finish loading; continuing)'));
    await ok(['list-tabs']);
    const t = (await ok(['list-tabs', '--json'])).tabs;
    const urls = Object.fromEntries(t.map((x) => [x.id, x.url]));
    assert.equal(urls[A.id], 'https://example.com/');
    assert.equal(urls[B.id], 'https://example.org/');
    assert.equal(urls[C.id], 'about:blank');
    for (const k of ['id', 'windowId', 'index', 'title', 'url', 'active', 'pinned', 'groupId', 'groupTitle', 'groupColor']) {
      assert.ok(k in t[0], `tab has ${k}`);
    }
  });

  await step('group_tabs with title + color', async () => {
    const { group } = await ok(['group-tabs', String(A.id), String(B.id), '--title', 'Research', '--color', 'blue', '--json']);
    groupId = group.id;
    assert.equal(group.title, 'Research');
    assert.equal(group.color, 'blue');
    assert.deepEqual([...group.tabIds].sort(), [A.id, B.id].sort());
    await ok(['group-tabs', String(A.id), String(B.id), '--group', String(groupId)]);
  });

  await step('list_groups', async () => {
    await ok(['list-groups']);
    const g = (await ok(['list-groups', '--json'])).groups.find((x) => x.id === groupId);
    assert.equal(g.title, 'Research');
    assert.equal(g.color, 'blue');
    assert.equal(g.collapsed, false);
    const t = (await tabs()).find((x) => x.id === A.id);
    assert.equal(t.groupTitle, 'Research');
  });

  await step('update_group rename + recolor + collapse, then expand', async () => {
    let { group } = await ok(['update-group', String(groupId), '--title', 'Reading', '--color', 'green', '--collapse', '--json']);
    assert.equal(group.title, 'Reading');
    assert.equal(group.color, 'green');
    assert.equal(group.collapsed, true);
    ({ group } = await ok(['update-group', String(groupId), '--expand', '--json']));
    assert.equal(group.collapsed, false);
  });

  await step('move_tabs', async () => {
    const { tabs: moved } = await ok(['move-tabs', String(C.id), '--index', '0', '--json']);
    assert.equal(moved[0].index, 0);
    await ok(['move-tabs', String(C.id), '--end']);
    const t = await tabs();
    const inWin = t.filter((x) => x.windowId === C.windowId);
    assert.equal(inWin.at(-1).id, C.id);
  });

  await step('focus_tab', async () => {
    const { tab } = await ok(['focus-tab', String(C.id), '--json']);
    assert.equal(tab.active, true);
    assert.equal((await tabs()).find((x) => x.id === C.id).active, true);
  });

  await step('ungroup', async () => {
    const { tabs: t } = await ok(['ungroup', String(A.id), '--json']);
    assert.equal(t[0].groupId, -1);
    const g = (await ok(['list-groups', '--json'])).groups.find((x) => x.id === groupId);
    assert.deepEqual(g.tabIds, [B.id]);
  });

  await step('close_tabs dry run closes nothing', async () => {
    const before = (await tabs()).length;
    const r = await cli(['close-tabs', String(A.id), String(B.id)]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Dry run, nothing closed/);
    const j = await ok(['close-tabs', String(A.id), String(B.id), '--json']);
    assert.equal(j.dryRun, true);
    assert.deepEqual(j.wouldClose.map((x) => x.id), [A.id, B.id]);
    const after = await tabs();
    assert.equal(after.length, before);
    assert.ok(after.some((x) => x.id === A.id) && after.some((x) => x.id === B.id));
  });

  await step('close_tabs --yes closes', async () => {
    const before = (await tabs()).length;
    const j = await ok(['close-tabs', String(A.id), String(B.id), '--yes', '--json']);
    assert.equal(j.dryRun, false);
    assert.deepEqual(j.closed.map((x) => x.id), [A.id, B.id]);
    const after = await waitFor('tabs to close', async () => {
      const t = await tabs();
      return t.length === before - 2 ? t : null;
    }, 5000);
    assert.ok(!after.some((x) => x.id === A.id || x.id === B.id));
    await ok(['list-tabs']);
  });

  await step('short aliases: open several URLs into a new group, rename, close --group --confirm', async () => {
    const before = (await tabs()).length;
    const o = await ok(['open', 'https://example.com/a', 'https://example.org/b', '--background', '--title', 'Research', '--color', 'purple', '--json']);
    assert.equal(o.tabs.length, 2);
    assert.equal(o.group.title, 'Research');
    assert.equal(o.group.color, 'purple');
    assert.deepEqual([...o.group.tabIds].sort(), o.tabs.map((t) => t.id).sort());
    const G = o.group.id;
    const seen = await waitFor('oracle to see both tabs', async () => {
      const u = await oracleUrls();
      return u.includes('https://example.com/a') && u.includes('https://example.org/b') ? u : null;
    }, 15000);
    log(`oracle (DevTools /json/list) page URLs: ${seen.join(' | ')}`);
    await ok(['rename', String(G), 'Reading', 'list']);
    const listed = (await ok(['list', '--json'])).tabs.filter((t) => t.groupId === G);
    assert.equal(listed.length, 2);
    assert.ok(listed.every((t) => t.groupTitle === 'Reading list'));
    const dry = await ok(['close', '--group', String(G), '--json']);
    assert.equal(dry.dryRun, true);
    assert.equal((await tabs()).length, before + 2, 'dry run closed nothing');
    const done = await ok(['close', '--group', String(G), '--confirm', '--json']);
    assert.equal(done.dryRun, false);
    assert.equal(done.closed.length, 2);
    await waitFor('group tabs to close', async () => ((await tabs()).length === before ? true : null), 5000);
    const left = await waitFor('oracle to drop both tabs', async () => {
      const u = await oracleUrls();
      return !u.includes('https://example.com/a') && !u.includes('https://example.org/b') ? u : null;
    }, 5000);
    log(`oracle after close --group --confirm: ${left.join(' | ')}`);
    const gone = (await ok(['list-groups', '--json'])).groups.find((g) => g.id === G);
    assert.equal(gone, undefined);
  });

  await step('native host crash -> extension reconnects with backoff', async () => {
    const before = (await cli(['status', '--json'], { quiet: true })).json;
    process.kill(before.pid, 'SIGKILL'); // leaves a stale socket file behind
    log(`killed host pid ${before.pid} with SIGKILL`);
    const after = await waitFor('a new host', async () => {
      const r = await cli(['status', '--json'], { quiet: true });
      return r.code === 0 && r.json.pid !== before.pid ? r.json : null;
    }, 20000);
    log(`extension reconnected: new host pid ${after.pid}`);
    assert.ok((await tabs()).some((t) => t.id === C.id));
    await ok(['status']);
  });

  await step('MCP with the official SDK client', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env, stderr: 'inherit' });
    const client = new Client({ name: 'agent-tabs-e2e', version: '0.0.0' });
    await client.connect(transport); // initialize + notifications/initialized
    log(`MCP initialize -> server ${JSON.stringify(client.getServerVersion())}, protocol ${transport._protocolVersion ?? '(negotiated)'}`);
    await client.ping();
    const { tools } = await client.listTools();
    log(`tools/list -> ${tools.map((t) => t.name).join(', ')}`);
    assert.equal(tools.length, 9);

    const list = await client.callTool({ name: 'list_tabs', arguments: {} });
    assert.ok(!list.isError);
    const mcpTabs = list.structuredContent.tabs;
    log(`tools/call list_tabs -> ${mcpTabs.length} tabs: ${mcpTabs.map((t) => `${t.id} ${t.url}`).join(' | ')}`);
    assert.ok(mcpTabs.some((t) => t.id === C.id));

    const preview = await client.callTool({ name: 'close_tabs', arguments: { tabIds: [C.id] } });
    log(`tools/call close_tabs (no confirm) ->\n${abridge(preview.content[0].text, 20)}`);
    assert.ok(!preview.isError);
    assert.match(preview.content[0].text, /^Dry run: nothing was closed/);
    assert.equal(preview.structuredContent.dryRun, true);
    assert.ok((await tabs()).some((t) => t.id === C.id), 'tab still open after MCP dry run');

    const closeTool = tools.find((t) => t.name === 'close_tabs');
    assert.match(closeTool.description, /explicit approval/);
    const neither = await client.callTool({ name: 'close_tabs', arguments: { confirm: true } });
    assert.equal(neither.isError, true, 'close_tabs without tabIds/groupId is rejected');

    const bad = await client.callTool({ name: 'open_url', arguments: { url: 'javascript:alert(1)' } });
    log(`tools/call open_url javascript: -> isError=${bad.isError} "${bad.content[0].text}"`);
    assert.equal(bad.isError, true);

    const opened = await client.callTool({ name: 'open_url', arguments: { url: 'https://example.net', active: false } });
    assert.ok(!opened.isError);
    const closed = await client.callTool({ name: 'close_tabs', arguments: { tabIds: [opened.structuredContent.tab.id], confirm: true } });
    log(`tools/call open_url + close_tabs confirm:true -> closed ${closed.structuredContent.closed[0].url}`);
    assert.equal(closed.structuredContent.dryRun, false);
    await client.close();
    log('');
  });

  let socketPath;
  await step('kill browser -> host exits, socket removed, clear not-connected errors', async () => {
    socketPath = (await cli(['status', '--json'], { quiet: true })).json.socket;
    await killBrowser();
    log(`browser stopped (pgid ${browser.pid})`);
    await waitFor('socket removal', async () => !fs.existsSync(socketPath), 10000);
    log(`socket ${socketPath} removed`);
    for (const args of [['status'], ['list-tabs'], ['close-tabs', '1', '--yes']]) {
      const r = await cli(args);
      assert.equal(r.code, 3);
      assert.equal(r.stderr.trim(), NOT_CONNECTED);
    }
    const r = await cli(['list-tabs', '--json']);
    assert.equal(r.json.error.code, 'ENOTCONNECTED');

    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env, stderr: 'inherit' });
    const client = new Client({ name: 'agent-tabs-e2e', version: '0.0.0' });
    await client.connect(transport);
    const res = await client.callTool({ name: 'list_tabs', arguments: {} });
    log(`MCP tools/call list_tabs while disconnected -> isError=${res.isError} "${res.content[0].text}"`);
    assert.equal(res.isError, true);
    assert.equal(res.content[0].text, NOT_CONNECTED);
    await client.close();
  });

  await step('uninstall', async () => {
    await ok(['uninstall', '--target-dir', nmhDir]);
    assert.equal(fs.existsSync(path.join(nmhDir, 'com.agenttabs.host.json')), false);
  });

  log(`ALL ${steps.length} STEPS PASSED`);
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  log(`\nFAILED: ${err.stack || err}`);
  const bl = path.join(tmp, 'browser.log');
  if (fs.existsSync(bl)) log(`browser log tail:\n${fs.readFileSync(bl, 'utf8').split('\n').slice(-30).join('\n')}`);
} finally {
  await killBrowser();
  if (process.env.E2E_TRANSCRIPT) fs.writeFileSync(process.env.E2E_TRANSCRIPT, transcript.join('\n') + '\n');
  if (!process.env.E2E_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
