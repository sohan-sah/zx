'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const schema = z.object({ displayName: z.string().trim().min(1).max(80) });

export type ProfileState = { error: string | null; success: boolean };

export async function updateProfileAction(_prev: ProfileState, formData: FormData): Promise<ProfileState> {
  const parsed = schema.safeParse({ displayName: formData.get('displayName') });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Nombre inválido.', success: false };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'No has iniciado sesión.', success: false };

  // RLS policy profiles_update_own restricts this to the caller's own row regardless of any id
  // supplied here (none is): the grant is column-scoped to display_name only.
  const { error } = await supabase
    .from('profiles')
    .update({ display_name: parsed.data.displayName })
    .eq('id', user.id);

  if (error) return { error: 'No se pudo actualizar el perfil.', success: false };

  revalidatePath('/profile');
  return { error: null, success: true };
}
