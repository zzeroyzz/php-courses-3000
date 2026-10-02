'use client';

import { CourseProvider } from '@/lib/course-context';
import { AppNav, RAIL_WIDTH, useRailCollapsed } from '@/components/AppNav';

// Shell for every signed-in page. The course loads once here and the nav is
// mounted once, instead of each page mounting its own AppNav that refetched
// its data on every navigation.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <CourseProvider>
      <Shell>{children}</Shell>
    </CourseProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const collapsed = useRailCollapsed();
  return (
    <>
      <AppNav />
      <div className={collapsed ? RAIL_WIDTH.closed : RAIL_WIDTH.open}>{children}</div>
    </>
  );
}
