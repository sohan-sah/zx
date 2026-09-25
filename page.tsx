import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/require-admin';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { VideoEditForm } from './video-edit-form';
import { VideoUpload } from '@/components/admin/video-upload';
import { PublishControls } from '@/components/admin/publish-controls';
import { DeleteVideoForm } from '@/components/admin/delete-video-form';

const idSchema = z.string().uuid();

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export default async function AdminVideoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();

  const { id } = await params;
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) notFound();

  const svc = createServiceRoleClient();
  const [{ data: video, error }, { data: categories }] = await Promise.all([
    svc
      .from('videos')
      .select(
        'id, title, description, category_id, thumbnail_key, status, primary_storage_status, size_bytes, sha256, backup_status, backup_verified_at, last_backup_attempt, backup_error'
      )
      .eq('id', parsedId.data)
      .maybeSingle(),
    svc.from('categories').select('id, name').order('name'),
  ]);

  if (error || !video) notFound();

  return (
    <main>
      <h1>{video.title}</h1>

      <section>
        <h2>Metadatos</h2>
        <VideoEditForm
          videoId={video.id}
          title={video.title}
          description={video.description}
          categoryId={video.category_id}
          thumbnailKey={video.thumbnail_key}
          categories={categories ?? []}
        />
      </section>

      <section>
        <h2>Archivo de video</h2>
        <VideoUpload videoId={video.id} initialStatus={video.primary_storage_status} />
      </section>

      <section>
        <h2>Estado de almacenamiento y respaldo</h2>
        <dl>
          <dt>Almacenamiento principal</dt>
          <dd>{video.primary_storage_status}</dd>
          <dt>Tamaño</dt>
          <dd>{formatBytes(video.size_bytes)}</dd>
          <dt>SHA-256</dt>
          <dd>{video.sha256 ?? 'Aún no calculado'}</dd>
          <dt>Estado del respaldo</dt>
          <dd>{video.backup_status}</dd>
          <dt>Último intento de respaldo</dt>
          <dd>{video.last_backup_attempt ?? '—'}</dd>
          <dt>Verificado el</dt>
          <dd>{video.backup_verified_at ?? '—'}</dd>
          {video.backup_error && (
            <>
              <dt>Error de respaldo</dt>
              <dd role="alert">{video.backup_error}</dd>
            </>
          )}
        </dl>
      </section>

      <section>
        <h2>Publicación</h2>
        <PublishControls videoId={video.id} status={video.status} canPublish={video.primary_storage_status === 'available'} />
      </section>

      <section>
        <h2>Eliminar archivo principal</h2>
        <DeleteVideoForm videoId={video.id} title={video.title} backupStatus={video.backup_status} />
      </section>
    </main>
  );
}
