import { randomUUID } from 'node:crypto';
import { extensionForVideoMime, extensionForThumbnailMime } from './video-mime';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds the R2 key for a video's master file: `videos/<video-id>/master.<ext>`.
 *
 * Path traversal / arbitrary key injection is prevented structurally, not by sanitization: the only
 * two inputs are `videoId` (a server-generated UUID, validated against the UUID shape below — it is
 * never taken from a client-supplied string that could contain `../` or similar) and `mimeType`
 * (looked up in a fixed whitelist, never used as a raw string). The client-supplied filename is
 * stored only for display/audit (see the upload init route) and never touches this function.
 */
export function primaryObjectKey(videoId: string, mimeType: string): string {
  if (!UUID_RE.test(videoId)) {
    throw new Error('primaryObjectKey: videoId must be a UUID');
  }
  const ext = extensionForVideoMime(mimeType);
  if (!ext) {
    throw new Error('primaryObjectKey: unsupported mime type');
  }
  return `videos/${videoId}/master.${ext}`;
}

/** Same structural guarantee as primaryObjectKey: videoId must be a UUID, extension comes only from
 * the image whitelist, and a fresh random UUID (never client input) makes the filename component. */
export function thumbnailObjectKey(videoId: string, mimeType: string): string {
  if (!UUID_RE.test(videoId)) {
    throw new Error('thumbnailObjectKey: videoId must be a UUID');
  }
  const ext = extensionForThumbnailMime(mimeType);
  if (!ext) {
    throw new Error('thumbnailObjectKey: unsupported mime type');
  }
  return `thumbnails/${videoId}/${randomUUID()}.${ext}`;
}
