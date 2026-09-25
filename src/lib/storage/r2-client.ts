import 'server-only';
import { S3Client } from '@aws-sdk/client-s3';
import { env } from '@/lib/env';

let client: S3Client | null = null;

/**
 * Cloudflare R2 client (S3-compatible). Credentials come only from server-side env vars and are
 * never sent to the browser — this module must never be imported from a Client Component. The
 * browser talks to R2 directly only via presigned URLs this server issues per part/object.
 *
 * requestChecksumCalculation/responseChecksumValidation are pinned to 'WHEN_REQUIRED': recent AWS
 * SDK v3 versions default to always sending/validating extra checksums (e.g. aws-chunked trailing
 * checksums), which several S3-compatible providers — R2 and B2 included — do not fully support and
 * which can cause uploads to fail with errors like InvalidContentEncoding. Cached across invocations
 * within one serverless instance since S3Client is safe to reuse.
 */
export function createR2Client(): S3Client {
  if (client) return client;
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}
