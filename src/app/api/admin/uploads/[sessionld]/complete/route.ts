import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CompleteMultipartUploadCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { requireAdminForApi } from '@/lib/auth/require-admin-api';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { createR2Client } from '@/lib/storage/r2-client';
import { writeAuditEvent } from '@/lib/audit/log';
import { rateLimit } from '@/lib/rate-limit';
import { env } from '@/lib/env';

const bodySchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        // The raw ETag string as R2 returned it on the part's PUT response (usually quoted, e.g.
        // "\"9a0364b9...\"") — passed through verbatim. R2/S3 itself is the authority on whether an
        // ETag is valid for a given part: CompleteMultipartUpload rejects any part whose ETag does
        // not match what R2 actually stored, so a forged ETag here cannot fake a completed part.
        etag: z.string().min(1).max(200),
      })
    )
    .min(1)
    .max(10_000),
});

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const guard = await requireAdminForApi();
  if ('response' in guard) return guard.response;
  const { ctx } = guard;

  const { sessionId } = await context.params;
  if (!z.string().uuid().safeParse(sessionId).success) {
    return NextResponse.json({ error: 'invalid_session' }, { status: 400 });
  }

  const limit = await rateLimit(`upload-complete:${ctx.userId}`, 10, 60);
  if (!limit.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const partNumbers = parsed.data.parts.map((p) => p.partNumber);
  if (new Set(partNumbers).size !== partNumbers.length) {
    return NextResponse.json({ error: 'duplicate_part_numbers' }, { status: 400 });
  }

  const svc = createServiceRoleClient();
  const { data: session } = await svc
    .from('upload_sessions')
    .select('id, video_id, r2_upload_id, object_key, total_parts, status, created_by')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session || session.created_by !== ctx.userId || session.status !== 'in_progress') {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
  }
  if (parsed.data.parts.length !== session.total_parts) {
    return NextResponse.json(
      { error: 'incomplete_parts', expected: session.total_parts, received: parsed.data.parts.length },
      { status: 409 }
    );
  }
  if (Math.max(...partNumbers) > session.total_parts) {
    return NextResponse.json({ error: 'part_number_out_of_range' }, { status: 400 });
  }

  const r2 = createR2Client();

  try {
    await r2.send(
      new CompleteMultipartUploadCommand({
        Bucket: env.R2_BUCKET,
        Key: session.object_key,
        UploadId: session.r2_upload_id,
        MultipartUpload: {
          Parts: parsed.data.parts
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      })
    );
  } catch {
    // Left in 'in_progress' on purpose: whatever caused this (a bad/stale ETag, a missing part) is
    // usually recoverable by the client re-checking GET .../parts and retrying, not a reason to
    // force starting the whole upload over.
    return NextResponse.json({ error: 'r2_complete_failed' }, { status: 502 });
  }

  let sizeBytes: number | null = null;
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: session.object_key }));
    sizeBytes = head.ContentLength ?? null;
  } catch {
    // The multipart upload itself succeeded even if this confirmation call failed; size_bytes will
    // just be null until the worker fills it in during backup/verification.
  }

  await svc
    .from('upload_sessions')
    .update({ status: 'completed' })
    .eq('id', session.id);

  await svc
    .from('videos')
    .update({
      primary_object_key: session.object_key,
      primary_storage_status: 'available',
      size_bytes: sizeBytes,
    })
    .eq('id', session.video_id);

  // One row per video can be queued/processing/retrying at a time (migration 0003's partial unique
  // index) — a duplicate call here is harmless and just fails this insert silently via that
  // constraint rather than creating a second backup job.
  await svc.from('video_jobs').insert({ type: 'backup_video', video_id: session.video_id });

  await writeAuditEvent({
    actorId: ctx.userId,
    actorRole: 'admin',
    eventType: 'upload_completed',
    videoId: session.video_id,
    details: { sizeBytes, totalParts: session.total_parts },
  });

  return NextResponse.json({ ok: true, videoId: session.video_id, sizeBytes });
}
