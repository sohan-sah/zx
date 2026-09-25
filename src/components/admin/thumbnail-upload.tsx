'use client';

import { useState } from 'react';

const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024;

export function ThumbnailUpload({
  videoId,
  currentKey,
  onUploaded,
}: {
  videoId: string;
  currentKey: string | null;
  onUploaded: (objectKey: string) => void;
}) {
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setStatus('uploading');
    setError(null);

    if (file.size > MAX_BYTES) {
      setError('El archivo supera el tamaño máximo (5 MB).');
      setStatus('error');
      return;
    }

    try {
      const signRes = await fetch('/api/admin/thumbnails/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, mimeType: file.type, sizeBytes: file.size }),
      });
      if (!signRes.ok) throw new Error();
      const { url, objectKey } = (await signRes.json()) as { url: string; objectKey: string };

      const putRes = await fetch(url, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!putRes.ok) throw new Error();

      onUploaded(objectKey);
      setStatus('done');
    } catch {
      setError('No se pudo subir la miniatura.');
      setStatus('error');
    }
  }

  return (
    <div>
      <label>
        Miniatura (JPEG, PNG o WebP, máx. 5 MB)
        <input
          type="file"
          accept={ACCEPTED_MIME.join(',')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </label>
      {status === 'uploading' && <p>Subiendo…</p>}
      {status === 'done' && <p>Miniatura actualizada (se guardará al enviar el formulario).</p>}
      {status === 'error' && <p role="alert">{error}</p>}
      {currentKey && status === 'idle' && <p className="video-card__meta">Miniatura actual: {currentKey}</p>}
    </div>
  );
}
