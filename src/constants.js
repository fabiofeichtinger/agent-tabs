// Shared constants. Keep this file dependency-free: it is imported by the CLI,
// the MCP server and the native host.
import { readFileSync } from 'node:fs';

export const HOST_NAME = 'com.agenttabs.host';

// Derived from the public key in extension/manifest.json ("key"). A Chrome Web
// Store release gets its own ID, which must be added to allowed_origins.
export const DEFAULT_EXTENSION_ID = 'fafpncbnpnoipmnfnpcpaopookpogfii';

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export const NOT_CONNECTED_MESSAGE =
  'agent-tabs: Chrome extension not connected. Is Chrome running with the agent-tabs ' +
  'extension installed? Run `agent-tabs doctor`.';

// Chrome limits: 1 MB per message host -> extension, 64 MB extension -> host.
export const MAX_TO_EXTENSION = 1024 * 1024;
export const MAX_FROM_EXTENSION = 64 * 1024 * 1024;

export const TAB_GROUP_COLORS = [
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
];

export const DEFAULT_TIMEOUT_MS = 15000;
