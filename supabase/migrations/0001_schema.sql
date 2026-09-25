-- 0001_schema.sql  (revised after SQL security review)
-- Run each migration file ONCE, in order, on a FRESH Supabase project. No secrets appear in any file.
-- Storage keys, hashes and backup fields on `videos` are SERVER-MANAGED: normal users never get
-- column privileges on them (see 0002_rls.sql).

create extension if not exists pgcrypto;

-- ---------- enums ----------
create type public.video_status   as enum ('draft', 'processing', 'published', 'unpublished');
create type public.storage_status as enum ('pending', 'uploading', 'available', 'missing', 'corrupted');
create type public.backup_status  as enum ('none', 'queued', 'in_progress', 'copied', 'verified', 'failed', 'mismatch');
create type public.job_type       as enum ('backup_video', 'verify_backup', 'restore_video', 'transcode_hls', 'export_audit_log');
create type public.job_status     as enum ('queued', 'processing', 'completed', 'failed', 'retrying');
create type public.upload_status  as enum ('in_progress', 'completed', 'aborted');

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
revoke all on function public.set_updated_at() from public, anon, authenticated;

-- ---------- single admin registry ----------
-- Exactly one row can exist (singleton primary key). Filled manually, see docs/setup.md.
create table public.admin_registry (
  singleton  boolean primary key default true check (singleton),
  user_id    uuid not null unique references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

-- ---------- profiles ----------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Creates a profile for each new auth user. raw_user_meta_data is user-controlled, so it is used
-- ONLY for a length-limited display name, never for any privilege decision.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, ''), '@', 1)), 80)
  )
  on conflict (id) do nothing;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- categories ----------
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9-]{1,60}$'),
  name       text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now()
);

