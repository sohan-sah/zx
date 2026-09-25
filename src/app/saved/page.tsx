import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { VideoCard } from '@/components/video-card';
import { SaveButton } from '@/components/save-button';

type SavedRow = {
  video_id: string;
  videos: { id: string; title: string; duration_seconds: number | null } | null;
};

export default async function SavedPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Nested select relies on the saved_videos.video_id -> videos.id foreign key for the embed.
  // RLS on saved_videos (own rows only) and on videos (published-only for non-admins) both still
  // apply to the embedded rows.
  const { data, error } = await supabase
    .from('saved_videos')
    .select('video_id, videos(id, title, duration_seconds)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .returns<SavedRow[]>();

  const rows = (data ?? []).filter((r): r is SavedRow & { videos: NonNullable<SavedRow['videos']> } => r.videos != null);

  return (
    <main>
      <h1>Guardados</h1>
      {error && <p role="alert">No se pudieron cargar tus videos guardados.</p>}
      {rows.length > 0 ? (
        <ul className="video-grid">
          {rows.map((r) => (
            <VideoCard key={r.video_id} id={r.videos.id} title={r.videos.title} durationSeconds={r.videos.duration_seconds}>
              <SaveButton videoId={r.videos.id} initiallySaved />
            </VideoCard>
          ))}
        </ul>
      ) : (
        <p className="empty-state">Aún no has guardado ningún video.</p>
      )}
    </main>
  );
}
