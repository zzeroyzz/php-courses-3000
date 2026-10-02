import type { SupabaseClient } from '@supabase/supabase-js';
import {
  LESSON_SUMMARY_COLUMNS,
  type Profile,
  type DBachievement,
  type Section,
  type Lesson,
  type LessonSummary,
  type StudyCard,
  type Question,
  type Attempt,
  type DueCount,
  type SectionStats,
} from './db-types';
import type { Invite } from './invites';

// Content tables (sections, lessons, flashcards, questions) are shared: RLS lets
// every signed-in user read them and only admins write them. Study state
// (card_progress, lesson_progress, attempts) is per-user and RLS-scoped to the
// caller, so those queries need no user filter beyond what RLS applies.

// ── Profile ───────────────────────────────────────────────────────────────────

export async function getProfile(
  supabase: SupabaseClient,
  userId: string
): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    console.error('[db] getProfile', error.message);
    return null;
  }
  return data as Profile;
}

export async function upsertProfile(
  supabase: SupabaseClient,
  userId: string,
  // role is not client-writable (column grants in migration 010)
  updates: Partial<Omit<Profile, 'user_id' | 'role' | 'created_at' | 'updated_at'>>
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .upsert({ user_id: userId, ...updates }, { onConflict: 'user_id' });
  if (error) console.error('[db] upsertProfile', error.message);
}

// ── Achievements ──────────────────────────────────────────────────────────────

export async function getUserAchievements(
  supabase: SupabaseClient,
  userId: string
): Promise<DBachievement[]> {
  const { data, error } = await supabase
    .from('achievements')
    .select('*')
    .eq('user_id', userId)
    .order('unlocked_at', { ascending: false });
  if (error) { console.error('[db] getUserAchievements', error.message); return []; }
  return data as DBachievement[];
}

export async function addAchievement(
  supabase: SupabaseClient,
  userId: string,
  achievementId: string
): Promise<void> {
  const { error } = await supabase
    .from('achievements')
    .upsert(
      { user_id: userId, achievement_id: achievementId },
      { onConflict: 'user_id,achievement_id', ignoreDuplicates: true }
    );
  if (error) console.error('[db] addAchievement', error.message);
}

// ── Sections ──────────────────────────────────────────────────────────────────

export async function getSections(supabase: SupabaseClient): Promise<Section[]> {
  const { data, error } = await supabase
    .from('sections')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) { console.error('[db] getSections', error.message); return []; }
  return data as Section[];
}

export async function getSectionBySlug(
  supabase: SupabaseClient,
  slug: string
): Promise<Section | null> {
  const { data, error } = await supabase
    .from('sections')
    .select('*')
    .eq('slug', slug)
    .single();
  if (error) { console.error('[db] getSectionBySlug', error.message); return null; }
  return data as Section;
}

export async function getSectionById(
  supabase: SupabaseClient,
  sectionId: string
): Promise<Section | null> {
  const { data, error } = await supabase
    .from('sections')
    .select('*')
    .eq('id', sectionId)
    .single();
  if (error) { console.error('[db] getSectionById', error.message); return null; }
  return data as Section;
}

// ── Lessons ───────────────────────────────────────────────────────────────────

// Summaries only — never source_content, which across ~350 lessons is megabytes.
export async function getLessonSummaries(
  supabase: SupabaseClient,
  sectionId?: string
): Promise<LessonSummary[]> {
  let query = supabase
    .from('lessons')
    .select(LESSON_SUMMARY_COLUMNS)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (sectionId) query = query.eq('section_id', sectionId);
  const { data, error } = await query;
  if (error) { console.error('[db] getLessonSummaries', error.message); return []; }
  return data as unknown as LessonSummary[];
}

export async function getLessonById(
  supabase: SupabaseClient,
  lessonId: string
): Promise<Lesson | null> {
  const { data, error } = await supabase
    .from('lessons')
    .select('*')
    .eq('id', lessonId)
    .single();
  if (error) { console.error('[db] getLessonById', error.message); return null; }
  return data as Lesson;
}

