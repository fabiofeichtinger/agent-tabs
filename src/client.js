// Client side of the local socket: used by the CLI and the MCP server to talk
// to the native host, which relays to the extension.
import fs from 'node:fs';
import net from 'node:net';
import { DEFAULT_TIMEOUT_MS, NOT_CONNECTED_MESSAGE } from './constants.js';
import { LineDecoder, encodeLine } from './framing.js';
import { listSockets } from './paths.js';

export class NotConnectedError extends Error {
  constructor(detail) {
    super(NOT_CONNECTED_MESSAGE);
    this.code = 'ENOTCONNECTED';
    this.detail = detail;
  }
}

export class RemoteError extends Error {
  constructor(error) {
    super(error?.message || 'unknown error');
    this.code = error?.code || 'EREMOTE';
  }
}

function openSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    sock.once('connect', () => {
      sock.removeListener('error', reject);
      resolve(sock);
    });
    sock.once('error', reject);
  });
}

export class Connection {
  constructor(sock, socketPath) {
    this.sock = sock;
    this.socketPath = socketPath;
    this.nextId = 1;
    this.pending = new Map();
    const decoder = new LineDecoder((msg) => this.#onMessage(msg), { onError: () => {} });
    sock.on('data', (chunk) => decoder.push(chunk));
    sock.on('error', () => {});
    sock.on('close', () => this.#failAll(new NotConnectedError('host closed the connection')));
  }

  request(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agent-tabs: request "${method}" timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(encodeLine({ id, method, params }));
    });
  }

  close() {
    this.sock.end();
    this.sock.destroy();
  }

  #onMessage(msg) {
    const entry = this.pending.get(msg?.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new RemoteError(msg.error));
    else entry.resolve(msg.result);
  }

  #failAll(err) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}

// Connect to an explicit socket (--socket / AGENT_TABS_SOCKET) or to the most
// recently started host. Sockets nobody listens on are left over from crashed
// hosts and get removed.
export async function connect({ socket = process.env.AGENT_TABS_SOCKET } = {}) {
  const candidates = socket ? [socket] : listSockets();
  let lastErr;
  for (const p of candidates) {
    try {
      return new Connection(await openSocket(p), p);
    } catch (err) {
      lastErr = err;
      if (err.code === 'ECONNREFUSED' && !socket) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  }
  throw new NotConnectedError(lastErr ? `${lastErr.code || lastErr.message}` : 'no socket found');
}

// One-shot helper: connect, send one request, disconnect.
export async function call(method, params = {}, opts = {}) {
  const conn = await connect(opts);
  try {
    return await conn.request(method, params, opts);
  } finally {
    conn.close();
  }
}
