-- 0003_audit_jobs_worker.sql  (revised after SQL security review)

-- =====================================================================
-- Worker role: dedicated, least-privilege, able to LOG IN.
--
-- The role is created WITHOUT a password. A role with no password cannot authenticate over the
-- network, so it is unusable until you set one MANUALLY, outside Git, once:
--     alter role video_worker password '<long random value>';
-- (Run that statement only in the Supabase SQL editor. Never put it in a migration or in source.)
-- Defaults apply: NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS.
-- =====================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'video_worker') then
    create role video_worker login noinherit connection limit 5;
  else
    alter role video_worker login noinherit connection limit 5;
  end if;
end $$;

alter role video_worker set statement_timeout = '60s';
alter role video_worker set idle_in_transaction_session_timeout = '60s';
alter role video_worker set search_path = public;

grant usage on schema public to video_worker;

-- =====================================================================
-- Audit log: append-only.
-- Triggers reject UPDATE / DELETE / TRUNCATE even for service_role (which bypasses RLS).
-- A database owner could still drop the trigger, which is why the periodic B2 export is required.
-- =====================================================================
create or replace function public.audit_log_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end $$;
revoke all on function public.audit_log_immutable() from public, anon, authenticated;

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.audit_log_immutable();

revoke update, delete, truncate on public.audit_log from public, anon, authenticated;

-- =====================================================================
-- Video integrity guards
--  * master sha256, once set, can never change
--  * a video can only be published when primary storage is available
-- =====================================================================
create or replace function public.videos_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if old.sha256 is not null and new.sha256 is distinct from old.sha256 then
      raise exception 'sha256 of a master video is immutable once set' using errcode = '23514';
    end if;
  end if;

  if new.status = 'published' then
    if new.primary_storage_status <> 'available' then
      raise exception 'cannot publish: primary storage is not available' using errcode = '23514';
    end if;
    if new.published_at is null then
      new.published_at := now();
    end if;
  end if;
  return new;
end $$;
revoke all on function public.videos_guard() from public, anon, authenticated;

create trigger videos_guard
  before insert or update on public.videos
  for each row execute function public.videos_guard();

-- =====================================================================
-- Atomic job queue functions (SECURITY INVOKER: they run as video_worker, so the worker's
-- column grants and RLS policies below apply to everything they do).
-- =====================================================================

-- Jobs whose lock expired (worker crash / timeout) go to 'retrying', or 'failed' if out of attempts.
create or replace function public.reap_expired_jobs()
returns integer language plpgsql as $$
declare
  n integer;
begin
  update public.video_jobs
     set status       = case when attempts >= max_attempts then 'failed'::public.job_status
                             else 'retrying'::public.job_status end,
         error        = 'worker lock expired (crash or timeout)',
         completed_at = case when attempts >= max_attempts then now() else null end,
         run_after    = now(),
         locked_until = null,
         locked_by    = null
   where status = 'processing' and locked_until < now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Claims at most one runnable job. FOR UPDATE SKIP LOCKED => two workers can never claim the same row.
create or replace function public.claim_next_job(
  p_worker       text,
  p_lock_seconds integer default 900,
  p_types        public.job_type[] default null
) returns setof public.video_jobs
language plpgsql as $$
declare
  v_job public.video_jobs;
begin
  perform public.reap_expired_jobs();

  update public.video_jobs j
     set status       = 'processing',
         attempts     = j.attempts + 1,
         started_at   = now(),
         locked_by    = p_worker,
         locked_until = now() + make_interval(secs => p_lock_seconds)
   where j.id = (
           select q.id
             from public.video_jobs q
            where q.status in ('queued', 'retrying')
              and q.run_after <= now()
              and (p_types is null or q.type = any (p_types))
            order by q.run_after, q.created_at
              for update skip locked
            limit 1
         )
  returning j.* into v_job;

  if v_job.id is not null then
    return next v_job;
  end if;
  return;
end $$;

