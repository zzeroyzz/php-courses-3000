-- ════════════════════════════════════════════════════════════════════════
-- Migration 013: cancellable generation, legible status, clearing a lesson
--
-- Generation is fire-and-forget: the client POSTs /api/generate without
-- awaiting it and watches the lessons row over Realtime. There is no request
-- to abort, so cancellation is cooperative and server-side, keyed on a per-run
-- id:
--
--   queue_generation()        client, before firing the route: new run id,
--                             fresh heartbeat, optional wipe of old output
--   generation_tick()         route, every few seconds during a chunk: bumps
--                             the heartbeat, says whether to keep going
--   save_generated_chunk()    route, per chunk: inserts ONLY if this run is
--                             still current and not cancelled — under a row
--                             lock, so a cancel or clear can't interleave
--   request_generation_cancel()  admin "Stop"
--   clear_lesson()            admin "Clear": back to an empty, unpasted lesson
--
-- Status is derived from these timestamps (contentStatus() in
-- lib/db-types.ts), never stored. GENERATION_STALE (2 minutes) must match
-- GENERATION_STALE_MS there.
--
-- All functions are SECURITY INVOKER: RLS still applies, and each checks
-- is_admin() up front for a clear error.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.lessons
  ADD COLUMN generation_run_id              uuid,         -- current run; NULL when nothing is running
  ADD COLUMN generation_heartbeat_at        timestamptz,  -- last sign of life from that run
  ADD COLUMN generation_cancel_requested_at timestamptz,  -- admin pressed Stop
  ADD COLUMN generation_cancelled_at        timestamptz;  -- the run actually stopped
-- generation_chunk (009) keeps its meaning: the chunk to resume from, whether
-- the run failed there or was stopped there.

-- ── queue_generation ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.queue_generation(p_lesson_id uuid, p_reset boolean)
RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_run uuid := gen_random_uuid();
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admins only' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.lessons WHERE id = p_lesson_id AND has_source FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lesson not found or has no source' USING ERRCODE = 'P0002';
  END IF;

  -- A full restart replaces earlier output. This cascades to every student's
  -- card_progress and attempts for the lesson; the UI confirms that first.
  IF p_reset THEN
    DELETE FROM public.flashcards WHERE lesson_id = p_lesson_id;
    DELETE FROM public.questions  WHERE lesson_id = p_lesson_id;
  END IF;

  UPDATE public.lessons SET
    generation_run_id              = v_run,
    generation_heartbeat_at        = now(),
    generation_cancel_requested_at = NULL,
    generation_cancelled_at        = NULL,
    generated_at                   = NULL,
    generation_chunk               = CASE WHEN p_reset THEN NULL ELSE generation_chunk END,
    why_it_matters                 = CASE WHEN p_reset THEN NULL ELSE why_it_matters END
  WHERE id = p_lesson_id;

  RETURN v_run;
END $$;

-- ── generation_tick ──────────────────────────────────────────────────────────
-- Returns false when the run should stop: cancelled, superseded or cleared.

