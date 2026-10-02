'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/client';
import { APP_NAME, COURSE_NAME } from '@/lib/course';

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setLoading(true);
    setError('');

    const supabase = createClient();
    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setLoading(false);
    if (err) { setError(err.message); return; }
    router.push('/');
  }

  return (
    <main className="min-h-dvh bg-bg flex flex-col justify-center px-6 md:px-0">
      <div className="w-full max-w-sm mx-auto md:ml-[15vw]">

        <div className="mb-10">
          <h1 className="text-[38px] font-medium text-fg leading-none tracking-[-0.03em]">{APP_NAME}</h1>
          <p className="text-[14px] text-n500 mt-3 leading-relaxed">
            {COURSE_NAME}. Your progress syncs across all devices.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
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

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="input"
            />
          </div>

          {error && (
            <p className="text-[13px] leading-snug" style={{ color: '#e87d6e' }}>{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary btn-block"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          <Link href="/forgot-password" className="block text-[13px] text-n500 hover:text-fg transition-colors">
            Forgot password?
          </Link>
        </form>
      </div>
    </main>
  );
}