-- ---------- videos ----------
create table public.videos (
  id                     uuid primary key default gen_random_uuid(),
  title                  text not null check (char_length(title) between 1 and 200),
  description            text not null default '' check (char_length(description) <= 5000),
  category_id            uuid references public.categories (id) on delete set null,
  thumbnail_key          text,
  duration_seconds       integer check (duration_seconds is null or duration_seconds >= 0),
  status                 public.video_status not null default 'draft',
  published_at           timestamptz,

  -- server-managed storage / integrity / backup / recovery fields (never readable by normal users)
  primary_object_key     text unique,
  hls_prefix             text,
  size_bytes             bigint check (size_bytes is null or size_bytes >= 0),
  primary_storage_status public.storage_status not null default 'pending',
  sha256                 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  backup_status          public.backup_status not null default 'none',
  backup_object_key      text,
  backup_version_id      text,
  backup_sha256          text check (backup_sha256 is null or backup_sha256 ~ '^[0-9a-f]{64}$'),
  backup_verified_at     timestamptz,
  last_backup_attempt    timestamptz,
  backup_error           text,
  -- recovery: the worker restores B2 -> a TEMPORARY R2 key and verifies the hash; promotion of the
  -- restored copy to the primary key is done by trusted server code, never by the worker.
  recovery_status        text check (recovery_status is null or recovery_status in
                           ('requested', 'restoring', 'restored_verified', 'promoted', 'failed', 'mismatch')),
  restore_object_key     text,
  restore_sha256         text check (restore_sha256 is null or restore_sha256 ~ '^[0-9a-f]{64}$'),

  created_by             uuid references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  tsv tsvector generated always as (
    to_tsvector('spanish', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) stored,

  -- A backup can only be VERIFIED when both hashes exist, match, and a verification time is recorded.
  constraint backup_verified_requires_matching_hash check (
    backup_status <> 'verified'
    or (sha256 is not null and backup_sha256 = sha256 and backup_verified_at is not null)
  )
);
create trigger videos_updated_at before update on public.videos
  for each row execute function public.set_updated_at();

create index videos_published_idx on public.videos (published_at desc) where status = 'published';
create index videos_category_idx  on public.videos (category_id);
create index videos_status_idx    on public.videos (status, created_at desc);
create index videos_tsv_idx       on public.videos using gin (tsv);
create index videos_backup_idx    on public.videos (backup_status);

-- ---------- saved videos ----------
create table public.saved_videos (
  user_id    uuid not null references auth.users (id) on delete cascade,
  video_id   uuid not null references public.videos (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, video_id)
);
create index saved_videos_user_idx on public.saved_videos (user_id, created_at desc);

-- ---------- watch progress ----------
create table public.watch_progress (
  user_id          uuid not null references auth.users (id) on delete cascade,
  video_id         uuid not null references public.videos (id) on delete cascade,
  position_seconds integer not null default 0 check (position_seconds between 0 and 172800),
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  completed        boolean not null default false,
  updated_at       timestamptz not null default now(),
  primary key (user_id, video_id)
);
create index watch_progress_user_idx on public.watch_progress (user_id, updated_at desc);

-- ---------- multipart upload sessions (server-only) ----------
create table public.upload_sessions (
  id            uuid primary key default gen_random_uuid(),
  video_id      uuid not null references public.videos (id) on delete cascade,
  r2_upload_id  text not null,
  object_key    text not null,
  part_size     integer not null check (part_size >= 5242880),
  total_parts   integer not null check (total_parts between 1 and 10000),
  status        public.upload_status not null default 'in_progress',
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger upload_sessions_updated_at before update on public.upload_sessions
  for each row execute function public.set_updated_at();
create index upload_sessions_video_idx on public.upload_sessions (video_id, status);

-- ---------- job queue ----------
create table public.video_jobs (
  id            uuid primary key default gen_random_uuid(),
  type          public.job_type not null,
  video_id      uuid references public.videos (id) on delete cascade,
  status        public.job_status not null default 'queued',
  attempts      integer not null default 0 check (attempts >= 0),
  max_attempts  integer not null default 5 check (max_attempts between 1 and 20),
  payload       jsonb not null default '{}'::jsonb check (pg_column_size(payload) < 16384),
  created_at    timestamptz not null default now(),
  run_after     timestamptz not null default now(),
  started_at    timestamptz,
  completed_at  timestamptz,
  locked_until  timestamptz,
  locked_by     text,
  error         text
);
create index video_jobs_claim_idx on public.video_jobs (run_after, created_at)
  where status in ('queued', 'retrying');
create index video_jobs_processing_idx on public.video_jobs (locked_until)
  where status = 'processing';
-- At most one active job of the same type per video (prevents duplicate backups etc.).
create unique index video_jobs_one_active_per_video on public.video_jobs (type, video_id)
  where video_id is not null and status in ('queued', 'processing', 'retrying');

-- ---------- audit log (append-only; protections in 0003) ----------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid,            -- deliberately no FK: history must survive user deletion
  actor_role  text,            -- 'admin', 'user', or 'worker'
  event_type  text not null check (event_type in (
    'login', 'login_failed', 'logout',
    'mfa_enrolled', 'mfa_removed', 'mfa_changed',
    'upload_started', 'upload_completed', 'upload_aborted',
    'edit', 'publish', 'unpublish',
    'delete_primary', 'delete_backup',
    'backup_started', 'backup_verified', 'backup_failed',
    'restore_started', 'restore_completed', 'restore_failed',
    'security_setting_changed', 'audit_export', 'permission_denied'
  )),
  video_id    uuid,            -- no FK for the same reason
  ip_hash     text,            -- store a salted hash, never the raw IP
  user_agent  text check (user_agent is null or char_length(user_agent) <= 300),
  details     jsonb not null default '{}'::jsonb check (pg_column_size(details) < 16384)
);
create index audit_log_time_idx  on public.audit_log (occurred_at desc);
create index audit_log_event_idx on public.audit_log (event_type, occurred_at desc);
create index audit_log_video_idx on public.audit_log (video_id) where video_id is not null;

-- ---------- audit exports (B2 copies of the audit log) ----------
create table public.audit_exports (
  id          uuid primary key default gen_random_uuid(),
  from_id     bigint not null,
  to_id       bigint not null check (to_id >= from_id),
  b2_key      text,
  sha256      text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status      text not null default 'pending' check (status in ('pending', 'exported', 'verified', 'failed')),
  error       text,
  created_at  timestamptz not null default now(),
  verified_at timestamptz
);
create index audit_exports_status_idx on public.audit_exports (status, created_at desc);
