import { createServerSupabaseClient } from '@/lib/supabase/server';
import { VideoCard } from '@/components/video-card';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? '').trim().slice(0, 200); // cap length; the query text goes through the
  // Postgres client's parameterized query builder, never string-concatenated SQL, so this length
  // cap is a usability/DoS guard, not an injection defense.

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main>
        <h1>Buscar</h1>
        <p>Inicia sesión para buscar en el catálogo.</p>
      </main>
    );
  }

  let videos: { id: string; title: string; duration_seconds: number | null }[] = [];
  let searchError = false;

  if (query.length > 0) {
    const { data, error } = await supabase
      .from('videos')
      .select('id, title, duration_seconds')
      .eq('status', 'published')
      // 'websearch' tolerates natural free-text input ("película de", quotes, -exclusions) without
      // the caller having to construct valid tsquery syntax themselves.
      .textSearch('tsv', query, { type: 'websearch', config: 'spanish' })
      .order('published_at', { ascending: false })
      .limit(24);

    if (error) {
      searchError = true;
    } else {
      videos = data ?? [];
    }
  }

  return (
    <main>
      <h1>Buscar</h1>
      <form action="/search" method="get">
        <label>
          Título o descripción
          <input type="text" name="q" defaultValue={query} maxLength={200} autoFocus />
        </label>
        <button type="submit">Buscar</button>
      </form>

      {searchError && <p role="alert">No se pudo completar la búsqueda.</p>}

      {query.length > 0 && !searchError && (
        <>
          {videos.length > 0 ? (
            <ul className="video-grid">
              {videos.map((v) => (
                <VideoCard key={v.id} id={v.id} title={v.title} durationSeconds={v.duration_seconds} />
              ))}
            </ul>
          ) : (
            <p className="empty-state">Sin resultados para &ldquo;{query}&rdquo;.</p>
          )}
        </>
      )}
    </main>
  );
}
