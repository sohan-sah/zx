import { S3Client } from '@aws-sdk/client-s3';
import { env } from './env.js';

// requestChecksumCalculation/responseChecksumValidation pinned to 'WHEN_REQUIRED': recent AWS SDK v3
// versions default to always sending/validating extra checksums (aws-chunked trailing checksums),
// which R2 and B2's S3-compatible APIs do not fully support and which can otherwise cause uploads to
// fail with errors like InvalidContentEncoding or a rejected trailer.
const CHECKSUM_CONFIG = {
  requestChecksumCalculation: 'WHEN_REQUIRED' as const,
  responseChecksumValidation: 'WHEN_REQUIRED' as const,
};

export function createR2Client(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${env.WORKER_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.WORKER_R2_ACCESS_KEY_ID,
      secretAccessKey: env.WORKER_R2_SECRET_ACCESS_KEY,
    },
    ...CHECKSUM_CONFIG,
  });
}

export function createB2Client(): S3Client {
  return new S3Client({
    // B2's S3-compatible API is region-locked per account; the region name is embedded in
    // B2_S3_ENDPOINT (e.g. https://s3.us-west-004.backblazeb2.com) and Backblaze docs say to pass a
    // matching region string here for correct SigV4 signing — derived from the endpoint below rather
    // than hardcoded, so this keeps working if the bucket's region changes.
    region: new URL(env.B2_S3_ENDPOINT).hostname.split('.')[1] ?? 'us-west-004',
    endpoint: env.B2_S3_ENDPOINT,
    credentials: {
      accessKeyId: env.B2_KEY_ID,
      secretAccessKey: env.B2_APPLICATION_KEY,
    },
    ...CHECKSUM_CONFIG,
  });
}
