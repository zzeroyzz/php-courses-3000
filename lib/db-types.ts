// TypeScript types mirroring the Supabase database schema

// ── Profile ───────────────────────────────────────────────────────────────────

export type Role = 'admin' | 'student';

export type Profile = {
  user_id: string;
  role: Role;
  xp: number;
  level: number;
  current_streak: number;
  longest_streak: number;
  last_active_date: string | null;
  daily_goal: number;
  created_at: string;
  updated_at: string;
};

export type DBachievement = {
  id: string;
  user_id: string;
  achievement_id: string;
  unlocked_at: string;
};

// ── Content (shared by all users, written by admins) ──────────────────────────

export type QuestionMix = {
  factual: number;
  scenario: number;
  calculation: number;
};

export type Section = {
  id: string;
  slug: string;
  name: string;
  chapter_number: number | null;   // null for Orientation / Final Exam
  // Course-completion weight for now: the chapter's share of the course's
  // lessons. See lib/course.ts PROGRESS_LABEL.
  exam_weight: number;
  sort_order: number;
  question_mix: QuestionMix;
  allow_generated_depth: boolean;  // false for Georgia statute chapters
};

// "10 · Georgia Residential Landlord Tenant Act"; Orientation / Final Exam as-is.
export function sectionLabel(section: Pick<Section, 'chapter_number' | 'name'>): string {
  return section.chapter_number != null ? `${section.chapter_number} · ${section.name}` : section.name;
}

export type LessonKind = 'prose' | 'infographic' | 'quiz' | 'document';

// What list views load — everything except the large text columns.
export type LessonSummary = {
  id: string;
  section_id: string;
  created_by: string | null;
  lesson_number: string | null;
  title: string;
  kind: LessonKind;
  sort_order: number;
  has_source: boolean;
  generated_at: string | null;     // null = generation not complete
  generation_chunk: number | null; // non-null = generation failed at this chunk
  created_at: string;
};

export type Lesson = LessonSummary & {
  source_content: string;          // verbatim paste — NEVER overwritten by regeneration
  why_it_matters: string | null;
  // The generated "Going deeper" reading layer. Unsourced by design, so it is
  // never drilled: it lives in this text column rather than as flashcard or
  // question rows, which means nothing in it can reach the review queue.
  depth_content: string | null;
  depth_generated_at: string | null;
};

export const LESSON_SUMMARY_COLUMNS =
  'id, section_id, created_by, lesson_number, title, kind, sort_order, has_source, generated_at, generation_chunk, created_at';

// Global content state — the same for every user. Per-user completion is
// separate (lesson_progress).
export type ContentStatus = 'empty' | 'generating' | 'failed' | 'ready';

export function contentStatus(
  lesson: Pick<LessonSummary, 'has_source' | 'generated_at' | 'generation_chunk' | 'kind'>
): ContentStatus {
  if (!lesson.has_source) return 'empty';
  if (lesson.generated_at) return 'ready';
  // Document examples are reading material; drill generation is opt-in.
  if (lesson.kind === 'document') return 'ready';
  if (lesson.generation_chunk != null) return 'failed';
  return 'generating';
}

// Image-only lessons count only once someone has typed up their content.
export function countsTowardProgress(lesson: Pick<LessonSummary, 'kind' | 'has_source'>): boolean {
  return lesson.kind !== 'infographic' || lesson.has_source;
}

// Display "10.3a" but not the synthetic keys the seed gives unnumbered lessons.
export function displayLessonNumber(lesson: Pick<LessonSummary, 'lesson_number'>): string | null {
  return lesson.lesson_number && /^\d+\.\d+[a-z]?$/.test(lesson.lesson_number) ? lesson.lesson_number : null;
}

export type QuestionType = 'factual' | 'scenario' | 'calculation';

export type Flashcard = {
  id: string;
  lesson_id: string;
  front: string;          // description / scenario side
  back: string;           // term / rule / number
  source_anchor: string | null;
  created_at: string;
};

export type Question = {
  id: string;
  lesson_id: string;
  question_type: QuestionType;
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string;
  source_anchor: string | null;
  created_at: string;
};

// ── Per-user study state ──────────────────────────────────────────────────────

export type SrsState = {
  ease: number;
  interval_days: number;
  due_at: string | null;  // null = this user has never reviewed the card
  lapses: number;
};

// A shared card merged with the current user's scheduling state.
export type StudyCard = Flashcard & SrsState;

export type Attempt = {
  id: string;
  question_id: string;
  user_id: string;
  chosen_index: number;
  correct: boolean;
  answered_at: string;
};

export type DueCount = { lesson_id: string; section_id: string; due: number };

export type SectionStats = {
  section_id: string;
  answered: number;
  correct: number;
  lessons_attempted: number;
};
