'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import { AppNav } from '@/components/AppNav';
import { getViewer } from '@/lib/viewer';
import * as db from '@/lib/db';
import { inviteStatus, INVITE_DEFAULT_DAYS } from '@/lib/invites';
import type { Invite, InviteStatus } from '@/lib/invites';

const STATUS_LABEL: Record<InviteStatus, string> = {
  pending: 'Pending',
  used: 'Used',
  revoked: 'Revoked',
  expired: 'Expired',
};

const STATUS_STYLE: Record<InviteStatus, React.CSSProperties> = {
  pending: { background: 'var(--color-accent-dk)', color: 'var(--color-accent-md)', border: 'none' },
  used:    { background: 'var(--color-n900)', color: 'var(--color-n500)', border: 'none' },
  revoked: { background: 'transparent', color: 'var(--color-n600)', border: '1px solid var(--color-divider)' },
  expired: { background: 'transparent', color: 'var(--color-n600)', border: '1px solid var(--color-divider)' },
};

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function InvitesPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);

  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // The raw link exists only in this response; it can't be fetched again.
  const [newLink, setNewLink] = useState<{ url: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const viewer = await getViewer(supabase);
      if (!viewer) { router.push('/sign-in'); return; }
      if (!viewer.isAdmin) { router.replace('/'); return; }
      setInvites(await db.getInvites(supabase));
      setLoading(false);
    })();
  }, [supabase, router]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const res = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, email }),
      });
      const json = await res.json() as { invite?: Invite; url?: string; error?: string };
      if (!res.ok || !json.invite || !json.url) throw new Error(json.error ?? 'Could not create the invite.');
      setInvites((prev) => [json.invite!, ...prev]);
      setNewLink({ url: json.url, label: json.invite.label });
      setCopied(false);
      setLabel('');
      setEmail('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create the invite.');
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!newLink) return;
    try {
      await navigator.clipboard.writeText(newLink.url);
      setCopied(true);
    } catch {
      setCopied(false);   // clipboard blocked: the link stays selectable below
    }
  }

  async function handleRevoke(invite: Invite) {
    const ok = await db.revokeInvite(supabase, invite.id);
    setConfirmRevoke(null);
    if (ok) {
      setInvites((prev) => prev.map((i) => i.id === invite.id ? { ...i, revoked_at: new Date().toISOString() } : i));
    } else {
      setInvites(await db.getInvites(supabase));   // it changed underneath us (e.g. just used)
    }
  }

  const pendingCount = invites.filter((i) => inviteStatus(i) === 'pending').length;

  return (
    <div className="min-h-dvh bg-bg pb-24 md:pb-8">
      <AppNav />

      <div className="md:ml-56">
        <header className="px-5 py-4 md:px-8" style={{ borderBottom: '1px solid var(--color-divider)' }}>
          <h1 className="text-[17px] font-medium text-fg">Invites</h1>
          <p className="text-[13px] text-n500 mt-0.5">
            One link per student · expires after {INVITE_DEFAULT_DAYS} days · works once
          </p>
        </header>

        <div className="max-w-2xl mx-auto px-5 py-6 space-y-8">

          {/* ── Create ── */}
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="field">
              <label htmlFor="label">Who is this for?</label>
              <input
                id="label"
                type="text"
                required
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Jordan — Tuesday cohort"
                className="input"
              />
            </div>
            <div className="field">
              <label htmlFor="email">Email (optional)</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Lock the invite to one address"
                className="input"
              />
            </div>
            {createError && <p className="text-[13px]" style={{ color: '#e87d6e' }}>{createError}</p>}
            <button
              type="submit"
              disabled={creating || !label.trim()}
              className="btn btn-primary btn-block"
              style={{ paddingTop: '10px', paddingBottom: '10px' }}
            >
              {creating ? 'Creating…' : 'Create invite link'}
            </button>
          </form>

          {/* ── The new link, shown once ── */}
          {newLink && (
            <div className="rounded-lg px-4 py-4 space-y-3" style={{ border: '1px solid var(--color-accent)' }}>
              <p className="text-[14px] font-medium text-fg">Invite link for {newLink.label}</p>
              <p
                className="text-[12px] text-n400 break-all rounded px-3 py-2 select-all"
                style={{ background: 'var(--color-bg)', fontFamily: 'ui-monospace, monospace' }}
              >
                {newLink.url}
              </p>
              <div className="flex gap-2">
                <button onClick={handleCopy} className="btn btn-primary flex-1">{copied ? 'Copied' : 'Copy link'}</button>
                <button onClick={() => setNewLink(null)} className="btn btn-secondary flex-1">Done</button>
              </div>
              <p className="text-[12px] text-n600 leading-relaxed">
                Copy it now. Only a fingerprint of the link is stored, so it can&rsquo;t be shown again.
                If it&rsquo;s lost, revoke this invite and create a new one.
              </p>
            </div>
          )}

          {/* ── List ── */}
          <div className="space-y-3">
            <h2 className="text-[13px] font-medium uppercase tracking-wide text-n600">
              All invites{!loading && invites.length > 0 && ` · ${pendingCount} pending`}
            </h2>

            {loading ? (
              <div className="h-16 animate-pulse rounded-lg" style={{ background: 'var(--color-surface)' }} />
            ) : invites.length === 0 ? (
              <p className="text-[13px] text-n600">No invites yet. Create one above for each student.</p>
            ) : (
              <div className="rounded-lg overflow-hidden" style={{ background: 'var(--color-surface)' }}>
                {invites.map((invite, i) => {
                  const status = inviteStatus(invite);
                  const when =
                    status === 'used' && invite.used_at ? `Used ${shortDate(invite.used_at)}`
                    : status === 'revoked' && invite.revoked_at ? `Revoked ${shortDate(invite.revoked_at)}`
                    : status === 'expired' ? `Expired ${shortDate(invite.expires_at)}`
                    : `Expires ${shortDate(invite.expires_at)}`;
                  return (
                    <div key={invite.id} className={`px-4 py-3 ${i > 0 ? 'row-rule' : ''}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium text-fg truncate">{invite.label}</p>
                          <p className="text-[12px] text-n600 mt-0.5 truncate">
                            {invite.email ?? 'Any email'} · {when}
                          </p>
                        </div>
                        <span className="tag shrink-0 mt-0.5" style={STATUS_STYLE[status]}>{STATUS_LABEL[status]}</span>
                      </div>

                      {status === 'pending' && (
                        confirmRevoke === invite.id ? (
                          <div className="flex items-center gap-3 mt-2">
                            <span className="text-[12px] text-n500 flex-1">Revoke this link? It stops working immediately.</span>
                            <button onClick={() => setConfirmRevoke(null)} className="text-[12px] text-n600 hover:text-fg">Cancel</button>
                            <button onClick={() => handleRevoke(invite)} className="text-[12px]" style={{ color: '#e87d6e' }}>Revoke</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmRevoke(invite.id)}
                            className="mt-2 text-[12px] text-n600 hover:text-fg transition-colors"
                          >
                            Revoke
                          </button>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
