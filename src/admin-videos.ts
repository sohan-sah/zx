'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { requireAdmin } from '@/lib/auth/require-admin';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { createR2Client } from '@/lib/storage/r2-client';
import { writeAuditEvent } from '@/lib/audit/log';
import { rateLimit } from '@/lib/rate-limit';
import { env } from '@/lib/env';

// Every action below starts with requireAdmin(). Server Actions are callable directly as HTTP
// endpoints by anyone who knows their action id — there is no implicit protection from the /admin
// route's layout guard, which only runs for page navigations. Never remove these calls.

const metadataSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).default(''),
  categoryId: z.string().uuid().nullable(),
});

export type ActionState = { error: string | null };

export async function createVideoAction(formData: FormData): Promise<void> {
  const ctx = await requireAdmin();

  const limit = await rateLimit(`admin-create-video:${ctx.userId}`, 30, 60);
  if (!limit.allowed) throw new Error('rate_limited');

  const parsed = metadataSchema.safeParse({
    title: formData.get('title'),
    description: formData.get('description') ?? '',
    categoryId: formData.get('categoryId') || null,
  });
  if (!parsed.success) throw new Error('invalid_input');

  const svc = createServiceRoleClient();
  const { data: video, error } = await svc
    .from('videos')
    .insert({
      title: parsed.data.title,
      description: parsed.data.description,
      category_id: parsed.data.categoryId,
      created_by: ctx.userId,
    })
    .select('id')
    .single();

  if (error || !video) throw new Error('create_failed');

  await writeAuditEvent({
    actorId: ctx.userId,
    actorRole: 'admin',
    eventType: 'edit',
    videoId: video.id,
    details: { action: 'create' },
  });

  revalidatePath('/admin/videos');
  redirect(`/admin/videos/${video.id}`);
}

export async function updateVideoMetadataAction(
  videoId: string,
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsedId = z.string().uuid().safeParse(videoId);
  if (!parsedId.success) return { error: 'Video inválido.' };

  const ctx = await requireAdmin();
  const limit = await rateLimit(`admin-edit-video:${ctx.userId}`, 60, 60);
  if (!limit.allowed) return { error: 'Demasiadas solicitudes. Espera un minuto.' };

  const parsed = metadataSchema.safeParse({
    title: formData.get('title'),
    description: formData.get('description') ?? '',
    categoryId: formData.get('categoryId') || null,
  });
  if (!parsed.success) return { error: 'Datos inválidos.' };

  // thumbnailKey is set separately by the thumbnail uploader (src/components/admin/thumbnail-upload.tsx)
  // after a successful presigned PUT to R2, then submitted here as a hidden field so the edit form
  // stays a single save action from the admin's point of view.
  const thumbnailKeyRaw = formData.get('thumbnailKey');
  const thumbnailKey = typeof thumbnailKeyRaw === 'string' && thumbnailKeyRaw.length > 0 ? thumbnailKeyRaw : undefined;

  const svc = createServiceRoleClient();
  const update: Record<string, unknown> = {
    title: parsed.data.title,
    description: parsed.data.description,
    category_id: parsed.data.categoryId,
  };
  if (thumbnailKey) update.thumbnail_key = thumbnailKey;

  const { error } = await svc.from('videos').update(update).eq('id', parsedId.data);
  if (error) return { error: 'No se pudo guardar.' };

  await writeAuditEvent({ actorId: ctx.userId, actorRole: 'admin', eventType: 'edit', videoId: parsedId.data });

  revalidatePath(`/admin/videos/${parsedId.data}`);
  revalidatePath('/admin/videos');
  return { error: null };
}

export async function publishVideoAction(videoId: string): Promise<{ error: string | null }> {
  const parsedId = z.string().uuid().safeParse(videoId);
  if (!parsedId.success) return { error: 'Video inválido.' };

  const ctx = await requireAdmin();
  const limit = await rateLimit(`admin-publish:${ctx.userId}`, 30, 60);
  if (!limit.allowed) return { error: 'Demasiadas solicitudes. Espera un minuto.' };

  const svc = createServiceRoleClient();
  // The database trigger (migration 0003, videos_guard) is the real enforcement: it raises an
  // exception if primary_storage_status is not 'available'. This UPDATE either succeeds because
  // storage is genuinely ready, or fails with that exception — there is no code path here that can
  // publish a video whose file isn't actually available.
  const { error } = await svc.from('videos').update({ status: 'published' }).eq('id', parsedId.data);
  if (error) {
    return { error: 'No se puede publicar: el archivo del video aún no está disponible.' };
  }

  await writeAuditEvent({ actorId: ctx.userId, actorRole: 'admin', eventType: 'publish', videoId: parsedId.data });
  revalidatePath(`/admin/videos/${parsedId.data}`);
  revalidatePath('/admin/videos');
  revalidatePath('/');
  return { error: null };
}

