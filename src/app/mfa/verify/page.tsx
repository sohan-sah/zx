'use client';

import { useActionState } from 'react';
import { verifyMfaAction, type VerifyState } from './actions';

const initialState: VerifyState = { error: null };

export default function MfaVerifyPage() {
  const [state, formAction, pending] = useActionState(verifyMfaAction, initialState);

  return (
    <main>
      <h1>Verificación en dos pasos</h1>
      <form action={formAction}>
        <label>
          Código de 6 dígitos
          <input type="text" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoFocus />
        </label>
        {state.error && <p role="alert">{state.error}</p>}
        <button type="submit" disabled={pending}>
          {pending ? 'Verificando…' : 'Verificar'}
        </button>
      </form>
    </main>
  );
}
