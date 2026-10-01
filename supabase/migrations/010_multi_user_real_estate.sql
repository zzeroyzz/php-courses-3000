-- ════════════════════════════════════════════════════════════════════════
-- Migration 010: multi-user roles + Georgia real estate course
--
-- Drops:     all MLO content and study history (sections cascade), the
--            textbook subsystem (textbook_chunks + search_textbook)
-- Changes:   content is now shared — readable by every signed-in user,
--            writable by admins only. Study state moves off the content
--            rows into per-user tables.
-- Adds:      profiles.role, is_admin(), card_progress, lesson_progress,
--            lesson structure columns, the generated "depth" reading layer
--
-- Course structure (sections + empty lessons) is seeded by 011.
-- ════════════════════════════════════════════════════════════════════════

-- ── Wipe MLO content ─────────────────────────────────────────────────────────
-- Cascades sections → lessons → flashcards, questions → attempts.

TRUNCATE public.sections CASCADE;

-- ── Remove the textbook subsystem ────────────────────────────────────────────
-- 007/008 seeded the SAFE mortgage textbook. The real estate course has no
-- textbook; lessons are verified against their own pasted source instead.

DROP FUNCTION IF EXISTS public.search_textbook(text, int);
DROP TABLE    IF EXISTS public.textbook_chunks;

-- ── Roles ────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN role text NOT NULL DEFAULT 'student' CHECK (role IN ('admin', 'student'));

-- Until now this was a single-user app, so every existing account is the owner.
-- New sign-ups default to 'student'.
UPDATE public.profiles SET role = 'admin';

-- profiles_update / profiles_insert (001) let users write their own row with no
-- column restriction — left alone, any student could make themselves admin.
-- Re-grant writes on every column except role.
REVOKE INSERT, UPDATE ON public.profiles FROM authenticated, anon;
GRANT INSERT (user_id, xp, level, current_streak, longest_streak, last_active_date, daily_goal)
  ON public.profiles TO authenticated;
GRANT UPDATE (xp, level, current_streak, longest_streak, last_active_date, daily_goal)
  ON public.profiles TO authenticated;

-- SECURITY DEFINER so RLS policies can call it without recursing into the
-- profiles policies.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ── sections ─────────────────────────────────────────────────────────────────

ALTER TABLE public.sections
  ADD COLUMN chapter_number int,                                -- null for Orientation / Final Exam
  ADD COLUMN allow_generated_depth boolean NOT NULL DEFAULT true; -- false for Georgia statute chapters

-- ── lessons ──────────────────────────────────────────────────────────────────

ALTER TABLE public.lessons RENAME COLUMN user_id TO created_by;
ALTER TABLE public.lessons ALTER COLUMN created_by DROP NOT NULL;   -- seeded rows have no author

-- Was ON DELETE CASCADE: deleting the admin's account would delete the course.
ALTER TABLE public.lessons DROP CONSTRAINT IF EXISTS lessons_user_id_fkey;
ALTER TABLE public.lessons
  ADD CONSTRAINT lessons_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Completion is per-user now (lesson_progress).
ALTER TABLE public.lessons DROP COLUMN completed_at;

ALTER TABLE public.lessons
  ADD COLUMN lesson_number      text,   -- '10.3', '10.3a' — course numbering
  ADD COLUMN kind               text NOT NULL DEFAULT 'prose'
    CHECK (kind IN ('prose', 'infographic', 'quiz', 'document')),
  -- Generated depth layer. Unsourced by design and never drilled: it is a text
  -- column, not flashcard/question rows, so it cannot enter the review queue.
  ADD COLUMN depth_content      text,
  ADD COLUMN depth_generated_at timestamptz;

ALTER TABLE public.lessons
  ADD CONSTRAINT lessons_section_lesson_number_key UNIQUE (section_id, lesson_number);

DROP INDEX IF EXISTS public.lessons_user_id_section_id_sort_order_idx;
CREATE INDEX lessons_section_sort_idx ON public.lessons (section_id, sort_order);

DROP POLICY IF EXISTS "users own their lessons" ON public.lessons;
CREATE POLICY "authenticated read lessons"
  ON public.lessons FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins write lessons"
  ON public.lessons FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ── flashcards — content only; scheduling moves to card_progress ─────────────

ALTER TABLE public.flashcards
  DROP COLUMN ease,
  DROP COLUMN interval_days,
  DROP COLUMN due_at,
  DROP COLUMN lapses;

DROP POLICY IF EXISTS "users own flashcards for their lessons" ON public.flashcards;
CREATE POLICY "authenticated read flashcards"
  ON public.flashcards FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins write flashcards"
  ON public.flashcards FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ── questions ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "users own questions for their lessons" ON public.questions;
CREATE POLICY "authenticated read questions"
  ON public.questions FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins write questions"
  ON public.questions FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ── card_progress — per-user SM-2 state ──────────────────────────────────────
-- No row = the user has never reviewed the card = new and due now.

CREATE TABLE public.card_progress (
  user_id       uuid        NOT NULL REFERENCES auth.users(id)       ON DELETE CASCADE,
  flashcard_id  uuid        NOT NULL REFERENCES public.flashcards(id) ON DELETE CASCADE,
  ease          numeric     NOT NULL DEFAULT 2.5,
  interval_days int         NOT NULL DEFAULT 0,
  due_at        timestamptz NOT NULL DEFAULT now(),
  lapses        int         NOT NULL DEFAULT 0,
  reviewed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, flashcard_id)
);

ALTER TABLE public.card_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users own their card progress"
  ON public.card_progress FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.card_progress TO authenticated;

CREATE INDEX ON public.card_progress (user_id, due_at);

-- ── lesson_progress — per-user completion ────────────────────────────────────

CREATE TABLE public.lesson_progress (
  user_id      uuid        NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
  lesson_id    uuid        NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lesson_id)
);

ALTER TABLE public.lesson_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users own their lesson progress"
  ON public.lesson_progress FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lesson_progress TO authenticated;

-- ── Regenerate guard ─────────────────────────────────────────────────────────
-- Regenerating a lesson deletes its flashcards and questions, which cascades to
-- every student's card_progress and attempts for that lesson. The admin UI shows
-- this count before confirming. SECURITY DEFINER because RLS hides other users'
-- progress rows from the admin; it returns a count only, and only to admins.

CREATE OR REPLACE FUNCTION public.lesson_learner_count(p_lesson_id uuid)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN NOT public.is_admin() THEN 0 ELSE (
    SELECT count(DISTINCT u)::int FROM (
      SELECT a.user_id AS u
        FROM public.attempts a
        JOIN public.questions q ON q.id = a.question_id
       WHERE q.lesson_id = p_lesson_id
      UNION
      SELECT cp.user_id
        FROM public.card_progress cp
        JOIN public.flashcards f ON f.id = cp.flashcard_id
       WHERE f.lesson_id = p_lesson_id
    ) learners
  ) END;
$$;

REVOKE ALL ON FUNCTION public.lesson_learner_count(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.lesson_learner_count(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
