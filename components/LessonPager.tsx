'use client';

import Link from 'next/link';
import { ArrowLeft, ArrowRight } from '@phosphor-icons/react';
import { useCourse } from '@/lib/course-context';
import { displayLessonNumber } from '@/lib/db-types';
import type { LessonSummary } from '@/lib/db-types';

// Previous / next lesson in course order, so finishing a lesson leads straight
// to the next one instead of back up to the chapter page. Students step through
// lessons that have content; admins step through every lesson, because they
// fill the course in order.
export function useLessonNeighbours(lessonId: string) {
  const course = useCourse();
  if (!course) return { prev: null, next: null };
  const steppable = course.viewer.isAdmin ? course.lessons : course.lessons.filter((l) => l.has_source);
  const idx = steppable.findIndex((l) => l.id === lessonId);
  if (idx === -1) return { prev: null, next: null };
  return { prev: steppable[idx - 1] ?? null, next: steppable[idx + 1] ?? null };
}

export function LessonPager({ lessonId, emphasiseNext }: { lessonId: string; emphasiseNext: boolean }) {
  const course = useCourse();
  const { prev, next } = useLessonNeighbours(lessonId);
  if (!course || (!prev && !next)) return null;

  const chapterOf = (l: LessonSummary) => course.sections.find((s) => s.id === l.section_id);
  const card = (l: LessonSummary, dir: 'prev' | 'next') => {
    const number = displayLessonNumber(l);
    const chapter = chapterOf(l);
    const crossesChapter = l.section_id !== course.lessons.find((x) => x.id === lessonId)?.section_id;
    const strong = dir === 'next' && emphasiseNext;
    return (
      <Link
        href={`/lessons/${l.id}`}
        className={`group flex-1 min-w-0 rounded-lg px-4 py-3 transition-colors hover:bg-dim ${dir === 'next' ? 'text-right' : ''}`}
        style={{ border: `1px solid ${strong ? 'var(--color-accent)' : 'var(--color-divider)'}` }}
      >
        <span className={`flex items-center gap-1.5 text-[11px] uppercase tracking-wide ${dir === 'next' ? 'justify-end' : ''}`}
          style={{ color: strong ? 'var(--color-accent-md)' : 'var(--color-n600)' }}>
          {dir === 'prev' && <ArrowLeft size={12} />}
          {dir === 'prev' ? 'Previous' : 'Next'}
          {crossesChapter && chapter?.chapter_number != null && ` · Chapter ${chapter.chapter_number}`}
          {dir === 'next' && <ArrowRight size={12} />}
        </span>
        <span className="block text-[14px] text-fg truncate mt-1 group-hover:text-accent-hi">
          {number && <span className="tabular-nums text-n500 mr-1.5">{number}</span>}
          {l.title}
        </span>
      </Link>
    );
  };

  return (
    <nav aria-label="Lesson navigation" className="flex flex-col sm:flex-row gap-2">
      {prev ? card(prev, 'prev') : <span className="hidden sm:block flex-1" />}
      {next ? card(next, 'next') : <span className="hidden sm:block flex-1" />}
    </nav>
  );
}