-- Long jobs (multi-GB copies/hashes) must extend their lock periodically.
create or replace function public.extend_job_lock(p_job_id uuid, p_worker text, p_lock_seconds integer default 900)
returns boolean language plpgsql as $$
declare
  n integer;
begin
  update public.video_jobs
     set locked_until = now() + make_interval(secs => p_lock_seconds)
   where id = p_job_id and status = 'processing' and locked_by = p_worker;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- IMPORTANT ORDER: write all video/audit updates for a job BEFORE calling complete_job/fail_job.
-- Worker access to `videos` is only granted while a matching job is still 'processing'.
create or replace function public.complete_job(p_job_id uuid, p_worker text)
returns boolean language plpgsql as $$
declare
  n integer;
begin
  update public.video_jobs
     set status = 'completed', completed_at = now(), locked_until = null, locked_by = null, error = null
   where id = p_job_id and status = 'processing' and locked_by = p_worker;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Backoff grows with attempts. NEVER pass secrets/credentials in p_error.
create or replace function public.fail_job(p_job_id uuid, p_worker text, p_error text, p_retry_delay_seconds integer default 60)
returns public.job_status language plpgsql as $$
declare
  v_status public.job_status;
begin
  update public.video_jobs
     set status       = case when attempts >= max_attempts then 'failed'::public.job_status
                             else 'retrying'::public.job_status end,
         error        = left(p_error, 2000),
         run_after    = now() + make_interval(secs => p_retry_delay_seconds * greatest(attempts, 1)),
         completed_at = case when attempts >= max_attempts then now() else null end,
         locked_until = null,
         locked_by    = null
   where id = p_job_id and status = 'processing' and locked_by = p_worker
  returning status into v_status;
  return v_status;
end $$;

revoke all on function public.reap_expired_jobs()                              from public, anon, authenticated;
revoke all on function public.claim_next_job(text, integer, public.job_type[]) from public, anon, authenticated;
revoke all on function public.extend_job_lock(uuid, text, integer)             from public, anon, authenticated;
revoke all on function public.complete_job(uuid, text)                         from public, anon, authenticated;
revoke all on function public.fail_job(uuid, text, text, integer)              from public, anon, authenticated;
grant execute on function public.reap_expired_jobs()                              to video_worker;
grant execute on function public.claim_next_job(text, integer, public.job_type[]) to video_worker;
grant execute on function public.extend_job_lock(uuid, text, integer)             to video_worker;
grant execute on function public.complete_job(uuid, text)                         to video_worker;
grant execute on function public.fail_job(uuid, text, text, integer)              to video_worker;

-- =====================================================================
-- WORKER PRIVILEGES (documented per operation in docs/worker-privileges.md)
-- No access at all to: auth.*, profiles, categories, saved_videos, watch_progress, upload_sessions,
-- admin_registry. New identity columns need no separate sequence grant.
-- =====================================================================

-- ---------- video_jobs: read all, update only queue-state columns ----------
grant select on public.video_jobs to video_worker;
grant update (status, attempts, started_at, completed_at, locked_until, locked_by, run_after, error)
  on public.video_jobs to video_worker;

-- SELECT is unrestricted on this table on purpose: job rows hold no secrets, and a narrower SELECT
-- policy can interfere with UPDATE ... RETURNING once a job leaves the active states.
create policy worker_jobs_select on public.video_jobs
  for select to video_worker using (true);
-- The worker may only touch ACTIVE jobs, and may never put a job back to 'queued'.
create policy worker_jobs_update on public.video_jobs
  for update to video_worker
  using      (status in ('queued', 'retrying', 'processing'))
  with check (status in ('processing', 'retrying', 'completed', 'failed'));
-- No INSERT or DELETE grant/policy: the worker cannot create or delete jobs.

