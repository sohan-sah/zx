'use client';

import { useActionState, useState } from 'react';
import { updateVideoMetadataAction, type ActionState } from '@/lib/actions/admin-videos';
import { ThumbnailUpload } from '@/components/admin/thumbnail-upload';

const initialState: ActionState = { error: null };

export function VideoEditForm({
  videoId,
  title,
  description,
  categoryId,
  thumbnailKey,
  categories,
}: {
  videoId: string;
  title: string;
  description: string;
  categoryId: string | null;
  thumbnailKey: string | null;
  categories: { id: string; name: string }[];
}) {
  const boundAction = updateVideoMetadataAction.bind(null, videoId);
  const [state, formAction, pending] = useActionState(boundAction, initialState);
  const [pendingThumbnailKey, setPendingThumbnailKey] = useState<string | null>(null);

  return (
    <form action={formAction}>
      <label>
        Título
        <input type="text" name="title" defaultValue={title} maxLength={200} required />
      </label>
      <label>
        Descripción
        <textarea name="description" defaultValue={description} maxLength={5000} rows={6} />
      </label>
      <label>
        Categoría
        <select name="categoryId" defaultValue={categoryId ?? ''}>
          <option value="">Sin categoría</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <ThumbnailUpload videoId={videoId} currentKey={thumbnailKey} onUploaded={setPendingThumbnailKey} />
      <input type="hidden" name="thumbnailKey" value={pendingThumbnailKey ?? ''} />

      {state.error && <p role="alert">{state.error}</p>}
      <button type="submit" disabled={pending}>
        {pending ? 'Guardando…' : 'Guardar cambios'}
      </button>
    </form>
  );
}
