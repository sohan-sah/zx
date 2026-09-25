'use client';

import { useState, useTransition } from 'react';
import { saveVideoAction, unsaveVideoAction } from '@/lib/actions/saved';

export function SaveButton({ videoId, initiallySaved }: { videoId: string; initiallySaved: boolean }) {
  const [saved, setSaved] = useState(initiallySaved);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    setError(null);
    const next = !saved;
    setSaved(next); // optimistic
    startTransition(async () => {
      const result = next ? await saveVideoAction(videoId) : await unsaveVideoAction(videoId);
      if (result.error) {
        setSaved(!next); // revert
        setError(result.error);
      }
    });
  }

  return (
    <div>
      <button type="button" className="button--secondary" onClick={toggle} disabled={pending} aria-pressed={saved}>
        {saved ? 'Quitar de guardados' : 'Guardar'}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
