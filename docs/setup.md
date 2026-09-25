# Setup & Build Status — Slice 1 (Database Foundation), revised

## Status: STATICALLY REVIEWED, NOT YET EXECUTED

No Postgres was available while writing these files, so the SQL has never been run. It has had a
manual security/dependency review only (see "Review notes"). Apply it first to a **new, empty Supabase
development project**. Each file runs once, in order: 0001 → 0002 → 0003. If a file errors, the whole
file rolls back (single implicit transaction); fix and re-run that file.

## Manual steps (you do these; none of them puts a secret in SQL or Git)

1. Apply the three migrations in order.
2. Create your admin user (sign up), enroll TOTP MFA, then in the SQL editor:
   ```sql
   update auth.users
      set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
    where email = 'YOUR_ADMIN_EMAIL';
   insert into public.admin_registry (user_id)
     select id from auth.users where email = 'YOUR_ADMIN_EMAIL';
   ```
   The admin check needs ALL of: app_metadata role, an MFA (aal2) session, and the registry row.
   Sign out and in again after changing app_metadata.
3. Set the worker password ONCE, in the SQL editor only (never in a file, migration, or Git):
   ```sql
   alter role video_worker password '<generate a long random value>';
   ```
   Put the resulting connection string only in Railway's environment as `WORKER_DATABASE_URL`.
   Supabase poolers usually expect the username as `video_worker.<project-ref>` — confirm the exact
   format in your Supabase dashboard's connection settings.
4. Create the **B2 backup bucket with Object Lock enabled at creation**, Governance mode, short retention.
   Create a normal worker key (no bypass) and a separate bypass key stored elsewhere.
5. Create a **private** R2 bucket (no public access). Add a lifecycle rule aborting incomplete multipart
   uploads after ~7 days.

## Review notes (what was checked statically)

- Dependency order: 0001 creates all types/tables/indexes; 0002 uses only 0001 objects; 0003 uses 0001/0002
  objects and creates `video_worker` before granting to it. No forward references found.
- No secrets, passwords, keys or URLs appear in any migration.
- SECURITY DEFINER functions (`handle_new_user`, `is_admin_mfa`, `save_progress`) all set
  `search_path = public, pg_temp`, use schema-qualified names, and have explicit EXECUTE revoke/grant.
- Every function created in these migrations explicitly revokes EXECUTE from PUBLIC (a schema-level default
  privilege cannot remove the global PUBLIC default; do the same in future migrations).
- Queue functions are SECURITY INVOKER, so worker column grants + RLS apply to everything they do.
- Worker: column-level SELECT/UPDATE on `videos`; row scope limited to videos with a matching processing job;
  cannot create/delete/requeue jobs; audit inserts limited to its own event types.

## Known residual risks / limits

- **Untested SQL.** The most likely failure points, in order: the generated `tsv` column, RLS policies that
  reference `video_jobs` inside `videos` policies, and role creation permissions on your Supabase plan.
  Report any error message verbatim.
- A database owner can still drop the audit triggers. The required audit export to Object-Lock-protected
  B2 (job `export_audit_log`) is the independent safeguard; the export code is not built yet.
- Any worker instance can act on any active job (see docs/worker-privileges.md).
- `audit_log.ip_hash` must be salted-hashed by application code; the database cannot enforce that.
- Rate limiting, CSRF, CSP/headers, sessions and input validation are app-layer work in later slices.

## Slice 2 added (Next.js app scaffold)

Signup, login (rate-limited, generic error messages), TOTP MFA enrollment + verification, home page
(published videos only, via RLS), `requireAdmin()` (app_metadata role + aal2 + admin_registry — never
user_metadata) guarding `/admin`, append-only audit logging from server code, security headers +
per-request CSP nonce + same-origin check in `middleware.ts`, `/api/health`, and a CI workflow
(lint/typecheck/build/npm audit/gitleaks). Full details and required env vars: `docs/deployment-vercel.md`.

**None of Slice 2 has been executed.** No npm registry access was available while writing it (confirmed:
`npm install` returned 403 in this environment), so lint, typecheck, build, and the CI workflow are all
unverified. Only a rough bracket-balance smoke check was run — not a real parser. Run
`npm ci && npm run lint && npm run typecheck && npm run build` yourself and report the exact output.

## Slice 3 added (Auth + Admin Security + User UI)

Logout, profile page (display name + MFA status), home/search/saved pages, video detail page with a
save/unsave toggle, and watch-progress saving wired to `save_progress()`. `VideoPlayer` always
receives `src: null` right now — there is no upload or signed-playback endpoint yet, so it honestly
shows "not available for playback" instead of a fake player.

**Two real bugs found and fixed while inspecting Slice 2, before writing Slice 3:**
1. `src/lib/supabase/server.ts` and `src/middleware.ts` used the deprecated per-cookie
   `get`/`set`/`remove` cookie API. The current `@supabase/ssr` API is `getAll`/`setAll`; the old API
   is known to silently drop cookies when Supabase splits a large session token into chunks, which
   would have caused random logouts. Both files were rewritten.