export async function unpublishVideoAction(videoId: string): Promise<{ error: string | null }> {
  const parsedId = z.string().uuid().safeParse(videoId);
  if (!parsedId.success) return { error: 'Video inválido.' };

  const ctx = await requireAdmin();
  const limit = await rateLimit(`admin-unpublish:${ctx.userId}`, 30, 60);
  if (!limit.allowed) return { error: 'Demasiadas solicitudes. Espera un minuto.' };

  const svc = createServiceRoleClient();
  const { error } = await svc.from('videos').update({ status: 'unpublished' }).eq('id', parsedId.data);
  if (error) return { error: 'No se pudo despublicar.' };

  await writeAuditEvent({ actorId: ctx.userId, actorRole: 'admin', eventType: 'unpublish', videoId: parsedId.data });
  revalidatePath(`/admin/videos/${parsedId.data}`);
  revalidatePath('/admin/videos');
  revalidatePath('/');
  return { error: null };
}

const deleteSchema = z.object({
  videoId: z.string().uuid(),
  confirmTitle: z.string().min(1),
  acknowledgeNoBackup: z.boolean().optional(),
});

export type DeleteState = { error: string | null; requiresBackupAcknowledgement: boolean };

/**
 * Deletes the PRIMARY object only — never the B2 backup (a separate, deliberately harder action,
 * not built in this slice). Requires the admin to type the video's exact title to confirm, and if
 * there is no verified backup, requires an explicit extra acknowledgement checkbox.
 */
export async function deleteVideoPrimaryAction(_prev: DeleteState, formData: FormData): Promise<DeleteState> {
  const parsed = deleteSchema.safeParse({
    videoId: formData.get('videoId'),
    confirmTitle: formData.get('confirmTitle'),
    acknowledgeNoBackup: formData.get('acknowledgeNoBackup') === 'on',
  });
  if (!parsed.success) return { error: 'Datos inválidos.', requiresBackupAcknowledgement: false };

  const ctx = await requireAdmin();
  const limit = await rateLimit(`admin-delete-video:${ctx.userId}`, 10, 60);
  if (!limit.allowed) return { error: 'Demasiadas solicitudes. Espera un minuto.', requiresBackupAcknowledgement: false };

  const svc = createServiceRoleClient();
  const { data: video, error: videoError } = await svc
    .from('videos')
    .select('id, title, primary_object_key, backup_status, status')
    .eq('id', parsed.data.videoId)
    .maybeSingle();

  if (videoError || !video) return { error: 'Video no encontrado.', requiresBackupAcknowledgement: false };
  if (parsed.data.confirmTitle !== video.title) {
    return { error: 'El título escrito no coincide.', requiresBackupAcknowledgement: false };
  }
  if (video.backup_status !== 'verified' && !parsed.data.acknowledgeNoBackup) {
    return {
      error: 'Este video no tiene una copia de seguridad verificada. Marca la casilla para confirmar que entiendes que la eliminación puede ser irreversible.',
      requiresBackupAcknowledgement: true,
    };
  }

  if (video.primary_object_key) {
    const r2 = createR2Client();
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: video.primary_object_key }));
    } catch {
      return { error: 'No se pudo eliminar el archivo en el almacenamiento. Inténtalo de nuevo.', requiresBackupAcknowledgement: false };
    }
  }

  const nextStatus = video.status === 'published' ? 'unpublished' : video.status;
  const { error: updateError } = await svc
    .from('videos')
    .update({
      primary_object_key: null,
      primary_storage_status: 'missing',
      status: nextStatus,
    })
    .eq('id', video.id);
  if (updateError) return { error: 'No se pudo actualizar el registro del video.', requiresBackupAcknowledgement: false };

  await writeAuditEvent({
    actorId: ctx.userId,
    actorRole: 'admin',
    eventType: 'delete_primary',
    videoId: video.id,
    details: { hadVerifiedBackup: video.backup_status === 'verified' },
  });

  revalidatePath('/admin/videos');
  redirect('/admin/videos');
}
