import Link from 'next/link';

function formatDuration(totalSeconds: number | null): string | null {
  if (totalSeconds == null || totalSeconds <= 0) return null;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

export function VideoCard({
  id,
  title,
  durationSeconds,
  children,
}: {
  id: string;
  title: string;
  durationSeconds: number | null;
  /** Optional extra controls (e.g. a save/unsave button) rendered below the meta line. */
  children?: React.ReactNode;
}) {
  const duration = formatDuration(durationSeconds);
  return (
    <li className="video-card">
      <Link href={`/videos/${id}`} className="video-card__title">
        {title}
      </Link>
      {duration && <p className="video-card__meta">{duration}</p>}
      {children}
    </li>
  );
}
