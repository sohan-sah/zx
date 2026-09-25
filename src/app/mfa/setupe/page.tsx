'use client';

import { useActionState, useEffect, useState } from 'react';
import { startEnrollAction, confirmEnrollAction, type ConfirmState, type EnrollState } from './actions';

const initialConfirmState: ConfirmState = { error: null, success: false };

export default function MfaSetupPage() {
  const [enroll, setEnroll] = useState<EnrollState | null>(null);
  const [confirmState, formAction, pending] = useActionState(confirmEnrollAction, initialConfirmState);

  useEffect(() => {
    startEnrollAction().then(setEnroll);
  }, []);

  if (confirmState.success) {
    return (
      <main>
        <h1>MFA activado</h1>
        <p>La autenticación en dos pasos está activa en tu cuenta.</p>
        <p>Se recomienda registrar un segundo autenticador independiente como respaldo.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Configurar autenticación en dos pasos</h1>
      {!enroll && <p>Cargando…</p>}
      {enroll?.error && <p role="alert">{enroll.error}</p>}
      {enroll?.qrCode && (
        <>
          <p>Escanea este código con tu aplicación de autenticación (por ejemplo, Google Authenticator).</p>
          {/* Plain <img>, not next/image: next/image sets inline `style` attributes for sizing,
              which the site's CSP (style-src with a nonce, no 'unsafe-inline') blocks — nonces only
              cover <style> elements/tags, not inline style="" attributes. Supabase returns an
              SVG data URI, which needs no optimization anyway. */}
          <img src={enroll.qrCode} alt="Código QR de MFA" width={200} height={200} className="mfa-qr" />
          <p>
            O ingresa esta clave manualmente: <code>{enroll.secret}</code>
          </p>
          <form action={formAction}>
            <input type="hidden" name="factorId" value={enroll.factorId ?? ''} />
            <label>
              Código de 6 dígitos
              <input type="text" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} required />
            </label>
            {confirmState.error && <p role="alert">{confirmState.error}</p>}
            <button type="submit" disabled={pending}>
              {pending ? 'Verificando…' : 'Confirmar'}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
