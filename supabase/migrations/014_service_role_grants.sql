-- ════════════════════════════════════════════════════════════════════════
-- Migration 014: table privileges for the service role (invite routes)
--
-- The invite routes (/api/invites/validate, /api/invites/accept) run as
-- service_role. On this project, default privileges give service_role only
-- TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on new tables — no SELECT/INSERT/UPDATE —
-- and BYPASSRLS skips row policies, not table privileges. So validation failed
-- with "permission denied for table invites".
--
-- Grants exactly what those two routes do, nothing broader:
--   invites  — read an invite by token hash; claim it (used_at), record
--              used_by, or release the claim
--   profiles — the fallback upsert of a new student's profile row
-- Additive: grants only, no data touched.
-- ════════════════════════════════════════════════════════════════════════

GRANT SELECT, UPDATE ON public.invites  TO service_role;
GRANT SELECT, INSERT ON public.profiles TO service_role;

NOTIFY pgrst, 'reload schema';
