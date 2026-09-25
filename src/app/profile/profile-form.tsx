'use client';

import { useActionState } from 'react';
import { updateProfileAction, type ProfileState } from './actions';

const initialState: ProfileState = { error: null, success: false };

export function ProfileForm({ initialDisplayName }: { initialDisplayName: string }) {
  const [state, formAction, pending] = useActionState(updateProfileAction, initialState);

  return (
    <form action={formAction}>
      <label>
        Nombre para mostrar
        <input type="text" name="displayName" defaultValue={initialDisplayName} maxLength={80} required />
      </label>
      {state.error && <p role="alert">{state.error}</p>}
      {state.success && <p>Perfil actualizado.</p>}
      <button type="submit" disabled={pending}>
        {pending ? 'Guardando…' : 'Guardar cambios'}
      </button>
    </form>
  );
}
