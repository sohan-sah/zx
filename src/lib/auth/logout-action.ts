'use server';

import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { writeAuditEvent } from '@/lib/audit/log';

export async function logoutAction() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  await supabase.auth.signOut();

  if (user) {
    await writeAuditEvent({ actorId: user.id, actorRole: 'user', eventType: 'logout' });
  }

  redirect('/login');
}
