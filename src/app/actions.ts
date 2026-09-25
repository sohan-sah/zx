'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { writeAuditEvent } from '@/lib/audit/log';
import { hashedClientIp } from '@/lib/audit/request-context';
import { rateLimit } from '@/lib/rate-limit';

const schema = z.object({ code: z.string().regex(/^\d{6}$/, 'Ingresa un código de 6 dígitos.') });

export type VerifyState = { error: string | null };

export async function verifyMfaAction(_prev: VerifyState, formData: FormData): Promise<VerifyState> {
  const parsed = schema.safeParse({ code: formData.get('code') });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Código inválido.' };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const ipHash = (await hashedClientIp()) ?? 'unknown';
  const limit = await rateLimit(`mfa:${user.id}:${ipHash}`, 5, 60);
  if (!limit.allowed) {
    return { error: 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.' };
  }

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const factor = factors?.totp?.[0];
  if (!factor) {
    return { error: 'No hay un método de MFA configurado.' };
  }

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: factor.id });
  if (challengeError || !challenge) {
    return { error: 'No se pudo iniciar la verificación.' };
  }

  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId: factor.id,
    challengeId: challenge.id,
    code: parsed.data.code,
  });

  if (verifyError) {
    await writeAuditEvent({ actorId: user.id, actorRole: 'user', eventType: 'login_failed', details: { stage: 'mfa' } });
    return { error: 'Código incorrecto.' };
  }

  redirect('/');
}
