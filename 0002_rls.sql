-- 0002_rls.sql  (revised after SQL security review)
-- Deny by default: strip default privileges, enable RLS everywhere, then grant the minimum.
-- Admin WRITE operations run in trusted server code (service role) AFTER server-side admin
-- verification; the browser roles (anon/authenticated) never get write access to videos,
-- categories, jobs, uploads or audit data.

-- ---------- strip defaults ----------
revoke create on schema public from anon, authenticated;
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- Future objects created by `postgres` in schema public: no automatic browser-role access.
-- NOTE: a schema-level ALTER DEFAULT PRIVILEGES cannot remove the GLOBAL default that lets PUBLIC
-- execute new functions, so EVERY function in these migrations explicitly revokes/grants its own
-- EXECUTE privilege. Keep doing that in every future migration.
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;

-- ---------- enable RLS on every table ----------
alter table public.admin_registry  enable row level security;
alter table public.profiles        enable row level security;
alter table public.categories      enable row level security;
alter table public.videos          enable row level security;
alter table public.saved_videos    enable row level security;
alter table public.watch_progress  enable row level security;
alter table public.upload_sessions enable row level security;
alter table public.video_jobs      enable row level security;
alter table public.audit_log       enable row level security;
alter table public.audit_exports   enable row level security;
-- admin_registry, upload_sessions, audit_exports: RLS on, NO policies for browser roles => no access.

-- ---------- admin check ----------
-- TRUE only when ALL hold: (1) app_metadata.role = 'admin' (app_metadata can only be written
-- server-side; user_metadata is NEVER consulted), (2) the session passed MFA (aal2), and
-- (3) the user id matches the single row in admin_registry.
create or replace function public.is_admin_mfa()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    and (auth.jwt() ->> 'aal') = 'aal2'
    and exists (select 1 from public.admin_registry r where r.user_id = auth.uid()),
    false
  )
$$;
revoke all on function public.is_admin_mfa() from public, anon;
grant execute on function public.is_admin_mfa() to authenticated;

-- ---------- profiles ----------
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---------- categories (read-only for the browser) ----------
grant select on public.categories to authenticated;
create policy categories_read on public.categories
  for select to authenticated using (true);

-- ---------- videos ----------
-- Column-level grant: storage keys, hashes, backup/recovery fields are NOT selectable from the browser.
grant select (id, title, description, category_id, thumbnail_key, duration_seconds,
              status, published_at, created_at, updated_at, tsv)
  on public.videos to authenticated;
create policy videos_read on public.videos
  for select to authenticated
  using (status = 'published' or public.is_admin_mfa());

-- ---------- saved videos ----------
grant select, insert, delete on public.saved_videos to authenticated;
create policy saved_select_own on public.saved_videos
  for select to authenticated using (user_id = auth.uid());
create policy saved_insert_own on public.saved_videos
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.videos v where v.id = saved_videos.video_id and v.status = 'published')
  );
create policy saved_delete_own on public.saved_videos
  for delete to authenticated using (user_id = auth.uid());

-- ---------- watch progress ----------
-- Read own rows directly; WRITE only through save_progress() (no direct insert/update grants).
grant select on public.watch_progress to authenticated;
create policy watch_select_own on public.watch_progress
  for select to authenticated using (user_id = auth.uid());

create or replace function public.save_progress(
  p_video_id uuid,
  p_position_seconds integer,
  p_duration_seconds integer default null
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_position_seconds is null or p_position_seconds < 0 or p_position_seconds > 172800 then
    raise exception 'invalid position' using errcode = '22023';
  end if;
  if p_duration_seconds is not null and (p_duration_seconds < 0 or p_duration_seconds > 172800) then
    raise exception 'invalid duration' using errcode = '22023';
  end if;
  if not exists (select 1 from public.videos where id = p_video_id and status = 'published') then
    raise exception 'video not available' using errcode = 'P0002';
  end if;

  insert into public.watch_progress (user_id, video_id, position_seconds, duration_seconds, completed)
  values (
    v_uid, p_video_id, p_position_seconds, p_duration_seconds,
    coalesce(p_duration_seconds > 0 and p_position_seconds >= p_duration_seconds * 0.95, false)
  )
  on conflict (user_id, video_id) do update
    set position_seconds = excluded.position_seconds,
        duration_seconds = coalesce(excluded.duration_seconds, public.watch_progress.duration_seconds),
        completed        = excluded.completed,
        updated_at       = now();
end $$;
revoke all on function public.save_progress(uuid, integer, integer) from public, anon;
grant execute on function public.save_progress(uuid, integer, integer) to authenticated;

-- ---------- admin read access (RLS-gated) ----------
grant select on public.audit_log  to authenticated;
grant select on public.video_jobs to authenticated;
create policy audit_admin_read on public.audit_log
  for select to authenticated using (public.is_admin_mfa());
create policy jobs_admin_read on public.video_jobs
  for select to authenticated using (public.is_admin_mfa());
