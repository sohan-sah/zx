import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';
import { env } from '../env.js';
import { createR2Client, createB2Client } from '../storage.js';
import { HashingPassThrough, hashReadable } from '../hashing.js';
import {
  extendJobLock,
  fetchVideoForBackup,
  markBackupFailed,
  markBackupVerified,
  writeWorkerAuditEvent,
  type VideoJobRow,
} from '../db.js';

export class BackupJobError extends Error {}

function asNodeReadable(body: unknown): Readable {
  // In the Node.js runtime (this worker), @aws-sdk/client-s3's GetObjectCommand response Body is a
  // Node Readable stream. This guards against silently mis-handling the web-stream variant the SDK
  // can also produce in edge/browser runtimes, which does not apply here but is worth failing loudly
  // on rather than assuming.
  if (body && typeof (body as Readable).pipe === 'function') {
    return body as Readable;
  }
  throw new BackupJobError('R2 GetObject did not return a Node.js Readable stream in this runtime');
}

/**
 * Handles one backup_video job:
 *   1. Stream the primary object from R2 straight into a B2 upload, hashing the R2 side while it
 *      flows through (never buffering the whole file).
 *   2. Re-read the just-written B2 object and hash it independently (catches corruption introduced
 *      by the upload/storage step itself, not just a hash computed once and assumed to still apply).
 *   3. Mark the backup verified ONLY if both hashes match exactly.
 * Periodically extends the job's lock so a multi-hour transfer of a 6-hour video doesn't get reaped
 * as a crashed job by another worker instance.
 */
export async function handleBackupVideo(job: VideoJobRow): Promise<void> {
  if (!job.video_id) throw new BackupJobError('backup_video job has no video_id');

  const video = await fetchVideoForBackup(job.video_id);
  if (!video) throw new BackupJobError(`video ${job.video_id} not found`);
  if (!video.primary_object_key) throw new BackupJobError(`video ${job.video_id} has no primary_object_key`);

  await writeWorkerAuditEvent({ eventType: 'backup_started', videoId: job.video_id });

  const lockExtendInterval = setInterval(() => {
    void extendJobLock(job.id);
  }, Math.max(1, env.WORKER_LOCK_SECONDS - env.WORKER_LOCK_EXTEND_MARGIN_SECONDS) * 1000);

  try {
    const r2 = createR2Client();
    const b2 = createB2Client();
    const key = video.primary_object_key;

    // --- Step 1: stream R2 -> B2, hashing the source side in transit ---
    const getResult = await r2.send(new GetObjectCommand({ Bucket: env.WORKER_R2_BUCKET, Key: key }));
    const sourceStream = asNodeReadable(getResult.Body);
    const hasher = new HashingPassThrough();
    sourceStream.pipe(hasher);

    const upload = new Upload({
      client: b2,
      params: {
        Bucket: env.B2_BACKUP_BUCKET,
        Key: key,
        Body: hasher,
        ContentType: getResult.ContentType,
      },
      // Keep part size/queueing modest and predictable rather than the library's more aggressive
      // defaults, since this worker may run with limited memory on a small Railway instance.
      partSize: 64 * 1024 * 1024,
      queueSize: 2,
    });

    const uploadResult = await upload.done();
    const sourceSha256 = hasher.digestHex();

    // --- Step 2: re-read the B2 copy and hash it independently ---
    const b2GetResult = await b2.send(new GetObjectCommand({ Bucket: env.B2_BACKUP_BUCKET, Key: key }));
    const { sha256: backupSha256 } = await hashReadable(asNodeReadable(b2GetResult.Body));

    // --- Step 3: verify ---
    if (sourceSha256 !== backupSha256) {
      const message = `sha256 mismatch: source=${sourceSha256} backup=${backupSha256}`;
      await markBackupFailed(job.video_id, 'mismatch', message);
      await writeWorkerAuditEvent({ eventType: 'backup_failed', videoId: job.video_id, details: { reason: 'hash_mismatch' } });
      throw new BackupJobError(message);
    }

    await markBackupVerified({
      videoId: job.video_id,
      sha256: sourceSha256,
      backupObjectKey: key,
      backupVersionId: uploadResult.VersionId ?? null,
      backupSha256,
    });
    await writeWorkerAuditEvent({ eventType: 'backup_verified', videoId: job.video_id });
  } catch (err) {
    if (!(err instanceof BackupJobError)) {
      // Only reachable for errors before the explicit mismatch handling above (e.g. R2/B2 network
      // failures) — those haven't written backup_error yet, so record a generic, secret-free message.
      const message = err instanceof Error ? err.message : 'unknown error during backup';
      await markBackupFailed(job.video_id, 'failed', message).catch(() => {});
      await writeWorkerAuditEvent({ eventType: 'backup_failed', videoId: job.video_id, details: { reason: 'error' } }).catch(() => {});
    }
    throw err;
  } finally {
    clearInterval(lockExtendInterval);
  }
}
