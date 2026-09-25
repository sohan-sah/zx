# Deploying to Vercel

## What this app is (Slice 4 status)

Next.js 15 (App Router) on Vercel. Supabase Auth + Postgres + RLS. Public pages: home, search, saved,
video detail (player has no source yet — see below), profile. Admin area gated by `requireAdmin()`
(app_metadata role + aal2 MFA + admin_registry row — never `user_metadata`): video list, create, edit
metadata + thumbnail, publish/unpublish, delete-primary with confirmation, and a full R2 multipart
upload flow (init/sign-part/list-parts/complete/abort) with resumable uploads. A Railway worker
(`worker/`) processes `backup_video` jobs: streams R2 → B2, hashes both sides independently, and only
marks a backup verified on a hash match.

**Not yet built:** signed video playback (the player always gets `src: null`), HLS, the admin backup
dashboard (retry/restore), `docs/backup.md` / `docs/recovery.md` / `docs/security.md` /
`docs/recovery-drill.md`, and `verify_backup`/`restore_video`/`transcode_hls`/`export_audit_log` job
handlers (their job types exist in the database but the worker doesn't process them yet).

## Before your first deploy

1. Apply `supabase/migrations/0001` → `0002` → `0003` to your Supabase project (see `docs/setup.md`).
2. Create the admin user, enroll MFA, and insert the `admin_registry` row (see `docs/setup.md`).
3. Enforce a minimum password length in **Supabase Dashboard → Authentication → Policies** (12+, to
   match the app's own check) and enable **leaked-password protection** if available on your plan.
4. Create an Upstash Redis database (free tier is enough) for rate limiting; without it, login/MFA/
   signup rate limiting fails open (see `src/lib/rate-limit.ts`).
5. Create a **private** Cloudflare R2 bucket for primary video + thumbnail storage, and an R2 API
   token scoped to just that bucket (Object Read & Write) for the Vercel app to use.
6. **Configure CORS on the R2 bucket** — required for the browser to upload multipart parts directly
   to R2. Without `ExposeHeaders: ["ETag"]` specifically, the upload will appear to work but every
   part will fail with a "missing_etag" error: browsers block JavaScript from reading most response
   headers on a cross-origin request unless the server's CORS policy explicitly exposes them, and the
   whole point of that ETag is that the browser must read it and report it back to complete the
   multipart upload. In the Cloudflare dashboard → R2 → your bucket → Settings → CORS Policy:
   ```json
   [
     {
       "AllowedOrigins": ["https://your-production-domain.com"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   Add your Vercel preview domain pattern too if you test uploads from preview deploys.
7. Add an R2 lifecycle rule aborting incomplete multipart uploads after a few days, so an admin who
   abandons an upload (closes the tab without clicking "Cancelar subida") doesn't leave storage
   charges accumulating indefinitely.
8. Set up the Railway worker — see `worker/README.md` for its own required environment variables and
   deploy steps. It is a **separate** Railway service, not part of this Vercel deploy.

## Vercel project settings

**Environment variables** (Project Settings → Environment Variables). Mark the ones below as
**Sensitive**. Set all for the Production environment; set a second set (or reuse a staging Supabase
project) for Preview if you want preview deploys to work against real auth.

| Variable | Sensitive | Notes |
|---|---|---|
| `SUPABASE_URL` | no | from Supabase → Project Settings → API |
| `SUPABASE_ANON_KEY` | no | same page — safe to expose, RLS is the real boundary |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | same page — never used in any Client Component |
| `APP_ORIGIN` | no | your production URL, e.g. `https://videos.example.com` |
| `AUDIT_IP_HASH_SALT` | **yes** | `openssl rand -hex 32` |
| `UPSTASH_REDIS_REST_URL` | no | from Upstash console |
| `UPSTASH_REDIS_REST_TOKEN` | **yes** | from Upstash console |
| `R2_ACCOUNT_ID` | no | Cloudflare dashboard → R2 → Overview (right sidebar) |
| `R2_ACCESS_KEY_ID` | **yes** | from the R2 API token created above |
| `R2_SECRET_ACCESS_KEY` | **yes** | from the same token — shown once at creation |
| `R2_BUCKET` | no | the bucket name |

Do not add any variable with a `NEXT_PUBLIC_` prefix for a secret — this app has no browser-side
Supabase client, so none should exist at all right now. The R2 credentials above are also never sent
to the browser: the app only uses them server-side to presign URLs.

**Build & Development Settings:** framework preset "Next.js" (auto-detected); `vercel.json` sets
`installCommand: npm ci` (uses the committed lockfile exactly, not `npm install`) and
`buildCommand: npm run build`.

**Node.js version:** 22.x, pinned via `.nvmrc` and `engines.node` in `package.json`.

**Auth redirect URLs:** in Supabase → Authentication → URL Configuration, add your Vercel production
URL and preview-deploy URL pattern (`https://*.vercel.app` for previews, if you use them) to Redirect
URLs, and set Site URL to your production `APP_ORIGIN`.

## What Vercel Functions must never do

No route in this app streams, hashes, or copies multi-GB video files. Upload routes only issue
presigned URLs and make small metadata calls to R2 (`CreateMultipartUpload`, `UploadPart` presigning,
`CompleteMultipartUpload`, `HeadObject`, `ListParts`, `DeleteObject`) — the actual bytes flow directly
between the admin's browser and R2, never through a Vercel Function. The R2 → B2 copy and hashing
happen entirely in the Railway worker (`worker/`), which polls the `video_jobs` table rather than
exposing an endpoint Vercel would call. Keep it that way as more routes are added.

## Verifying a deploy

1. `https://<your-domain>/api/health` → `{"status":"ok"}`. This confirms env vars validated and the
   database is reachable; it never returns error details or connection info.
2. Sign up, confirm the email, and log in as a normal user — confirm `/admin` redirects to `/` (not a
   403 page, so the route's existence isn't confirmed to non-admins), and that `/api/admin/uploads/init`
   returns 404 for this user, not 401/403.
3. Log in as the admin user, complete the MFA challenge, and confirm `/admin/videos` loads.
4. Create a video, upload a small test file, confirm it reaches `primary_storage_status: available`,
   then confirm the Railway worker picks up the resulting `backup_video` job and the video eventually
   shows `backup_status: verified`.
5. Try publishing a video with no uploaded file yet and confirm it's rejected (the database trigger,
   not just the UI, is what's actually being tested here).
6. Check response headers on any page for `Content-Security-Policy`, `Strict-Transport-Security`,
   `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`.

## CI (GitHub Actions, `.github/workflows/ci.yml`)

Two jobs on every push/PR to `main`: the Next.js app (`npm ci`, unit tests, lint, typecheck, build with
placeholder env values, `npm audit`) and the worker (`npm ci`, typecheck, unit tests, build, `npm
audit`), plus a Gitleaks secret scan across the full git history. **Neither job has ever been run** —
no network access was available while writing this project (see "Honest status" below) — and **neither
has a committed lockfile yet** (`package-lock.json` in both the project root and `worker/`), so the
very first `npm ci` in CI or in your own environment will fail until you run `npm install` once in each
directory and commit the resulting lockfile.

## Actually run in this environment (2026-09-24)

`npm install` in both the root and `worker/` still returns **403 from the npm registry** — this
container has no outbound network access to it, confirmed again. Since `node_modules` was never
created, `npm test`, `npm run lint`, and `npm run build` all failed immediately (`vitest: not found`,
`next: not found`) — that is expected and not evidence of anything about the code's correctness.

**`npm run typecheck` did run**, using a global `tsc`, and it surfaced one real bug: root's
`tsconfig.json` had no `worker` entry in `exclude`, so root's typecheck was pulling in the worker's
separate TypeScript project (different `module`/`moduleResolution` settings, different dependencies) —
34 of the errors were worker files leaking into the root check. **Fixed**: added `"worker"` to root
`tsconfig.json`'s `exclude`.

After that fix, root typecheck reported 558 errors and the worker's own typecheck (run from `worker/`,
now correctly isolated) reported 44. I categorized every single one rather than assuming they were all
equivalent:

- The overwhelming majority (`TS2307` Cannot find module, `TS7026`/`TS7006`/`TS7031` implicit `any`
  from unresolved types, `TS2882` unresolved side-effect imports like `server-only` and `./globals.css`,
  `TS2591`/`TS2584`/`TS2304` missing ambient globals like `process`, `Buffer`, `console`, `setTimeout`,
  `URL`, `__dirname`) are exactly what running TypeScript with zero installed packages produces — none
  of these are reachable without `node_modules`, since even Node's own globals come from the
  `@types/node` package, not from the language itself.
- Two error codes could plausibly have been real bugs, so I checked each occurrence individually rather
  than assuming: `TS2366` ("function lacks ending return statement") on `loginAction`, `verifyMfaAction`,
  and `deleteVideoPrimaryAction` — each ends its final branch with `redirect(...)`, whose real type is
  `redirect(): never` in Next.js's types; with `next/navigation` unresolved, TypeScript falls back to
  `any` and loses that guarantee, which is what triggered the error. `TS2322` on the three `<VideoCard
  key={...} .../>` usages — React's types are what teach TypeScript to special-case the `key` prop
  (`JSX.LibraryManagedAttributes`); without `@types/react` resolved, it's checked as a plain prop
  instead. Both are confirmed artifacts of the missing install, not logic errors, by inspecting the
  actual code at every flagged line.

This is still not the same as a real, dependency-installed run — I can rule out the specific failure
modes above, not everything. Run `npm ci && npm test && npm run lint && npm run typecheck && npm run
build` in both directories yourself (generating `package-lock.json` in each on the first `npm install`,
per the note above) and report the exact output.
