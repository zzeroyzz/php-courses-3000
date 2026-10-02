'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from '@phosphor-icons/react';
import { createClient } from '@/utils/supabase/client';
import { AppNav } from '@/components/AppNav';
import { CardSkeleton } from '@/components/Skeleton';
import { StopGeneration, ClearLesson } from '@/components/GenerationControls';
import { getViewer } from '@/lib/viewer';
import * as db from '@/lib/db';
import { startGeneration } from '@/lib/generation-client';
import { useNow } from '@/lib/use-now';
import {
  contentStatus,
  countsTowardProgress,
  displayLessonNumber,
  isResumable,
  sectionLabel,
} from '@/lib/db-types';
import type { ContentStatus, Section, LessonSummary } from '@/lib/db-types';

type RowStatus = ContentStatus | 'completed';

export default function SectionPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [section, setSection] = useState<Section | null>(null);
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [dueCounts, setDueCounts] = useState<Record<string, number>>({});
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  // Regenerate / start over: confirm (with the number of students who'd lose progress), then run
  const [confirming, setConfirming] = useState<{ lessonId: string; learners: number } | null>(null);
  const [actionError, setActionError] = useState<{ lessonId: string; message: string } | null>(null);

  const reloadLessons = useCallback(async (sectionId: string) => {
    setLessons(await db.getLessonSummaries(supabase, sectionId));
  }, [supabase]);

  useEffect(() => {
    (async () => {
      const viewer = await getViewer(supabase);
      if (!viewer) { router.push('/sign-in'); return; }

      const sect = await db.getSectionBySlug(supabase, slug);
      if (!sect) { router.push('/'); return; }

      const [sectionLessons, due, completed] = await Promise.all([
        db.getLessonSummaries(supabase, sect.id),
        db.getDueCounts(supabase),
        db.getCompletedLessonIds(supabase),
      ]);

      setSection(sect);
      setLessons(sectionLessons);
      setDueCounts(Object.fromEntries(due.map((d) => [d.lesson_id, d.due])));
      setCompletedIds(completed);
      setIsAdmin(viewer.isAdmin);
      setLoading(false);
    })();
  }, [supabase, router, slug]);

  // Follow generation live: every status change is a write to a lessons row.
  useEffect(() => {
    if (!section) return;
    const channel = supabase
      .channel(`section-lessons-${section.id}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'lessons', filter: `section_id=eq.${section.id}` },
        () => { reloadLessons(section.id); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [supabase, section, reloadLessons]);

  async function askRegenerate(lesson: LessonSummary) {
    setActionError(null);
    const learners = await db.getLessonLearnerCount(supabase, lesson.id);
    setConfirming({ lessonId: lesson.id, learners });
  }

  // reset: start over (deletes earlier output). Otherwise resume from the
  // chunk where it failed or was stopped, keeping what it saved.
  async function runGenerate(lesson: LessonSummary, reset: boolean) {
    if (!section) return;
    setConfirming(null);
    setActionError(null);
    const ok = await startGeneration(supabase, lesson.id, { reset, chunkFrom: lesson.generation_chunk ?? 0 });
    if (!ok) setActionError({ lessonId: lesson.id, message: 'Couldn\u2019t start generation. Try again.' });
    await reloadLessons(section.id);
  }

  const anyRunning = lessons.some((l) => {
    const st = contentStatus(l);
    return st === 'generating' || st === 'cancelling';
  });
  const now = useNow(anyRunning);

  const countable = lessons.filter(countsTowardProgress);
  const available = countable.filter((l) => contentStatus(l, now) === 'ready');
  const completedCount = available.filter((l) => completedIds.has(l.id)).length;
  const notAddedCount = countable.filter((l) => !l.has_source).length;

  return (
    <div className="min-h-dvh bg-bg pb-24 md:pb-8">
      <AppNav />

      <div className="md:ml-56">
        {/* Header */}
        <header className="px-5 py-4 md:px-8" style={{ borderBottom: '1px solid var(--color-divider)' }}>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-[13px] text-n500 hover:text-fg transition-colors mb-3"
          >
            <ArrowLeft size={14} />
            Home
          </Link>
          {section ? (
            <div>
              {section.chapter_number != null && (
                <p className="text-[12px] text-n600 mb-1">Chapter {section.chapter_number}</p>
              )}
              <h1 className="text-[22px] font-medium text-fg leading-snug tracking-[-0.02em]">
                {section.name}
              </h1>
              {!loading && (
                <p className="text-[13px] text-n500 mt-1 tabular-nums">
                  {available.length > 0
                    ? `${completedCount} of ${available.length} available complete`
                    : 'No lessons added yet'}
                  {available.length > 0 && notAddedCount > 0 && ` · ${notAddedCount} not added yet`}
                </p>
              )}
            </div>
          ) : (
            <div className="h-7 w-56 animate-pulse rounded" style={{ background: 'var(--color-n900)' }} />
          )}
        </header>

        <div className="max-w-2xl mx-auto px-5 py-6 space-y-2">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)
          ) : lessons.length === 0 ? (
            <div className="rounded-lg p-8 text-center" style={{ background: 'var(--color-surface)' }}>
              <p className="text-[15px] text-n500">This chapter has no lessons.</p>
            </div>
          ) : (
            <>
              {!isAdmin && available.length === 0 && (
                <p className="text-[13px] text-n500 pb-2 leading-relaxed">
                  Lessons in {section ? sectionLabel(section) : 'this chapter'} haven&rsquo;t been added yet.
                  They&rsquo;ll unlock here as your instructor adds them.
                </p>
              )}

              {lessons.map((lesson) => {
                const content = contentStatus(lesson, now);
                const status: RowStatus = content === 'ready' && completedIds.has(lesson.id) ? 'completed' : content;
                const due = dueCounts[lesson.id] ?? 0;
                const number = displayLessonNumber(lesson);
                const isConfirming = confirming?.lessonId === lesson.id;
                const error = actionError?.lessonId === lesson.id ? actionError.message : null;
                const refresh = () => section && reloadLessons(section.id);

                // Empty lessons: dimmed and inert for students; a paste link for admins.
                if (content === 'empty') {
                  const emptyLabel = lesson.kind === 'infographic' ? 'Image-only lesson' : 'Not added yet';
                  const titleRow = (
                    <div className="flex items-start justify-between gap-4 px-4 py-3">
                      <p className="text-[14px] text-n600 leading-snug">
                        {number && <span className="tabular-nums mr-2">{number}</span>}
                        {lesson.title}
                      </p>
                      <span className="text-[11px] text-n700 shrink-0 mt-0.5">
                        {isAdmin ? 'Paste content →' : emptyLabel}
                      </span>
                    </div>
                  );
                  return isAdmin ? (
                    <Link
                      key={lesson.id}
                      href={`/ingest?lesson=${lesson.id}`}
                      className="block rounded-lg hover:bg-dim transition-colors"
                      style={{ border: '1px dashed var(--color-divider)' }}
                    >
                      {titleRow}
                    </Link>
                  ) : (
                    <div key={lesson.id} className="rounded-lg" style={{ border: '1px dashed var(--color-divider)' }}>
                      {titleRow}
                    </div>
                  );
                }

                return (
                  <div
                    key={lesson.id}
                    className="rounded-lg overflow-hidden"
                    style={{ background: 'var(--color-surface)' }}
                  >
                    <Link
                      href={`/lessons/${lesson.id}`}
                      className="flex items-start justify-between gap-4 px-4 py-3.5 hover:bg-dim transition-colors group"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-[15px] font-medium text-fg leading-snug group-hover:text-accent-md transition-colors">
                          {number && <span className="tabular-nums text-n500 font-normal mr-2">{number}</span>}
                          {lesson.title}
                        </p>
                        {(status === 'ready' || status === 'completed') && lesson.generated_at && (
                          <p className="text-[12px] text-n600 mt-0.5 tabular-nums">
                            {due > 0
                              ? <span style={{ color: 'var(--color-accent-md)' }}>{due} due</span>
                              : status === 'completed' ? 'Completed' : 'Ready to study'}
                          </p>
                        )}
                      </div>
                      <StatusTag status={status} kind={lesson.kind} />
                    </Link>

                    {(status === 'ready' || status === 'completed') && lesson.generated_at && !isConfirming && (
                      <div className="flex items-center" style={{ borderTop: '1px solid var(--color-divider)' }}>
                        <Link
                          href={`/lessons/${lesson.id}?tab=cards`}
                          className="flex-1 text-center py-2 text-[12px] text-n600 hover:text-fg transition-colors"
                        >
                          Cards {due > 0 ? `(${due})` : ''}
                        </Link>
                        <div className="w-px h-4" style={{ background: 'var(--color-divider)' }} />
                        <Link
                          href={`/lessons/${lesson.id}?tab=practice`}
                          className="flex-1 text-center py-2 text-[12px] text-n600 hover:text-fg transition-colors"
                        >
                          Practice
                        </Link>
                        {isAdmin && (
                          <>
                            <div className="w-px h-4" style={{ background: 'var(--color-divider)' }} />
                            <button
                              onClick={() => askRegenerate(lesson)}
                              className="flex-1 text-center py-2 text-[12px] text-n600 hover:text-fg transition-colors"
                            >
                              Regenerate
                            </button>
                          </>
                        )}
                      </div>
                    )}

                    {isConfirming && confirming && (
                      <div className="px-4 py-3 space-y-3" style={{ borderTop: '1px solid var(--color-divider)' }}>
                        <p className="text-[13px] text-n400 leading-relaxed">
                          Regenerating replaces this lesson&rsquo;s cards and questions
                          {confirming.learners > 0
                            ? <> and <span className="text-fg">erases progress for {confirming.learners} student{confirming.learners !== 1 ? 's' : ''}</span> (their card schedules and answer history for this lesson).</>
                            : '. No students have progress on it yet.'}
                        </p>
                        <div className="flex gap-2">
                          <button onClick={() => setConfirming(null)} className="btn btn-secondary flex-1">Cancel</button>
                          <button onClick={() => runGenerate(lesson, true)} className="btn btn-primary flex-1">Regenerate</button>
                        </div>
                      </div>
                    )}

                    {(status === 'generating' || status === 'cancelling') && (
                      <div className="px-4 py-2 flex flex-wrap items-center gap-2" style={{ borderTop: '1px solid var(--color-divider)' }}>
                        <Spinner />
                        <p className="text-[12px] text-n600 flex-1">{status === 'cancelling' ? 'Stopping…' : 'Generating…'}</p>
                        {isAdmin && status === 'generating' && (
                          <StopGeneration lessonId={lesson.id} onStopped={refresh} />
                        )}
                      </div>
                    )}

                    {(isResumable(status as ContentStatus) || status === 'stalled') && (
                      <div className="px-4 py-2 space-y-2" style={{ borderTop: '1px solid var(--color-divider)' }}>
                        <p className="text-[12px] text-n600">
                          {!isAdmin
                            ? 'Study materials are being prepared.'
                            : status === 'cancelled'
                            ? `Stopped before part ${(lesson.generation_chunk ?? 0) + 1}. What was generated is kept.`
                            : status === 'failed'
                            ? `Generation failed at part ${(lesson.generation_chunk ?? 0) + 1}.`
                            : 'Generation isn\u2019t running. It may have timed out.'}
                        </p>
                        {isAdmin && !isConfirming && (
                          <div className="flex flex-wrap gap-x-4 gap-y-2 items-center">
                            {lesson.generation_chunk != null && (
                              <button onClick={() => runGenerate(lesson, false)} className="text-[12px]" style={{ color: 'var(--color-accent-md)' }}>
                                Resume
                              </button>
                            )}
                            <button onClick={() => askRegenerate(lesson)} className="text-[12px] text-n600 hover:text-fg">
                              {lesson.generation_chunk != null ? 'Start over' : 'Generate'}
                            </button>
                            <ClearLesson lessonId={lesson.id} onCleared={refresh} />
                          </div>
                        )}
                      </div>
                    )}

                    {error && (
                      <p className="px-4 py-2 text-[12px] text-n500" style={{ borderTop: '1px solid var(--color-divider)' }}>
                        {error}
                      </p>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<RowStatus, string> = {
  empty: 'Not added',
  generating: 'Generating',
  cancelling: 'Stopping',
  cancelled: 'Stopped',
  failed: 'Failed',
  stalled: 'Not running',
  ready: 'Ready',
  completed: 'Done',
};

function StatusTag({ status, kind }: { status: RowStatus; kind: LessonSummary['kind'] }) {
  const styles: Record<RowStatus, React.CSSProperties> = {
    empty:      { background: 'transparent', color: 'var(--color-n700)', border: '1px solid var(--color-divider)' },
    generating: { background: 'var(--color-accent-dk)', color: 'var(--color-accent-md)', border: 'none' },
    cancelling: { background: 'var(--color-accent-dk)', color: 'var(--color-accent-md)', border: 'none' },
    cancelled:  { background: 'transparent', color: 'var(--color-n500)', border: '1px solid var(--color-divider)' },
    failed:     { background: 'transparent', color: 'var(--color-n500)', border: '1px solid var(--color-divider)' },
    stalled:    { background: 'transparent', color: 'var(--color-n500)', border: '1px solid var(--color-divider)' },
    ready:      { background: 'var(--color-accent-dk)', color: 'var(--color-accent-md)', border: 'none' },
    completed:  { background: 'var(--color-n900)', color: 'var(--color-n500)', border: 'none' },
  };
  const label = status === 'ready' && kind === 'document' ? 'Document' : STATUS_LABEL[status];
  return (
    <span className="tag shrink-0 mt-0.5" style={styles[status]}>
      {label}
    </span>
  );
}

function Spinner() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin text-n600" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
