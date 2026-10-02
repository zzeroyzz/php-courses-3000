// Client-safe invite types and status logic. Token handling lives in
// lib/server/invite-token.ts.

export type Invite = {
  id: string;
  email: string | null;
  label: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  used_at: string | null;
  used_by: string | null;
};

export type InviteStatus = 'pending' | 'used' | 'revoked' | 'expired';

// Derived, never stored. Used wins over revoked (revoking a used invite is
// disabled anyway), revoked over expired: the most specific reason first.
export function inviteStatus(
  invite: Pick<Invite, 'used_at' | 'revoked_at' | 'expires_at'>,
  now = new Date()
): InviteStatus {
  if (invite.used_at) return 'used';
  if (invite.revoked_at) return 'revoked';
  if (new Date(invite.expires_at) <= now) return 'expired';
  return 'pending';
}

export const INVITE_DEFAULT_DAYS = 14;

// What the signup page shows for each outcome — distinct on purpose, so a
// student can tell an expired link (ask for a new one) from a used one
// (you already have an account).
export type InviteCheck = InviteStatus | 'invalid';

export const INVITE_MESSAGE: Record<Exclude<InviteCheck, 'pending'>, { title: string; body: string }> = {
  invalid: {
    title: 'This invite link isn’t valid',
    body: 'Check that you copied the whole link. If it still doesn’t work, ask your instructor for a new one.',
  },
  used: {
    title: 'This invite has already been used',
    body: 'An account was already created with this link. Sign in instead, or reset your password if you’ve forgotten it.',
  },
  revoked: {
    title: 'This invite was withdrawn',
    body: 'Your instructor cancelled this link. Ask them for a new one if you still need access.',
  },
  expired: {
    title: 'This invite has expired',
    body: 'Invite links last 14 days. Ask your instructor to send you a new one.',
  },
};

export const MIN_PASSWORD_LENGTH = 8;
