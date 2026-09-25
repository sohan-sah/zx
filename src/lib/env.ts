import 'server-only';
import { z } from 'zod';

// Fails the build/boot loudly if a required var is missing, instead of failing silently at request time.
// Deliberately no NEXT_PUBLIC_* here: this app has no browser-side Supabase client.
const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  APP_ORIGIN: z.string().url(),
  AUDIT_IP_HASH_SALT: z.string().min(32, 'AUDIT_IP_HASH_SALT must be at least 32 random characters'),

  // Cloudflare R2 (primary private video/thumbnail storage). Never exposed to the browser: only
  // used server-side to presign URLs the browser then uses directly against R2.
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(
    `Invalid/missing server environment variables: ${missing}. Check .env.example and your Vercel project settings.`
  );
}

export const env = parsed.data;
