import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { VideoPlayer } from '@/components/video-player';
import { SaveButton } from '@/components/save-button';

const idSchema = z.string().uuid();

export default async function VideoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) notFound();

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // RLS (videos_read) already restricts this to published videos unless the caller is the admin;
  // .eq('status', 'published') keeps the intent explicit without weakening what RLS enforces.
  const { data: video, error } = await supabase
    .from('videos')
    .select('id, title, description, duration_seconds, status')
    .eq('id', parsedId.data)
    .maybeSingle();

  if (error || !video || (video.status !== 'published')) {
    notFound();
  }

  const [{ data: progress }, { data: saved }] = await Promise.all([
    supabase
      .from('watch_progress')
      .select('position_seconds')
      .eq('user_id', user.id)
      .eq('video_id', video.id)
      .maybeSingle(),
    supabase
      .from('saved_videos')
      .select('video_id')
      .eq('user_id', user.id)
      .eq('video_id', video.id)
      .maybeSingle(),
  ]);

  return (
    <main>
      <VideoPlayer videoId={video.id} src={null} initialPositionSeconds={progress?.position_seconds ?? 0} />
      <h1>{video.title}</h1>
      <SaveButton videoId={video.id} initiallySaved={saved != null} />
      {video.description && <p>{video.description}</p>}
    </main>
  );
}
