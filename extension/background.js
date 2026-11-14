// grok-tabs service worker.
//
// Opens a native messaging port to the local host and answers requests by
// calling chrome.tabs / chrome.tabGroups / chrome.windows. An open native port
// keeps the service worker alive (Chrome 105+); if it drops we reconnect with
// exponential backoff. If the worker is terminated anyway, it reconnects the
// next time Chrome starts it (browser startup, install, or a tab event).

const HOST_NAME = 'com.grokbot.tabs';
const VERSION = chrome.runtime.getManifest().version;
const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;

let port = null;
let backoffMs = MIN_BACKOFF_MS;
let reconnectTimer = null;

function connect() {
  if (port) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    console.warn('grok-tabs: connectNative failed:', err);
    scheduleReconnect();
    return;
  }
  const connectedAt = Date.now();
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || 'disconnected';
    console.warn('grok-tabs: native host disconnected:', reason);
    port = null;
    // A port that stayed up for a while was healthy; start backoff over.
    if (Date.now() - connectedAt > 10000) backoffMs = MIN_BACKOFF_MS;
    scheduleReconnect();
  });
  port.postMessage({ type: 'hello', version: VERSION, userAgent: navigator.userAgent });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

async function onMessage(msg) {
  if (!msg || msg.id === undefined) return;
  let reply;
  try {
    const handler = HANDLERS[msg.method];
    if (!handler) throw new Error(`unknown method "${msg.method}"`);
    reply = { id: msg.id, result: await handler(msg.params || {}) };
  } catch (err) {
    reply = { id: msg.id, error: { message: String(err?.message || err) } };
  }
  port?.postMessage(reply);
}

// --- helpers ---------------------------------------------------------------

function ids(value, name) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(Number.isInteger)) {
    throw new Error(`${name} must be a non-empty array of integers`);
  }
  return value;
}

function int(value, name) {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function groupProps(params) {
  const props = {};
  if (params.title !== undefined) props.title = String(params.title);
  if (params.color !== undefined) {
    if (!COLORS.includes(params.color)) throw new Error(`color must be one of: ${COLORS.join(', ')}`);
    props.color = params.color;
  }
  if (params.collapsed !== undefined) props.collapsed = Boolean(params.collapsed);
  return props;
}

function allowedUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.href === 'about:blank') return parsed.href;
  throw new Error(`refusing to open ${parsed.protocol} URL; only http, https and about:blank are allowed`);
}

function tabInfo(tab, groups) {
  const group = tab.groupId >= 0 ? groups.get(tab.groupId) : null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title,
    url: tab.url || tab.pendingUrl,
    active: tab.active,
    pinned: tab.pinned,
    groupId: tab.groupId,
    groupTitle: group ? group.title : null,
    groupColor: group ? group.color : null,
  };
}

function groupInfo(group, tabs) {
  return {
    id: group.id,
    title: group.title,
    color: group.color,
    collapsed: group.collapsed,
    windowId: group.windowId,
    tabIds: tabs.filter((t) => t.groupId === group.id).map((t) => t.id),
  };
}

async function groupMap() {
  return new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
}

async function describeGroup(groupId) {
  const [group, tabs] = await Promise.all([chrome.tabGroups.get(groupId), chrome.tabs.query({})]);
  return groupInfo(group, tabs);
}

async function getTabs(tabIds) {
  const groups = await groupMap();
  return Promise.all(tabIds.map(async (id) => {
    try {
      return tabInfo(await chrome.tabs.get(id), groups);
    } catch {
      throw new Error(`no tab with id ${id}`);
    }
  }));
}

// --- operations ------------------------------------------------------------

const HANDLERS = {
  async ping() {
    return { pong: true, version: VERSION, userAgent: navigator.userAgent };
  },

  async list_tabs(params) {
    const query = params.windowId !== undefined ? { windowId: int(params.windowId, 'windowId') } : {};
    const [tabs, groups] = await Promise.all([chrome.tabs.query(query), groupMap()]);
    tabs.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    return { tabs: tabs.map((t) => tabInfo(t, groups)) };
  },

  async list_groups() {
    const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);
    return { groups: groups.map((g) => groupInfo(g, tabs)) };
  },

  async group_tabs(params) {
    const options = { tabIds: ids(params.tabIds, 'tabIds') };
    if (params.groupId !== undefined) options.groupId = int(params.groupId, 'groupId');
    const props = groupProps(params);
    const groupId = await chrome.tabs.group(options);
    if (Object.keys(props).length) await chrome.tabGroups.update(groupId, props);
    return { group: await describeGroup(groupId) };
  },

  async update_group(params) {
    const groupId = int(params.groupId, 'groupId');
    const props = groupProps(params);
    if (!Object.keys(props).length) throw new Error('nothing to update: pass title, color or collapsed');
    await chrome.tabGroups.update(groupId, props);
    return { group: await describeGroup(groupId) };
  },

  async ungroup(params) {
    const tabIds = ids(params.tabIds, 'tabIds');
    await chrome.tabs.ungroup(tabIds);
    return { tabs: await getTabs(tabIds) };
  },

  async move_tabs(params) {
    const tabIds = ids(params.tabIds, 'tabIds');
    const props = { index: int(params.index, 'index') };
    if (params.windowId !== undefined) props.windowId = int(params.windowId, 'windowId');
    await chrome.tabs.move(tabIds, props);
    return { tabs: await getTabs(tabIds) };
  },

  async open_url(params) {
    const props = { url: allowedUrl(params.url), active: params.active !== false };
    if (params.windowId !== undefined) props.windowId = int(params.windowId, 'windowId');
    const tab = await chrome.tabs.create(props);
    if (params.groupId !== undefined) {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: int(params.groupId, 'groupId') });
    }
    return { tab: (await getTabs([tab.id]))[0] };
  },

  async focus_tab(params) {
    const tab = await chrome.tabs.update(int(params.tabId, 'tabId'), { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { tab: (await getTabs([tab.id]))[0] };
  },

  // Enforced here as well as in the CLI/MCP layer: any client of the local
  // socket gets a dry run unless it explicitly sends confirm: true.
  async close_tabs(params) {
    const tabs = await getTabs(ids(params.tabIds, 'tabIds'));
    if (params.confirm !== true) return { dryRun: true, wouldClose: tabs };
    await chrome.tabs.remove(tabs.map((t) => t.id));
    return { dryRun: false, closed: tabs };
  },
};

// --- lifecycle -------------------------------------------------------------

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// Tab events wake a terminated worker, giving it another chance to connect.
chrome.tabs.onCreated.addListener(connect);
chrome.tabs.onActivated.addListener(connect);
connect();
