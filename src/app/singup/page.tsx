'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { signupAction, type SignupState } from './actions';

const initialState: SignupState = { error: null, success: false };

export default function SignupPage() {
  const [state, formAction, pending] = useActionState(signupAction, initialState);

  if (state.success) {
    return (
      <main>
        <h1>Revisa tu correo</h1>
        <p>Te enviamos un enlace para confirmar tu cuenta.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Crear cuenta</h1>
      <form action={formAction}>
        <label>
          Correo electrónico
          <input type="email" name="email" required autoComplete="email" maxLength={254} />
        </label>
        <label>
          Contraseña
          <input type="password" name="password" required autoComplete="new-password" maxLength={200} minLength={12} />
        </label>
        {state.error && <p role="alert">{state.error}</p>}
        <button type="submit" disabled={pending}>
          {pending ? 'Creando…' : 'Crear cuenta'}
        </button>
      </form>
      <p>
        <Link href="/login">Ya tengo una cuenta</Link>
      </p>
    </main>
  );
}
