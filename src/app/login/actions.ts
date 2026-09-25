'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { writeAuditEvent } from '@/lib/audit/log';
import { hashedClientIp } from '@/lib/audit/request-context';
import { rateLimit } from '@/lib/rate-limit';

const schema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

// Generic message for every failure path: never reveal whether an account exists.
const GENERIC_ERROR = 'Correo electrónico o contraseña incorrectos.';

export type LoginState = { error: string | null };

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: GENERIC_ERROR };
  }

  const ipHash = (await hashedClientIp()) ?? 'unknown';
  const limit = await rateLimit(`login:${ipHash}`, 10, 60);
  if (!limit.allowed) {
    return { error: 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.' };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error || !data.user) {
    await writeAuditEvent({ actorId: null, actorRole: 'anonymous', eventType: 'login_failed' });
    return { error: GENERIC_ERROR };
  }

  await writeAuditEvent({ actorId: data.user.id, actorRole: 'user', eventType: 'login' });

  // Password step passed (aal1). If this account has MFA enrolled, Supabase will require an
  // aal2 challenge next — requireAdmin() checks aal2 explicitly, so admin routes stay protected
  // even if this redirect is skipped somehow.
  const { data: factors } = await supabase.auth.mfa.listFactors();
  if ((factors?.totp?.length ?? 0) > 0) {
    redirect('/mfa/verify');
  }

  redirect('/');
}
