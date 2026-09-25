import { NextResponse } from 'next/server';
import { z } from 'zod';
import { UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireAdminForApi } from '@/lib/auth/require-admin-api';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { createR2Client } from '@/lib/storage/r2-client';
import { rateLimit } from '@/lib/rate-limit';
import { env } from '@/lib/env';

const bodySchema = z.object({ partNumber: z.number().int().min(1).max(10_000) });

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const guard = await requireAdminForApi();
  if ('response' in guard) return guard.response;
  const { ctx } = guard;

  const { sessionId } = await context.params;
  if (!z.string().uuid().safeParse(sessionId).success) {
    return NextResponse.json({ error: 'invalid_session' }, { status: 400 });
  }

  // Generous limit: a multi-GB upload at the default 64MB part size can need hundreds of parts.
  const limit = await rateLimit(`upload-sign-part:${ctx.userId}`, 600, 60);
  if (!limit.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const svc = createServiceRoleClient();
  const { data: session } = await svc
    .from('upload_sessions')
    .select('id, r2_upload_id, object_key, total_parts, status, created_by')
    .eq('id', sessionId)
    .maybeSingle();

  // Ownership check: even with a single admin today, this stops any future second admin account
  // from signing parts for a session they did not start.
  if (!session || session.created_by !== ctx.userId || session.status !== 'in_progress') {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
  }
  if (body.data.partNumber > session.total_parts) {
    return NextResponse.json({ error: 'part_number_out_of_range' }, { status: 400 });
  }

  const r2 = createR2Client();
  const url = await getSignedUrl(
    r2,
    new UploadPartCommand({
      Bucket: env.R2_BUCKET,
      Key: session.object_key,
      UploadId: session.r2_upload_id,
      PartNumber: body.data.partNumber,
    }),
    { expiresIn: 3600 }
  );

  return NextResponse.json({ url, partNumber: body.data.partNumber });
}
