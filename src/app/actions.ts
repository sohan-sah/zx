'use server';

import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { writeAuditEvent } from '@/lib/audit/log';

export type EnrollState = { error: string | null; qrCode: string | null; secret: string | null; factorId: string | null };

export async function startEnrollAction(): Promise<EnrollState> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'No has iniciado sesión.', qrCode: null, secret: null, factorId: null };

  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
  if (error || !data) {
    return { error: 'No se pudo iniciar la configuración de MFA.', qrCode: null, secret: null, factorId: null };
  }

  return { error: null, qrCode: data.totp.qr_code, secret: data.totp.secret, factorId: data.id };
}

const confirmSchema = z.object({
  factorId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'Ingresa un código de 6 dígitos.'),
});

export type ConfirmState = { error: string | null; success: boolean };

export async function confirmEnrollAction(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const parsed = confirmSchema.safeParse({
    factorId: formData.get('factorId'),
    code: formData.get('code'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Código inválido.', success: false };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'No has iniciado sesión.', success: false };

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId: parsed.data.factorId,
  });
  if (challengeError || !challenge) {
    return { error: 'No se pudo verificar el código.', success: false };
  }

  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId: parsed.data.factorId,
    challengeId: challenge.id,
    code: parsed.data.code,
  });
  if (verifyError) {
    return { error: 'Código incorrecto. Inténtalo de nuevo.', success: false };
  }

  await writeAuditEvent({ actorId: user.id, actorRole: 'user', eventType: 'mfa_enrolled' });
  return { error: null, success: true };
}
