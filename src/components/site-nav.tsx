import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { isAdminDisplayHint } from '@/lib/auth/admin-display-hint';
import { logoutAction } from '@/lib/auth/logout-action';

export async function SiteNav() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const showAdminLink = user ? await isAdminDisplayHint() : false;

  return (
    <header className="site-header">
      <nav className="site-nav" aria-label="Principal">
        <Link href="/" className="site-nav__brand">
          Plataforma de Video
        </Link>
        <ul className="site-nav__links">
          {user ? (
            <>
              <li>
                <Link href="/">Inicio</Link>
              </li>
              <li>
                <Link href="/search">Buscar</Link>
              </li>
              <li>
                <Link href="/saved">Guardados</Link>
              </li>
              {showAdminLink && (
                <li>
                  <Link href="/admin">Administración</Link>
                </li>
              )}
              <li>
                <Link href="/profile">Perfil</Link>
              </li>
              <li>
                <form action={logoutAction}>
                  <button type="submit">Salir</button>
                </form>
              </li>
            </>
          ) : (
            <>
              <li>
                <Link href="/login">Iniciar sesión</Link>
              </li>
              <li>
                <Link href="/signup">Crear cuenta</Link>
              </li>
            </>
          )}
        </ul>
      </nav>
    </header>
  );
}