// Admin: paste content into a seeded empty lesson. Generation is started
// separately (lib/generation-client.ts), which stamps a run id first.
// Only fills an empty lesson: undoing a paste goes through clearLesson().
export async function saveLessonSource(
  supabase: SupabaseClient,
  lessonId: string,
  sourceContent: string,
  createdBy: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('lessons')
    .update({ source_content: sourceContent, created_by: createdBy })
    .eq('id', lessonId)
    .eq('source_content', '')
    .select('id');
  if (!error && (data?.length ?? 0) === 0) {
    console.error('[db] saveLessonSource: lesson already has content');
    return false;
  }
  if (error) { console.error('[db] saveLessonSource', error.message); return false; }
  return true;
}

export async function updateLessonDepth(
  supabase: SupabaseClient,
  lessonId: string,
  depthContent: string
): Promise<boolean> {
  const { error } = await supabase
    .from('lessons')
    .update({ depth_content: depthContent, depth_generated_at: new Date().toISOString() })
    .eq('id', lessonId);
  if (error) { console.error('[db] updateLessonDepth', error.message); return false; }
  return true;
}

// ── Generation control (migration 013) ────────────────────────────────────────

// New run id for this lesson; reset=true also deletes earlier cards/questions
// (a full restart). Returns null on failure.
export async function queueGeneration(
  supabase: SupabaseClient,
  lessonId: string,
  reset: boolean
): Promise<string | null> {
  const { data, error } = await supabase.rpc('queue_generation', { p_lesson_id: lessonId, p_reset: reset });
  if (error) { console.error('[db] queueGeneration', error.message); return null; }
  return data as string;
}

export type CancelResult = 'cancelling' | 'cancelled' | 'idle';

export async function requestGenerationCancel(
  supabase: SupabaseClient,
  lessonId: string
): Promise<CancelResult | null> {
  const { data, error } = await supabase.rpc('request_generation_cancel', { p_lesson_id: lessonId });
  if (error) { console.error('[db] requestGenerationCancel', error.message); return null; }
  return data as CancelResult;
}

// Undo a paste: the lesson returns to empty and can be pasted again. Deletes
// its cards and questions (and with them every student's progress on them).
export async function clearLesson(supabase: SupabaseClient, lessonId: string): Promise<boolean> {
  const { error } = await supabase.rpc('clear_lesson', { p_lesson_id: lessonId });
  if (error) { console.error('[db] clearLesson', error.message); return false; }
  return true;
}

// Card and question counts per lesson in a section, via PostgREST's embedded
// count (one request, no rows transferred beyond the counts).
export type ContentCounts = { cards: number; questions: number };

export async function getContentCounts(
  supabase: SupabaseClient,
  sectionId: string
): Promise<Map<string, ContentCounts>> {
  const { data, error } = await supabase
    .from('lessons')
    .select('id, flashcards(count), questions(count)')
    .eq('section_id', sectionId);
  if (error) { console.error('[db] getContentCounts', error.message); return new Map(); }
  type Row = { id: string; flashcards: { count: number }[]; questions: { count: number }[] };
  return new Map((data as unknown as Row[]).map((r) => [
    r.id,
    { cards: r.flashcards[0]?.count ?? 0, questions: r.questions[0]?.count ?? 0 },
  ]));
}

// How many students have progress that regenerating this lesson would erase.
export async function getLessonLearnerCount(
  supabase: SupabaseClient,
  lessonId: string
): Promise<number> {
  const { data, error } = await supabase.rpc('lesson_learner_count', { p_lesson_id: lessonId });
  if (error) { console.error('[db] getLessonLearnerCount', error.message); return 0; }
  return (data as number) ?? 0;
}

// ── Lesson completion (per user) ──────────────────────────────────────────────

export async function getCompletedLessonIds(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from('lesson_progress').select('lesson_id');
  if (error) { console.error('[db] getCompletedLessonIds', error.message); return new Set(); }
  return new Set((data as { lesson_id: string }[]).map((r) => r.lesson_id));
}

