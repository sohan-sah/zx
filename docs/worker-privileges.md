# Worker Database Privileges (`video_worker`)

The Railway worker connects to PostgreSQL directly as the dedicated `video_worker` role. It does NOT
use the Supabase service-role key. The role is created with LOGIN but **no password**; you set the
password once, manually (see docs/setup.md). Nothing secret is in any migration.

## What the worker can read on `videos`

Column-level SELECT only, and only rows that have a matching job currently in `processing`
(types: backup_video, verify_backup, restore_video, transcode_hls).

| Column | backup | verify | HLS/transcode | recovery |
|---|---|---|---|---|
| id | ✔ | ✔ | ✔ | ✔ |
| primary_object_key | ✔ (source) | ✔ | ✔ (source) | – |
| primary_storage_status | ✔ | ✔ | – | ✔ |
| size_bytes | ✔ | ✔ | – | – |
| sha256 | ✔ | ✔ | – | ✔ (expected hash) |
| backup_status / backup_object_key / backup_version_id / backup_sha256 | ✔ | ✔ | – | ✔ (key + version) |
| backup_verified_at / last_backup_attempt / backup_error | ✔ | ✔ | – | – |
| hls_prefix / duration_seconds | – | – | ✔ | – |
| recovery_status / restore_object_key / restore_sha256 | – | – | – | ✔ |

Not readable: title, description, category_id, thumbnail_key, status, published_at, created_by, tsv.

## What the worker can write on `videos`

`primary_storage_status, size_bytes, sha256, backup_status, backup_object_key, backup_version_id,
backup_sha256, backup_verified_at, last_backup_attempt, backup_error, recovery_status,
restore_object_key, restore_sha256, hls_prefix, duration_seconds` — same row scope as above.

Not writable: primary_object_key, status, published_at, title/description, ownership. A restored copy is
verified by the worker (`recovery_status = 'restored_verified'`) but **promoted to the primary key by
trusted server code**, after admin re-authentication.

Database-level guards that also apply: `sha256` cannot change once set; `backup_status = 'verified'` is
rejected unless `sha256 = backup_sha256` and `backup_verified_at` is set.

## Other tables

| Table | Worker access |
|---|---|
| video_jobs | SELECT all; UPDATE only queue-state columns on active jobs; cannot insert, delete, or re-queue |
| audit_log | INSERT own events only (`actor_role = 'worker'`, backup/restore/audit_export types); SELECT own rows, and all rows only while an `export_audit_log` job is processing |
| audit_exports | SELECT; INSERT/UPDATE only while an `export_audit_log` job is processing |
| profiles, categories, saved_videos, watch_progress, upload_sessions, admin_registry, auth.* | none |

## Rules the worker code must follow

1. Write all `videos` / `audit_log` results for a job BEFORE calling `complete_job` / `fail_job`
   (row access ends when the job leaves `processing`).
2. Call `extend_job_lock` regularly during multi-GB copies and hashes.
3. Never put credentials, tokens or presigned URLs in `p_error` or audit `details`.
4. Any worker instance can act on any active job (RLS cannot tell instances apart). Instances share one
   trust domain; do not run untrusted code on the worker.

## Role hardening applied in SQL

`connection limit 5`, `noinherit`, `statement_timeout = 60s`, `idle_in_transaction_session_timeout = 60s`,
`search_path = public`. Default role attributes are NOSUPERUSER / NOCREATEDB / NOCREATEROLE /
NOREPLICATION / NOBYPASSRLS. Long streaming work happens outside the database, so 60s per statement is ample.
