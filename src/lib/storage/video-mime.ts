/** Whitelisted video MIME types and the extension each maps to. This mapping is the ONLY source of
 * a file extension ever used to build an R2 object key — user-supplied filenames are never used for
 * that purpose (see object-key.ts), which is what makes path traversal via a crafted filename
 * impossible regardless of what a client sends.
 */
export const ALLOWED_VIDEO_MIME_TO_EXT: Readonly<Record<string, string>> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
};

export const ALLOWED_THUMBNAIL_MIME_TO_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function extensionForVideoMime(mimeType: string): string | null {
  return ALLOWED_VIDEO_MIME_TO_EXT[mimeType] ?? null;
}

export function extensionForThumbnailMime(mimeType: string): string | null {
  return ALLOWED_THUMBNAIL_MIME_TO_EXT[mimeType] ?? null;
}
