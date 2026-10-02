'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle } from '@phosphor-icons/react';
import { createClient } from '@/utils/supabase/client';
import { AppNav } from '@/components/AppNav';
import { StopGeneration } from '@/components/GenerationControls';
import { getViewer } from '@/lib/viewer';
import * as db from '@/lib/db';
import { startGeneration } from '@/lib/generation-client';
import { contentStatus, displayLessonNumber, sectionLabel } from '@/lib/db-types';
import type { Lesson, LessonSummary, Section } from '@/lib/db-types';

type Step = 'form' | 'saving' | 'generating' | 'done' | 'error';

const KIND_HINT: Record<LessonSummary['kind'], string | null> = {
  prose: null,
  infographic: 'Image-only lesson on the course platform. Paste a text description to make it studyable.',
  quiz: 'Course quiz. Paste the questions; cards and practice are generated from them.',
  document: 'Document example. Saved as reading material; cards and practice are not generated for documents.',
};

// useSearchParams needs a Suspense boundary on a prerendered page.
export default function IngestPage() {
  return (
    <Suspense>
      <Ingest />
    </Suspense>
  );
}

function Ingest() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);

  const [userId, setUserId] = useState<string | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [lessons, setLessons] = useState<LessonSummary[]>([]);   // course order
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step>('form');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [lessonId, setLessonId] = useState('');
  const [sourceContent, setSourceContent] = useState('');

  // Latest copy of the lesson row being generated, fed by Realtime. Its
  // status is derived (contentStatus), so a run that dies shows up as
  // 'stalled' without any client-side timeout.
  const genRowRef = useRef<LessonSummary | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  function cleanup() {
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
  }

  useEffect(() => {
    (async () => {
      const viewer = await getViewer(supabase);
      if (!viewer) { router.push('/sign-in'); return; }
      if (!viewer.isAdmin) { router.replace('/'); return; }
      setUserId(viewer.user.id);

      const [sects, summaries] = await Promise.all([db.getSections(supabase), db.getLessonSummaries(supabase)]);
      const order = new Map(sects.map((s, i) => [s.id, i]));
      const inOrder = [...summaries].sort(
        (a, b) => (order.get(a.section_id) ?? 0) - (order.get(b.section_id) ?? 0) || a.sort_order - b.sort_order
      );
      setSections(sects);
      setLessons(inOrder);

      const requested = searchParams.get('lesson');
      const initial = inOrder.find((l) => l.id === requested && !l.has_source)
        ?? inOrder.find((l) => !l.has_source && l.kind !== 'infographic');
      if (initial) setLessonId(initial.id);
      setLoading(false);
    })();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, router]);

  const emptyLessons = lessons.filter((l) => !l.has_source);
  const lesson = lessons.find((l) => l.id === lessonId) ?? null;
  const section = lesson ? sections.find((s) => s.id === lesson.section_id) ?? null : null;
  const sectionEmptyLessons = section ? emptyLessons.filter((l) => l.section_id === section.id) : [];

  const wordCount = sourceContent.trim() ? sourceContent.trim().split(/\s+/).length : 0;
  const canSubmit = !!lesson && !lesson.has_source && sourceContent.trim().length > 50;
  const isActive = step === 'form' || step === 'error';

  async function handleSubmit() {
    if (!userId || !lesson || !canSubmit) return;
    setErrorMsg(null);
    setStep('saving');

    // Save the paste first: a failed generation can never lose the source.
    const saved = await db.saveLessonSource(supabase, lesson.id, sourceContent, userId);
    if (!saved) { setErrorMsg('Failed to save. Please try again.'); setStep('error'); return; }
    setLessons((prev) => prev.map((l) => l.id === lesson.id ? { ...l, has_source: true } : l));

    if (lesson.kind === 'document') { setStep('done'); return; }

    setStep('generating');
    genRowRef.current = null;

    const channel = supabase
      .channel(`ingest-gen-${lesson.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'lessons', filter: `id=eq.${lesson.id}` },
        (payload) => { genRowRef.current = payload.new as Lesson; evaluate(); }
      )
      .subscribe();
    channelRef.current = channel;

    const started = await startGeneration(supabase, lesson.id, { reset: true });
    if (!started) {
      cleanup();
      setErrorMsg('Your source is saved, but generation didn\u2019t start. Start it from the chapter page.');
      setStep('done');
      return;
    }
    // The subscription may not have been live for the first write; read the
    // row once so a run that dies silently still surfaces as 'stalled'.
    const row = await db.getLessonById(supabase, lesson.id);
    if (row && !genRowRef.current) { genRowRef.current = row; evaluate(); }
  }

  // Act on the generation's derived status. Called when the row changes and
  // on a timer, since 'stalled' means "no news for too long".
  function evaluate() {
    const row = genRowRef.current;
    if (!row) return;
    const status = contentStatus(row);
    const finish = (msg: string | null) => { cleanup(); genRowRef.current = null; setErrorMsg(msg); setStep('done'); };
    if (status === 'ready') finish(null);
    else if (status === 'cancelled') finish('Stopped. What was generated so far is kept; you can resume it from the chapter page.');
    else if (status === 'failed') finish('Generation failed partway. Your source is saved; resume it from the chapter page.');
    else if (status === 'stalled') finish('Generation stopped responding. Your source is saved; restart it from the chapter page.');
  }

  useEffect(() => {
    if (step !== 'generating') return;
    const id = setInterval(evaluate, 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // "Stop and clear": the paste is undone server-side. Go back to the form with
  // the text still in the box, so it can be saved into the right lesson.
  function handleStopped(mode: 'keep' | 'discard') {
    if (mode === 'keep') return;   // the 'cancelled' status arrives over Realtime
    cleanup();
    genRowRef.current = null;
    setLessons((prev) => prev.map((l) => l.id === lessonId ? { ...l, has_source: false } : l));
    setErrorMsg('Cleared. Your text is still below. Pick the right chapter and lesson, then save again.');
    setStep('error');
  }

  function pasteNext() {
    const idx = lessons.findIndex((l) => l.id === lessonId);
    const next = lessons.slice(idx + 1).find((l) => !l.has_source && l.kind !== 'infographic')
      ?? lessons.find((l) => !l.has_source && l.kind !== 'infographic');
    setLessonId(next?.id ?? '');
    setSourceContent(''); setErrorMsg(null); setStep('form');
  }

  const label = (l: LessonSummary) => `${displayLessonNumber(l) ? `${displayLessonNumber(l)} ` : ''}${l.title}`;

  return (
    <div className="min-h-dvh bg-bg pb-24 md:pb-8">
      <AppNav />

      <div className="md:ml-56">
        <div className="max-w-2xl mx-auto w-full px-5 py-6 space-y-5">
          <header>
            <h1 className="text-[17px] font-medium text-fg">Add lesson content</h1>
            <p className="text-[13px] text-n500 mt-0.5">
              {loading ? 'Loading…' : `${emptyLessons.length} lesson${emptyLessons.length !== 1 ? 's' : ''} still empty · source is saved immediately`}
            </p>
          </header>

          {!loading && !lesson && step === 'form' && (
            <div className="rounded-lg p-6" style={{ background: 'var(--color-surface)' }}>
              <p className="text-[15px] font-medium text-fg">Every lesson has content</p>
              <p className="text-[13px] text-n500 mt-1">There are no empty lessons left to fill.</p>
            </div>
          )}

          {/* Done state */}
          {step === 'done' && lesson && section && (
            <div className="rounded-lg p-6 space-y-5" style={{ background: 'var(--color-surface)' }}>
              <div className="flex items-center gap-2">
                <CheckCircle size={18} weight="fill" style={{ color: 'var(--color-accent-md)' }} />
                <span className="text-[14px] font-medium" style={{ color: 'var(--color-accent-md)' }}>Saved</span>
                {!errorMsg && lesson.kind !== 'document' && <span className="text-[13px] text-n600">· generation complete</span>}
              </div>
              <p className="text-[17px] font-medium text-fg leading-snug">{label(lesson)}</p>
              {errorMsg && (
                <p className="text-[13px] text-n500 leading-relaxed rounded-lg px-4 py-3" style={{ background: 'var(--color-bg)' }}>
                  {errorMsg}
                </p>
              )}
              <div className="space-y-2">
                <a href={`/lessons/${lesson.id}`} className="btn btn-primary btn-block">View lesson →</a>
                <a href={`/sections/${section.slug}`} className="btn btn-secondary btn-block">Chapter overview</a>
                <button onClick={pasteNext} className="btn btn-secondary btn-block">Paste next lesson</button>
              </div>
            </div>
          )}

          {/* Form */}
          {lesson && section && step !== 'done' && (
            <div className="space-y-4">
              {errorMsg && step === 'error' && (
                <div className="rounded-lg px-4 py-3 text-[13px] text-n400"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-divider)' }}>
                  {errorMsg}
                </div>
              )}

              <div className="field">
                <label>Chapter</label>
                <select
                  value={section.id}
                  onChange={(e) => {
                    const first = emptyLessons.find((l) => l.section_id === e.target.value);
                    if (first) setLessonId(first.id);
                  }}
                  disabled={!isActive}
                  className="input"
                  style={{ appearance: 'none' }}
                >
                  {sections.map((s) => {
                    const empties = emptyLessons.filter((l) => l.section_id === s.id).length;
                    return (
                      <option key={s.id} value={s.id} disabled={empties === 0}>
                        {sectionLabel(s)}{empties === 0 ? ' — all added' : ` — ${empties} empty`}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="field">
                <label>Lesson</label>
                {isActive ? (
                  <select
                    value={lesson.id}
                    onChange={(e) => setLessonId(e.target.value)}
                    className="input"
                    style={{ appearance: 'none' }}
                  >
                    {sectionEmptyLessons.map((l) => (
                      <option key={l.id} value={l.id}>{label(l)}</option>
                    ))}
                  </select>
                ) : (
                  // While saving/generating, show the lesson actually being
                  // filled. A <select> here would fall back to its first option
                  // once this lesson stops being "empty", and show the WRONG lesson.
                  <div className="input" style={{ color: 'var(--color-n400)' }}>{label(lesson)}</div>
                )}
                {KIND_HINT[lesson.kind] && (
                  <p className="text-[12px] text-n600 mt-1.5 leading-relaxed">{KIND_HINT[lesson.kind]}</p>
                )}
              </div>

              <div className="field">
                <label>Source content</label>
                <textarea
                  rows={14}
                  placeholder="Paste the lesson text from the course here…"
                  value={sourceContent}
                  onChange={(e) => setSourceContent(e.target.value)}
                  disabled={!isActive}
                  className="input"
                  style={{ resize: 'none', lineHeight: '1.65' }}
                />
                <div className="flex items-center justify-between mt-1.5">
                  <p className="text-[11px] text-n700 tabular-nums">
                    {wordCount > 0 ? `${wordCount.toLocaleString()} words` : ''}
                  </p>
                  {wordCount > 0 && lesson.kind !== 'document' && (
                    <p className="text-[11px] text-n700 tabular-nums">
                      ~{Math.max(12, Math.min(30, Math.round(wordCount / 130)))} questions
                    </p>
                  )}
                </div>
              </div>

              <button
                onClick={handleSubmit}
                disabled={!canSubmit || !isActive}
                className="btn btn-primary btn-block"
                style={{ paddingTop: '10px', paddingBottom: '10px' }}
              >
                {step === 'saving' ? (
                  <span className="flex items-center gap-2"><Spinner /> Saving source…</span>
                ) : step === 'generating' ? (
                  <span className="flex items-center gap-2"><Spinner /> Generating…</span>
                ) : lesson.kind === 'document' ? (
                  'Save'
                ) : (
                  'Save & Generate'
                )}
              </button>

              {step === 'generating' && (
                <div className="space-y-3">
                  <p className="text-[12px] text-n600 text-center leading-relaxed">
                    Source is saved to <span className="text-n400">{label(lesson)}</span>. You can close this tab — generation finishes in the background.
                  </p>
                  <div className="flex justify-center">
                    <StopGeneration
                      lessonId={lesson.id}
                      onStopped={handleStopped}
                      discardLabel="Stop and undo this paste"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
