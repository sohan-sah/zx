'use client';

import { useEffect } from 'react';

export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Server-side stack traces already go to Vercel's logs automatically for errors thrown in
    // Server Components/Actions. This just avoids a second client-side console leak of `error`.
    console.error('[app error]', error.digest ?? 'unhandled');
  }, [error]);

  return (
    <html lang="es">
      <body>
        <main>
          <h1>Ocurrió un error</h1>
          <p>Inténtalo de nuevo más tarde.</p>
        </main>
      </body>
    </html>
  );
}
