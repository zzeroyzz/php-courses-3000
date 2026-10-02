'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/client';
import { APP_NAME } from '@/lib/course';
import { MIN_PASSWORD_LENGTH } from '@/lib/invites';

// Reached from /auth/callback after a reset link is verified, which leaves a
// short-lived recovery session. Without that session there's nothing to update.
export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => setHasSession(!!user));
  }, [supabase]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < MIN_PASSWORD_LENGTH) { setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`); return; }
    if (password !== confirm) { setError('The passwords don’t match.'); return; }
    setSaving(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (err) {
      setError(err.code === 'same_password' ? 'Choose a password different from your old one.' : err.message);
      return;
    }
    router.replace('/');
  }

  return (
    <main className="min-h-dvh bg-bg flex flex-col justify-center px-6 md:px-0">
      <div className="w-full max-w-sm mx-auto md:ml-[15vw]">
        <div className="mb-10">
          <h1 className="text-[38px] font-medium text-fg leading-none tracking-[-0.03em]">{APP_NAME}</h1>
          <p className="text-[14px] text-n500 mt-3 leading-relaxed">Choose a new password</p>
        </div>

        {hasSession === null && <p className="text-[14px] text-n500">Checking your reset link…</p>}

        {hasSession === false && (
          <div className="space-y-4">
            <div className="rounded-lg px-4 py-4 space-y-1.5" style={{ background: 'var(--color-surface)' }}>
              <p className="text-[15px] font-medium text-fg">This reset link has expired</p>
              <p className="text-[14px] text-n500 leading-relaxed">Reset links work once and last an hour. Request a new one.</p>
            </div>
            <Link href="/forgot-password" className="text-[13px]" style={{ color: 'var(--color-accent-md)' }}>Request a new link</Link>
          </div>
        )}

        {hasSession && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="field">
              <label htmlFor="password">New password</label>
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
              <label htmlFor="confirm">Confirm new password</label>
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
            {error && <p className="text-[13px] leading-snug" style={{ color: '#e87d6e' }}>{error}</p>}
            <button type="submit" disabled={saving} className="btn btn-primary btn-block">
              {saving ? 'Saving…' : 'Save new password'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
