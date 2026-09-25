import 'server-only';

/**
 * Rate limiting via Upstash Redis REST API (works from Vercel serverless/edge; a plain in-memory
 * counter would NOT work correctly across serverless instances, so this deliberately does not use one).
 *
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are optional. If unset, this fails OPEN and logs
 * a warning on every call — acceptable for local development, NOT acceptable for production. Set
 * these two variables in Vercel before going live; login and admin-sensitive routes depend on this.
 */
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export type RateLimitResult = { allowed: boolean; remaining: number; configured: boolean };

/**
 * Fixed-window limiter: allows `limit` calls per `windowSeconds` for a given key.
 * key should already be a hash/opaque identifier (e.g. `login:<ip-hash>`), never a raw IP or email.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn(`[rate-limit] not configured; allowing "${key}" by default. Set UPSTASH_REDIS_REST_URL/TOKEN before production use.`);
    return { allowed: true, remaining: limit, configured: false };
  }

  const bucketKey = `ratelimit:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;

  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ['INCR', bucketKey],
      ['EXPIRE', bucketKey, String(windowSeconds)],
    ]),
    cache: 'no-store',
  });

  if (!res.ok) {
    console.error('[rate-limit] Upstash request failed; failing CLOSED for this call');
    return { allowed: false, remaining: 0, configured: true };
  }

  const [incrResult] = (await res.json()) as Array<{ result: number }>;
  const count = incrResult.result;
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), configured: true };
}
