import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_NOT_CONFIGURED, tryCreateAdminClient } from '@/utils/supabase/admin';
import { hashInviteToken, isWellFormedToken } from '@/lib/server/invite-token';
import { inviteStatus, MIN_PASSWORD_LENGTH } from '@/lib/invites';

// Public: redeem an invite and create the account.
//
// This route is the only way accounts get created. Email signups are disabled
// in Supabase, so auth.signUp() with the public anon key is closed; the account
// is created here with the service role after the invite checks out.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { token?: unknown; email?: string; password?: string };
  const { token } = body;
  const email = body.email?.trim().toLowerCase() ?? '';
  const password = body.password ?? '';

  if (!isWellFormedToken(token)) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  const admin = tryCreateAdminClient();
  if (!admin) return NextResponse.json(ADMIN_NOT_CONFIGURED, { status: 503 });
  const tokenHash = hashInviteToken(token);

  const { data: invite, error: readError } = await admin
    .from('invites')
    .select('id, email, expires_at, revoked_at, used_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (readError) {
    console.error('[invites] accept read', readError.message);
    return NextResponse.json({ error: 'Could not check this invite. Try again in a moment.' }, { status: 500 });
  }
  if (!invite) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  const status = inviteStatus(invite);
  if (status !== 'pending') return NextResponse.json({ status }, { status: 409 });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }
  if (invite.email && invite.email !== email) {
    return NextResponse.json({ error: 'This invite is for a different email address.' }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.` }, { status: 400 });
  }

  // Claim the invite in ONE conditional statement:
  //   UPDATE invites SET used_at = now
  //   WHERE id = … AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now
  //   RETURNING id
  // If two people open the same link at once, Postgres serialises the two
  // updates on the row; the second sees used_at already set, matches nothing,
  // and gets no row back. A read-then-write would let both through.
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await admin
    .from('invites')
    .update({ used_at: now })
    .eq('id', invite.id)
    .is('used_at', null)
    .is('revoked_at', null)
    .gt('expires_at', now)
    .select('id');

  if (claimError) {
    console.error('[invites] accept claim', claimError.message);
    return NextResponse.json({ error: 'Could not use this invite. Try again in a moment.' }, { status: 500 });
  }
  if (!claimed || claimed.length === 0) {
    // Lost a race, or the invite changed since the read above.
    const { data: latest } = await admin
      .from('invites').select('expires_at, revoked_at, used_at').eq('id', invite.id).maybeSingle();
    return NextResponse.json({ status: latest ? inviteStatus(latest) : 'invalid' }, { status: 409 });
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,   // the invite is the verification; no confirmation email
  });

  if (createError || !created.user) {
    // Give the link back: nothing was created, so the invite stays usable.
    await admin.from('invites').update({ used_at: null }).eq('id', invite.id).is('used_by', null);
    const code = createError?.code;
    const message =
      code === 'email_exists' || code === 'user_already_exists'
        ? 'An account with this email already exists. Sign in instead.'
        : code === 'weak_password'
        ? 'That password is too weak. Try a longer one.'
        : 'Could not create your account. Try again in a moment.';
    if (!code || (code !== 'email_exists' && code !== 'user_already_exists' && code !== 'weak_password')) {
      console.error('[invites] accept createUser', createError?.message);
    }
    return NextResponse.json({ error: message }, { status: code === 'email_exists' || code === 'user_already_exists' ? 409 : 400 });
  }

  const userId = created.user.id;
  await admin.from('invites').update({ used_by: userId }).eq('id', invite.id);

  // handle_new_user() fires on any insert into auth.users, including the admin
  // API, and creates the profile with the default 'student' role. This upsert
  // only matters if that trigger is ever missing; it never overwrites a role.
  const { error: profileError } = await admin
    .from('profiles')
    .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true });
  if (profileError) console.error('[invites] accept profile', profileError.message);

  return NextResponse.json({ ok: true });
}
