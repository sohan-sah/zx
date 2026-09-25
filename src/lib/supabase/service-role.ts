import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

/**
 * Bypasses RLS. NEVER import this from a Client Component, NEVER return its results directly to
 * the browser without your own authorization check first, and NEVER call it before verifying
 * admin status with requireAdmin() (see src/lib/auth/require-admin.ts).
 *
 * Every call site using this client must be traceable to an explicit server-side authorization
 * decision — that decision is the security boundary, not the existence of this file.
 */
export function createServiceRoleClient() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
