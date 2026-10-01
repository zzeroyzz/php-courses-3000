'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/client';
import { APP_NAME } from '@/lib/course';

// useSearchParams needs a Suspense boundary on a prerendered page.
export default function ForgotPasswordPage() {
  return (
    <Suspense>
      <ForgotPassword />
    </Suspense>
  );
}

function ForgotPassword() {
  const searchParams = useSearchParams();
  const linkExpired = searchParams.get('error') === 'expired';

  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSending(true);
    setError('');
    const supabase = createClient();
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });
    setSending(false);
    // Supabase returns success whether or not the address has an account, and
    // the confirmation below is worded the same way, so this page never reveals
    // who is registered. Errors here are rate limits and outages.
    if (err) {
      setError(err.status === 429
        ? 'Too many reset requests. Wait a few minutes and try again.'
        : 'Could not send the email right now. Try again in a minute.');
      return;
    }
    setSent(true);
  }

  return (
    <main className="min-h-dvh bg-bg flex flex-col justify-center px-6 md:px-0">
      <div className="w-full max-w-sm mx-auto md:ml-[15vw]">
        <div className="mb-10">
          <h1 className="text-[38px] font-medium text-fg leading-none tracking-[-0.03em]">{APP_NAME}</h1>
          <p className="text-[14px] text-n500 mt-3 leading-relaxed">Reset your password</p>
        </div>

        {sent ? (
          <div className="space-y-4">
            <div className="rounded-lg px-4 py-4 space-y-1.5" style={{ background: 'var(--color-surface)' }}>
              <p className="text-[15px] font-medium text-fg">Check your email</p>
              <p className="text-[14px] text-n500 leading-relaxed">
                If an account exists for {email.trim()}, we&rsquo;ve sent a link to reset your password.
                It expires in an hour.
              </p>
            </div>
            <Link href="/sign-in" className="text-[13px]" style={{ color: 'var(--color-accent-md)' }}>Back to sign in</Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {linkExpired && (
              <p className="text-[13px] text-n400 leading-relaxed rounded-lg px-4 py-3" style={{ background: 'var(--color-surface)' }}>
                That reset link has expired or was already used. Request a new one below.
              </p>
            )}
            <div className="field">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="input"
              />
            </div>
            {error && <p className="text-[13px] leading-snug" style={{ color: '#e87d6e' }}>{error}</p>}
            <button type="submit" disabled={sending} className="btn btn-primary btn-block">
              {sending ? 'Sending…' : 'Send reset link'}
            </button>
            <Link href="/sign-in" className="block text-[13px] text-n500 hover:text-fg">Back to sign in</Link>
          </form>
        )}
      </div>
    </main>
  );
}
