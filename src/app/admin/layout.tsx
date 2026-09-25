import { requireAdmin, ForbiddenError, UnauthenticatedError } from '@/lib/auth/require-admin';
import { redirect } from 'next/navigation';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof UnauthenticatedError) redirect('/login');
    if (e instanceof ForbiddenError) redirect('/'); // deliberately not a 403 page: don't confirm /admin exists to non-admins
    throw e;
  }

  return (
    <section>
      <nav aria-label="Administración">
        <span>Panel de administración</span>
      </nav>
      {children}
    </section>
  );
}
