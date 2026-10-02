'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import { getViewer } from './viewer';
import type { Viewer } from './viewer';
import * as db from './db';
import type { LessonSummary, Section } from './db-types';

// The course, loaded once per session by app/(app)/layout.tsx and shared by the
// nav, the lesson page's prev/next and anything else that needs the course
// shape. Before this, AppNav refetched sections, every flashcard and the
// profile on every navigation; with 393 lessons that would only get worse.
//
//   lessons      — summaries only (no source text), in course order
//   completedIds — this user's completed lessons
//   dueByLesson  — this user's due card counts
//
// Lesson rows are kept current over Realtime; progress is re-read on
// navigation (one completion query and one aggregated due-count RPC).

export type CourseData = {
  viewer: Viewer;
  sections: Section[];
  lessons: LessonSummary[];
  completedIds: Set<string>;
  dueByLesson: Map<string, number>;
  totalDue: number;
};

type CourseContextValue = CourseData & {
  refreshLessons: () => Promise<void>;
  refreshProgress: () => Promise<void>;
  markCompleted: (lessonId: string) => void;
};

// Exported for previews that supply course data directly.
export const CourseContext = createContext<CourseContextValue | null>(null);
export type { CourseContextValue };

// null while loading.
export function useCourse(): CourseContextValue | null {
  return useContext(CourseContext);
}

function inCourseOrder(sections: Section[], lessons: LessonSummary[]): LessonSummary[] {
  const order = new Map(sections.map((s, i) => [s.id, i]));
  return [...lessons].sort(
    (a, b) => (order.get(a.section_id) ?? 0) - (order.get(b.section_id) ?? 0) || a.sort_order - b.sort_order
  );
}

export function CourseProvider({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const pathname = usePathname();
  const [data, setData] = useState<CourseData | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      const viewer = await getViewer(supabase);
      if (!viewer) { router.push('/sign-in'); return; }
      const [sections, lessons, completedIds, due] = await Promise.all([
        db.getSections(supabase),
        db.getLessonSummaries(supabase),
        db.getCompletedLessonIds(supabase),
        db.getDueCounts(supabase),
      ]);
      setData({
        viewer,
        sections,
        lessons: inCourseOrder(sections, lessons),
        completedIds,
        dueByLesson: new Map(due.map((d) => [d.lesson_id, d.due])),
        totalDue: due.reduce((s, d) => s + d.due, 0),
      });
    })();
  }, [supabase, router]);

  const refreshLessons = useCallback(async () => {
    const lessons = await db.getLessonSummaries(supabase);
    setData((prev) => prev && { ...prev, lessons: inCourseOrder(prev.sections, lessons) });
  }, [supabase]);

  const refreshProgress = useCallback(async () => {
    const [completedIds, due] = await Promise.all([db.getCompletedLessonIds(supabase), db.getDueCounts(supabase)]);
    setData((prev) => prev && {
      ...prev,
      completedIds,
      dueByLesson: new Map(due.map((d) => [d.lesson_id, d.due])),
      totalDue: due.reduce((s, d) => s + d.due, 0),
    });
  }, [supabase]);

  const markCompleted = useCallback((lessonId: string) => {
    setData((prev) => prev && { ...prev, completedIds: new Set(prev.completedIds).add(lessonId) });
  }, []);

  // Any lesson row change (a paste, generation finishing, a clear) updates the
  // tree. Debounced: a generation run writes its row several times.
  useEffect(() => {
    if (!data) return;
    const channel = supabase
      .channel('course-lessons')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lessons' }, () => {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(refreshLessons, 400);
      })
      .subscribe();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      supabase.removeChannel(channel);
    };
    // Subscribe once the course has loaded; refreshLessons is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, !!data]);

  // Due counts and completion change as the user studies; re-read them when
  // they move between pages.
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) { firstPath.current = false; return; }
    refreshProgress();
  }, [pathname, refreshProgress]);

  const value = useMemo(
    () => (data ? { ...data, refreshLessons, refreshProgress, markCompleted } : null),
    [data, refreshLessons, refreshProgress, markCompleted]
  );

  return <CourseContext.Provider value={value}>{children}</CourseContext.Provider>;
}
