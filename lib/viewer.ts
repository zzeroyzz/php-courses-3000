import type { SupabaseClient, User } from '@supabase/supabase-js';
import * as db from './db';
import type { Profile } from './db-types';

export type Viewer = { user: User; profile: Profile | null; isAdmin: boolean };

// The signed-in user plus their role. UI gating only — the real enforcement is
// RLS (content writes) and requireAdmin() in the generation routes.
export async function getViewer(supabase: SupabaseClient): Promise<Viewer | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const profile = await db.getProfile(supabase, user.id);
  return { user, profile, isAdmin: profile?.role === 'admin' };
}
