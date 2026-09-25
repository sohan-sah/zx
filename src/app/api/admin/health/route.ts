import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase/service-role';

export const dynamic = 'force-dynamic';

/**
 * Liveness/readiness check for Vercel + uptime monitoring. Confirms env vars are valid (env.ts
 * throws at import time otherwise) and that the database is reachable. Never returns error details,
 * stack traces, or connection strings — only a boolean-ish status.
 */
export async function GET() {
  try {
    void env; // importing env.ts already validated required vars at module load
    const supabase = createServiceRoleClient();
    const { error } = await supabase.from('categories').select('id').limit(1);
    if (error) {
      return NextResponse.json({ status: 'degraded' }, { status: 503 });
    }
    return NextResponse.json({ status: 'ok' });
  } catch {
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}
