'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/client';
import { APP_NAME, COURSE_NAME } from '@/lib/course';
import { INVITE_MESSAGE, MIN_PASSWORD_LENGTH } from '@/lib/invites';
import type { InviteCheck } from '@/lib/invites';

type Phase =
  | { kind: 'checking' }
  | { kind: 'blocked'; status: Exclude<InviteCheck, 'pending'> }
  | { kind: 'form'; lockedEmail: string | null }
  | { kind: 'error'; message: string };

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Validate server-side before showing any form.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/invites/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const json = await res.json() as { status?: InviteCheck; email?: string | null; error?: string };
        if (!res.ok || !json.status) { setPhase({ kind: 'error', message: json.error ?? 'Could not check this invite.' }); return; }
        if (json.status !== 'pending') { setPhase({ kind: 'blocked', status: json.status }); return; }
        if (json.email) setEmail(json.email);
        setPhase({ kind: 'form', lockedEmail: json.email ?? null });
      } catch {
        setPhase({ kind: 'error', message: 'Could not check this invite. Check your connection and reload.' });
      }
    })();
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (password.length < MIN_PASSWORD_LENGTH) { setFormError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`); return; }
    if (password !== confirm) { setFormError('The passwords don’t match.'); return; }

    setSubmitting(true);
    const res = await fetch('/api/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, email: email.trim(), password }),
    });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; status?: InviteCheck; error?: string };

    if (json.status && json.status !== 'pending') {
      setSubmitting(false);
      setPhase({ kind: 'blocked', status: json.status });
      return;
    }
    if (!res.ok || !json.ok) {
      setSubmitting(false);
      setFormError(json.error ?? 'Could not create your account.');
      return;
    }

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) {
      // The account exists; only the automatic sign-in failed.
      router.replace('/sign-in');
      return;
    }
    router.replace('/');
  }

  return (
    <main className="min-h-dvh bg-bg flex flex-col justify-center px-6 md:px-0">
      <div className="w-full max-w-sm mx-auto md:ml-[15vw]">
        <div className="mb-10">
          <h1 className="text-[38px] font-medium text-fg leading-none tracking-[-0.03em]">{APP_NAME}</h1>
          <p className="text-[14px] text-n500 mt-3 leading-relaxed">{COURSE_NAME}</p>
        </div>

        {phase.kind === 'checking' && (
          <p className="text-[14px] text-n500">Checking your invite…</p>
        )}

        {phase.kind === 'error' && (
          <p className="text-[14px] text-n400 leading-relaxed">{phase.message}</p>
        )}

        {phase.kind === 'blocked' && (
          <div className="space-y-4">
            <div className="rounded-lg px-4 py-4 space-y-1.5" style={{ background: 'var(--color-surface)' }}>
              <p className="text-[15px] font-medium text-fg">{INVITE_MESSAGE[phase.status].title}</p>
              <p className="text-[14px] text-n500 leading-relaxed">{INVITE_MESSAGE[phase.status].body}</p>
            </div>
            {phase.status === 'used' && (
              <div className="flex gap-4 text-[13px]">
                <Link href="/sign-in" style={{ color: 'var(--color-accent-md)' }}>Sign in</Link>
                <Link href="/forgot-password" className="text-n500 hover:text-fg">Forgot password?</Link>
              </div>
            )}
          </div>
        )}

        {phase.kind === 'form' && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-[14px] text-n400 leading-relaxed">You&rsquo;ve been invited. Set a password to create your account.</p>

            <div className="field">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                readOnly={!!phase.lockedEmail}
                placeholder="you@example.com"
                className="input"
                style={phase.lockedEmail ? { color: 'var(--color-n500)' } : undefined}
              />
              {phase.lockedEmail && (
                <p className="text-[12px] text-n600 mt-1.5">This invite is for this address.</p>
              )}
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                className="input"
              />
            </div>

            <div className="field">
              <label htmlFor="confirm">Confirm password</label>
              <input
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="input"
              />
            </div>

            {formError && (
              <p className="text-[13px] leading-snug" style={{ color: '#e87d6e' }}>{formError}</p>
            )}

            <button type="submit" disabled={submitting} className="btn btn-primary btn-block">
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
