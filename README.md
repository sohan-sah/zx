# Video Backup Worker (Railway)

Polls `public.video_jobs` and processes `backup_video` jobs: streams the primary video from R2 to
B2, hashing both sides independently, and marks the backup `verified` only when the hashes match.
No public HTTP endpoint — this process only makes outbound connections (to Postgres, R2, and B2).

## Status: WRITTEN, NOT EXECUTED

Like the rest of this project, this worker has never been run — this container has no network access
to npm, R2, B2, or a live Postgres instance. The AWS SDK usage (`@aws-sdk/lib-storage` Upload
accepting a stream, `GetObjectCommand`'s Body as a Node Readable, the checksum-config workaround, B2's
S3-compatible endpoint/region format) was checked against current documentation, not against a real
run. Treat this as a reviewed first draft.

## Deploying on Railway

1. Create a new Railway service from this repo, **root directory set to `worker/`** (a separate
   service from anything hosting the Next.js app — this is intentionally not the same deployment).
2. Build command: `npm run build`. Start command: `npm start`.
3. Set the environment variables below in the Railway service's Variables tab. None of them should
   ever also appear in the Vercel project.
4. Railway's default SIGTERM grace period should be generous (a few minutes at least) — `src/index.ts`
   waits for the in-flight job to reach `completeJob`/`failJob` before exiting, and a multi-GB
   transfer can take a while. If Railway kills the process before that finishes anyway, the job's
   lock simply expires and `reap_expired_jobs()` (called automatically on the next claim, from any
   worker instance) puts it back to `retrying` — no job is silently lost, just retried.

## Environment variables

| Variable | Notes |
|---|---|
| `WORKER_DATABASE_URL` | Direct Postgres connection as the `video_worker` role — **not** the Supabase service-role key. Set that role's password manually first (see `docs/setup.md`), then build the connection string from your Supabase project's connection info (direct connection or pooler — confirm the exact username format required by your pooler, e.g. `video_worker.<project-ref>`). |
| `WORKER_R2_ACCOUNT_ID`, `WORKER_R2_ACCESS_KEY_ID`, `WORKER_R2_SECRET_ACCESS_KEY`, `WORKER_R2_BUCKET` | R2 credentials scoped to read (and, once restore is built in a later slice, write to a restore prefix) on the primary bucket only. Separate from the Vercel app's R2 credentials — create a distinct R2 API token for the worker. |
| `B2_S3_ENDPOINT` | e.g. `https://s3.us-west-004.backblazeb2.com` — from your B2 bucket's details page. |
| `B2_KEY_ID`, `B2_APPLICATION_KEY` | A B2 **application key** (not the master key), scoped to the backup bucket, with no `bypassGovernance` capability. |
| `B2_BACKUP_BUCKET` | Must already exist, created with **Object Lock enabled at creation** (cannot be added later) — see `docs/setup.md`. |
| `WORKER_ID` | Optional; defaults to `worker-<pid>`. Only needs to be unique if you run more than one instance. |
| `WORKER_POLL_INTERVAL_SECONDS` | Default `5`. |
| `WORKER_LOCK_SECONDS` | Default `900` (15 min). Must comfortably exceed how long a single R2→B2 streaming copy can take for your largest video at your expected transfer rate — the lock is extended automatically partway through a job, but only if the process is still alive to do so. |

## What this worker does NOT do yet

- `verify_backup`, `restore_video`, `transcode_hls`, `export_audit_log` — job types that already exist
  in the database enum but have no handler here. `claimNextJob` only asks for `backup_video`, so these
  sit queued/untouched until a later slice adds handlers.
- Re-attempting a backup does not skip re-hashing the primary from scratch, even if a previous attempt
  already got partway through. Correct, but not the most efficient possible retry.
- No metrics/alerting integration — failures are visible via `console.error` (Railway logs) and the
  `videos.backup_error` / `audit_log` columns, not pushed anywhere proactively.

## Local development

`npm install && npm run dev` (uses `tsx watch`, no build step) with a `.env` file — copy the worker
variables from the project root's `.env.example`. Never commit that `.env` file.
