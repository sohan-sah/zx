import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { requireAdminForApi } from '@/lib/auth/require-admin-api';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { createR2Client } from '@/lib/storage/r2-client';
import { writeAuditEvent } from '@/lib/audit/log';
import { rateLimit } from '@/lib/rate-limit';
import { env } from '@/lib/env';

export async function POST(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const guard = await requireAdminForApi();
  if ('response' in guard) return guard.response;
  const { ctx } = guard;

  const { sessionId } = await context.params;
  if (!z.string().uuid().safeParse(sessionId).success) {
    return NextResponse.json({ error: 'invalid_session' }, { status: 400 });
  }

  const limit = await rateLimit(`upload-abort:${ctx.userId}`, 20, 60);
  if (!limit.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

  const svc = createServiceRoleClient();
  const { data: session } = await svc
    .from('upload_sessions')
    .select('id, video_id, r2_upload_id, object_key, status, created_by')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session || session.created_by !== ctx.userId) {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
  }
  if (session.status !== 'in_progress') {
    return NextResponse.json({ ok: true }); // already completed/aborted — idempotent no-op
  }

  const r2 = createR2Client();
  try {
    await r2.send(
      new AbortMultipartUploadCommand({ Bucket: env.R2_BUCKET, Key: session.object_key, UploadId: session.r2_upload_id })
    );
  } catch {
    // Continue regardless: R2's own incomplete-multipart-upload lifecycle rule (documented in
    // docs/deployment-vercel.md) cleans up abandoned uploads even if this explicit abort call fails.
  }

  await svc.from('upload_sessions').update({ status: 'aborted' }).eq('id', session.id);

  // Only reset the video's storage status if it was still pointing at THIS in-progress upload —
  // avoids clobbering a state some other, newer session may have already moved past.
  await svc
    .from('videos')
    .update({ primary_storage_status: 'pending', status: 'draft' })
    .eq('id', session.video_id)
    .eq('primary_storage_status', 'uploading');

  await writeAuditEvent({
    actorId: ctx.userId,
    actorRole: 'admin',
    eventType: 'upload_aborted',
    videoId: session.video_id,
  });

  return NextResponse.json({ ok: true });
}