2. `requireAdmin()` read a non-existent `session.aal` property (always `undefined`, so the MFA check
   would have always failed, or worse, always evaluated falsy in a way that never blocked anyone
   depending on the comparison — either way, not the real check). Fixed to call
   `supabase.auth.mfa.getAuthenticatorAssuranceLevel()`, which is the actual API for this. The
   database-side check in `is_admin_mfa()` (`auth.jwt()->>'aal'`) was already correct and unchanged.
3. `mfa/setup/page.tsx` used `next/image`, which sets inline `style` attributes for sizing — that
   would have been silently blocked by the strict nonce-based CSP (`style-src` has no `'unsafe-inline'`,
   and nonces don't apply to inline style attributes, only `<style>` elements). Switched to a plain
   `<img>`, which needs no optimization for a small SVG data URI anyway.

**None of Slice 3 has been executed**, for the same reason as Slice 2: no npm registry access in this
environment (`npm install` still returns 403, confirmed again). The API usage above (cookie methods,
MFA AAL check, RLS JWT claim) was checked against current Supabase documentation via web search, which
is a stronger check than Slice 2 had, but it is still not the same as a real compile and run. Run
`npm ci && npm run lint && npm run typecheck && npm run build` and report the output.

## Slice 4 added (Admin Video Management + R2 Multipart Upload + Railway Worker)

Admin video CRUD (`/admin/videos`, create, edit metadata + thumbnail, publish/unpublish, delete-primary
with typed-title confirmation), a full resumable R2 multipart upload flow (init/sign-part/list-parts/
complete/abort Route Handlers under `src/app/api/admin/uploads/`), a single-shot presigned thumbnail
upload, and the Railway worker (`worker/`) that processes `backup_video` jobs: streams R2 → B2, hashes
both sides independently via `HashingPassThrough`/`hashReadable`, and marks `backup_status = 'verified'`
only on a hash match. Object keys are generated server-side only (`videos/<uuid>/master.<ext>`,
`thumbnails/<uuid>/<uuid>.<ext>`) from a validated UUID and a fixed MIME whitelist — no client-supplied
string ever reaches an R2 key, which is what makes path traversal structurally impossible rather than
merely filtered. Added `npm test` (vitest) with real, runnable unit tests for the object-key/multipart-
plan pure functions (Next app) and the streaming-hash helpers (worker), plus a documented, currently-
skipped integration test file for admin authorization, upload-session ownership, the publish-restriction
trigger, and job creation (needs a disposable Supabase test project — see the file's header comment).

**One real product-fit issue found and fixed while building this slice:** the original 20 GiB upload
size ceiling (carried over from earlier planning) was too low for a 6-hour video at anything beyond
fairly compressed 1080p — a 6-hour 1080p/4K master at a generous bitrate can approach 100 GiB. Raised
`MAX_UPLOAD_BYTES` in `src/lib/storage/multipart-plan.ts` to 100 GiB and documented the reasoning
in-code. Revisit this number against your actual source bitrate.

**A required manual R2 configuration step this slice depends on:** the R2 bucket's CORS policy must set
`ExposeHeaders: ["ETag"]`, or every part upload will fail — browsers block JavaScript from reading most
cross-origin response headers unless the server's CORS policy explicitly exposes them, and the ETag the
browser reads off each part's PUT response is exactly what `CompleteMultipartUpload` needs back. Full
CORS JSON in `docs/deployment-vercel.md`.

**None of Slice 4 has been executed**, for the same reason as every earlier slice: no npm registry, no
live Postgres, no R2/B2 account, and no Railway account were reachable while writing it (`npm install`
still returns 403 in this environment, confirmed again). The AWS SDK v3 usage — `@aws-sdk/lib-storage`
Upload accepting a stream Body, `GetObjectCommand`'s Body as a Node Readable in the Node runtime, the
`requestChecksumCalculation`/`responseChecksumValidation` workaround for R2/B2 compatibility, and B2's
S3-compatible endpoint/region format — was checked against current documentation via web search, not
against a real run. **Neither `package-lock.json` (root) nor `worker/package-lock.json` exists yet** —
run `npm install` once in each directory and commit the resulting lockfile before your first `npm ci`
or CI run. Run `npm ci && npm test && npm run lint && npm run typecheck && npm run build` in both the
project root and `worker/`, and report the exact output.

## Not built yet

Signed video playback, HLS transcoding, the admin backup dashboard (retry/restore UI), `verify_backup` /
`restore_video` / `transcode_hls` / `export_audit_log` worker job handlers, `docs/backup.md` /
`docs/recovery.md` / `docs/security.md` / `docs/recovery-drill.md`, and the placeholder integration
tests (real assertions need a disposable Supabase test project — see
`src/__tests__/integration/admin-security.test.ts`).