CREATE OR REPLACE FUNCTION public.generation_tick(p_lesson_id uuid, p_run_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  WITH t AS (
    UPDATE public.lessons SET generation_heartbeat_at = now()
    WHERE id = p_lesson_id AND generation_run_id = p_run_id
      AND generation_cancel_requested_at IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM t);
$$;

-- ── save_generated_chunk ─────────────────────────────────────────────────────
-- p_cards:     [{front, back, source_anchor}]
-- p_questions: [{question_type, stem, options, correct_index, explanation, source_anchor}]
-- Returns false (and writes nothing) if the run is no longer current.

CREATE OR REPLACE FUNCTION public.save_generated_chunk(
  p_lesson_id uuid, p_run_id uuid, p_cards jsonb, p_questions jsonb, p_why_it_matters text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admins only' USING ERRCODE = '42501';
  END IF;

  -- The row lock serialises this against request_generation_cancel(),
  -- clear_lesson() and queue_generation(): whichever commits first wins, and
  -- a cancel can never land between this check and the inserts.
  PERFORM 1 FROM public.lessons
   WHERE id = p_lesson_id AND generation_run_id = p_run_id
     AND generation_cancel_requested_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.flashcards (lesson_id, front, back, source_anchor)
  SELECT p_lesson_id, c.front, c.back, c.source_anchor
  FROM jsonb_to_recordset(coalesce(p_cards, '[]'::jsonb))
       AS c(front text, back text, source_anchor text);

  INSERT INTO public.questions (lesson_id, question_type, stem, options, correct_index, explanation, source_anchor)
  SELECT p_lesson_id, q.question_type, q.stem, q.options, q.correct_index, q.explanation, q.source_anchor
  FROM jsonb_to_recordset(coalesce(p_questions, '[]'::jsonb))
       AS q(question_type text, stem text, options jsonb, correct_index int, explanation text, source_anchor text);

  UPDATE public.lessons SET
    generation_heartbeat_at = now(),
    why_it_matters = coalesce(p_why_it_matters, why_it_matters)
  WHERE id = p_lesson_id;

  RETURN true;
END $$;

-- ── request_generation_cancel ────────────────────────────────────────────────
-- 'cancelling': a live run will stop at its next check (within seconds).
-- 'cancelled':  nothing alive was running, so it's settled immediately.
-- 'idle':       no run to stop.

CREATE OR REPLACE FUNCTION public.request_generation_cancel(p_lesson_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  l record;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admins only' USING ERRCODE = '42501';
  END IF;

  SELECT generation_run_id, generation_heartbeat_at, generated_at
    INTO l FROM public.lessons WHERE id = p_lesson_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lesson not found' USING ERRCODE = 'P0002';
  END IF;
  IF l.generation_run_id IS NULL OR l.generated_at IS NOT NULL THEN
    RETURN 'idle';
  END IF;

  IF l.generation_heartbeat_at > now() - interval '2 minutes' THEN   -- GENERATION_STALE
    UPDATE public.lessons SET generation_cancel_requested_at = now() WHERE id = p_lesson_id;
    RETURN 'cancelling';
  END IF;

  UPDATE public.lessons SET
    generation_cancel_requested_at = now(),
    generation_cancelled_at        = now(),
    generation_run_id              = NULL
  WHERE id = p_lesson_id;
  RETURN 'cancelled';
END $$;

-- ── clear_lesson ─────────────────────────────────────────────────────────────
-- Undo a paste: the lesson goes back to empty and can be pasted again.
-- Deletes its flashcards and questions, which cascades to every student's
-- card_progress and attempts for it; the UI shows that count first. Any run
-- still in flight loses its run id, so its next save is refused.

CREATE OR REPLACE FUNCTION public.clear_lesson(p_lesson_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admins only' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.lessons WHERE id = p_lesson_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lesson not found' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public.flashcards WHERE lesson_id = p_lesson_id;
  DELETE FROM public.questions  WHERE lesson_id = p_lesson_id;

  UPDATE public.lessons SET
    source_content                 = '',
    created_by                     = NULL,
    why_it_matters                 = NULL,
    depth_content                  = NULL,
    depth_generated_at             = NULL,
    generated_at                   = NULL,
    generation_chunk               = NULL,
    generation_run_id              = NULL,
    generation_heartbeat_at        = NULL,
    generation_cancel_requested_at = NULL,
    generation_cancelled_at        = NULL
  WHERE id = p_lesson_id;
END $$;

REVOKE ALL ON FUNCTION
  public.queue_generation(uuid, boolean),
  public.generation_tick(uuid, uuid),
  public.save_generated_chunk(uuid, uuid, jsonb, jsonb, text),
  public.request_generation_cancel(uuid),
  public.clear_lesson(uuid)
FROM public, anon;

GRANT EXECUTE ON FUNCTION
  public.queue_generation(uuid, boolean),
  public.generation_tick(uuid, uuid),
  public.save_generated_chunk(uuid, uuid, jsonb, jsonb, text),
  public.request_generation_cancel(uuid),
  public.clear_lesson(uuid)
TO authenticated;

NOTIFY pgrst, 'reload schema';
