// Tab operations: one table shared by the CLI and the MCP server. Each entry
// has an MCP tool description and a JSON Schema for its parameters; params are
// validated here before anything is sent to the browser (the extension
// re-checks the essentials).
import { TAB_GROUP_COLORS } from './constants.js';

const id = { type: 'integer', minimum: 0 };
const idList = (description) => ({ type: 'array', items: id, minItems: 1, description });
const color = { type: 'string', enum: TAB_GROUP_COLORS };

export const OPERATIONS = [
  {
    name: 'list_tabs',
    description: 'List open tabs in all windows (or one window) with id, windowId, index, title, url, active, pinned and tab group.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { windowId: { ...id, description: 'Only list tabs in this window.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_groups',
    description: 'List tab groups with id, title, color, collapsed, windowId and member tabIds.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'group_tabs',
    description: 'Group tabs into a new group, or add them to an existing group (groupId). Optionally set title, color and collapsed.',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: idList('Tabs to group.'),
        groupId: { ...id, description: 'Existing group to add the tabs to.' },
        title: { type: 'string' },
        color,
        collapsed: { type: 'boolean' },
      },
      required: ['tabIds'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_group',
    description: 'Rename, recolor, collapse or expand a tab group.',
    inputSchema: {
      type: 'object',
      properties: { groupId: id, title: { type: 'string' }, color, collapsed: { type: 'boolean' } },
      required: ['groupId'],
      additionalProperties: false,
    },
  },
  {
    name: 'ungroup',
    description: 'Remove tabs from whatever group they are in. The tabs stay open.',
    inputSchema: {
      type: 'object',
      properties: { tabIds: idList('Tabs to ungroup.') },
      required: ['tabIds'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_tabs',
    description: 'Move tabs to a position (index, -1 for the end), optionally into another window.',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: idList('Tabs to move, in order.'),
        index: { type: 'integer', minimum: -1 },
        windowId: id,
      },
      required: ['tabIds', 'index'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_url',
    description: 'Open a URL in a new tab. Only http(s) URLs and about:blank are allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        active: { type: 'boolean', description: 'Focus the new tab (default true).' },
        windowId: id,
        groupId: { ...id, description: 'Add the new tab to this group.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'focus_tab',
    description: 'Activate a tab and focus its window.',
    inputSchema: {
      type: 'object',
      properties: { tabId: id },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_tabs',
    description:
      'Close tabs. Without confirm: true this is a dry run that only returns the tabs that would be closed. ' +
      'Show the preview to the user before confirming.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: idList('Tabs to close.'),
        confirm: { type: 'boolean', description: 'Must be true to actually close the tabs.' },
      },
      required: ['tabIds'],
      additionalProperties: false,
    },
  },
];

export const OPERATIONS_BY_NAME = new Map(OPERATIONS.map((op) => [op.name, op]));

export function checkUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  if (parsed.href === 'about:blank') return parsed.href;
  throw new Error(`refusing to open ${parsed.protocol} URL; only http, https and about:blank are allowed`);
}

// Minimal JSON Schema check covering the keywords used above.
function check(schema, value, where) {
  const t = schema.type;
  if (t === 'integer' && !Number.isInteger(value)) throw new Error(`${where} must be an integer`);
  if (t === 'string' && typeof value !== 'string') throw new Error(`${where} must be a string`);
  if (t === 'boolean' && typeof value !== 'boolean') throw new Error(`${where} must be a boolean`);
  if (t === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new Error(`${where} must be an object`);
  }
  if (t === 'array') {
    if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
    if (schema.minItems && value.length < schema.minItems) throw new Error(`${where} must not be empty`);
    value.forEach((v, i) => check(schema.items, v, `${where}[${i}]`));
  }
  if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${where} must be >= ${schema.minimum}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${where} must be one of: ${schema.enum.join(', ')}`);
  if (t === 'object') {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) throw new Error(`missing required parameter "${key}"`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (!sub) {
        if (schema.additionalProperties === false) throw new Error(`unknown parameter "${key}"`);
        continue;
      }
      if (v !== undefined) check(sub, v, key);
    }
  }
}

export function validateParams(name, params = {}) {
  const op = OPERATIONS_BY_NAME.get(name);
  if (!op) throw new Error(`unknown operation "${name}"`);
  const clean = Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v !== undefined));
  check(op.inputSchema, clean, 'params');
  if (name === 'open_url') clean.url = checkUrl(clean.url);
  return clean;
}
