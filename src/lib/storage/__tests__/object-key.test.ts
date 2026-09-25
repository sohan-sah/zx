import { describe, expect, it } from 'vitest';
import { primaryObjectKey, thumbnailObjectKey } from '../object-key';

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('primaryObjectKey', () => {
  it('builds the expected deterministic key for a valid UUID + whitelisted mime type', () => {
    expect(primaryObjectKey(VALID_UUID, 'video/mp4')).toBe(`videos/${VALID_UUID}/master.mp4`);
    expect(primaryObjectKey(VALID_UUID, 'video/quicktime')).toBe(`videos/${VALID_UUID}/master.mov`);
  });

  it('rejects a non-UUID videoId, including path-traversal attempts', () => {
    for (const bad of ['../../etc/passwd', '../other-video', 'not-a-uuid', '', VALID_UUID + '/../x']) {
      expect(() => primaryObjectKey(bad, 'video/mp4')).toThrow();
    }
  });

  it('rejects an unwhitelisted mime type, however it is spelled', () => {
    for (const bad of ['video/mp4; charset=binary', 'application/octet-stream', 'text/html', '']) {
      expect(() => primaryObjectKey(VALID_UUID, bad)).toThrow();
    }
  });

  it('never lets the mime type string leak directly into the key', () => {
    // If mimeType were ever used as a raw string instead of a whitelist lookup, this would produce
    // a key containing "../" — assert that never happens even for a deliberately hostile input.
    expect(() => primaryObjectKey(VALID_UUID, '../../evil')).toThrow();
  });
});

describe('thumbnailObjectKey', () => {
  it('builds a key under thumbnails/<uuid>/ with a random filename', () => {
    const key = thumbnailObjectKey(VALID_UUID, 'image/jpeg');
    expect(key).toMatch(new RegExp(`^thumbnails/${VALID_UUID}/[0-9a-f-]+\\.jpg$`));
  });

  it('produces a different filename on each call (no collisions across uploads)', () => {
    const a = thumbnailObjectKey(VALID_UUID, 'image/png');
    const b = thumbnailObjectKey(VALID_UUID, 'image/png');
    expect(a).not.toBe(b);
  });

  it('rejects a non-UUID videoId and an unwhitelisted mime type', () => {
    expect(() => thumbnailObjectKey('../x', 'image/png')).toThrow();
    expect(() => thumbnailObjectKey(VALID_UUID, 'image/gif')).toThrow();
  });
});
