import 'server-only';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { writeAuditEvent } from '@/lib/audit/log';

export class ForbiddenError extends Error {}
export class UnauthenticatedError extends Error {}

export type AdminContext = { userId: string; email: string | null };

/**
 * THE server-side authorization boundary for admin operations. Every admin Server Action and every
 * admin API route must call this before doing anything privileged — never infer admin status from a
 * client-supplied field, a cookie value read directly, or the mere existence of the /admin route.
 *
 * Checks, all required:
 *   1. A valid Supabase session exists (anon-key client — the session is exactly what RLS also sees).
 *   2. app_metadata.role === 'admin'. NEVER user_metadata: it is user-editable via the browser SDK.
 *   3. The session's authentication assurance level is aal2 (MFA was completed this session).
 *   4. The user id is the single row in admin_registry (defense in depth against a metadata bug).
 *
 * Failures are audited via the service-role client (the audit_log RLS policy would otherwise block
 * an unauthenticated/non-admin actor from writing their own denial).
 */
export async function requireAdmin(): Promise<AdminContext> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser(); // getUser(), not getSession(): revalidates the token against Supabase.

  if (!user) {
    throw new UnauthenticatedError('No authenticated session.');
  }

  // The Session object has no `aal` field on it — the correct API is
  // supabase.auth.mfa.getAuthenticatorAssuranceLevel(), which returns { currentLevel, nextLevel }.
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const role = (user.app_metadata as Record<string, unknown> | null)?.role;

  if (role !== 'admin' || aalData?.currentLevel !== 'aal2') {
    await writeAuditEvent({
      actorId: user.id,
      actorRole: 'user',
      eventType: 'permission_denied',
      details: { reason: role !== 'admin' ? 'not_admin_role' : 'mfa_not_satisfied' },
    });
    throw new ForbiddenError('Admin privileges required.');
  }

  // Defense in depth: confirm against admin_registry using the service-role client, since the
  // anon-key client's RLS-scoped read could in principle be affected by a future policy change.
  const svc = createServiceRoleClient();
  const { data: registryRow, error } = await svc
    .from('admin_registry')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !registryRow) {
    await writeAuditEvent({
      actorId: user.id,
      actorRole: 'user',
      eventType: 'permission_denied',
      details: { reason: 'not_in_admin_registry' },
    });
    throw new ForbiddenError('Admin privileges required.');
  }

  return { userId: user.id, email: user.email ?? null };
}
