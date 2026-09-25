import { env } from './env.js';
import { pool, claimNextJob, completeJob, failJob } from './db.js';
import { handleBackupVideo } from './jobs/backup-video.js';

// Slice 4 scope: only backup_video is handled. verify_backup, restore_video, transcode_hls and
// export_audit_log are reserved job types (already in the database enum, migration 0001) for later
// slices — claimNextJob only asks for types this worker actually knows how to process, so those
// other job types simply sit queued/untouched until a future worker version adds handlers for them.
const HANDLED_JOB_TYPES = ['backup_video'];

let shuttingDown = false;
let currentJobPromise: Promise<boolean> | null = null;

function sanitizeError(err: unknown): string {
  // Never let a raw error object (which could contain a connection string, a signed URL, or SDK
  // internals) reach the database — the audit-visible error field must never carry credentials.
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 2000);
}

async function runOnce(): Promise<boolean> {
  const job = await claimNextJob(HANDLED_JOB_TYPES);
  if (!job) return false;

  console.log(`[worker] claimed job ${job.id} (${job.type}), attempt ${job.attempts}/${job.max_attempts}`);

  try {
    switch (job.type) {
      case 'backup_video':
        await handleBackupVideo(job);
        break;
      default:
        throw new Error(`no handler for job type ${job.type}`);
    }
    await completeJob(job.id);
    console.log(`[worker] completed job ${job.id}`);
  } catch (err) {
    const status = await failJob(job.id, sanitizeError(err));
    console.error(`[worker] job ${job.id} failed (now ${status}):`, sanitizeError(err));
  }

  return true;
}

async function mainLoop() {
  console.log(`[worker] starting as ${env.WORKER_ID}, polling every ${env.WORKER_POLL_INTERVAL_SECONDS}s`);
  while (!shuttingDown) {
    let processed = false;
    try {
      currentJobPromise = runOnce();
      processed = await currentJobPromise;
    } catch (err) {
      // A failure in claimNextJob/completeJob itself (e.g. a transient DB connection error) — log
      // and keep the loop alive rather than crashing the whole worker process over one bad poll.
      console.error('[worker] poll iteration failed:', sanitizeError(err));
    } finally {
      currentJobPromise = null;
    }
    if (!processed && !shuttingDown) {
      await new Promise((r) => setTimeout(r, env.WORKER_POLL_INTERVAL_SECONDS * 1000));
    }
  }
}

async function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, shutting down after the current job finishes`);
  shuttingDown = true;
  // Actually wait for the in-flight job (if any) to reach completeJob/failJob before closing the
  // pool — otherwise a job's own DB writes could be cut off mid-transfer. Railway's default
  // termination grace period must be long enough for the current job to actually finish (or for its
  // lock to be worth relying on reap_expired_jobs() instead); see worker/README.md.
  if (currentJobPromise) {
    await currentJobPromise.catch(() => {});
  }
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

mainLoop().catch((err) => {
  console.error('[worker] fatal error, exiting:', sanitizeError(err));
  process.exit(1);
});
