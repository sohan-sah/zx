'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { hashedClientIp } from '@/lib/audit/request-context';
import { rateLimit } from '@/lib/rate-limit';
import { env } from '@/lib/env';

const schema = z.object({
  email: z.string().email().max(254),
  // Length + a mix requirement; Supabase itself also enforces a minimum (configure in dashboard).
  password: z
    .string()
    .min(12, 'La contraseña debe tener al menos 12 caracteres.')
    .max(200)
    .regex(/[a-z]/, 'Incluye una letra minúscula.')
    .regex(/[A-Z]/, 'Incluye una letra mayúscula.')
    .regex(/[0-9]/, 'Incluye un número.'),
});

export type SignupState = { error: string | null; success: boolean };

export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const parsed = schema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Datos inválidos.', success: false };
  }

  const ipHash = (await hashedClientIp()) ?? 'unknown';
  const limit = await rateLimit(`signup:${ipHash}`, 5, 60);
  if (!limit.allowed) {
    return { error: 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.', success: false };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { emailRedirectTo: `${env.APP_ORIGIN}/login` },
  });

  // Same generic response whether or not the email already exists, so account existence is never
  // revealed via signup either.
  if (error && error.status !== 400) {
    return { error: 'No se pudo crear la cuenta. Inténtalo de nuevo más tarde.', success: false };
  }

  return { error: null, success: true };
}

export async function redirectAfterSignup() {
  redirect('/login');
}
