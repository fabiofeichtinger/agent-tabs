// Native messaging host. Chrome starts this process when the extension calls
// chrome.runtime.connectNative(); it lives exactly as long as that port.
//
//   Chrome (stdin/stdout, length-prefixed JSON)  <->  host  <->  Unix socket clients
//
// stdout is reserved for native messages; all logging goes to stderr, which
// Chrome forwards to its own log.
import fs from 'node:fs';
import net from 'node:net';
import { VERSION } from './constants.js';
import { FramingError, LineDecoder, NativeDecoder, encodeLine, encodeNative } from './framing.js';
import { ensurePrivateDir, runDir, socketPathFor } from './paths.js';

const REQUEST_TIMEOUT_MS = 30000;

function log(...args) {
  process.stderr.write(`[grok-tabs host ${process.pid}] ${args.join(' ')}\n`);
}

export function runHost({ origin = null, stdin = process.stdin, stdout = process.stdout } = {}) {
  const socketPath = socketPathFor();
  const startedAt = new Date().toISOString();
  let extensionInfo = null;
  let nextId = 1;
  const inflight = new Map(); // host id -> { sock, clientId, timer }
  let closing = false;

  ensurePrivateDir(runDir());
  try { fs.unlinkSync(socketPath); } catch {}

  function shutdown(code = 0, reason = '') {
    if (closing) return;
    closing = true;
    if (reason) log('shutting down:', reason);
    try { fs.unlinkSync(socketPath); } catch {}
    server.close();
    for (const { sock } of inflight.values()) sock.destroy();
    process.exit(code);
  }

  function toExtension(msg) {
    stdout.write(encodeNative(msg));
  }

  function reply(sock, id, payload) {
    if (!sock.destroyed) sock.write(encodeLine({ id, ...payload }));
  }

  function handleClientMessage(sock, msg) {
    const { id, method, params } = msg ?? {};
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof method !== 'string') {
      return reply(sock, id ?? null, { error: { code: 'EINVAL', message: 'request needs "id" and "method"' } });
    }
    if (method === 'host.status') {
      return reply(sock, id, {
        result: { connected: true, hostVersion: VERSION, pid: process.pid, socket: socketPath, origin, startedAt, extension: extensionInfo },
      });
    }
    const hostId = nextId++;
    try {
      toExtension({ id: hostId, method, params: params ?? {} });
    } catch (err) {
      return reply(sock, id, { error: { code: err instanceof FramingError ? 'ETOOBIG' : 'EIO', message: err.message } });
    }
    const timer = setTimeout(() => {
      inflight.delete(hostId);
      reply(sock, id, { error: { code: 'ETIMEDOUT', message: `extension did not answer "${method}" within ${REQUEST_TIMEOUT_MS} ms` } });
    }, REQUEST_TIMEOUT_MS);
    inflight.set(hostId, { sock, clientId: id, timer });
  }

  function handleExtensionMessage(msg) {
    if (msg?.type === 'hello') {
      extensionInfo = { version: msg.version, userAgent: msg.userAgent, connectedAt: new Date().toISOString() };
      log('extension connected', msg.version || '');
      return;
    }
    const entry = inflight.get(msg?.id);
    if (!entry) return;
    inflight.delete(msg.id);
    clearTimeout(entry.timer);
    reply(entry.sock, entry.clientId, msg.error ? { error: msg.error } : { result: msg.result });
  }

  const server = net.createServer((sock) => {
    const decoder = new LineDecoder((msg) => handleClientMessage(sock, msg), {
      onError: (err) => reply(sock, null, { error: { code: 'EPARSE', message: err.message } }),
    });
    sock.on('data', (chunk) => decoder.push(chunk));
    sock.on('error', () => {});
    sock.on('close', () => {
      for (const [hostId, entry] of inflight) {
        if (entry.sock === sock) {
          clearTimeout(entry.timer);
          inflight.delete(hostId);
        }
      }
    });
  });

  server.on('error', (err) => shutdown(1, `socket server error: ${err.message}`));
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    log('listening on', socketPath);
  });

  const decoder = new NativeDecoder(handleExtensionMessage);
  stdin.on('data', (chunk) => {
    try {
      decoder.push(chunk);
    } catch (err) {
      shutdown(1, err.message);
    }
  });
  // Chrome closes our stdin when the extension's port disconnects (or Chrome exits).
  stdin.on('end', () => shutdown(0, 'stdin closed'));
  stdin.on('close', () => shutdown(0, 'stdin closed'));
  stdout.on('error', (err) => shutdown(0, `stdout ${err.code || err.message}`));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(0, sig));
  process.on('uncaughtException', (err) => shutdown(1, err.stack || err.message));
}
