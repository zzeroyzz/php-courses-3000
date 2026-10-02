'use client';

import { useMemo, useSyncExternalStore } from 'react';
import type { Lesson, Section } from '@/lib/db-types';

// Reading surface of the lesson page: the course text, the anchor matching that
// lets a card or question jump to its quote, and the "Going deeper" layer.

// ── Source parser ─────────────────────────────────────────────────────────────

type Block =
  | { type: 'heading'; text: string }
  | { type: 'sub'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'note'; text: string }
  | { type: 'paragraph'; text: string };

export function parseSource(text: string): Block[] {
  const sections = text.split(/\n{2,}/);
  const blocks: Block[] = [];
  const bulletRe = /^[-•*]\s|^\d+[.)]\s/;

  for (const section of sections) {
    const lines = section.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    // A short lead line ending in ':' or '?' with text right under it (no
    // blank line between) is a heading for that text, not part of it:
    // "So, what is a real estate broker?" / "A worked example:".
    if (lines.length > 1 && lines[0].length <= 80 && /[:?]$/.test(lines[0]) && !bulletRe.test(lines[0])) {
      blocks.push({ type: lines[0].endsWith(':') ? 'heading' : 'sub', text: lines[0] });
      lines.splice(0, 1);
    }

    if (lines.length === 1 && lines[0].length <= 80 && lines[0].endsWith(':')) {
      blocks.push({ type: 'heading', text: lines[0] });
      continue;
    }

    if (lines.length === 1 && lines[0].length <= 60 && !bulletRe.test(lines[0])) {
      blocks.push({ type: 'sub', text: lines[0] });
      continue;
    }

    if (lines[0].toLowerCase().startsWith('note:') || lines[0].toLowerCase().startsWith('important:')) {
      blocks.push({ type: 'note', text: lines.join(' ') });
      continue;
    }

    const bulletLines = lines.filter((l) => bulletRe.test(l));
    if (bulletLines.length >= 2 && bulletLines.length / lines.length >= 0.5) {
      blocks.push({ type: 'list', items: lines.map((l) => l.replace(/^[-•*]\s*|^\d+[.)]\s*/, '')) });
      continue;
    }

    blocks.push({ type: 'paragraph', text: lines.join(' ') });
  }

  return blocks;
}

// ── Anchor matching ───────────────────────────────────────────────────────────
// source_anchor is meant to be verbatim, but models drift on whitespace, curly
// quotes and dashes, and the rendered source joins lines and strips bullets.
// Match on a normalised form and map the hit back to DOM text positions.

function normChar(c: string): string {
  if (c === '‘' || c === '’') return "'";
  if (c === '“' || c === '”') return '"';
  if (c === '–' || c === '—') return '-';
  return c.toLowerCase();
}

function normalise(s: string): string {
  return Array.from(s).map(normChar).join('').replace(/\s+/g, ' ').replace(/^[-•*]\s*/, '').trim();
}

export function findInSource(root: HTMLElement, anchor: string): Range | null {
  let text = '';
  const map: { node: Text; offset: number }[] = [];
  let lastSpace = true;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    for (let i = 0; i < node.data.length; i++) {
      let c = normChar(node.data[i]);
      if (/\s/.test(c)) {
        if (lastSpace) continue;
        c = ' ';
        lastSpace = true;
      } else {
        lastSpace = false;
      }
      text += c;
      map.push({ node, offset: i });
    }
    // Separate text nodes (blocks, list items) with a space.
    if (!lastSpace) { text += ' '; map.push({ node, offset: node.data.length }); lastSpace = true; }
  }

  const needle = normalise(anchor);
  // Whole quote first, then progressively shorter prefixes.
  for (const len of [needle.length, 60, 30]) {
    const probe = needle.slice(0, len).trim();
    if (probe.length < 15 && probe.length < needle.length) continue;
    const idx = text.indexOf(probe);
    if (idx === -1) continue;
    const start = map[idx];
    const end = map[Math.min(idx + probe.length - 1, map.length - 1)];
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, Math.min(end.offset + 1, end.node.data.length));
    return range;
  }
  return null;
}


