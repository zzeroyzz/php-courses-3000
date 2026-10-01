import 'server-only';
import { createClient } from '@supabase/supabase-js';

// Service-role client: bypasses RLS and can create users. Server-only — the
// 'server-only' import makes the build fail if a client component ever imports
// this file, and SUPABASE_SERVICE_ROLE_KEY has no NEXT_PUBLIC_ prefix, so Next
// never inlines it into browser bundles.
//
// Used only by the invite routes, for the two things the caller's own session
// can't do: read an invite before anyone is signed in, and create the account.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// For public routes: a missing key is a deployment mistake, not something the
// visitor caused, so answer with a clear 503 instead of an HTML 500.
export const ADMIN_NOT_CONFIGURED = {
  error: 'Invites aren\u2019t set up on this site yet. Let your instructor know.',
} as const;

export function tryCreateAdminClient() {
  try {
    return createAdminClient();
  } catch (err) {
    console.error('[supabase/admin]', err instanceof Error ? err.message : err);
    return null;
  }
}
