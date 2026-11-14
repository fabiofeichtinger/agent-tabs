// Message framing.
//
// Native messaging (Chrome <-> host): each message is a 32-bit length in
// native byte order followed by UTF-8 JSON. Every platform Chrome supports is
// little-endian, so we read/write UInt32LE.
//
// Local socket (CLI/MCP <-> host): newline-delimited JSON. JSON.stringify never
// emits a raw newline, so "\n" is a safe delimiter.

import { StringDecoder } from 'node:string_decoder';
import { MAX_FROM_EXTENSION, MAX_TO_EXTENSION } from './constants.js';

export class FramingError extends Error {}

export function encodeNative(message, maxBytes = MAX_TO_EXTENSION) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > maxBytes) {
    throw new FramingError(`message of ${body.length} bytes exceeds limit of ${maxBytes} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Incremental decoder: feed it arbitrary chunks, it calls onMessage once per
// complete frame. Handles split headers, split bodies and many frames per chunk.
export class NativeDecoder {
  constructor(onMessage, { maxBytes = MAX_FROM_EXTENSION } = {}) {
    this.onMessage = onMessage;
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.buffered = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    for (;;) {
      if (this.buffered < 4) return;
      const head = this.#peek(4);
      const length = head.readUInt32LE(0);
      if (length > this.maxBytes) {
        throw new FramingError(`incoming message of ${length} bytes exceeds limit of ${this.maxBytes} bytes`);
      }
      if (this.buffered < 4 + length) return;
      const frame = this.#take(4 + length);
      let message;
      try {
        message = JSON.parse(frame.subarray(4).toString('utf8'));
      } catch (err) {
        throw new FramingError(`invalid JSON in native message: ${err.message}`);
      }
      this.onMessage(message);
    }
  }

  get pending() {
    return this.buffered;
  }

  #peek(n) {
    if (this.chunks[0].length >= n) return this.chunks[0];
    this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0];
  }

  #take(n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }
}

export function encodeLine(message) {
  return JSON.stringify(message) + '\n';
}

// Newline-delimited JSON decoder. Malformed lines are reported via onError so a
// single bad client line does not tear down the connection.
export class LineDecoder {
  constructor(onMessage, { onError = (err) => { throw err; }, maxBytes = MAX_FROM_EXTENSION } = {}) {
    this.onMessage = onMessage;
    this.onError = onError;
    this.maxBytes = maxBytes;
    this.buffer = '';
    // StringDecoder keeps multi-byte UTF-8 sequences intact across chunks.
    this.text = new StringDecoder('utf8');
  }

  push(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : this.text.write(chunk);
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        this.onError(new FramingError(`invalid JSON line: ${err.message}`), line);
        continue;
      }
      this.onMessage(message);
    }
    if (this.buffer.length > this.maxBytes) {
      this.buffer = '';
      this.onError(new FramingError('line exceeds maximum length'));
    }
  }
}
