// Command-line interface.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { call, connect, NotConnectedError } from './client.js';
import { DEFAULT_EXTENSION_ID, HOST_NAME, VERSION } from './constants.js';
import { checkManifest, install, knownBrowsers, uninstall } from './install.js';
import { validateParams } from './ops.js';
import { launcherPath, listSockets, runDir } from './paths.js';

const USAGE = `grok-tabs ${VERSION}: manage Chrome tabs from the CLI and MCP clients

Usage: grok-tabs <command> [options]

Tabs and groups:
  list-tabs [--window ID]                       List tabs in all windows
  list-groups                                   List tab groups
  group-tabs <tabId...> [--group ID] [--title T] [--color C] [--collapsed]
                                                Group tabs (new group, or add to --group)
  update-group <groupId> [--title T] [--color C] [--collapse | --expand]
  ungroup <tabId...>                            Remove tabs from their group
  move-tabs <tabId...> (--index N | --end) [--window ID]
  open-url <url> [--background] [--window ID] [--group ID]
  focus-tab <tabId>                             Activate a tab and focus its window
  close-tabs <tabId...> [--yes]                 Dry run unless --yes is given

Setup:
  install [--extension-id ID]... [--browser NAME]... [--target-dir DIR]... [--dry-run]
  uninstall [--target-dir DIR]...
  doctor [--target-dir DIR]...                  Check installation and connection
  status                                        Is the extension connected?
  mcp                                           Run the MCP server on stdio
  host                                          Native host (started by Chrome)

Global options:
  --json            Machine-readable output
  --socket PATH     Use this host socket instead of the most recent one
  --timeout MS      Request timeout (default 15000)

Colors: grey blue red yellow green pink purple cyan orange
Underscore names (list_tabs, ...) work too.`;

