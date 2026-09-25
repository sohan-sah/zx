// S3/R2 multipart limits: https://developers.cloudflare.com/r2/objects/multipart-objects/
export const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024; // 5 MiB minimum for every part except the last
export const MAX_PARTS = 10_000;
export const DEFAULT_PART_SIZE_BYTES = 64 * 1024 * 1024; // 64 MiB — a reasonable default for large video

// 100 GiB. A 6-hour video at a generous 1080p/4K bitrate (e.g. ~35 Mbps) is roughly 95 GiB, so this
// ceiling is sized around that, not around a lower "typical web video" assumption. Adjust here if
// the admin needs to upload higher-bitrate masters than this.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024 * 1024;

export class InvalidUploadSizeError extends Error {}

/**
 * Pure part-sizing math, no ceiling check — exported separately so its scaling behavior (the branch
 * that only matters once a file would need more than MAX_PARTS at the default part size) can be unit
 * tested directly. Under MAX_UPLOAD_BYTES as currently configured this branch is not reachable via
 * planMultipart() below (100 GiB / 64 MiB ≈ 1,600 parts, well under the 10,000 limit) — it exists so
 * the function stays correct if MAX_UPLOAD_BYTES is ever raised, without needing to revisit this math.
 */
export function computePartPlan(sizeBytes: number): { partSize: number; totalParts: number } {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new InvalidUploadSizeError('sizeBytes must be a positive number');
  }

  let partSize = DEFAULT_PART_SIZE_BYTES;
  let totalParts = Math.ceil(sizeBytes / partSize);

  if (totalParts > MAX_PARTS) {
    const rawPartSize = Math.ceil(sizeBytes / MAX_PARTS);
    partSize = Math.ceil(rawPartSize / MIN_PART_SIZE_BYTES) * MIN_PART_SIZE_BYTES;
    totalParts = Math.ceil(sizeBytes / partSize);
  }

  return { partSize, totalParts };
}

/** Public entry point: validates the size is within this deployment's configured ceiling, then
 * applies the part-sizing math above. */
export function planMultipart(sizeBytes: number): { partSize: number; totalParts: number } {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES) {
    throw new InvalidUploadSizeError(
      `sizeBytes must be a positive number no greater than ${MAX_UPLOAD_BYTES} bytes for this deployment`
    );
  }
  return computePartPlan(sizeBytes);
}
