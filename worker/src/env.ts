function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required worker environment variable: ${name}`);
  }
  return value;
}

export const env = {
  // Direct Postgres connection as the dedicated `video_worker` role — NOT the Supabase service-role
  // key. That role's password is set manually outside Git (see docs/setup.md); this only reads the
  // resulting connection string from the environment.
  WORKER_DATABASE_URL: required('WORKER_DATABASE_URL'),

  WORKER_R2_ACCOUNT_ID: required('WORKER_R2_ACCOUNT_ID'),
  WORKER_R2_ACCESS_KEY_ID: required('WORKER_R2_ACCESS_KEY_ID'),
  WORKER_R2_SECRET_ACCESS_KEY: required('WORKER_R2_SECRET_ACCESS_KEY'),
  WORKER_R2_BUCKET: required('WORKER_R2_BUCKET'),

  B2_S3_ENDPOINT: required('B2_S3_ENDPOINT'),
  B2_KEY_ID: required('B2_KEY_ID'),
  B2_APPLICATION_KEY: required('B2_APPLICATION_KEY'),
  B2_BACKUP_BUCKET: required('B2_BACKUP_BUCKET'),

  WORKER_ID: process.env.WORKER_ID ?? `worker-${process.pid}`,
  WORKER_POLL_INTERVAL_SECONDS: Number(process.env.WORKER_POLL_INTERVAL_SECONDS ?? '5'),
  WORKER_LOCK_SECONDS: Number(process.env.WORKER_LOCK_SECONDS ?? '900'),
  WORKER_LOCK_EXTEND_MARGIN_SECONDS: 120, // extend the lock once this close to expiry
};
