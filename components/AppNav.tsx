'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { House, Cards, Plus, UserPlus, ListBullets, SidebarSimple, X, SignOut } from '@phosphor-icons/react';
import { createClient } from '@/utils/supabase/client';
import { useCourse } from '@/lib/course-context';
import { APP_NAME } from '@/lib/course';
import { CourseProgress, CourseTree } from './CourseTree';

// App shell. Desktop: a left rail holding the nav and the course tree, which
// collapses to a slim icon rail. Phone: a bottom bar, with the course tree in
// a full-screen sheet. Course data comes from the shared CourseProvider in
// app/(app)/layout.tsx, so navigating no longer refetches anything here.

const NAV = [
  { href: '/',              label: 'Home',    Icon: House,    adminOnly: false },
  { href: '/review',        label: 'Review',  Icon: Cards,    adminOnly: false },
  { href: '/ingest',        label: 'Add',     Icon: Plus,     adminOnly: true  },
  { href: '/admin/invites', label: 'Invites', Icon: UserPlus, adminOnly: true  },
] as const;

export const RAIL_WIDTH = { open: 'md:pl-72', closed: 'md:pl-16' } as const;

// ── Rail collapse, remembered per browser ─────────────────────────────────────
// A per-viewer convenience, so localStorage is fine; read through
// useSyncExternalStore so the server render and first client render agree.

const RAIL_KEY = 'rail-collapsed';
const railListeners = new Set<() => void>();

function readRailCollapsed(): boolean {
  try { return localStorage.getItem(RAIL_KEY) === '1'; } catch { return false; }
}

export function setRailCollapsed(collapsed: boolean) {
  try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch { /* storage blocked: session-only */ }
  railListeners.forEach((l) => l());
}

export function useRailCollapsed(): boolean {
  return useSyncExternalStore(
    (onChange) => { railListeners.add(onChange); return () => { railListeners.delete(onChange); }; },
    readRailCollapsed,
    () => false
  );
}

// ── Nav ───────────────────────────────────────────────────────────────────────

