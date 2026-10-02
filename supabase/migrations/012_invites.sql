-- ════════════════════════════════════════════════════════════════════════
-- Migration 012: per-person invite links
--
-- Accounts are created only through /api/invites/accept, which validates an
-- invite and then calls auth.admin.createUser with the service role. Email
-- signups must be DISABLED in the Supabase dashboard — otherwise anyone holding
-- the (public) anon key can call auth.signUp() directly and none of this gates
-- anything.
--
-- Status (pending / used / revoked / expired) is derived from the timestamps,
-- never stored, so it can't disagree with them — same approach as
-- contentStatus() for lessons.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE public.invites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- sha256(token) as hex. The token itself is a bearer credential and is never
  -- stored: if this table leaks, the hashes can't be turned back into links.
  token_hash  text        NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  email       text        CHECK (email IS NULL OR email = lower(email)),  -- if set, signup must use it
  label       text        NOT NULL CHECK (length(trim(label)) > 0),       -- admin's note: who it's for
  created_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '14 days',
  revoked_at  timestamptz,
  used_at     timestamptz,
  used_by     uuid        REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX invites_created_at_idx ON public.invites (created_at DESC);

ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;

-- Admins only. Students and anonymous clients get no policy at all, so they
-- can't list invites or probe whether a token hash exists. Token validation and
-- claiming happen server-side under the service role, which bypasses RLS.
CREATE POLICY "admins manage invites"
  ON public.invites FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

REVOKE ALL ON public.invites FROM anon;
REVOKE ALL ON public.invites FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.invites TO authenticated;   -- RLS narrows to admins

NOTIFY pgrst, 'reload schema';
