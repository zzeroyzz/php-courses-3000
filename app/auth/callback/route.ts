import { type NextRequest, NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createClient } from '@/utils/supabase/server';

// Landing point for links Supabase emails out — currently password reset.
//
// Two shapes arrive here:
//   ?token_hash=…&type=recovery  — the recommended server-side flow. Requires
//     the Supabase "Reset Password" email template to link to
//     {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password
//     and works whichever browser or device opens the email.
//   ?code=…                       — PKCE, what the default template produces.
//     Only works in the same browser that requested the reset, because the
//     code verifier lives in that browser's cookies.
// Either way, success leaves a session cookie and redirects to `next`.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const next = safeNext(searchParams.get('next'));
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const code = searchParams.get('code');

  const supabase = await createClient();
  let ok = false;

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    ok = !error;
    if (error) console.error('[auth/callback] verifyOtp', error.message);
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
    if (error) console.error('[auth/callback] exchangeCodeForSession', error.message);
  }

  if (ok) return NextResponse.redirect(`${origin}${next}`);

  const failure = next.startsWith('/reset-password') ? '/forgot-password?error=expired' : '/sign-in?error=auth_error';
  return NextResponse.redirect(`${origin}${failure}`);
}

// Only same-site paths. `next` comes from the URL, so without this a crafted
// link like ?next=@evil.example would turn the redirect into an open redirect.
function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}
