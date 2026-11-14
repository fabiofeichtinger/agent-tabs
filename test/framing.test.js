import assert from 'node:assert/strict';
import test from 'node:test';
import { FramingError, LineDecoder, NativeDecoder, encodeLine, encodeNative } from '../src/framing.js';

function collect(Decoder, opts) {
  const out = [];
  return { out, dec: new Decoder((m) => out.push(m), opts) };
}

test('encodeNative writes a 4-byte little-endian length prefix', () => {
  const buf = encodeNative({ a: 'é' });
  const body = Buffer.from('{"a":"é"}');
  assert.equal(buf.readUInt32LE(0), body.length);
  assert.deepEqual(buf.subarray(4), body);
});

test('round trip in a single chunk', () => {
  const { out, dec } = collect(NativeDecoder);
  dec.push(encodeNative({ id: 1, method: 'ping' }));
  assert.deepEqual(out, [{ id: 1, method: 'ping' }]);
  assert.equal(dec.pending, 0);
});

test('partial reads: one byte at a time, split header and body', () => {
  const { out, dec } = collect(NativeDecoder);
  const msgs = [{ id: 1, s: 'hello' }, { id: 2, s: 'ünïcødé ✓' }, { id: 3, list: [1, 2, 3] }];
  const bytes = Buffer.concat(msgs.map((m) => encodeNative(m)));
  for (const b of bytes) dec.push(Buffer.from([b]));
  assert.deepEqual(out, msgs);
});

test('many messages per chunk, with a trailing partial frame', () => {
  const { out, dec } = collect(NativeDecoder);
  const frames = Array.from({ length: 50 }, (_, i) => encodeNative({ i }));
  const all = Buffer.concat(frames);
  const cut = all.length - 3;
  dec.push(all.subarray(0, cut));
  assert.equal(out.length, 49);
  dec.push(all.subarray(cut));
  assert.equal(out.length, 50);
  assert.deepEqual(out.at(-1), { i: 49 });
});

test('random chunk boundaries', () => {
  const { out, dec } = collect(NativeDecoder);
  const msgs = Array.from({ length: 200 }, (_, i) => ({ i, pad: 'x'.repeat(i * 7) }));
  const all = Buffer.concat(msgs.map((m) => encodeNative(m)));
  let pos = 0;
  while (pos < all.length) {
    const n = 1 + Math.floor(Math.random() * 300);
    dec.push(all.subarray(pos, pos + n));
    pos += n;
  }
  assert.deepEqual(out, msgs);
});

test('outgoing messages over the 1 MB limit are rejected', () => {
  assert.throws(() => encodeNative({ s: 'x'.repeat(1024 * 1024) }), FramingError);
  assert.ok(encodeNative({ s: 'x'.repeat(1024 * 1024 - 20) }));
});

test('incoming frames over the limit are rejected before buffering the body', () => {
  const { dec } = collect(NativeDecoder, { maxBytes: 100 });
  const header = Buffer.alloc(4);
  header.writeUInt32LE(101, 0);
  assert.throws(() => dec.push(header), /exceeds limit/);
});

test('default incoming limit is 64 MB', () => {
  const { dec } = collect(NativeDecoder);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(64 * 1024 * 1024 + 1, 0);
  assert.throws(() => dec.push(header), /exceeds limit/);
});

test('invalid JSON in a native frame throws FramingError', () => {
  const { dec } = collect(NativeDecoder);
  const body = Buffer.from('{nope');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  assert.throws(() => dec.push(Buffer.concat([header, body])), FramingError);
});

test('LineDecoder handles split lines, multiple lines and split UTF-8', () => {
  const { out, dec } = collect(LineDecoder);
  const text = Buffer.from(encodeLine({ a: 1 }) + encodeLine({ b: '✓✓' }) + '\n' + encodeLine({ c: 3 }));
  for (let i = 0; i < text.length; i += 3) dec.push(text.subarray(i, i + 3));
  assert.deepEqual(out, [{ a: 1 }, { b: '✓✓' }, { c: 3 }]);
});

test('LineDecoder reports bad lines and keeps going', () => {
  const errors = [];
  const out = [];
  const dec = new LineDecoder((m) => out.push(m), { onError: (e) => errors.push(e) });
  dec.push('not json\n{"ok":true}\n');
  assert.equal(errors.length, 1);
  assert.deepEqual(out, [{ ok: true }]);
});
