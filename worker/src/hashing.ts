import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';

/**
 * A pass-through Transform that computes a SHA-256 of everything flowing through it while forwarding
 * every chunk unchanged, so it can sit inline in a pipe (e.g. R2 GetObject -> HashingPassThrough ->
 * B2 Upload) without buffering the object — memory use stays bounded by the stream's chunk size,
 * not the file size, regardless of whether this is a 200 MB or 6-hour 20 GB video.
 */
export class HashingPassThrough extends Transform {
  private readonly hash = createHash('sha256');
  private bytes = 0;

  _transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    callback(null, chunk);
  }

  digestHex(): string {
    return this.hash.digest('hex');
  }

  get bytesSeen(): number {
    return this.bytes;
  }
}

/** Consumes a readable stream purely to compute its SHA-256 (used to independently re-hash the B2
 * copy after upload, rather than trusting the hash computed while uploading it). */
export async function hashReadable(stream: Readable): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    hash.update(buf);
    bytes += buf.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}
