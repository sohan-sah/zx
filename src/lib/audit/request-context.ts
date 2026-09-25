import 'server-only';
import { createHash } from 'node:crypto';
import { headers } from 'next/headers';
import { env } from '@/lib/env';

/**
 * Returns a salted, non-reversible hash of the caller's IP for audit logging — never the raw IP.
 * On Vercel, x-forwarded-for's first entry is the original client (Vercel's edge sets this header
 * itself; it cannot be spoofed by the client past Vercel's proxy).
 */
export async function hashedClientIp(): Promise<string | null> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim();
  if (!ip) return null;
  return createHash('sha256').update(env.AUDIT_IP_HASH_SALT).update(ip).digest('hex');
}

export async function currentUserAgent(): Promise<string | null> {
  const h = await headers();
  return h.get('user-agent')?.slice(0, 300) ?? null;
}
