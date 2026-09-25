import { createServerSupabaseClient } from '@/lib/supabase/server';
import { VideoCard } from '@/components/video-card';

export default async function HomePage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main>
        <h1>Plataforma de Video</h1>
        <p>Inicia sesión o crea una cuenta para ver el catálogo.</p>
      </main>
    );
  }

  // RLS + column-level grants already restrict this to published videos and browser-safe columns;
  // the explicit .eq('status', 'published') keeps the query's intent readable, not the enforcement.
  const { data: videos, error } = await supabase
    .from('videos')
    .select('id, title, duration_seconds, published_at')
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .limit(24);

  return (
    <main>
      <h1>Inicio</h1>
      {error && <p role="alert">No se pudieron cargar los videos.</p>}
      {videos && videos.length > 0 ? (
        <ul className="video-grid">
          {videos.map((v) => (
            <VideoCard key={v.id} id={v.id} title={v.title} durationSeconds={v.duration_seconds} />
          ))}
        </ul>
      ) : (
        <p className="empty-state">Todavía no hay videos publicados.</p>
      )}
    </main>
  );
}
