import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { env } from '@/lib/env';

/**
 * A Supabase client scoped to the current request's session. Uses the ANON key, so every query
 * still goes through RLS — this client can never bypass row/column security. Use this for all
 * reads/writes done "as the signed-in user".
 *
 * Uses getAll/setAll (current @supabase/ssr API, stable since 0.4.0), not the deprecated per-cookie
 * get/set/remove API, which can silently drop cookies when Supabase splits a large session token
 * into multiple chunks.
 */
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, { ...options, httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax' })
          );
        } catch {
          // setAll was called from a Server Component render, where cookies() is read-only.
          // Safe to ignore: middleware.ts refreshes the session cookie on every request.
        }
      },
    },
  });
}
