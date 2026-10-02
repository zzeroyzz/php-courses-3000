import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_NOT_CONFIGURED, tryCreateAdminClient } from '@/utils/supabase/admin';
import { hashInviteToken, isWellFormedToken } from '@/lib/server/invite-token';
import { inviteStatus } from '@/lib/invites';
import type { InviteCheck } from '@/lib/invites';

// Public: is this invite usable? Runs under the service role because the
// visitor isn't signed in and the invites table has no non-admin policies.
// Returns only the status and, if the invite is locked to an address, that
// address — never the admin's label or other invites.
//
// Probing this endpoint for valid tokens is pointless: tokens are 256-bit
// random values.
export async function POST(request: NextRequest) {
  const { token } = await request.json().catch(() => ({})) as { token?: unknown };
  if (!isWellFormedToken(token)) return NextResponse.json({ status: 'invalid' satisfies InviteCheck });

  const admin = tryCreateAdminClient();
  if (!admin) return NextResponse.json(ADMIN_NOT_CONFIGURED, { status: 503 });
  const { data: invite, error } = await admin
    .from('invites')
    .select('email, expires_at, revoked_at, used_at')
    .eq('token_hash', hashInviteToken(token))
    .maybeSingle();

  if (error) {
    console.error('[invites] validate', error.message);
    return NextResponse.json({ error: 'Could not check this invite. Try again in a moment.' }, { status: 500 });
  }
  if (!invite) return NextResponse.json({ status: 'invalid' satisfies InviteCheck });

  const status = inviteStatus(invite);
  return NextResponse.json({ status, email: status === 'pending' ? invite.email : null });
}
