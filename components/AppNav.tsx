'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { House, Cards, Plus, UserPlus } from '@phosphor-icons/react';
import { createClient } from '@/utils/supabase/client';
import * as db from '@/lib/db';
import { getLevelInfo } from '@/lib/gamification';
import { getViewer } from '@/lib/viewer';
import { APP_NAME } from '@/lib/course';
import { sectionLabel } from '@/lib/db-types';
import type { Section, Profile } from '@/lib/db-types';

type RailData = { sections: Section[]; totalDue: number; profile: Profile | null; isAdmin: boolean };

const NAV = [
  { href: '/',        label: 'Home',   Icon: House, adminOnly: false },
  { href: '/review',  label: 'Review', Icon: Cards, adminOnly: false },
  { href: '/ingest',  label: 'Add',    Icon: Plus,  adminOnly: true  },
  { href: '/admin/invites', label: 'Invites', Icon: UserPlus, adminOnly: true },
] as const;

export function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [rail, setRail] = useState<RailData | null>(null);

  useEffect(() => {
    (async () => {
      const [viewer, sections, dueCounts] = await Promise.all([
        getViewer(supabase),
        db.getSections(supabase),
        db.getDueCounts(supabase),
      ]);
      if (!viewer) return;
      const totalDue = dueCounts.reduce((s, d) => s + d.due, 0);
      setRail({ sections, totalDue, profile: viewer.profile, isAdmin: viewer.isAdmin });
    })();
  }, [supabase]);

  async function signOut() {
    await supabase.auth.signOut();
    router.push('/sign-in');
  }

  const active = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  // Admin-only items stay hidden until the role is known, so they never flash in.
  const navItems = NAV.filter((item) => !item.adminOnly || rail?.isAdmin);

  return (
    <>
      {/* ── Phone bottom bar ── */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 pb-safe"
        style={{ background: 'var(--color-surface-sunk)', boxShadow: '0 -1px 0 rgba(233,233,237,.1)' }}
      >
        <div className="flex">
          {navItems.map(({ href, label, Icon }) => {
            const isActive = active(href);
            const badge = href === '/review' && rail && rail.totalDue > 0 ? rail.totalDue : null;
            return (
              <Link
                key={href}
                href={href}
                className="flex flex-1 flex-col items-center gap-1 py-2.5"
                style={{ color: isActive ? 'var(--color-accent)' : 'var(--color-n600)' }}
              >
                <span className="relative">
                  <Icon size={20} weight={isActive ? 'fill' : 'regular'} />
                  {badge && (
                    <span
                      className="absolute -top-1 -right-1.5 min-w-[14px] h-3.5 flex items-center justify-center rounded-full px-0.5 text-[9px] font-medium tabular-nums"
                      style={{ background: 'var(--color-accent)', color: '#fff' }}
                    >
                      {badge}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-medium">{label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* ── Desktop left rail ── */}
      <aside
        className="hidden md:flex flex-col fixed top-0 left-0 bottom-0 w-56 z-50"
        style={{ background: 'var(--color-surface)', borderRight: '1px solid var(--color-divider)' }}
      >
        {/* Brand */}
        <div className="px-5 py-5" style={{ borderBottom: '1px solid var(--color-divider)' }}>
          <Link href="/" className="text-[15px] font-medium text-fg">{APP_NAME}</Link>
        </div>

        {/* Nav items */}
        <div className="px-3 py-4 space-y-0.5">
          {navItems.map(({ href, label, Icon }) => {
            const isActive = active(href);
            const badge = href === '/review' && rail && rail.totalDue > 0 ? rail.totalDue : null;
            return (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] font-medium transition-colors"
                style={{
                  color: isActive ? 'var(--color-fg)' : 'var(--color-n500)',
                  background: isActive ? 'var(--color-dim)' : 'transparent',
                }}
              >
                <Icon size={18} weight={isActive ? 'fill' : 'regular'} />
                <span className="flex-1">{label}</span>
                {badge && (
                  <span
                    className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums"
                    style={{ background: 'var(--color-accent)', color: '#fff' }}
                  >
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        {/* Section links */}
        {rail && rail.sections.length > 0 && (
          <div
            className="px-3 pb-3 flex-1 overflow-y-auto"
            style={{ borderTop: '1px solid var(--color-divider)' }}
          >
            <p className="px-3 pt-4 pb-2 text-[11px] font-medium uppercase tracking-wide text-n600">
              Chapters
            </p>
            {rail.sections.map((s) => (
              <Link
                key={s.id}
                href={`/sections/${s.slug}`}
                title={sectionLabel(s)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] transition-colors text-n500 hover:text-fg"
              >
                <span className="w-1 h-1 rounded-full bg-n700 shrink-0" />
                <span className="truncate">{sectionLabel(s)}</span>
              </Link>
            ))}
          </div>
        )}

        {/* Footer */}
        {rail && rail.profile && (() => {
          const { level } = getLevelInfo(rail.profile!.xp);
          return (
            <div
              className="px-5 py-4 mt-auto"
              style={{ borderTop: '1px solid var(--color-divider)' }}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-[13px] text-n400">
                  {rail.profile!.current_streak} day streak
                  {rail.profile!.current_streak > 0 ? ' 🔥' : ''}
                </span>
                <span className="text-[11px] text-n600">Lv {level}</span>
              </div>
              <button
                onClick={signOut}
                className="text-[13px] text-n600 hover:text-n400 transition-colors"
              >
                Sign out
              </button>
            </div>
          );
        })()}
      </aside>
    </>
  );
}
