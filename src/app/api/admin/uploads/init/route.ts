import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CreateMultipartUploadCommand } from '@aws-sdk/client-s3';
import { requireAdminForApi } from '@/lib/auth/require-admin-api';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { createR2Client } from '@/lib/storage/r2-client';
import { primaryObjectKey } from '@/lib/storage/object-key';
import { extensionForVideoMime } from '@/lib/storage/video-mime';
import { planMultipart, InvalidUploadSizeError } from '@/lib/storage/multipart-plan';
import { writeAuditEvent } from '@/lib/audit/log';
import { rateLimit } from '@/lib/rate-limit';
import { env } from '@/lib/env';

const bodySchema = z.object({
  videoId: z.string().uuid(),
  // Stored only for the audit log / admin display — never used to build the R2 object key.
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive(),
});

export async function POST(request: Request) {
  const guard = await requireAdminForApi();
  if ('response' in guard) return guard.response;
  const { ctx } = guard;

  const limit = await rateLimit(`upload-init:${ctx.userId}`, 20, 60);
  if (!limit.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

  const raw = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  if (!extensionForVideoMime(parsed.data.mimeType)) {
    return NextResponse.json({ error: 'unsupported_mime_type' }, { status: 400 });
  }

  let plan: { partSize: number; totalParts: number };
  try {
    plan = planMultipart(parsed.data.sizeBytes);
  } catch (e) {
    if (e instanceof InvalidUploadSizeError) {
      return NextResponse.json({ error: 'invalid_size' }, { status: 400 });
    }
    throw e;
  }

  const svc = createServiceRoleClient();
  const { data: video, error: videoError } = await svc
    .from('videos')
    .select('id, primary_storage_status')
    .eq('id', parsed.data.videoId)
    .maybeSingle();

  if (videoError || !video) {
    return NextResponse.json({ error: 'video_not_found' }, { status: 404 });
  }
  // Only allow starting an upload for a video with no usable primary object yet. A video whose
  // storage is already 'available' must go through delete-primary first — this route never
  // overwrites an existing master silently.
  if (!['pending', 'missing'].includes(video.primary_storage_status)) {
    return NextResponse.json({ error: 'upload_not_allowed_in_current_state' }, { status: 409 });
  }

  const objectKey = primaryObjectKey(video.id, parsed.data.mimeType);

  const r2 = createR2Client();
  let uploadId: string | undefined;
  try {
    const created = await r2.send(
      new CreateMultipartUploadCommand({ Bucket: env.R2_BUCKET, Key: objectKey, ContentType: parsed.data.mimeType })
    );
    uploadId = created.UploadId;
  } catch {
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 502 });
  }
  if (!uploadId) {
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 502 });
  }

  const { data: session, error: sessionError } = await svc
    .from('upload_sessions')
    .insert({
      video_id: video.id,
      r2_upload_id: uploadId,
      object_key: objectKey,
      part_size: plan.partSize,
      total_parts: plan.totalParts,
      created_by: ctx.userId,
    })
    .select('id')
    .single();

  if (sessionError || !session) {
    return NextResponse.json({ error: 'session_create_failed' }, { status: 500 });
  }

  await svc
    .from('videos')
    .update({ primary_storage_status: 'uploading', status: 'processing' })
    .eq('id', video.id);

  await writeAuditEvent({
    actorId: ctx.userId,
    actorRole: 'admin',
    eventType: 'upload_started',
    videoId: video.id,
    details: { filename: parsed.data.filename, sizeBytes: parsed.data.sizeBytes, totalParts: plan.totalParts },
  });

  return NextResponse.json({
    uploadSessionId: session.id,
    partSize: plan.partSize,
    totalParts: plan.totalParts,
  });
}
