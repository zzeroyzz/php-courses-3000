'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/client';
import * as db from '@/lib/db';
import { scheduleCard, shuffle } from '@/lib/srs';
import type { StudyCard } from '@/lib/db-types';

export default function ReviewPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [userId, setUserId] = useState<string | null>(null);
  const [queue, setQueue] = useState<StudyCard[]>([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessionCorrect, setSessionCorrect] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/sign-in'); return; }
      setUserId(user.id);
      setQueue(shuffle(await db.getDueCards(supabase)));
      setLoading(false);
    });
  }, [supabase, router]);

  async function handleAnswer(correct: boolean) {
    const card = queue[idx];
    if (!card || !userId) return;

    const updates = scheduleCard(card, correct);
    await db.saveCardReview(supabase, userId, card.id, {
      ease: updates.ease,
      interval_days: updates.interval_days,
      due_at: updates.due_at.toISOString(),
      lapses: updates.lapses,
    });

    if (correct) setSessionCorrect((n) => n + 1);
    setSessionTotal((n) => n + 1);

    const next = idx + 1;
    if (next >= queue.length) {
      setDone(true);
    } else {
      setIdx(next);
      setFlipped(false);
    }
  }

  const card = queue[idx];

  return (
    <div className="min-h-dvh bg-bg pb-24 md:pb-8">

      <div >
        <header
          className="px-5 py-4 md:px-8"
          style={{ borderBottom: '1px solid var(--color-divider)' }}
        >
          <h1 className="text-[17px] font-medium text-fg">Review</h1>
          <p className="text-[13px] text-n500 mt-0.5">
            {loading
              ? 'Loading…'
              : done || queue.length === 0
              ? sessionTotal > 0
                ? `${sessionCorrect}/${sessionTotal} correct this session`
                : 'All caught up'
              : `${idx + 1} of ${queue.length}`}
          </p>
        </header>

        <div className="max-w-xl mx-auto px-5 py-8">
          {loading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg" style={{ background: 'var(--color-surface)' }} />
              ))}
            </div>
          ) : queue.length === 0 ? (
            <div className="rounded-lg p-8 text-center space-y-4" style={{ background: 'var(--color-surface)' }}>
              <p className="text-[22px] font-medium text-fg">All caught up</p>
              <p className="text-[15px] text-n400 leading-relaxed">
                No cards are due right now. Cards join your review schedule when you complete a lesson.
              </p>
              <Link href="/" className="btn btn-secondary btn-block mt-4">Back to home</Link>
            </div>
          ) : done ? (
            <div className="rounded-lg p-8 text-center space-y-5" style={{ background: 'var(--color-surface)' }}>
              <p className="text-[22px] font-medium text-fg">Session complete</p>
              <div className="flex items-center justify-center gap-8 py-2">
                <div>
                  <p className="text-[32px] font-medium text-fg tabular-nums">{sessionCorrect}</p>
                  <p className="text-[12px] text-n500 mt-1">Correct</p>
                </div>
                <div className="w-px h-10" style={{ background: 'var(--color-divider)' }} />
                <div>
                  <p className="text-[32px] font-medium text-fg tabular-nums">{sessionTotal - sessionCorrect}</p>
                  <p className="text-[12px] text-n500 mt-1">Again</p>
                </div>
                <div className="w-px h-10" style={{ background: 'var(--color-divider)' }} />
                <div>
                  <p className="text-[32px] font-medium text-fg tabular-nums">
                    {Math.round((sessionCorrect / sessionTotal) * 100)}%
                  </p>
                  <p className="text-[12px] text-n500 mt-1">Accuracy</p>
                </div>
              </div>
              <Link href="/" className="btn btn-primary btn-block">Done</Link>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Progress bar */}
              <div className="h-1 rounded-sm overflow-hidden" style={{ background: 'var(--color-n900)' }}>
                <div
                  className="h-full rounded-sm transition-all duration-300"
                  style={{ width: `${(idx / queue.length) * 100}%`, background: 'var(--color-accent)' }}
                />
              </div>

              {/* Card */}
              <button
                onClick={() => setFlipped((f) => !f)}
                className="w-full text-left cursor-pointer transition-colors rounded-lg p-8"
                style={{
                  minHeight: '400px',
                  background: 'var(--color-surface)',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <p className="text-[11px] font-medium text-n600 uppercase tracking-wide mb-5">
                  {flipped ? 'Answer' : 'Description'}
                </p>
                <p className="text-[24px] font-medium text-fg leading-relaxed flex-1">
                  {flipped ? card.back : card.front}
                </p>
                {!flipped && (
                  <p className="text-[13px] text-n700 mt-6">Tap to reveal</p>
                )}
              </button>

              {/* Answer buttons */}
              <div
                className={`flex gap-3 transition-all duration-150 ${flipped ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
              >
                <button
                  onClick={() => handleAnswer(false)}
                  className="flex-1 py-3 rounded-lg text-[14px] font-medium text-n400 transition-colors"
                  style={{ border: '1px solid var(--color-divider)' }}
                >
                  Again
                </button>
                <button
                  onClick={() => handleAnswer(true)}
                  className="flex-1 py-3 rounded-lg text-[14px] font-medium transition-colors"
                  style={{
                    background: 'color-mix(in srgb, var(--color-accent) 16%, transparent)',
                    color: 'var(--color-accent-md)',
                    border: '1px solid var(--color-accent)',
                  }}
                >
                  Got it
                </button>
              </div>

              {/* Source anchor */}
              {card.source_anchor && flipped && (
                <Link
                  href={`/lessons/${card.lesson_id}?tab=read&anchor=${encodeURIComponent(card.source_anchor)}`}
                  className="block text-[12px] text-n600 hover:text-n400 italic transition-colors text-center"
                >
                  &ldquo;{card.source_anchor.slice(0, 60)}&hellip;&rdquo; →
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
