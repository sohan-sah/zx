import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireAdminForApi } from '@/lib/auth/require-admin-api';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { createR2Client } from '@/lib/storage/r2-client';
import { thumbnailObjectKey } from '@/lib/storage/object-key';
import { extensionForThumbnailMime } from '@/lib/storage/video-mime';
import { rateLimit } from '@/lib/rate-limit';
import { env } from '@/lib/env';

const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

const bodySchema = z.object({
  videoId: z.string().uuid(),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive().max(MAX_THUMBNAIL_BYTES),
});

/**
 * Thumbnails are small enough for a single presigned PUT — no multipart/resume machinery needed.
 * The browser PUTs the image bytes directly to R2 using the URL this returns; this route never
 * touches the image bytes themselves.
 */
export async function POST(request: Request) {
  const guard = await requireAdminForApi();
  if ('response' in guard) return guard.response;
  const { ctx } = guard;

  const limit = await rateLimit(`thumbnail-sign:${ctx.userId}`, 30, 60);
  if (!limit.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const ext = extensionForThumbnailMime(parsed.data.mimeType);
  if (!ext) return NextResponse.json({ error: 'unsupported_mime_type' }, { status: 400 });

  const svc = createServiceRoleClient();
  const { data: video } = await svc.from('videos').select('id').eq('id', parsed.data.videoId).maybeSingle();
  if (!video) return NextResponse.json({ error: 'video_not_found' }, { status: 404 });

  const objectKey = thumbnailObjectKey(video.id, parsed.data.mimeType);
  const r2 = createR2Client();
  const url = await getSignedUrl(
    r2,
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: objectKey,
      ContentType: parsed.data.mimeType,
      ContentLength: parsed.data.sizeBytes,
    }),
    { expiresIn: 600 }
  );

  return NextResponse.json({ url, objectKey });
}
