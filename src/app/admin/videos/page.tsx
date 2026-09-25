import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/require-admin';
import { createServiceRoleClient } from '@/lib/supabase/service-role';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  processing: 'Procesando',
  published: 'Publicado',
  unpublished: 'Despublicado',
};

const STORAGE_LABEL: Record<string, string> = {
  pending: 'Sin subir',
  uploading: 'Subiendo',
  available: 'Disponible',
  missing: 'Faltante',
  corrupted: 'Dañado',
};

const BACKUP_LABEL: Record<string, string> = {
  none: 'Sin respaldo',
  queued: 'En cola',
  in_progress: 'En progreso',
  copied: 'Copiado',
  verified: 'Verificado',
  failed: 'Fallido',
  mismatch: 'No coincide',
};

export default async function AdminVideosPage() {
  // requireAdmin() also runs in the /admin layout on every request; calling it again here is
  // intentional defense-in-depth (see require-admin.ts) and is what authorizes the service-role
  // read below, which returns columns normal authenticated users cannot select.
  await requireAdmin();

  const svc = createServiceRoleClient();
  const { data: videos, error } = await svc
    .from('videos')
    .select('id, title, status, primary_storage_status, backup_status, created_at')
    .order('created_at', { ascending: false });

  return (
    <main>
      <h1>Videos</h1>
      <p>
        <Link href="/admin/videos/new" className="button">
          Crear video
        </Link>
      </p>
      {error && <p role="alert">No se pudieron cargar los videos.</p>}
      {videos && videos.length > 0 ? (
        <ul className="video-grid">
          {videos.map((v) => (
            <li key={v.id} className="video-card">
              <Link href={`/admin/videos/${v.id}`} className="video-card__title">
                {v.title}
              </Link>
              <p className="video-card__meta">
                {STATUS_LABEL[v.status] ?? v.status} · Almacenamiento: {STORAGE_LABEL[v.primary_storage_status] ?? v.primary_storage_status} ·
                Respaldo: {BACKUP_LABEL[v.backup_status] ?? v.backup_status}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">Todavía no hay videos.</p>
      )}
    </main>
  );
}
