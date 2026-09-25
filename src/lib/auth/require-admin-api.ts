import 'server-only';
import { NextResponse } from 'next/server';
import { requireAdmin, ForbiddenError, UnauthenticatedError, type AdminContext } from './require-admin';

/**
 * Same authorization boundary as requireAdmin() (app_metadata role + aal2 MFA + admin_registry —
 * see require-admin.ts for the full contract), adapted for Route Handlers, which can't throw into a
 * React error boundary the way Server Components/Actions can. Every admin Route Handler must call
 * this FIRST, before reading the request body or touching any admin data.
 *
 * Deliberately returns 404 (not 401/403) for both failure cases: an admin API route responding
 * differently to "not logged in" vs "logged in but not admin" would let a non-admin distinguish
 * those states, which is a minor information leak about the existence of admin-only functionality.
 */
export async function requireAdminForApi(): Promise<{ ctx: AdminContext } | { response: NextResponse }> {
  try {
    const ctx = await requireAdmin();
    return { ctx };
  } catch (e) {
    if (e instanceof UnauthenticatedError || e instanceof ForbiddenError) {
      return { response: NextResponse.json({ error: 'not_found' }, { status: 404 }) };
    }
    throw e;
  }
}
