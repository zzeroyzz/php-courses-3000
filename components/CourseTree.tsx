'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { CaretRight, CheckCircle } from '@phosphor-icons/react';
import { useCourse } from '@/lib/course-context';
import { contentStatus, countsTowardProgress, displayLessonNumber } from '@/lib/db-types';
import type { LessonSummary, Section } from '@/lib/db-types';

// The course as a tree, modelled on the RealEstateU sidebar the course comes
// from: chapters are collapsible groups with their lessons nested inside, the
// current lesson is marked, and progress sits at the top. The chapter you're
// in opens by itself; any chapter can be opened or closed by hand.

export function CourseProgress() {
  const course = useCourse();
  if (!course) return <div className="h-10 animate-pulse rounded" style={{ background: 'var(--color-n900)' }} />;
  const countable = course.lessons.filter(countsTowardProgress);
  const available = countable.filter((l) => contentStatus(l) === 'ready');
  const done = available.filter((l) => course.completedIds.has(l.id)).length;
  const pct = countable.length ? (done / countable.length) * 100 : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-n400">Your progress</span>
        <span className="text-[11px] text-n600 tabular-nums">{done} of {countable.length} lessons</span>
      </div>
      <div className="relative h-1 rounded-sm overflow-hidden" style={{ background: 'var(--color-n900)' }}>
        {/* what's been added so far, then what's been completed on top */}
        <div className="absolute inset-y-0 left-0" style={{ width: `${countable.length ? (available.length / countable.length) * 100 : 0}%`, background: 'var(--color-accent-dk)' }} />
        <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: 'var(--color-accent)' }} />
      </div>
      <p className="text-[11px] text-n700 tabular-nums">{available.length} available so far</p>
    </div>
  );
}

export function CourseTree({ onNavigate }: { onNavigate?: () => void }) {
  const course = useCourse();
  const pathname = usePathname();
  const params = useParams<{ id?: string; slug?: string }>();
  const currentRef = useRef<HTMLAnchorElement>(null);

  // Hand-toggled chapters; anything not toggled follows "open if current".
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const currentLessonId = pathname.startsWith('/lessons/') ? params.id ?? null : null;

  const bySection = useMemo(() => {
    const map = new Map<string, LessonSummary[]>();
    course?.lessons.forEach((l) => {
      const arr = map.get(l.section_id) ?? [];
      arr.push(l);
      map.set(l.section_id, arr);
    });
    return map;
  }, [course?.lessons]);

  const currentSectionId = useMemo(() => {
    if (!course) return null;
    if (currentLessonId) return course.lessons.find((l) => l.id === currentLessonId)?.section_id ?? null;
    if (pathname.startsWith('/sections/')) return course.sections.find((s) => s.slug === params.slug)?.id ?? null;
    return null;
  }, [course, currentLessonId, pathname, params.slug]);

  // Keep the current lesson in view inside the scrolling tree.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentLessonId, currentSectionId]);

  if (!course) {
    return (
      <div className="space-y-2 px-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-7 animate-pulse rounded" style={{ background: 'var(--color-n900)' }} />
        ))}
      </div>
    );
  }

  const isAdmin = course.viewer.isAdmin;

  return (
    <nav aria-label="Course" className="space-y-0.5">
      {course.sections.map((section) => {
        const lessons = bySection.get(section.id) ?? [];
        const open = toggled[section.id] ?? section.id === currentSectionId;
        return (
          <ChapterGroup
            key={section.id}
            section={section}
            lessons={lessons}
            open={open}
            isCurrent={section.id === currentSectionId}
            onToggle={() => setToggled((t) => ({ ...t, [section.id]: !open }))}
            currentLessonId={currentLessonId}
            currentRef={currentRef}
            completedIds={course.completedIds}
            isAdmin={isAdmin}
            onNavigate={onNavigate}
          />
        );
      })}
    </nav>
  );
}

