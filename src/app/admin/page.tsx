import Link from 'next/link';

export default function AdminDashboardPage() {
  return (
    <main>
      <h1>Panel de administración</h1>
      <p>
        <Link href="/admin/videos" className="button">
          Gestionar videos
        </Link>
      </p>
      <p className="video-card__meta">
        El panel de respaldos, restauración y los registros de auditoría se agregan en una fase
        posterior.
      </p>
    </main>
  );
}
