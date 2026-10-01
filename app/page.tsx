'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/client';
import { AppNav } from '@/components/AppNav';
import { getLevelInfo } from '@/lib/gamification';
import { getViewer } from '@/lib/viewer';
import * as db from '@/lib/db';
import { PROGRESS_LABEL } from '@/lib/course';
import { chapterMastery, weightedProgress, accuracyOf } from '@/lib/progress';
import {
  contentStatus,
  countsTowardProgress,
  displayLessonNumber,
  sectionLabel,
} from '@/lib/db-types';
import type { Profile, Section, LessonSummary, SectionStats } from '@/lib/db-types';

type SectionRow = {
  section: Section;
  countable: number;     // lessons that count toward progress
  ready: LessonSummary[]; // countable lessons with content available to study
  completed: number;     // ready lessons this user has marked complete
  notAdded: number;      // countable lessons with no content yet
  dueCount: number;
  stats: SectionStats | undefined;
  mastery: number;       // 0–1, see lib/progress.ts
};

type DashData = {
  profile: Profile;
  isAdmin: boolean;
  rows: SectionRow[];
  totalDue: number;
  nextLesson: LessonSummary | null;    // first ready lesson not yet completed
  nextEmptyLesson: LessonSummary | null;
};

export default function HomePage() {
  const supabase = useMemo(() => createClient(), []);
  const [data, setData] = useState<DashData | null>(null);

  useEffect(() => {
    (async () => {
      const viewer = await getViewer(supabase);
      if (!viewer?.profile) return;

      const [sections, lessons, dueCounts, sectionStats, completedIds] = await Promise.all([
        db.getSections(supabase),
        db.getLessonSummaries(supabase),
        db.getDueCounts(supabase),
        db.getSectionStats(supabase, new Date(Date.now() - 30 * 86400000)),
        db.getCompletedLessonIds(supabase),
      ]);

      const statsBySection = new Map(sectionStats.map((s) => [s.section_id, s]));
      const dueBySection = new Map<string, number>();
      dueCounts.forEach((d) => dueBySection.set(d.section_id, (dueBySection.get(d.section_id) ?? 0) + d.due));

      const lessonsBySection = new Map<string, LessonSummary[]>();
      lessons.forEach((l) => {
        const arr = lessonsBySection.get(l.section_id) ?? [];
        arr.push(l);
        lessonsBySection.set(l.section_id, arr);
      });

      const rows: SectionRow[] = sections.map((section) => {
        const countableLessons = (lessonsBySection.get(section.id) ?? []).filter(countsTowardProgress);
        const ready = countableLessons.filter((l) => contentStatus(l) === 'ready');
        const stats = statsBySection.get(section.id);
        return {
          section,
          countable: countableLessons.length,
          ready,
          completed: ready.filter((l) => completedIds.has(l.id)).length,
          notAdded: countableLessons.filter((l) => !l.has_source).length,
          dueCount: dueBySection.get(section.id) ?? 0,
          stats,
          mastery: chapterMastery(stats, countableLessons.length),
        };
      });

      // Course order: sections are already sorted; lessons within by sort_order.
      const inOrder = rows.flatMap((r) => (lessonsBySection.get(r.section.id) ?? []));
      const nextLesson = inOrder.find(
        (l) => countsTowardProgress(l) && contentStatus(l) === 'ready' && !completedIds.has(l.id)
      ) ?? null;
      const nextEmptyLesson = inOrder.find((l) => !l.has_source && l.kind !== 'infographic') ?? null;

      setData({
        profile: viewer.profile,
        isAdmin: viewer.isAdmin,
        rows,
        totalDue: dueCounts.reduce((s, d) => s + d.due, 0),
        nextLesson,
        nextEmptyLesson,
      });
    })();
  }, [supabase]);

  if (!data) {
    return (
      <div className="min-h-dvh bg-bg">
        <div className="md:ml-56 max-w-2xl mx-auto px-5 py-8 space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg" style={{ background: 'var(--color-surface)' }} />
          ))}
        </div>
        <AppNav />
      </div>
    );
  }

  const { profile, isAdmin, rows, totalDue, nextLesson, nextEmptyLesson } = data;
  const { level } = getLevelInfo(profile.xp);

  const progressPct = weightedProgress(rows) * 100;
  const totalCountable = rows.reduce((s, r) => s + r.countable, 0);
  const totalReady = rows.reduce((s, r) => s + r.ready.length, 0);
  const totalCompleted = rows.reduce((s, r) => s + r.completed, 0);
  const anyPractice = rows.some((r) => (r.stats?.answered ?? 0) > 0);

  const startedRows = rows.filter((r) => r.ready.length > 0);
  const notStartedCount = rows.length - startedRows.length;

  // Secondary suggestions: chapters with content, most unclaimed weight first.
  const suggestions = [...startedRows]
    .sort((a, b) => b.section.exam_weight * (1 - b.mastery) - a.section.exam_weight * (1 - a.mastery))
    .slice(0, 2);

  return (
    <div className="min-h-dvh bg-bg pb-24 md:pb-8">
      <AppNav />

      <div className="md:ml-56">
        {/* Header — desktop only (phone uses AppNav) */}
        <header className="hidden md:flex items-center justify-between px-8 py-5 border-b border-divider">
          <div>
            <h1 className="text-[17px] font-medium text-fg">Good day</h1>
            <p className="text-[13px] text-n500 mt-0.5">
              {profile.current_streak > 0 && `${profile.current_streak} day streak 🔥 · `}
              Level {level}
            </p>
          </div>
        </header>

        <div className="max-w-2xl mx-auto px-5 py-6 space-y-8">

          {rows.length === 0 ? (
            <div className="rounded-lg p-6 space-y-2" style={{ background: 'var(--color-surface)' }}>
              <p className="text-[15px] font-medium text-fg">The course isn&rsquo;t set up yet</p>
              <p className="text-[13px] text-n500 leading-relaxed">
                {isAdmin
                  ? 'No chapters found. Apply the course-structure seed (migration 011) to load the chapters and lessons.'
                  : 'Your instructor is still setting up the course. Check back soon.'}
              </p>
            </div>
          ) : (
            <>
              {/* ── Course progress strip ── */}
              <div className="rounded-lg px-4 py-4 space-y-3" style={{ background: 'var(--color-surface)' }}>
                <div className="flex items-baseline justify-between">
                  <span className="text-[14px] font-medium text-fg">{PROGRESS_LABEL}</span>
                  <span className="text-[13px] tabular-nums text-n500">{Math.round(progressPct)}%</span>
                </div>
                <div className="relative h-1.25 rounded-sm" style={{ background: 'var(--color-bg)' }}>
                  <div
                    className="absolute inset-y-0 left-0 rounded-sm transition-all duration-500"
                    style={{
                      width: `${Math.min(progressPct, 100)}%`,
                      background: 'var(--color-accent)',
                      boxShadow: '0 0 12px rgba(145,132,217,.6)',
                    }}
                  />
                </div>
                <p className="text-[12px] text-n600">
                  {totalReady} of {totalCountable} lessons available · {totalCompleted} completed
                  {!anyPractice && totalReady > 0 && ' · answer practice questions to build progress'}
                </p>
              </div>

              {/* ── Today ── */}
              <div className="space-y-3">
                <h2 className="text-[13px] font-medium uppercase tracking-wide text-n600">Today</h2>

                {totalDue > 0 ? (
                  <PrimaryLink href="/review" title={`Review ${totalDue} card${totalDue !== 1 ? 's' : ''}`} hint="Due for spaced repetition" />
                ) : nextLesson ? (
                  <PrimaryLink
                    href={`/lessons/${nextLesson.id}`}
                    title={`${displayLessonNumber(nextLesson) ? `${displayLessonNumber(nextLesson)} ` : ''}${nextLesson.title}`}
                    hint="Next lesson"
                  />
                ) : isAdmin && nextEmptyLesson ? (
                  <PrimaryLink href="/ingest" title="Add the next lesson" hint={`Paste content for ${nextEmptyLesson.title}`} />
                ) : totalReady === 0 ? (
                  <div className="rounded-lg p-4" style={{ background: 'var(--color-surface)' }}>
                    <p className="text-[15px] font-medium text-fg">Lessons are on the way</p>
                    <p className="text-[13px] text-n500 mt-0.5">Your instructor is adding course content. Check back soon.</p>
                  </div>
                ) : (
                  <div className="rounded-lg p-4" style={{ background: 'var(--color-surface)' }}>
                    <p className="text-[15px] font-medium text-fg">All available lessons complete</p>
                    <p className="text-[13px] text-n500 mt-0.5">New lessons appear here as they&rsquo;re added.</p>
                  </div>
                )}

                {suggestions.map(({ section, ready, completed, dueCount }) => {
                  const toStudy = ready.length - completed;
                  const hint = dueCount > 0
                    ? `${dueCount} card${dueCount !== 1 ? 's' : ''} due`
                    : toStudy > 0
                    ? `${toStudy} lesson${toStudy !== 1 ? 's' : ''} to study`
                    : 'Practice to build mastery';
                  return (
                    <Link
                      key={section.id}
                      href={`/sections/${section.slug}`}
                      className="flex items-center justify-between rounded-lg px-4 py-3 transition-colors"
                      style={{ background: 'var(--color-surface)' }}
                    >
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium text-fg leading-snug truncate">{sectionLabel(section)}</p>
                        <p className="text-[12px] text-n500 mt-0.5">{hint}</p>
                      </div>
                      <span className="text-n600 text-[13px] shrink-0 ml-3">→</span>
                    </Link>
                  );
                })}
              </div>

              {/* ── Where you stand ── only chapters with content */}
              {startedRows.length > 0 && (
                <>
                  <div style={{ height: '1px', background: 'var(--color-divider)' }} />
                  <div className="space-y-3">
                    <h2 className="text-[13px] font-medium uppercase tracking-wide text-n600">Where you stand</h2>
                    <div className="rounded-lg overflow-hidden" style={{ background: 'var(--color-surface)' }}>
                      {startedRows.map(({ section, ready, completed, notAdded, stats, mastery }, i) => {
                        const accuracy = accuracyOf(stats);
                        return (
                          <Link
                            key={section.id}
                            href={`/sections/${section.slug}`}
                            className={`flex items-center gap-4 px-4 py-3 transition-colors hover:bg-dim ${i > 0 ? 'row-rule' : ''}`}
                          >
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-medium text-fg truncate">{sectionLabel(section)}</p>
                              <p className="text-[11px] text-n600 tabular-nums">
                                {completed}/{ready.length} available complete
                                {notAdded > 0 && ` · ${notAdded} not added yet`}
                              </p>
                            </div>
                            <div className="w-24 shrink-0">
                              <div className="flex items-center justify-end gap-1.5 mb-1">
                                <span className="text-[12px] tabular-nums text-n400">
                                  {accuracy === null ? '—' : `${Math.round(accuracy * 100)}%`}
                                </span>
                                <span className="text-[11px] text-n700">accuracy</span>
                              </div>
                              <div className="flex h-1.5 rounded-sm overflow-hidden" style={{ background: 'var(--color-accent-dk)' }}>
                                <div
                                  className="h-full rounded-sm transition-all duration-500"
                                  style={{ width: `${mastery * 100}%`, background: 'var(--color-accent)' }}
                                />
                              </div>
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                    {notStartedCount > 0 && (
                      <p className="text-[12px] text-n600 px-1">
                        {notStartedCount} chapter{notStartedCount !== 1 ? 's' : ''} not started yet
                      </p>
                    )}
                  </div>
                </>
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}

function PrimaryLink({ href, title, hint }: { href: string; title: string; hint: string }) {
  return (
    <Link
      href={href}
      className="block rounded-lg p-4 transition-colors"
      style={{ border: '1px solid var(--color-accent)' }}
    >
      <p className="text-[15px] font-medium text-fg">{title}</p>
      <p className="text-[13px] text-n500 mt-0.5">{hint}</p>
    </Link>
  );
}
