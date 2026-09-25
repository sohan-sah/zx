'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const idSchema = z.string().uuid();

export type SavedActionState = { error: string | null };

export async function saveVideoAction(videoId: string): Promise<SavedActionState> {
  const parsed = idSchema.safeParse(videoId);
  if (!parsed.success) return { error: 'Video inválido.' };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'No has iniciado sesión.' };

  // RLS policy saved_insert_own already re-checks user_id = auth.uid() and that the video is
  // published; this insert cannot succeed for someone else's user_id or an unpublished video
  // no matter what is passed in.
  const { error } = await supabase.from('saved_videos').insert({ user_id: user.id, video_id: parsed.data });
  if (error && error.code !== '23505') {
    // 23505 = unique_violation (already saved) — treat as success, not an error.
    return { error: 'No se pudo guardar el video.' };
  }

  revalidatePath('/saved');
  revalidatePath(`/videos/${parsed.data}`);
  return { error: null };
}

export async function unsaveVideoAction(videoId: string): Promise<SavedActionState> {
  const parsed = idSchema.safeParse(videoId);
  if (!parsed.success) return { error: 'Video inválido.' };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'No has iniciado sesión.' };

  const { error } = await supabase
    .from('saved_videos')
    .delete()
    .eq('user_id', user.id)
    .eq('video_id', parsed.data);
  if (error) return { error: 'No se pudo quitar el video.' };

  revalidatePath('/saved');
  revalidatePath(`/videos/${parsed.data}`);
  return { error: null };
}
