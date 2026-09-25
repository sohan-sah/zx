'use client';

import { useState, useTransition } from 'react';
import { publishVideoAction, unpublishVideoAction } from '@/lib/actions/admin-videos';

export function PublishControls({ videoId, status, canPublish }: { videoId: string; status: string; canPublish: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function publish() {
    setError(null);
    startTransition(async () => {
      const result = await publishVideoAction(videoId);
      if (result.error) setError(result.error);
    });
  }

  function unpublish() {
    setError(null);
    startTransition(async () => {
      const result = await unpublishVideoAction(videoId);
      if (result.error) setError(result.error);
    });
  }

  return (
    <div>
      {status !== 'published' && (
        <button type="button" onClick={publish} disabled={pending || !canPublish} title={!canPublish ? 'El archivo del video debe estar disponible primero.' : undefined}>
          {pending ? 'Publicando…' : 'Publicar'}
        </button>
      )}
      {status === 'published' && (
        <button type="button" className="button--secondary" onClick={unpublish} disabled={pending}>
          {pending ? 'Despublicando…' : 'Despublicar'}
        </button>
      )}
      {!canPublish && status !== 'published' && (
        <p className="video-card__meta">No se puede publicar hasta que el archivo esté disponible.</p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
