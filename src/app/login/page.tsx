'use client';

import { useActionState } from 'react';
import { loginAction, type LoginState } from './actions';

const initialState: LoginState = { error: null };

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <main>
      <h1>Iniciar sesión</h1>
      <form action={formAction}>
        <label>
          Correo electrónico
          <input type="email" name="email" required autoComplete="email" maxLength={254} />
        </label>
        <label>
          Contraseña
          <input type="password" name="password" required autoComplete="current-password" maxLength={200} />
        </label>
        {state.error && <p role="alert">{state.error}</p>}
        <button type="submit" disabled={pending}>
          {pending ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
