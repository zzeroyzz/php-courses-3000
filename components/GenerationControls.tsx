'use client';

import { useMemo, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import * as db from '@/lib/db';

// Admin controls for a lesson's generated content. Both actions are
// server-side and race-safe (migration 013); these components only ask.

// Stop a running generation. Stopping is always an explicit choice between:
//   keep    — end the run; cards and questions saved so far stay, and it can
//             be resumed later (the right lesson, just stop spending credits)
//   discard — clear the lesson entirely, pasted text included (the wrong
//             lesson: undo the paste)
export function StopGeneration({
  lessonId,
  onStopped,
  discardLabel = 'Stop and clear this lesson',
}: {
  lessonId: string;
  onStopped: (mode: 'keep' | 'discard') => void;
  discardLabel?: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'keep' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function stop(mode: 'keep' | 'discard') {
    setBusy(mode);
    setError(null);
    // Clearing takes the run id away, which stops the run by itself.
    const ok = mode === 'keep'
      ? (await db.requestGenerationCancel(supabase, lessonId)) !== null
      : await db.clearLesson(supabase, lessonId);
    setBusy(null);
    if (!ok) { setError('Couldn’t stop it. Try again.'); return; }
    setOpen(false);
    onStopped(mode);
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-[12px] text-n500 hover:text-fg transition-colors">
        Stop
      </button>
    );
  }

  return (
    <div className="w-full space-y-2 pt-1">
      <p className="text-[12px] text-n400">Stop generating this lesson?</p>
      <button onClick={() => stop('keep')} disabled={!!busy} className="btn btn-secondary btn-block text-left">
        {busy === 'keep' ? 'Stopping…' : 'Stop and keep what’s generated'}
      </button>
      <button onClick={() => stop('discard')} disabled={!!busy} className="btn btn-secondary btn-block" style={{ color: '#e87d6e' }}>
        {busy === 'discard' ? 'Clearing…' : discardLabel}
      </button>
      <button onClick={() => setOpen(false)} disabled={!!busy} className="text-[12px] text-n600 hover:text-fg">
        Keep going
      </button>
      {error && <p className="text-[12px]" style={{ color: '#e87d6e' }}>{error}</p>}
    </div>
  );
}

// Undo a paste: the lesson goes back to "not added", source included, so it
// can be pasted again (or pasted into the right lesson). Confirms first, with
// how many students would lose progress.
export function ClearLesson({
  lessonId,
  onCleared,
  label = 'Clear lesson',
}: {
  lessonId: string;
  onCleared: () => void;
  label?: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [confirming, setConfirming] = useState<number | null>(null);   // learner count
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    setError(null);
    setConfirming(await db.getLessonLearnerCount(supabase, lessonId));
  }

  async function clear() {
    setBusy(true);
    const ok = await db.clearLesson(supabase, lessonId);
    setBusy(false);
    if (!ok) { setError('Couldn’t clear the lesson. Try again.'); return; }
    setConfirming(null);
    onCleared();
  }

  if (confirming === null) {
    return (
      <button onClick={ask} className="text-[12px] text-n600 hover:text-fg transition-colors">
        {label}
      </button>
    );
  }

  return (
    <div className="w-full space-y-2 pt-1">
      <p className="text-[12px] text-n400 leading-relaxed">
        This removes the pasted text, its cards and questions, and any deeper reading. The lesson goes back
        to &ldquo;not added&rdquo;.
        {confirming > 0
          ? <> It also <span className="text-fg">erases progress for {confirming} student{confirming !== 1 ? 's' : ''}</span>.</>
          : ' No students have progress on it.'}
      </p>
      <div className="flex gap-2">
        <button onClick={() => setConfirming(null)} disabled={busy} className="btn btn-secondary flex-1">Cancel</button>
        <button onClick={clear} disabled={busy} className="btn btn-secondary flex-1" style={{ color: '#e87d6e' }}>
          {busy ? 'Clearing…' : 'Clear lesson'}
        </button>
      </div>
      {error && <p className="text-[12px]" style={{ color: '#e87d6e' }}>{error}</p>}
    </div>
  );
}
