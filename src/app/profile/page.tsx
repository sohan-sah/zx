import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { ProfileForm } from './profile-form';

export default async function ProfilePage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: profile }, { data: factors }] = await Promise.all([
    supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle(),
    supabase.auth.mfa.listFactors(),
  ]);

  const mfaEnabled = (factors?.totp?.length ?? 0) > 0;

  return (
    <main>
      <h1>Perfil</h1>
      <p>
        Correo electrónico: <strong>{user.email}</strong>
      </p>
      <p>
        Verificación en dos pasos:{' '}
        {mfaEnabled ? <span className="badge">Activada</span> : <Link href="/mfa/setup">Configurar</Link>}
      </p>
      <ProfileForm initialDisplayName={profile?.display_name ?? ''} />
    </main>
  );
}