const GLOBAL = {
  json: { type: 'boolean' },
  socket: { type: 'string' },
  timeout: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

class UsageError extends Error {}

function toInt(value, what) {
  if (!/^-?\d+$/.test(String(value))) throw new UsageError(`${what} must be an integer, got "${value}"`);
  return Number(value);
}

const optInt = (value, what) => (value === undefined ? undefined : toInt(value, what));

function needIds(positionals, what = 'tabId') {
  if (!positionals.length) throw new UsageError(`expected at least one ${what}`);
  return positionals.map((p) => toInt(p, what));
}

// CLI command -> operation name, extra options, and argv -> params mapping.
const TAB_COMMANDS = {
  'list-tabs': {
    op: 'list_tabs',
    options: { window: { type: 'string' } },
    params: (pos, v) => ({ windowId: optInt(v.window, '--window') }),
  },
  'list-groups': { op: 'list_groups', options: {}, params: () => ({}) },
  'group-tabs': {
    op: 'group_tabs',
    options: { group: { type: 'string' }, title: { type: 'string' }, color: { type: 'string' }, collapsed: { type: 'boolean' } },
    params: (pos, v) => ({
      tabIds: needIds(pos), groupId: optInt(v.group, '--group'), title: v.title, color: v.color, collapsed: v.collapsed,
    }),
  },
  'update-group': {
    op: 'update_group',
    options: { title: { type: 'string' }, color: { type: 'string' }, collapse: { type: 'boolean' }, collapsed: { type: 'boolean' }, expand: { type: 'boolean' } },
    params: (pos, v) => {
      if (pos.length !== 1) throw new UsageError('expected exactly one groupId');
      if ((v.collapse || v.collapsed) && v.expand) throw new UsageError('--collapse and --expand are mutually exclusive');
      const collapsed = v.collapse || v.collapsed ? true : v.expand ? false : undefined;
      return { groupId: toInt(pos[0], 'groupId'), title: v.title, color: v.color, collapsed };
    },
  },
  ungroup: { op: 'ungroup', options: {}, params: (pos) => ({ tabIds: needIds(pos) }) },
  'move-tabs': {
    op: 'move_tabs',
    options: { index: { type: 'string' }, end: { type: 'boolean' }, window: { type: 'string' } },
    params: (pos, v) => {
      if (v.index === undefined && !v.end) throw new UsageError('move-tabs needs --index N or --end');
      return { tabIds: needIds(pos), index: v.end ? -1 : toInt(v.index, '--index'), windowId: optInt(v.window, '--window') };
    },
  },
  'open-url': {
    op: 'open_url',
    options: { background: { type: 'boolean' }, window: { type: 'string' }, group: { type: 'string' } },
    params: (pos, v) => {
      if (pos.length !== 1) throw new UsageError('expected exactly one URL');
      return {
        url: pos[0], active: v.background ? false : undefined, windowId: optInt(v.window, '--window'), groupId: optInt(v.group, '--group'),
      };
    },
  },
  'focus-tab': {
    op: 'focus_tab',
    options: {},
    params: (pos) => {
      if (pos.length !== 1) throw new UsageError('expected exactly one tabId');
      return { tabId: toInt(pos[0], 'tabId') };
    },
  },
  'close-tabs': {
    op: 'close_tabs',
    options: { yes: { type: 'boolean', short: 'y' } },
    params: (pos, v) => ({ tabIds: needIds(pos), confirm: v.yes === true }),
  },
};

const ALIASES = { tabs: 'list-tabs', groups: 'list-groups', group: 'group-tabs', move: 'move-tabs', open: 'open-url', focus: 'focus-tab', close: 'close-tabs' };

// --- human-readable output -------------------------------------------------

const groupLabel = (t) => (t.groupId >= 0 ? `  [group ${t.groupId}${t.groupTitle ? ` "${t.groupTitle}"` : ''} ${t.groupColor}]` : '');

function tabLine(t) {
  const flags = `${t.active ? '*' : ' '}${t.pinned ? 'P' : ' '}`;
  return `${String(t.id).padStart(10)} ${flags} ${t.title || '(untitled)'}  ${t.url}${groupLabel(t)}`;
}

function groupLine(g) {
  return `${String(g.id).padStart(10)}  "${g.title}" ${g.color}${g.collapsed ? ' (collapsed)' : ''}  window ${g.windowId}  tabs: ${g.tabIds.join(', ') || '-'}`;
}

function formatResult(op, r) {
  switch (op) {
    case 'list_tabs': {
      if (!r.tabs.length) return 'No tabs.';
      const lines = [];
      let win;
      for (const t of r.tabs) {
        if (t.windowId !== win) lines.push(`Window ${(win = t.windowId)}`);
        lines.push(tabLine(t));
      }
      return lines.join('\n');
    }
    case 'list_groups':
      return r.groups.length ? r.groups.map(groupLine).join('\n') : 'No tab groups.';
    case 'group_tabs':
    case 'update_group':
      return `Group:\n${groupLine(r.group)}`;
    case 'ungroup':
    case 'move_tabs':
      return r.tabs.map(tabLine).join('\n');
    case 'open_url':
      return `Opened:\n${tabLine(r.tab)}`;
    case 'focus_tab':
      return `Focused:\n${tabLine(r.tab)}`;
    case 'close_tabs':
      return r.dryRun
        ? `Dry run, nothing closed. These ${r.wouldClose.length} tab(s) would close:\n${r.wouldClose.map(tabLine).join('\n')}\nRe-run with --yes to close them.`
        : `Closed ${r.closed.length} tab(s):\n${r.closed.map(tabLine).join('\n')}`;
    default:
      return JSON.stringify(r, null, 2);
  }
}

// --- setup commands --------------------------------------------------------

function cmdInstall(v) {
  const extensionIds = v['extension-id']?.length ? v['extension-id'] : [DEFAULT_EXTENSION_ID];
  const res = install({ extensionIds, browsers: v.browser ?? [], targetDirs: v['target-dir'] ?? [], dryRun: v['dry-run'] });
  if (v.json) return console.log(JSON.stringify(res, null, 2));
  const verb = v['dry-run'] ? 'Would write' : 'Wrote';
  console.log(`${verb} launcher ${res.launcher}`);
  if (!res.written.length) {
    console.log('No supported browser config directory found. Use --browser NAME or --target-dir DIR.');
    console.log(`Known browsers: ${knownBrowsers().map((b) => b.name).join(', ') || '(none on this platform)'}`);
    return;
  }
  for (const w of res.written) console.log(`${verb} ${w.file}  (${w.target})`);
  console.log(`allowed_origins: ${res.manifest.allowed_origins.join(' ')}`);
  console.log('Restart the browser (or reload the extension) so it picks up the host.');
}

function cmdUninstall(v) {
  const res = uninstall({ targetDirs: v['target-dir'] ?? [] });
  if (v.json) return console.log(JSON.stringify(res, null, 2));
  if (!res.removed.length) console.log('Nothing to remove.');
  for (const f of res.removed) console.log(`Removed ${f}`);
}

async function status(v) {
  const conn = await connect({ socket: v.socket });
  try {
    const timeoutMs = optInt(v.timeout, '--timeout');
    const info = await conn.request('host.status', {}, { timeoutMs });
    const t0 = performance.now();
    const ping = await conn.request('ping', {}, { timeoutMs });
    return { ...info, extension: { ...info.extension, version: ping.version, userAgent: ping.userAgent }, pingMs: Math.round(performance.now() - t0) };
  } finally {
    conn.close();
  }
}

async function cmdStatus(v) {
  const s = await status(v);
  if (v.json) return console.log(JSON.stringify(s, null, 2));
  console.log(`connected: yes (ping ${s.pingMs} ms)`);
  console.log(`browser:   ${s.extension.userAgent}`);
  console.log(`extension: ${s.origin || '?'} v${s.extension.version}`);
  console.log(`host:      pid ${s.pid}, socket ${s.socket}`);
}

async function cmdDoctor(v) {
  const checks = [];
  const add = (ok, label, detail = '') => checks.push({ ok, label, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 18, `Node.js ${process.versions.node}`, major >= 18 ? '' : 'Node 18+ required');

  const launcher = launcherPath();
  let launcherOk = false;
  try {
    fs.accessSync(launcher, fs.constants.X_OK);
    const nodeInScript = fs.readFileSync(launcher, 'utf8').match(/^exec '([^']+)'/m)?.[1];
    launcherOk = !nodeInScript || fs.existsSync(nodeInScript);
    add(launcherOk, `launcher ${launcher}`, launcherOk ? '' : `node binary ${nodeInScript} no longer exists; re-run install`);
  } catch {
    add(false, `launcher ${launcher}`, 'missing; run `grok-tabs install`');
  }

  let manifests = 0;
  const dirs = [
    ...knownBrowsers().map((b) => ({ ...b, required: false })),
    ...(v['target-dir'] ?? []).map((d) => ({ name: 'custom', manifestDir: d, configDir: d, required: true })),
  ];
  for (const b of dirs) {
    const file = `${b.manifestDir}/${HOST_NAME}.json`;
    if (!fs.existsSync(file)) {
      if (b.required) add(false, `${b.name}: ${file}`, 'missing');
      else if (fs.existsSync(b.configDir)) add(null, `${b.name}: no host manifest`, `run \`grok-tabs install --browser ${b.name}\``);
      continue;
    }
    manifests++;
    const res = checkManifest(file);
    add(res.ok, `${b.name}: ${file}`, res.problems.join('; ') || res.allowedOrigins.join(' '));
  }
  // Downgraded to a warning below if the extension connects anyway (system-wide
  // or --user-data-dir manifests are not in the per-user dirs we know about).
  const noManifest = manifests ? null : checks[checks.push({ ok: false, label: 'host manifest', detail: 'none found in per-user browser dirs; run `grok-tabs install`' }) - 1];

  const dir = runDir();
  try {
    const st = fs.statSync(dir);
    const mode = (st.mode & 0o777).toString(8);
    add((st.mode & 0o077) === 0, `socket dir ${dir}`, `mode ${mode}`);
  } catch {
    add(null, `socket dir ${dir}`, 'does not exist yet (created when the extension connects)');
  }
  const sockets = listSockets();
  add(sockets.length > 0 || null, `sockets: ${sockets.length}`, sockets.join(', '));

  let connected = false;
  try {
    const s = await status(v);
    connected = true;
    add(true, `connected to extension (ping ${s.pingMs} ms)`, `${s.extension.userAgent}`);
    if (noManifest) noManifest.ok = null;
  } catch (err) {
    add(false, 'connection', err instanceof NotConnectedError ? `not connected (${err.detail})` : err.message);
  }

  if (v.json) {
    console.log(JSON.stringify({ ok: connected, checks }, null, 2));
  } else {
    for (const c of checks) {
      const mark = c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : 'warn';
      console.log(`[${mark}] ${c.label}${c.detail ? `\n         ${c.detail}` : ''}`);
    }
    if (!connected) {
      console.log('\nIf the manifest is fine but nothing connects: make sure the extension is loaded');
      console.log(`(chrome://extensions, ID ${DEFAULT_EXTENSION_ID}) and restart the browser or reload the extension.`);
    }
  }
  return connected ? 0 : 1;
}

// --- entry point -----------------------------------------------------------

function parse(argv, options) {
  return parseArgs({ args: argv, options: { ...GLOBAL, ...options }, allowPositionals: true, strict: true });
}

export async function main(argv) {
  const [rawCmd, ...rest] = argv;
  if (!rawCmd || rawCmd === 'help' || rawCmd === '--help' || rawCmd === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (rawCmd === 'version' || rawCmd === '--version' || rawCmd === '-v') {
    console.log(VERSION);
    return 0;
  }
  const cmd = ALIASES[rawCmd] ?? rawCmd.replace(/_/g, '-');
  let json = rest.includes('--json');

  try {
    if (cmd === 'host') {
      const { runHost } = await import('./host.js');
      // Chrome passes the caller's origin (chrome-extension://<id>/) as the first argument.
      runHost({ origin: rest.find((a) => a.startsWith('chrome-extension://')) ?? null });
      return null;
    }
    if (cmd === 'mcp') {
      const { runMcp } = await import('./mcp.js');
      runMcp();
      return null;
    }
    if (cmd === 'install' || cmd === 'uninstall') {
      const { values: v } = parse(rest, {
        'extension-id': { type: 'string', multiple: true },
        browser: { type: 'string', multiple: true },
        'target-dir': { type: 'string', multiple: true },
        'dry-run': { type: 'boolean' },
      });
      cmd === 'install' ? cmdInstall(v) : cmdUninstall(v);
      return 0;
    }
    if (cmd === 'status') {
      const { values: v } = parse(rest, {});
      await cmdStatus(v);
      return 0;
    }
    if (cmd === 'doctor') {
      const { values: v } = parse(rest, { 'target-dir': { type: 'string', multiple: true } });
      return await cmdDoctor(v);
    }

    const spec = TAB_COMMANDS[cmd];
    if (!spec) throw new UsageError(`unknown command "${rawCmd}". Run \`grok-tabs help\`.`);
    const { values: v, positionals } = parse(rest, spec.options);
    json = Boolean(v.json);
    if (v.help) {
      console.log(USAGE);
      return 0;
    }
    let params;
    try {
      params = validateParams(spec.op, spec.params(positionals, v));
    } catch (err) {
      throw err instanceof UsageError ? err : new UsageError(err.message);
    }
    const result = await call(spec.op, params, { socket: v.socket, timeoutMs: optInt(v.timeout, '--timeout') });
    console.log(json ? JSON.stringify(result, null, 2) : formatResult(spec.op, result));
    return 0;
  } catch (err) {
    const code = err instanceof NotConnectedError ? 3 : err instanceof UsageError || err.code?.startsWith?.('ERR_PARSE_ARGS') ? 2 : 1;
    const message = err.message.startsWith('grok-tabs:') ? err.message : `grok-tabs: ${err.message}`;
    if (json) console.log(JSON.stringify({ error: { code: err.code ?? 'EUSAGE', message } }, null, 2));
    console.error(message);
    return code;
  }
}