export function SourceBlocks({ text }: { text: string }) {
  return (
    <>
      {parseSource(text).map((block, i) => {
        if (block.type === 'heading') {
          return (
            <h3 key={i} className="text-[15px] font-medium text-fg mt-2 tracking-[-0.01em]">
              {block.text}
            </h3>
          );
        }
        if (block.type === 'sub') {
          return (
            <p key={i} className="text-[13px] font-medium" style={{ color: 'var(--color-accent-md)' }}>
              {block.text}
            </p>
          );
        }
        if (block.type === 'note') {
          return (
            <div
              key={i}
              className="rounded-r-lg px-4 py-3"
              style={{
                background: 'var(--color-n900)',
                boxShadow: 'inset 2px 0 0 var(--color-accent)',
              }}
            >
              <p className="text-[14px] text-n400 leading-relaxed">{block.text}</p>
            </div>
          );
        }
        if (block.type === 'list') {
          return (
            <ul key={i} className="space-y-1.5">
              {block.items.map((item, j) => (
                <li key={j} className="flex items-start gap-3 text-[16px] text-fg leading-[1.75]">
                  <span
                    className="mt-2.5 w-1 h-1 rounded-sm shrink-0"
                    style={{ background: 'var(--color-accent)' }}
                  />
                  {item}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="text-[16px] text-fg leading-[1.75]" style={{ textWrap: 'pretty' }}>{block.text}</p>
        );
      })}
    </>
  );
}


// "Going deeper": generated, unsourced, never drilled. Set apart from the course
// text by a sunk background, a muted left rule and an explicit label.
export function DepthLayer({
  lesson, section, isAdmin, state, error, onGenerate,
}: {
  lesson: Lesson;
  section: Section | null;
  isAdmin: boolean;
  state: 'idle' | 'working' | 'error';
  error: string | null;
  onGenerate: () => void;
}) {
  if (section && !section.allow_generated_depth) {
    // Georgia statute chapters: depth comes from primary sources, not the model.
    return isAdmin ? (
      <p className="text-[12px] text-n600 leading-relaxed">
        Georgia law chapter — generated depth is off here. Deeper reading should come from the
        Commission rules and O.C.G.A. text, not generated content.
      </p>
    ) : null;
  }

  if (!lesson.depth_content) {
    if (!isAdmin) return null;
    return (
      <div
        className="rounded-lg px-4 py-4 space-y-2"
        style={{ border: '1px dashed var(--color-divider)' }}
      >
        <p className="text-[13px] text-n500 leading-relaxed">
          Add a generated &ldquo;Going deeper&rdquo; section beneath this lesson. It&rsquo;s marked as
          unsourced and never goes on the review schedule.
        </p>
        <button onClick={onGenerate} disabled={state === 'working'} className="btn btn-secondary">
          {state === 'working' ? 'Generating…' : 'Generate deeper reading'}
        </button>
        {state === 'error' && error && <p className="text-[12px] text-n500">{error}</p>}
      </div>
    );
  }

  return (
    <section
      className="rounded-r-lg px-5 py-5 space-y-4"
      style={{
        background: 'var(--color-surface-sunk)',
        boxShadow: 'inset 2px 0 0 var(--color-n700)',
      }}
    >
      <div className="space-y-1">
        <p className="text-[11px] font-medium text-n500 uppercase tracking-wide">Going deeper</p>
        <p className="text-[12px] text-n600">
          Generated · not from the course · not on your review schedule
        </p>
      </div>
      <div className="space-y-3 text-n400 [&_p]:text-[15px] [&_p]:leading-[1.75] [&_li]:text-[15px] [&_h3]:text-n300">
        {parseSource(lesson.depth_content).map((block, i) => {
          if (block.type === 'heading' || block.type === 'sub') {
            return <h3 key={i} className="text-[14px] font-medium mt-1">{block.text.replace(/:$/, '')}</h3>;
          }
          if (block.type === 'list') {
            return (
              <ul key={i} className="space-y-1">
                {block.items.map((item, j) => (
                  <li key={j} className="flex items-start gap-3 leading-[1.75]">
                    <span className="mt-2.5 w-1 h-1 rounded-sm shrink-0" style={{ background: 'var(--color-n600)' }} />
                    {item}
                  </li>
                ))}
              </ul>
            );
          }
          return <p key={i} style={{ textWrap: 'pretty' }}>{block.text}</p>;
        })}
      </div>
      {isAdmin && (
        <div className="flex items-center gap-3">
          <button
            onClick={onGenerate}
            disabled={state === 'working'}
            className="text-[12px] text-n600 hover:text-n400 transition-colors disabled:opacity-40"
          >
            {state === 'working' ? 'Regenerating…' : 'Regenerate'}
          </button>
          {state === 'error' && error && <span className="text-[12px] text-n500">{error}</span>}
        </div>
      )}
    </section>
  );
}


// ── Revealing an anchor ───────────────────────────────────────────────────────
// When the course text sits in its own scroll box, the quote may be hidden
// inside the box rather than below the fold. Scroll the box to the quote, then
// bring the box onto the screen. Without a box, scroll the page.
export function revealRange(range: Range, scroller: HTMLElement | null) {
  const target = range.getBoundingClientRect();
  if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
    const box = scroller.getBoundingClientRect();
    scroller.scrollTo({
      top: scroller.scrollTop + (target.top - box.top) - scroller.clientHeight / 3,
      behavior: 'smooth',
    });
    window.scrollTo({ top: Math.max(0, window.scrollY + box.top - 96), behavior: 'smooth' });
  } else {
    window.scrollTo({ top: Math.max(0, window.scrollY + target.top - window.innerHeight / 3), behavior: 'smooth' });
  }
}

// ── Course text layouts ───────────────────────────────────────────────────────
// Two candidates for keeping a long lesson from turning the page into one
// endless scroll (CHO picks after seeing both):
//   box      — the text scrolls inside a container capped at 70% of the
//              viewport; "Show full text" lifts the cap
//   collapse — the text shows a preview and expands in place; nothing nests,
//              which suits a phone
// Either way the full text is always in the DOM, so anchor matching works, and
// "Going deeper ↓" skips straight past it.
export type SourceLayout = 'box' | 'collapse';

// Default: the box where there's room for it, collapse on phones, where a
// scroll area inside the page is awkward and studying mostly happens. Same
// 768px breakpoint as the rest of the app. ?source=box|collapse overrides.
const WIDE = '(min-width: 768px)';

export function useDefaultSourceLayout(): SourceLayout {
  const wide = useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(WIDE);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => window.matchMedia(WIDE).matches,
    () => false
  );
  return wide ? 'box' : 'collapse';
}

export function LessonSource({
  text, layout, expanded, onExpandedChange, contentRef, scrollerRef, hasDepth,
}: {
  text: string;
  layout: SourceLayout;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  contentRef: React.RefObject<HTMLDivElement | null>;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  hasDepth: boolean;
}) {
  const words = useMemo(() => (text.trim() ? text.trim().split(/\s+/).length : 0), [text]);
  const minutes = Math.max(1, Math.round(words / 230));

  const header = (
    <div className="flex items-baseline justify-between gap-3 mb-3">
      <p className="text-[11px] font-medium text-n600 uppercase tracking-wide">
        Lesson text{' '}
        <span className="normal-case tracking-normal font-normal text-n700">
          · {words.toLocaleString()} words · {minutes} min
        </span>
      </p>
      {hasDepth && (
        <button
          onClick={() => document.getElementById('going-deeper')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          className="text-[12px] shrink-0 transition-colors hover:text-fg"
          style={{ color: 'var(--color-accent-md)' }}
        >
          Going deeper ↓
        </button>
      )}
    </div>
  );

  const fade = (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-12 rounded-b-lg"
      style={{ background: 'linear-gradient(to bottom, transparent, var(--color-bg))' }}
    />
  );

  if (layout === 'box') {
    return (
      <section aria-label="Lesson text">
        {header}
        <div className="relative rounded-lg" style={{ border: '1px solid var(--color-divider)' }}>
          <div
            ref={scrollerRef}
            tabIndex={0}
            className="px-4 pt-4 pb-12 md:px-5 focus-visible:outline-none"
            style={{
              maxHeight: expanded ? undefined : 'min(70dvh, 720px)',
              overflowY: expanded ? 'visible' : 'auto',
              // 'auto' (the default, stated on purpose): once the box reaches
              // its top or bottom, further scrolling carries on to the page
              // instead of being trapped inside the box.
              overscrollBehaviorY: 'auto',
            }}
          >
            <div ref={contentRef} className="space-y-4">
              <SourceBlocks text={text} />
            </div>
          </div>
          {!expanded && fade}
        </div>
        <button
          onClick={() => onExpandedChange(!expanded)}
          className="mt-2 text-[12px] text-n600 hover:text-fg transition-colors"
        >
          {expanded ? 'Back to scrolling box' : 'Show full text'}
        </button>
      </section>
    );
  }

  return (
    <section aria-label="Lesson text" id="lesson-text">
      {header}
      <div
        className="relative"
        style={{ maxHeight: expanded ? undefined : '38dvh', overflow: expanded ? 'visible' : 'hidden' }}
      >
        <div ref={contentRef} className="space-y-4">
          <SourceBlocks text={text} />
        </div>
        {!expanded && fade}
      </div>
      <button
        aria-expanded={expanded}
        onClick={() => {
          onExpandedChange(!expanded);
          if (expanded) document.getElementById('lesson-text')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
        className="btn btn-secondary btn-block mt-3"
      >
        {expanded ? 'Collapse lesson text' : `Continue reading · ${words.toLocaleString()} words`}
      </button>
    </section>
  );
}
