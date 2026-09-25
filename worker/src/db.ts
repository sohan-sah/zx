import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

// A small pool is enough: this worker processes one job at a time (see index.ts) and only needs a
// couple of connections for the job-queue calls plus whatever a job handler itself needs.
export const pool = new Pool({
  connectionString: env.WORKER_DATABASE_URL,
  max: 4,
  ssl: { rejectUnauthorized: true },
});

export type VideoJobRow = {
  id: string;
  type: string;
  video_id: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  payload: unknown;
};

/** Claims at most one runnable job via the atomic FOR UPDATE SKIP LOCKED function (migration 0003). */
export async function claimNextJob(types: string[]): Promise<VideoJobRow | null> {
  const { rows } = await pool.query<VideoJobRow>(
    'select * from public.claim_next_job($1, $2, $3)',
    [env.WORKER_ID, env.WORKER_LOCK_SECONDS, types]
  );
  return rows[0] ?? null;
}

export async function extendJobLock(jobId: string): Promise<boolean> {
  const { rows } = await pool.query<{ extend_job_lock: boolean }>(
    'select public.extend_job_lock($1, $2, $3)',
    [jobId, env.WORKER_ID, env.WORKER_LOCK_SECONDS]
  );
  return rows[0]?.extend_job_lock ?? false;
}

export async function completeJob(jobId: string): Promise<boolean> {
  const { rows } = await pool.query<{ complete_job: boolean }>('select public.complete_job($1, $2)', [
    jobId,
    env.WORKER_ID,
  ]);
  return rows[0]?.complete_job ?? false;
}

/** error message only — NEVER pass credentials, tokens, or presigned URLs here; it is stored in the
 * database and later surfaced in the admin dashboard. */
export async function failJob(jobId: string, errorMessage: string): Promise<string | null> {
  const { rows } = await pool.query<{ fail_job: string }>('select public.fail_job($1, $2, $3)', [
    jobId,
    env.WORKER_ID,
    errorMessage,
  ]);
  return rows[0]?.fail_job ?? null;
}

export type VideoBackupColumns = {
  id: string;
  primary_object_key: string | null;
  size_bytes: string | null; // bigint comes back as string from node-postgres
  sha256: string | null;
};

/** Column set matches exactly what migration 0003 grants video_worker SELECT on for this job type. */
export async function fetchVideoForBackup(videoId: string): Promise<VideoBackupColumns | null> {
  const { rows } = await pool.query<VideoBackupColumns>(
    'select id, primary_object_key, size_bytes, sha256 from public.videos where id = $1',
    [videoId]
  );
  return rows[0] ?? null;
}

export async function markBackupVerified(params: {
  videoId: string;
  sha256: string;
  backupObjectKey: string;
  backupVersionId: string | null;
  backupSha256: string;
}): Promise<void> {
  await pool.query(
    `update public.videos
        set sha256 = $2,
            backup_status = 'verified',
            backup_object_key = $3,
            backup_version_id = $4,
            backup_sha256 = $5,
            backup_verified_at = now(),
            last_backup_attempt = now(),
            backup_error = null
      where id = $1`,
    [params.videoId, params.sha256, params.backupObjectKey, params.backupVersionId, params.backupSha256]
  );
}

export async function markBackupFailed(videoId: string, status: 'failed' | 'mismatch', errorMessage: string): Promise<void> {
  await pool.query(
    `update public.videos
        set backup_status = $2,
            last_backup_attempt = now(),
            backup_error = $3
      where id = $1`,
    [videoId, status, errorMessage.slice(0, 2000)]
  );
}

export async function writeWorkerAuditEvent(params: {
  eventType: 'backup_started' | 'backup_verified' | 'backup_failed';
  videoId: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `insert into public.audit_log (actor_role, event_type, video_id, details)
     values ('worker', $1, $2, $3)`,
    [params.eventType, params.videoId, JSON.stringify(params.details ?? {})]
  );
}
