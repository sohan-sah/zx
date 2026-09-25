'use client';

import { useActionState, useState } from 'react';
import { deleteVideoPrimaryAction, type DeleteState } from '@/lib/actions/admin-videos';

const initialState: DeleteState = { error: null, requiresBackupAcknowledgement: false };

/**
 * Confirmation is enforced two ways, both server-verified in deleteVideoPrimaryAction, not just
 * client-side UI: the submit button stays disabled until the typed title exactly matches, and if
 * there is no verified backup the action itself refuses the request until the acknowledgement
 * checkbox is also present. (Deliberately not layering a window.confirm() on top of the action prop
 * here — whether a plain onSubmit preventDefault() reliably suppresses a React 19 form `action` in
 * every case isn't something I could confirm confidently, so this sticks to the two checks above
 * rather than shipping an unverified interaction for something this destructive.)
 */
export function DeleteVideoForm({
  videoId,
  title,
  backupStatus,
}: {
  videoId: string;
  title: string;
  backupStatus: string;
}) {
  const [state, formAction, pending] = useActionState(deleteVideoPrimaryAction, initialState);
  const [confirmTitle, setConfirmTitle] = useState('');

  const hasVerifiedBackup = backupStatus === 'verified';
  const titleMatches = confirmTitle === title;

  return (
    <form action={formAction}>
      <input type="hidden" name="videoId" value={videoId} />
      <p>
        Para confirmar, escribe el título exacto del video: <strong>{title}</strong>
      </p>
      <label>
        Título de confirmación
        <input type="text" name="confirmTitle" value={confirmTitle} onChange={(e) => setConfirmTitle(e.target.value)} required />
      </label>

      {!hasVerifiedBackup && (
        <label>
          <input type="checkbox" name="acknowledgeNoBackup" />
          Entiendo que este video NO tiene una copia de seguridad verificada y que eliminarlo puede
          ser irreversible.
        </label>
      )}

      {state.error && <p role="alert">{state.error}</p>}

      <button type="submit" className="button--danger" disabled={pending || !titleMatches}>
        {pending ? 'Eliminando…' : 'Eliminar archivo principal'}
      </button>
    </form>
  );
}
