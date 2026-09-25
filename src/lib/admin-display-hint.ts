import 'server-only';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * Best-effort check for whether to SHOW the admin nav link. This is display only — it does not
 * check admin_registry and never throws. The real authorization boundary is requireAdmin()
 * (src/lib/auth/require-admin.ts), enforced independently by the /admin layout on every request.
 * Hiding or showing this link changes nothing about what a request is allowed to do.
 */
export async function isAdminDisplayHint(): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const role = (user.app_metadata as Record<string, unknown> | null)?.role;
  return role === 'admin';
}