export async function getLessonCompletedAt(
  supabase: SupabaseClient,
  lessonId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('lesson_progress')
    .select('completed_at')
    .eq('lesson_id', lessonId)
    .maybeSingle();
  if (error) { console.error('[db] getLessonCompletedAt', error.message); return null; }
  return (data as { completed_at: string } | null)?.completed_at ?? null;
}

// Completing a lesson also puts its unreviewed cards on the global review
// schedule (see due_cards() in migration 010).
export async function markLessonComplete(
  supabase: SupabaseClient,
  userId: string,
  lessonId: string
): Promise<void> {
  const { error } = await supabase
    .from('lesson_progress')
    .upsert({ user_id: userId, lesson_id: lessonId }, { onConflict: 'user_id,lesson_id', ignoreDuplicates: true });
  if (error) console.error('[db] markLessonComplete', error.message);
}

// ── Flashcards ────────────────────────────────────────────────────────────────

// A lesson's cards merged with the caller's scheduling state.
export async function getStudyCards(
  supabase: SupabaseClient,
  lessonId: string
): Promise<StudyCard[]> {
  const { data, error } = await supabase.rpc('study_cards', { p_lesson_id: lessonId });
  if (error) { console.error('[db] getStudyCards', error.message); return []; }
  return data as StudyCard[];
}

// The caller's cross-lesson review queue.
export async function getDueCards(supabase: SupabaseClient): Promise<StudyCard[]> {
  const { data, error } = await supabase.rpc('due_cards');
  if (error) { console.error('[db] getDueCards', error.message); return []; }
  return data as StudyCard[];
}

export async function getDueCounts(supabase: SupabaseClient): Promise<DueCount[]> {
  const { data, error } = await supabase.rpc('due_counts');
  if (error) { console.error('[db] getDueCounts', error.message); return []; }
  return data as DueCount[];
}

export async function saveCardReview(
  supabase: SupabaseClient,
  userId: string,
  cardId: string,
  state: { ease: number; interval_days: number; due_at: string; lapses: number }
): Promise<void> {
  const { error } = await supabase
    .from('card_progress')
    .upsert(
      { user_id: userId, flashcard_id: cardId, ...state, reviewed_at: new Date().toISOString() },
      { onConflict: 'user_id,flashcard_id' }
    );
  if (error) console.error('[db] saveCardReview', error.message);
}

// ── Questions ─────────────────────────────────────────────────────────────────

export async function getQuestions(
  supabase: SupabaseClient,
  lessonId: string
): Promise<Question[]> {
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('lesson_id', lessonId)
    .order('created_at', { ascending: true });
  if (error) { console.error('[db] getQuestions', error.message); return []; }
  return data as Question[];
}

// ── Attempts ──────────────────────────────────────────────────────────────────

export async function recordAttempt(
  supabase: SupabaseClient,
  attempt: Omit<Attempt, 'id' | 'answered_at'>
): Promise<void> {
  const { error } = await supabase.from('attempts').insert(attempt);
  if (error) console.error('[db] recordAttempt', error.message);
}

// The caller's practice results per section since `since`, aggregated in SQL.
export async function getSectionStats(
  supabase: SupabaseClient,
  since: Date
): Promise<SectionStats[]> {
  const { data, error } = await supabase.rpc('section_stats', { p_since: since.toISOString() });
  if (error) { console.error('[db] getSectionStats', error.message); return []; }
  return data as SectionStats[];
}

// ── Invites (admin only — RLS returns nothing to anyone else) ─────────────────

export async function getInvites(supabase: SupabaseClient): Promise<Invite[]> {
  const { data, error } = await supabase
    .from('invites')
    .select('id, email, label, created_by, created_at, expires_at, revoked_at, used_at, used_by')
    .order('created_at', { ascending: false });
  if (error) { console.error('[db] getInvites', error.message); return []; }
  return data as Invite[];
}

// Only an unused invite can be revoked; a used one already has an account.
export async function revokeInvite(supabase: SupabaseClient, inviteId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('invites')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', inviteId)
    .is('used_at', null)
    .is('revoked_at', null)
    .select('id');
  if (error) { console.error('[db] revokeInvite', error.message); return false; }
  return (data?.length ?? 0) > 0;
}
