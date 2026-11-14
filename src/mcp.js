// MCP server over stdio: newline-delimited JSON-RPC 2.0, written by hand to
// keep zero runtime dependencies. Implements initialize, ping, tools/list and
// tools/call; each tool call opens a fresh connection to the native host so a
// browser restart between calls is handled transparently.
import { call as defaultCall } from './client.js';
import { VERSION } from './constants.js';
import { LineDecoder } from './framing.js';
import { OPERATIONS, OPERATIONS_BY_NAME, validateParams } from './ops.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  'agent-tabs manages the tabs and tab groups of the user\'s running Chrome. Tab and group IDs come from ' +
  'list_tabs / list_groups and change when the browser restarts. close_tabs is a dry run unless confirm is true: ' +
  'show the preview to the user and only confirm when they agree.';

function toolResult(name, result) {
  let summary = '';
  if (name === 'close_tabs' && result?.dryRun) {
    summary = `Dry run: nothing was closed. ${result.wouldClose.length} tab(s) would close. ` +
      'Call close_tabs again with confirm: true to close them.\n';
  }
  return {
    content: [{ type: 'text', text: summary + JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

export function createMcpServer({ write, call = defaultCall }) {
  const send = (msg) => write(JSON.stringify(msg) + '\n');
  const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const methods = {
    initialize(params) {
      const requested = params?.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-tabs', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    },
    ping() {
      return {};
    },
    'tools/list'() {
      return {
        tools: OPERATIONS.map((op) => ({
          name: op.name,
          description: op.description,
          inputSchema: op.inputSchema,
          ...(op.annotations ? { annotations: op.annotations } : {}),
        })),
      };
    },
    async 'tools/call'(params) {
      const name = params?.name;
      if (!OPERATIONS_BY_NAME.has(name)) {
        const err = new Error(`unknown tool "${name}"`);
        err.rpcCode = -32602;
        throw err;
      }
      try {
        const args = validateParams(name, params.arguments ?? {});
        return toolResult(name, await call(name, args));
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
    },
  };

  async function handle(msg) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
      return fail(msg?.id ?? null, -32600, 'invalid request');
    }
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (!isRequest) return; // notifications (initialized, cancelled, ...) need no answer
    const method = methods[msg.method];
    if (!method) return fail(msg.id, -32601, `method not found: ${msg.method}`);
    try {
      respond(msg.id, await method(msg.params));
    } catch (err) {
      fail(msg.id, err.rpcCode ?? -32603, err.message);
    }
  }

  return { handle };
}

export function runMcp({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const server = createMcpServer({ write: (s) => stdout.write(s) });
  const decoder = new LineDecoder((msg) => server.handle(msg), {
    onError: () => stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'),
  });
  // When stdin ends the process exits on its own once in-flight calls finish.
  stdin.on('data', (chunk) => decoder.push(chunk));
}
