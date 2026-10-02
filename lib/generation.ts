import type { SupabaseClient } from '@supabase/supabase-js';
import * as db from './db';

// Model shared by both generation routes. Switching models is a one-line change.
export const GENERATION_MODEL = 'claude-sonnet-4-6';

// Generation spends Anthropic credits and writes shared content, so both routes
// check the caller's role before any model call. RLS would reject a student's
// writes anyway, but only after the (billed) model call had already run.
export async function requireAdmin(
  supabase: SupabaseClient
): Promise<{ userId: string } | { error: string; status: number }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not signed in', status: 401 };
  const profile = await db.getProfile(supabase, user.id);
  if (profile?.role !== 'admin') return { error: 'Admins only', status: 403 };
  return { userId: user.id };
}
