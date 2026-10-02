'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Cards, BookOpen, Target } from '@phosphor-icons/react';
import { createClient } from '@/utils/supabase/client';
import { useCourse } from '@/lib/course-context';
import * as db from '@/lib/db';
import { PROGRESS_LABEL } from '@/lib/course';
import { chapterMastery, weightedProgress, accuracyOf } from '@/lib/progress';
import { contentStatus, countsTowardProgress, displayLessonNumber, sectionLabel } from '@/lib/db-types';
import type { Section, LessonSummary, SectionStats } from '@/lib/db-types';

type ChapterRow = {
  section: Section;
  countable: number;
  ready: LessonSummary[];
  completed: number;
  due: number;
  stats: SectionStats | undefined;
  mastery: number;
};

// Course data (sections, lessons, completion, due counts) comes from the shared
// CourseProvider; only practice stats are fetched here.
export default function HomePage() {
  const supabase = useMemo(() => createClient(), []);
  const course = useCourse();
  const [stats, setStats] = useState<SectionStats[] | null>(null);

  useEffect(() => {
    db.getSectionStats(supabase, new Date(Date.now() - 30 * 86400000)).then(setStats);
  }, [supabase]);

  if (!course || !stats) return <HomeSkeleton />;

  const { sections, lessons, completedIds, dueByLesson, totalDue, viewer } = course;
  const isAdmin = viewer.isAdmin;
  const statsBySection = new Map(stats.map((s) => [s.section_id, s]));

  const rows: ChapterRow[] = sections.map((section) => {
    const chapterLessons = lessons.filter((l) => l.section_id === section.id);
    const countable = chapterLessons.filter(countsTowardProgress);
    const ready = countable.filter((l) => contentStatus(l) === 'ready');
    const s = statsBySection.get(section.id);
    return {
      section,
      countable: countable.length,
      ready,
      completed: ready.filter((l) => completedIds.has(l.id)).length,
      due: chapterLessons.reduce((n, l) => n + (dueByLesson.get(l.id) ?? 0), 0),
      stats: s,
      mastery: chapterMastery(s, countable.length),
    };
  });

  const progressPct = weightedProgress(rows) * 100;
  const totalCountable = rows.reduce((n, r) => n + r.countable, 0);
  const totalReady = rows.reduce((n, r) => n + r.ready.length, 0);
  const totalCompleted = rows.reduce((n, r) => n + r.completed, 0);
  const anyPractice = rows.some((r) => (r.stats?.answered ?? 0) > 0);

  const nextLesson = lessons.find((l) => countsTowardProgress(l) && contentStatus(l) === 'ready' && !completedIds.has(l.id)) ?? null;
  const nextEmpty = lessons.find((l) => !l.has_source && l.kind !== 'infographic') ?? null;
  const startedRows = rows.filter((r) => r.ready.length > 0);
  const focus = [...startedRows]
    .sort((a, b) => b.section.exam_weight * (1 - b.mastery) - a.section.exam_weight * (1 - a.mastery))[0] ?? null;

  const chapterOf = (l: LessonSummary) => sections.find((s) => s.id === l.section_id);
  const lessonLabel = (l: LessonSummary) => `${displayLessonNumber(l) ? `${displayLessonNumber(l)} ` : ''}${l.title}`;

  // ── Today: up to three cards, most urgent first ──
  type TodayCard = { key: string; href?: string; icon: React.ReactNode; kicker: string; title: string; hint: string };
  const today: TodayCard[] = [];
  if (totalDue > 0) {
    today.push({ key: 'review', href: '/review', icon: <Cards size={18} />, kicker: 'Review', title: `${totalDue} card${totalDue !== 1 ? 's' : ''} due`, hint: 'Spaced repetition · a few minutes' });
  }
  if (nextLesson) {
    const ch = chapterOf(nextLesson);
    today.push({ key: 'next', href: `/lessons/${nextLesson.id}`, icon: <BookOpen size={18} />, kicker: ch ? `Up next · ${sectionLabel(ch)}` : 'Up next', title: lessonLabel(nextLesson), hint: 'Read it, then mark it complete' });
  }
  if (focus && focus.section.id !== (nextLesson && chapterOf(nextLesson)?.id)) {
    const acc = accuracyOf(focus.stats);
    today.push({ key: 'focus', href: `/sections/${focus.section.slug}`, icon: <Target size={18} />, kicker: 'Focus', title: sectionLabel(focus.section), hint: acc === null ? 'No practice yet in this chapter' : `${Math.round(acc * 100)}% accuracy · most room to grow` });
  }
  if (isAdmin && nextEmpty) {
    today.push({ key: 'add', href: `/ingest?lesson=${nextEmpty.id}`, icon: <ArrowRight size={18} />, kicker: 'Add content', title: lessonLabel(nextEmpty), hint: 'Next lesson waiting to be pasted' });
  }

  return (
    <div className="min-h-dvh bg-bg pb-24 md:pb-10">
      <div className="max-w-2xl xl:max-w-[1080px] mx-auto px-5 md:px-8 pt-6 md:pt-10 space-y-10">

        {/* ── Header ── */}
        <header>
          <h1 className="text-[26px] md:text-[32px] font-medium text-fg tracking-[-0.02em] leading-tight">Today</h1>
          <p className="text-[13px] text-n500 mt-1 tabular-nums">
            {totalReady} of {totalCountable} lessons available · {totalCompleted} completed
          </p>
        </header>

        {sections.length === 0 ? (
          <div className="rounded-lg p-6 space-y-2" style={{ background: 'var(--color-surface)' }}>
            <p className="text-[15px] font-medium text-fg">The course isn&rsquo;t set up yet</p>
            <p className="text-[13px] text-n500 leading-relaxed">
              {isAdmin ? 'No chapters found. Apply the course-structure seed (migration 011).' : 'Your instructor is still setting up the course. Check back soon.'}
            </p>
          </div>
        ) : (
          <>
            {/* ── Progress strip (desktop: one horizontal bar) ── */}
            <section className="rounded-lg px-4 py-4 md:px-5 md:flex md:items-center md:gap-6 space-y-3 md:space-y-0" style={{ background: 'var(--color-surface)' }}>
              <div className="flex items-baseline justify-between md:block md:w-44 md:shrink-0">
                <span className="text-[14px] font-medium text-fg">{PROGRESS_LABEL}</span>
                <span className="md:hidden text-[13px] tabular-nums text-n400">{Math.round(progressPct)}%</span>
              </div>
              <div className="flex-1 relative h-1.5 rounded-sm" style={{ background: 'var(--color-bg)' }}>
                <div className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${totalCountable ? (totalReady / totalCountable) * 100 : 0}%`, background: 'var(--color-accent-dk)' }} />
                <div className="absolute inset-y-0 left-0 rounded-sm transition-all duration-500" style={{ width: `${Math.min(progressPct, 100)}%`, background: 'var(--color-accent)', boxShadow: '0 0 12px rgba(145,132,217,.6)' }} />
              </div>
              <span className="hidden md:block w-14 text-right text-[15px] tabular-nums text-fg">{Math.round(progressPct)}%</span>
              <p className="md:hidden text-[12px] text-n600">
                {anyPractice ? 'Accuracy × lessons practised, per chapter' : totalReady ? 'Answer practice questions to build progress' : 'Grows as lessons are added and practised'}
              </p>
            </section>

            {/* ── Today ── */}
            <section className="space-y-3">
              {today.length === 0 ? (
                <div className="rounded-lg p-5" style={{ background: 'var(--color-surface)' }}>
                  <p className="text-[15px] font-medium text-fg">{totalReady === 0 ? 'Lessons are on the way' : 'You’re all caught up'}</p>
                  <p className="text-[13px] text-n500 mt-1 leading-relaxed">
                    {totalReady === 0
                      ? 'Your instructor is adding the course lesson by lesson. Chapters light up on the map below as they arrive.'
                      : 'Every available lesson is complete and nothing is due. New lessons appear here as they’re added.'}
                  </p>
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-3 md:gap-4">
                  {today.slice(0, 3).map((card, i) => (
                    <Link
                      key={card.key}
                      href={card.href!}
                      className="group flex flex-col rounded-lg p-4 md:p-5 md:min-h-[170px] transition-colors hover:bg-dim"
                      style={i === 0
                        ? { border: '1px solid var(--color-accent)' }
                        : { background: 'var(--color-surface)', border: '1px solid transparent' }}
                    >
                      <span className="flex items-center gap-2 text-[11px] uppercase tracking-wide" style={{ color: i === 0 ? 'var(--color-accent-md)' : 'var(--color-n600)' }}>
                        {card.icon}
                        <span className="truncate">{card.kicker}</span>
                      </span>
                      <span className="mt-3 text-[16px] md:text-[17px] font-medium text-fg leading-snug group-hover:text-accent-hi">{card.title}</span>
                      <span className="mt-auto pt-3 text-[12px] text-n500">{card.hint}</span>
                    </Link>
                  ))}
                </div>
              )}
            </section>

            {/* ── Where you stand (chapters with content) ── */}
            {startedRows.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-[13px] font-medium uppercase tracking-wide text-n600">Where you stand</h2>
                <div className="rounded-lg overflow-hidden" style={{ background: 'var(--color-surface)' }}>
                  {startedRows.map(({ section, ready, completed, stats: st, mastery, countable }, i) => {
                    const acc = accuracyOf(st);
                    return (
                      <Link
                        key={section.id}
                        href={`/sections/${section.slug}`}
                        className={`flex items-center gap-4 px-4 py-3 transition-colors hover:bg-dim ${i > 0 ? 'row-rule' : ''}`}
                      >
                        <div className="flex-1 min-w-0 md:flex-none md:w-72">
                          <p className="text-[13px] font-medium text-fg truncate">{sectionLabel(section)}</p>
                          <p className="text-[11px] text-n600 tabular-nums md:hidden">{completed}/{ready.length} complete · {countable - ready.length} not added</p>
                        </div>
                        <div className="w-24 md:w-auto md:flex-1 shrink-0">
                          <div className="flex h-1.5 rounded-sm overflow-hidden" style={{ background: 'var(--color-accent-dk)' }}>
                            <div className="h-full rounded-sm transition-all duration-500" style={{ width: `${mastery * 100}%`, background: 'var(--color-accent)' }} />
                          </div>
                        </div>
                        <span className="hidden md:block w-28 text-right text-[12px] tabular-nums text-n500">{completed}/{ready.length} complete</span>
                        <span className="w-12 text-right text-[12px] tabular-nums text-n400">{acc === null ? '—' : `${Math.round(acc * 100)}%`}</span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Course map: the whole course at a glance ── */}
            <section className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-[13px] font-medium uppercase tracking-wide text-n600">Course map</h2>
                <span className="text-[11px] text-n700 tabular-nums">{totalReady} of {totalCountable} lessons added</span>
              </div>
              <div className="grid grid-cols-6 sm:grid-cols-9 md:grid-cols-10 xl:grid-cols-[repeat(19,minmax(0,1fr))] gap-1.5">
                {rows.map((r) => <MapTile key={r.section.id} row={r} />)}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-n600">
                <Legend color="var(--color-accent)" label="Completed" />
                <Legend color="var(--color-accent-dk)" label="Added" />
                <Legend color="var(--color-n900)" label="Not added yet" />
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// One tile per section: its number over a two-tone fill (added, completed).
function MapTile({ row }: { row: ChapterRow }) {
  const { section, countable, ready, completed } = row;
  const added = countable ? ready.length / countable : 0;
  const done = countable ? completed / countable : 0;
  const label = section.chapter_number != null ? String(section.chapter_number) : section.slug === 'orientation' ? 'O' : 'F';
  return (
    <Link
      href={`/sections/${section.slug}`}
      title={`${sectionLabel(section)} — ${ready.length} of ${countable} added, ${completed} completed`}
      className="group relative aspect-square rounded-md overflow-hidden flex items-center justify-center transition-colors"
      style={{ background: 'var(--color-n900)', boxShadow: ready.length ? 'inset 0 0 0 1px var(--color-accent-dk)' : undefined }}
    >
      <span className="absolute inset-x-0 bottom-0" style={{ height: `${added * 100}%`, background: 'var(--color-accent-dk)' }} />
      <span className="absolute inset-x-0 bottom-0" style={{ height: `${done * 100}%`, background: 'var(--color-accent)' }} />
      <span
        className="relative text-[12px] tabular-nums font-medium"
        style={{ color: done > 0.5 ? 'var(--color-bg)' : ready.length ? 'var(--color-accent-hi)' : 'var(--color-n700)' }}
      >
        {label}
      </span>
      <span className="absolute inset-0 rounded-md opacity-0 group-hover:opacity-100 transition-opacity" style={{ boxShadow: 'inset 0 0 0 1px var(--color-accent)' }} />
    </Link>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function HomeSkeleton() {
  return (
    <div className="max-w-2xl xl:max-w-[1080px] mx-auto px-5 md:px-8 pt-6 md:pt-10 space-y-6">
      <div className="h-9 w-32 animate-pulse rounded" style={{ background: 'var(--color-surface)' }} />
      <div className="h-16 animate-pulse rounded-lg" style={{ background: 'var(--color-surface)' }} />
      <div className="grid gap-3 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-28 md:h-[170px] animate-pulse rounded-lg" style={{ background: 'var(--color-surface)' }} />
        ))}
      </div>
    </div>
  );
}
