import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ListPartsCommand } from '@aws-sdk/client-s3';
import { requireAdminForApi } from '@/lib/auth/require-admin-api';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { createR2Client } from '@/lib/storage/r2-client';
import { env } from '@/lib/env';

/**
 * Returns the parts R2 already has for this upload session, straight from R2 (the source of truth)
 * rather than any client-side memory — this is what makes "resume after reload" correct: R2 knows
 * exactly which parts actually landed even if the browser tab was closed mid-upload.
 */
export async function GET(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const guard = await requireAdminForApi();
  if ('response' in guard) return guard.response;
  const { ctx } = guard;

  const { sessionId } = await context.params;
  if (!z.string().uuid().safeParse(sessionId).success) {
    return NextResponse.json({ error: 'invalid_session' }, { status: 400 });
  }

  const svc = createServiceRoleClient();
  const { data: session } = await svc
    .from('upload_sessions')
    .select('id, r2_upload_id, object_key, status, created_by')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session || session.created_by !== ctx.userId) {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
  }
  if (session.status !== 'in_progress') {
    return NextResponse.json({ parts: [] });
  }

  const r2 = createR2Client();
  const parts: { partNumber: number; etag: string; size: number }[] = [];
  let partNumberMarker: string | undefined;

  // Paginate through ListParts (R2/S3 caps each response at 1000 parts).
  do {
    const result = await r2.send(
      new ListPartsCommand({
        Bucket: env.R2_BUCKET,
        Key: session.object_key,
        UploadId: session.r2_upload_id,
        PartNumberMarker: partNumberMarker,
      })
    );
    for (const p of result.Parts ?? []) {
      if (p.PartNumber != null && p.ETag) {
        parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size ?? 0 });
      }
    }
    partNumberMarker = result.IsTruncated ? result.NextPartNumberMarker : undefined;
  } while (partNumberMarker);

  return NextResponse.json({ parts });
}