-- ---------- videos: minimum columns ----------
-- READ needs (by operation):
--   all jobs        id
--   backup/verify   primary_object_key (source), primary_storage_status, size_bytes, sha256,
--                   backup_status, backup_object_key, backup_version_id, backup_sha256,
--                   backup_verified_at, last_backup_attempt, backup_error
--   HLS/transcode   primary_object_key (source), hls_prefix, duration_seconds
--   recovery        backup_object_key, backup_version_id, sha256, restore_object_key,
--                   restore_sha256, recovery_status, primary_storage_status
-- NOT granted: title, description, category_id, thumbnail_key, status, published_at, created_by, tsv.
grant select (id, primary_object_key, primary_storage_status, size_bytes, sha256,
              backup_status, backup_object_key, backup_version_id, backup_sha256,
              backup_verified_at, last_backup_attempt, backup_error,
              recovery_status, restore_object_key, restore_sha256,
              hls_prefix, duration_seconds)
  on public.videos to video_worker;

-- WRITE: results only. NOT writable by the worker: primary_object_key, status, published_at, title, etc.
-- (Promoting a restored copy to the primary key is done by trusted server code, not the worker.)
grant update (primary_storage_status, size_bytes, sha256,
              backup_status, backup_object_key, backup_version_id, backup_sha256,
              backup_verified_at, last_backup_attempt, backup_error,
              recovery_status, restore_object_key, restore_sha256,
              hls_prefix, duration_seconds)
  on public.videos to video_worker;

-- Row scope: only videos that have a matching job currently being processed.
create policy worker_videos_select on public.videos
  for select to video_worker
  using (exists (
    select 1 from public.video_jobs j
     where j.video_id = videos.id
       and j.status = 'processing'
       and j.type in ('backup_video', 'verify_backup', 'restore_video', 'transcode_hls')
  ));
create policy worker_videos_update on public.videos
  for update to video_worker
  using (exists (
    select 1 from public.video_jobs j
     where j.video_id = videos.id
       and j.status = 'processing'
       and j.type in ('backup_video', 'verify_backup', 'restore_video', 'transcode_hls')
  ))
  with check (exists (
    select 1 from public.video_jobs j
     where j.video_id = videos.id
       and j.status = 'processing'
       and j.type in ('backup_video', 'verify_backup', 'restore_video', 'transcode_hls')
  ));

-- ---------- audit_log: write own events; read everything only while exporting ----------
grant select on public.audit_log to video_worker;
grant insert (actor_role, event_type, video_id, details) on public.audit_log to video_worker;

create policy worker_audit_insert on public.audit_log
  for insert to video_worker
  with check (
    actor_role = 'worker'
    and event_type in ('backup_started', 'backup_verified', 'backup_failed',
                       'restore_started', 'restore_completed', 'restore_failed', 'audit_export')
  );
-- Rows the worker wrote itself are always visible to it (so INSERT ... RETURNING works); the full
-- log is visible only while an export_audit_log job is being processed.
create policy worker_audit_select on public.audit_log
  for select to video_worker
  using (
    actor_role = 'worker'
    or exists (
      select 1 from public.video_jobs j
       where j.type = 'export_audit_log' and j.status = 'processing'
    )
  );

-- ---------- audit_exports: only while an export job is processing ----------
grant select on public.audit_exports to video_worker;
grant insert (from_id, to_id, status) on public.audit_exports to video_worker;
grant update (b2_key, sha256, status, error, verified_at) on public.audit_exports to video_worker;

create policy worker_exports_select on public.audit_exports
  for select to video_worker using (true);
create policy worker_exports_insert on public.audit_exports
  for insert to video_worker
  with check (
    status = 'pending'
    and exists (select 1 from public.video_jobs j where j.type = 'export_audit_log' and j.status = 'processing')
  );
create policy worker_exports_update on public.audit_exports
  for update to video_worker
  using (
    status in ('pending', 'exported')
    and exists (select 1 from public.video_jobs j where j.type = 'export_audit_log' and j.status = 'processing')
  )
  with check (
    status in ('pending', 'exported', 'verified', 'failed')
    and exists (select 1 from public.video_jobs j where j.type = 'export_audit_log' and j.status = 'processing')
  );
