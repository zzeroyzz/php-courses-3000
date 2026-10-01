import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { requireAdmin } from '@/lib/generation';
import { generateInviteToken, hashInviteToken } from '@/lib/server/invite-token';
import { INVITE_DEFAULT_DAYS } from '@/lib/invites';
import type { Invite } from '@/lib/invites';

// Admin: create an invite. The raw token is returned exactly once, inside the
// link; only its hash is stored, so the link can't be shown again later.
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json().catch(() => ({})) as { label?: string; email?: string };
  const label = body.label?.trim();
  const email = body.email?.trim().toLowerCase() || null;

  if (!label) return NextResponse.json({ error: 'Add a label so you know who this invite is for.' }, { status: 400 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'That email address doesn’t look right.' }, { status: 400 });
  }

  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_DEFAULT_DAYS * 86400000).toISOString();

  // Inserted with the admin's own session, so RLS (is_admin) still applies —
  // no service role needed to create an invite.
  const { data, error } = await supabase
    .from('invites')
    .insert({ token_hash: hashInviteToken(token), email, label, created_by: auth.userId, expires_at: expiresAt })
    .select('id, email, label, created_by, created_at, expires_at, revoked_at, used_at, used_by')
    .single();

  if (error) {
    console.error('[invites] create', error.message);
    return NextResponse.json({ error: 'Could not create the invite.' }, { status: 500 });
  }

  const url = `${new URL(request.url).origin}/invite/${token}`;
  return NextResponse.json({ invite: data as Invite, url });
}