export function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const course = useCourse();
  const collapsed = useRailCollapsed();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Close the phone sheet on any navigation (including browser back).
  const [sheetPath, setSheetPath] = useState(pathname);
  if (sheetPath !== pathname) { setSheetPath(pathname); setSheetOpen(false); }

  // The sheet covers the page; stop the page behind it from scrolling.
  useEffect(() => {
    if (!sheetOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [sheetOpen]);

  async function signOut() {
    await supabase.auth.signOut();
    router.push('/sign-in');
  }

  const isAdmin = course?.viewer.isAdmin ?? false;
  const items = NAV.filter((item) => !item.adminOnly || isAdmin);
  const totalDue = course?.totalDue ?? 0;
  const active = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  const badge = (href: string, small = false) =>
    href === '/review' && totalDue > 0 ? (
      <span
        className={`${small ? 'absolute -top-1 -right-1.5 min-w-[14px] h-3.5 text-[9px] px-0.5' : 'min-w-[18px] h-[18px] text-[10px] px-1'} flex items-center justify-center rounded-full font-medium tabular-nums`}
        style={{ background: 'var(--color-accent-dk)', color: 'var(--color-accent-lo)' }}
      >
        {totalDue}
      </span>
    ) : null;

  return (
    <>
      {/* ── Phone bottom bar ── */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 pb-safe"
        style={{ background: 'var(--color-surface-sunk)', boxShadow: '0 -1px 0 rgba(233,233,237,.1)' }}
      >
        <div className="flex">
          {[items[0], { href: '#course', label: 'Course', Icon: ListBullets, adminOnly: false } as const, ...items.slice(1)].map(({ href, label, Icon }) => {
            const isCourse = href === '#course';
            const isActive = isCourse ? sheetOpen : !sheetOpen && active(href);
            const inner = (
              <>
                <span className="relative">
                  <Icon size={20} weight={isActive ? 'fill' : 'regular'} />
                  {badge(href, true)}
                </span>
                <span className="text-[11px] font-medium">{label}</span>
              </>
            );
            const cls = 'flex flex-1 flex-col items-center gap-1 py-2.5 min-h-[52px]';
            const color = { color: isActive ? 'var(--color-accent)' : 'var(--color-n600)' };
            return isCourse ? (
              <button key={href} onClick={() => setSheetOpen((o) => !o)} aria-expanded={sheetOpen} className={cls} style={color}>{inner}</button>
            ) : (
              <Link key={href} href={href} className={cls} style={color}>{inner}</Link>
            );
          })}
        </div>
      </nav>

      {/* ── Phone course sheet ── */}
      {sheetOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex flex-col" style={{ background: 'var(--color-bg)' }}>
          <div className="flex items-center justify-between px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--color-divider)', paddingTop: 'max(16px, env(safe-area-inset-top))' }}>
            <span className="text-[17px] font-medium text-fg">Course</span>
            <button onClick={() => setSheetOpen(false)} aria-label="Close course" className="p-2 -mr-2 text-n500 hover:text-fg">
              <X size={20} />
            </button>
          </div>
          <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--color-divider)' }}>
            <CourseProgress />
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3 pb-28" style={{ overscrollBehavior: 'contain' }}>
            <CourseTree onNavigate={() => setSheetOpen(false)} />
          </div>
        </div>
      )}

      {/* ── Desktop rail ── */}
      <aside
        className={`hidden md:flex flex-col fixed top-0 left-0 bottom-0 z-50 ${collapsed ? 'w-16' : 'w-72'}`}
        style={{ background: 'var(--color-surface-sunk)', borderRight: '1px solid var(--color-divider)' }}
      >
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between'} px-4 py-4`}>
          {!collapsed && <Link href="/" className="text-[15px] font-medium text-fg truncate">{APP_NAME}</Link>}
          <button
            onClick={() => setRailCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="p-1.5 rounded-lg text-n600 hover:text-fg hover:bg-dim transition-colors"
          >
            <SidebarSimple size={18} />
          </button>
        </div>

        <div className={`px-3 pb-3 space-y-0.5 ${collapsed ? 'flex flex-col items-center' : ''}`}>
          {items.map(({ href, label, Icon }) => {
            const isActive = active(href);
            return (
              <Link
                key={href}
                href={href}
                title={collapsed ? label : undefined}
                className={`relative flex items-center gap-3 rounded-lg text-[14px] font-medium transition-colors ${collapsed ? 'p-2.5 justify-center' : 'px-3 py-2'}`}
                style={{
                  color: isActive ? 'var(--color-accent-hi)' : 'var(--color-n500)',
                  background: isActive ? 'var(--color-accent-tint)' : 'transparent',
                }}
              >
                <span className="relative">
                  <Icon size={18} weight={isActive ? 'fill' : 'regular'} />
                  {collapsed && badge(href, true)}
                </span>
                {!collapsed && <span className="flex-1">{label}</span>}
                {!collapsed && badge(href)}
              </Link>
            );
          })}
          {collapsed && (
            <button
              onClick={() => setRailCollapsed(false)}
              title="Course"
              aria-label="Show course"
              className="p-2.5 rounded-lg text-n500 hover:text-fg hover:bg-dim transition-colors"
            >
              <ListBullets size={18} />
            </button>
          )}
        </div>

        {!collapsed && (
          <>
            <div className="px-5 py-4" style={{ borderTop: '1px solid var(--color-divider)' }}>
              <CourseProgress />
            </div>
            <div className="flex-1 overflow-y-auto px-3 pb-3" style={{ overscrollBehavior: 'contain' }}>
              <CourseTree />
            </div>
          </>
        )}

        <div className={`mt-auto px-4 py-3 ${collapsed ? 'flex justify-center' : ''}`} style={{ borderTop: '1px solid var(--color-divider)' }}>
          <button
            onClick={signOut}
            title="Sign out"
            className="flex items-center gap-2 text-[13px] text-n600 hover:text-n400 transition-colors"
          >
            <SignOut size={16} />
            {!collapsed && 'Sign out'}
          </button>
        </div>
      </aside>
    </>
  );
}
