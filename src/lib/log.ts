import 'server-only';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { hashedClientIp, currentUserAgent } from '@/lib/audit/request-context';

export type AuditEventType =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'mfa_enrolled'
  | 'mfa_removed'
  | 'mfa_changed'
  | 'upload_started'
  | 'upload_completed'
  | 'upload_aborted'
  | 'edit'
  | 'publish'
  | 'unpublish'
  | 'delete_primary'
  | 'delete_backup'
  | 'backup_started'
  | 'backup_verified'
  | 'backup_failed'
  | 'restore_started'
  | 'restore_completed'
  | 'restore_failed'
  | 'security_setting_changed'
  | 'audit_export'
  | 'permission_denied';

/**
 * Writes one audit event. INSERT-only by design: the database rejects UPDATE/DELETE/TRUNCATE on
 * this table regardless of which credentials are used (see migration 0003). Never pass secrets,
 * tokens, or full request bodies in `details`.
 */
export async function writeAuditEvent(params: {
  actorId: string | null;
  actorRole: 'admin' | 'user' | 'anonymous';
  eventType: AuditEventType;
  videoId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  const supabase = createServiceRoleClient();
  const [ip_hash, user_agent] = await Promise.all([hashedClientIp(), currentUserAgent()]);

  const { error } = await supabase.from('audit_log').insert({
    actor_id: params.actorId,
    actor_role: params.actorRole,
    event_type: params.eventType,
    video_id: params.videoId ?? null,
    ip_hash,
    user_agent,
    details: params.details ?? {},
  });

  if (error) {
    // Never let audit-log failure silently swallow a security-relevant action. The caller decides
    // whether this is fatal; here we surface it to server logs at minimum.
    console.error('[audit] failed to write event', params.eventType, error.message);
  }
}
