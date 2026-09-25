import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Runs on every request. Three jobs:
 *  1. Refresh the Supabase session cookie so Server Components always see a valid session (access
 *     tokens are short-lived and Server Components cannot write cookies themselves).
 *  2. Generate a per-request CSP nonce and set a strict Content-Security-Policy (no 'unsafe-inline',
 *     no 'unsafe-eval'). The nonce is exposed via a request header so Server Components can read it
 *     for any inline <script>/<style> element they render (none exist yet in this slice — components
 *     use plain <img> instead of next/image and CSS classes only, specifically to avoid inline
 *     styles that would otherwise need 'unsafe-inline' in style-src).
 *  3. Reject cross-origin POST/PUT/PATCH/DELETE to same-site routes as CSRF defense-in-depth, in
 *     addition to the SameSite=Lax session cookie and Next's own Server Action origin check.
 *
 * Cookie handling uses getAll/setAll (the current, non-deprecated @supabase/ssr API, stable since
 * 0.4.0). The older per-cookie get/set/remove API is deprecated upstream and is known to lose
 * cookies when Supabase splits a large session token into multiple chunks — do not go back to it.
 */
export async function middleware(request: NextRequest) {
  const method = request.method.toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const origin = request.headers.get('origin');
    if (origin && origin !== request.nextUrl.origin) {
      return new NextResponse('Cross-origin request rejected', { status: 403 });
    }
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-csp-nonce', nonce);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseAnonKey) {
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write to the request first so any Server Component reading cookies() this same pass
          // sees the refreshed session, then rebuild the response from that request and mirror the
          // cookies onto it so the browser receives them too.
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, { ...options, httpOnly: true, secure: true, sameSite: 'lax' })
          );
        },
      },
    });

    // Revalidates the token with Supabase (not just reading the cookie) and refreshes it if needed.
    await supabase.auth.getUser();
  }
  // Reads process.env directly rather than importing src/lib/env.ts on purpose: that module throws
  // at import time on a missing var, which would take down asset/static handling too if it ran here.
  // Every Server Component/Action still imports env.ts and gets that fail-fast check; if the vars
  // are missing, session refresh is just skipped for this one request.

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data: https:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ');
  response.headers.set('Content-Security-Policy', csp);

  return response;
}

export const config = {
  matcher: [
    // Run on everything except static assets and image optimization files.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|gif|ico)$).*)',
  ],
};
