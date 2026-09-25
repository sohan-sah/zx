import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { HashingPassThrough, hashReadable } from '../hashing.js';

function randomBuffer(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

describe('HashingPassThrough', () => {
  it('produces the same SHA-256 as computing it directly over the same bytes', async () => {
    const data = randomBuffer(1024 * 1024 + 37); // not a round chunk boundary on purpose
    const expected = createHash('sha256').update(data).digest('hex');

    const hasher = new HashingPassThrough();
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(c));

    await pipeline(Readable.from([data]), hasher, sink);

    expect(hasher.digestHex()).toBe(expected);
    expect(Buffer.concat(chunks).equals(data)).toBe(true); // pass-through must not alter the bytes
    expect(hasher.bytesSeen).toBe(data.length);
  });

  it('handles being fed many small chunks the same as one big buffer', async () => {
    const chunks = [randomBuffer(1000), randomBuffer(2000), randomBuffer(500)];
    const whole = Buffer.concat(chunks);
    const expected = createHash('sha256').update(whole).digest('hex');

    const hasher = new HashingPassThrough();
    const sink = new PassThrough();
    sink.resume();
    await pipeline(Readable.from(chunks), hasher, sink);

    expect(hasher.digestHex()).toBe(expected);
  });
});

describe('hashReadable', () => {
  it('matches a direct hash of the same bytes and reports the correct length', async () => {
    const data = randomBuffer(500_000);
    const expected = createHash('sha256').update(data).digest('hex');

    const { sha256, bytes } = await hashReadable(Readable.from([data]));

    expect(sha256).toBe(expected);
    expect(bytes).toBe(data.length);
  });

  it('produces different hashes for different content (sanity check against a trivial always-pass bug)', async () => {
    const a = await hashReadable(Readable.from([Buffer.from('hello')]));
    const b = await hashReadable(Readable.from([Buffer.from('world')]));
    expect(a.sha256).not.toBe(b.sha256);
  });
});
