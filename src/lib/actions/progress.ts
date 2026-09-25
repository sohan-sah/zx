'use server';

import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const schema = z.object({
  videoId: z.string().uuid(),
  positionSeconds: z.number().int().min(0).max(172800),
  durationSeconds: z.number().int().min(0).max(172800).nullable().optional(),
});

export type SaveProgressState = { error: string | null };

/**
 * Thin wrapper around the save_progress() Postgres function (migration 0002). Validation happens
 * twice on purpose: here for a fast, cheap rejection, and again inside the SECURITY DEFINER function
 * itself, which is the actual enforcement point and the one that matters if this action is ever
 * bypassed or called incorrectly.
 */
export async function saveProgressAction(input: {
  videoId: string;
  positionSeconds: number;
  durationSeconds?: number | null;
}): Promise<SaveProgressState> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: 'Datos de progreso inválidos.' };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('save_progress', {
    p_video_id: parsed.data.videoId,
    p_position_seconds: parsed.data.positionSeconds,
    p_duration_seconds: parsed.data.durationSeconds ?? null,
  });

  if (error) return { error: 'No se pudo guardar tu progreso.' };
  return { error: null };
}