function ChapterGroup({
  section, lessons, open, isCurrent, onToggle, currentLessonId, currentRef, completedIds, isAdmin, onNavigate,
}: {
  section: Section;
  lessons: LessonSummary[];
  open: boolean;
  isCurrent: boolean;
  onToggle: () => void;
  currentLessonId: string | null;
  currentRef: React.RefObject<HTMLAnchorElement | null>;
  completedIds: Set<string>;
  isAdmin: boolean;
  onNavigate?: () => void;
}) {
  const countable = lessons.filter(countsTowardProgress);
  const available = countable.filter((l) => contentStatus(l) === 'ready');
  const done = available.filter((l) => completedIds.has(l.id)).length;
  const allDone = available.length > 0 && done === countable.length;
  const label = section.chapter_number != null ? String(section.chapter_number) : section.slug === 'orientation' ? 'O' : '★';

  return (
    <div>
      <div className="flex items-center rounded-lg" style={{ background: isCurrent && !open ? 'var(--color-dim)' : undefined }}>
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="flex items-center gap-2 flex-1 min-w-0 px-2 py-1.5 text-left rounded-lg hover:bg-dim transition-colors"
        >
          <CaretRight
            size={12}
            className="shrink-0 transition-transform text-n600"
            style={{ transform: open ? 'rotate(90deg)' : undefined }}
          />
          <span
            className="w-5 shrink-0 text-[11px] tabular-nums text-right"
            style={{ color: available.length ? 'var(--color-accent-md)' : 'var(--color-n700)' }}
          >
            {label}
          </span>
          <span
            className="flex-1 min-w-0 truncate text-[13px]"
            style={{ color: isCurrent ? 'var(--color-fg)' : available.length ? 'var(--color-n400)' : 'var(--color-n600)' }}
            title={section.name}
          >
            {section.name}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums" style={{ color: allDone ? 'var(--color-accent-md)' : 'var(--color-n700)' }}>
            {available.length ? `${done}/${available.length}` : ''}
          </span>
        </button>
      </div>

      {open && (
        <div className="ml-[18px] pl-2 my-0.5 space-y-px" style={{ borderLeft: '1px solid var(--color-divider)' }}>
          <Link
            href={`/sections/${section.slug}`}
            onClick={onNavigate}
            className="block px-2 py-1 text-[11px] text-n600 hover:text-fg rounded"
          >
            Chapter overview
          </Link>
          {lessons.map((lesson) => {
            const status = contentStatus(lesson);
            const current = lesson.id === currentLessonId;
            const completed = completedIds.has(lesson.id);
            const number = displayLessonNumber(lesson);
            const clickable = isAdmin || lesson.has_source;
            const row = (
              <>
                <LessonMark status={status} completed={completed} kind={lesson.kind} />
                {number && <span className="shrink-0 text-[11px] tabular-nums text-n700">{number}</span>}
                <span className="min-w-0 truncate">{lesson.title}</span>
              </>
            );
            const style: React.CSSProperties = {
              background: current ? 'var(--color-accent-tint)' : undefined,
              color: current ? 'var(--color-accent-hi)' : status === 'empty' ? 'var(--color-n700)' : 'var(--color-n400)',
            };
            return clickable ? (
              <Link
                key={lesson.id}
                ref={current ? currentRef : undefined}
                href={`/lessons/${lesson.id}`}
                onClick={onNavigate}
                aria-current={current ? 'page' : undefined}
                title={lesson.title}
                className="flex items-center gap-2 px-2 py-1 rounded text-[12.5px] hover:text-fg hover:bg-dim transition-colors"
                style={style}
              >
                {row}
              </Link>
            ) : (
              <div key={lesson.id} title={`${lesson.title} — not added yet`} className="flex items-center gap-2 px-2 py-1 text-[12.5px]" style={style}>
                {row}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LessonMark({ status, completed, kind }: { status: ReturnType<typeof contentStatus>; completed: boolean; kind: LessonSummary['kind'] }) {
  if (completed) return <CheckCircle size={12} weight="fill" className="shrink-0" style={{ color: 'var(--color-accent-md)' }} />;
  const ring = (color: string, fill?: string) => (
    <span className="w-3 h-3 shrink-0 rounded-full inline-flex items-center justify-center" style={{ boxShadow: `inset 0 0 0 1px ${color}` }}>
      {fill && <span className="w-1.5 h-1.5 rounded-full" style={{ background: fill }} />}
    </span>
  );
  if (status === 'empty') return ring(kind === 'infographic' ? 'transparent' : 'var(--color-n800)');
  if (status === 'ready') return ring('var(--color-accent-md)', 'var(--color-accent-md)');
  return ring('var(--color-accent-md)');
}
