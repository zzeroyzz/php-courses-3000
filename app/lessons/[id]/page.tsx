'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from '@phosphor-icons/react';
import { createClient } from '@/utils/supabase/client';
import { AppNav } from '@/components/AppNav';
import { getViewer } from '@/lib/viewer';
import * as db from '@/lib/db';
import { scheduleCard, filterDue } from '@/lib/srs';
import { contentStatus, displayLessonNumber, sectionLabel } from '@/lib/db-types';
import type { ContentStatus, Lesson, Section, StudyCard, Question, QuestionType } from '@/lib/db-types';

// Reading is one scrolling page (course text, then the generated depth layer);
// Cards and Practice are drills, so they stay separate tabs.
type Tab = 'read' | 'cards' | 'practice';

const TYPE_LABEL: Record<QuestionType, string> = {
  factual: 'Factual',
  scenario: 'Scenario',
  calculation: 'Calc',
};

// ── Source parser ─────────────────────────────────────────────────────────────

type Block =
  | { type: 'heading'; text: string }
  | { type: 'sub'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'note'; text: string }
  | { type: 'paragraph'; text: string };

function parseSource(text: string): Block[] {
  const sections = text.split(/\n{2,}/);
  const blocks: Block[] = [];
  const bulletRe = /^[-•*]\s|^\d+[.)]\s/;

  for (const section of sections) {
    const lines = section.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

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

function findInSource(root: HTMLElement, anchor: string): Range | null {
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

// ── Main component ─────────────────────────────────────────────────────────────

export default function LessonPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const rawTab = searchParams.get('tab');
  const initialTab: Tab =
    rawTab === 'flashcards' || rawTab === 'cards' ? 'cards' :
    rawTab === 'practice' ? 'practice' : 'read';   // 'study' / 'source' / 'read' all land on Read

  const [tab, setTab] = useState<Tab>(initialTab);
  const [userId, setUserId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [section, setSection] = useState<Section | null>(null);
  const [cards, setCards] = useState<StudyCard[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generationError, setGenerationError] = useState(false);

  // Cards state
  const [reviewQueue, setReviewQueue] = useState<StudyCard[]>([]);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [sessionCorrect, setSessionCorrect] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [reviewDone, setReviewDone] = useState(false);

  // Practice state
  const [typeFilter, setTypeFilter] = useState<QuestionType | 'all'>('all');
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [chosen, setChosen] = useState<Record<string, number>>({});

  // Depth layer (admin-triggered)
  const [depthState, setDepthState] = useState<'idle' | 'working' | 'error'>('idle');
  const [depthError, setDepthError] = useState<string | null>(null);

  // Admin asked for drills on a document example (otherwise documents have none).
  const [drillsRequested, setDrillsRequested] = useState(false);

  // Anchor jump: switching to Read and locating the quote happen in separate
  // renders, because the source text only exists in the DOM once Read is shown.
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(searchParams.get('anchor'));
  const [anchorMiss, setAnchorMiss] = useState<string | null>(null);

  const sourceRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function reloadContent() {
    const [freshLesson, freshCards, freshQuestions] = await Promise.all([
      db.getLessonById(supabase, id),
      db.getStudyCards(supabase, id),
      db.getQuestions(supabase, id),
    ]);
    if (freshLesson) setLesson(freshLesson);
    setCards(freshCards);
    setQuestions(freshQuestions);
    setReviewQueue(filterDue(freshCards));
    return freshLesson;
  }

  function watchGeneration(lessonId: string) {
    function cleanup() {
      if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    }
    cleanup();
    setGenerationError(false);
    channelRef.current = supabase
      .channel(`lesson-gen-${lessonId}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'lessons', filter: `id=eq.${lessonId}` },
        async (payload) => {
          const row = payload.new as Lesson;
          if (row.generated_at) { await reloadContent(); cleanup(); }
          else if (row.generation_chunk != null) { setLesson((prev) => prev ? { ...prev, generation_chunk: row.generation_chunk } : prev); cleanup(); }
        }
      )
      .subscribe();
    timeoutRef.current = setTimeout(() => { cleanup(); setGenerationError(true); }, 3 * 60 * 1000);
  }

  useEffect(() => {
    (async () => {
      const viewer = await getViewer(supabase);
      if (!viewer) { router.push('/sign-in'); return; }

      const [lessonData, cardsData, questionsData, completed] = await Promise.all([
        db.getLessonById(supabase, id),
        db.getStudyCards(supabase, id),
        db.getQuestions(supabase, id),
        db.getLessonCompletedAt(supabase, id),
      ]);

      if (!lessonData) { router.push('/'); return; }
      const sectionData = await db.getSectionById(supabase, lessonData.section_id);

      setUserId(viewer.user.id);
      setIsAdmin(viewer.isAdmin);
      setLesson(lessonData);
      setSection(sectionData);
      setCards(cardsData);
      setQuestions(questionsData);
      setCompletedAt(completed);
      setReviewQueue(filterDue(cardsData));
      setLoading(false);

      if (contentStatus(lessonData) === 'generating') watchGeneration(lessonData.id);
    })();

    return () => {
      if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, router, id]);

  // Second half of the anchor jump: runs after Read has rendered the source.
  useEffect(() => {
    if (!pendingAnchor || tab !== 'read' || !sourceRef.current) return;
    const range = findInSource(sourceRef.current, pendingAnchor);
    if (range) {
      setAnchorMiss(null);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      setAnchorMiss(pendingAnchor);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    setPendingAnchor(null);
  }, [pendingAnchor, tab, lesson]);

  function jumpToSource(anchor: string | null) {
    if (!anchor) return;
    setPendingAnchor(anchor);
    setTab('read');
  }

  async function handleCardAnswer(correct: boolean) {
    const card = reviewQueue[reviewIdx];
    if (!card || !userId) return;
    const updates = scheduleCard(card, correct);
    const state = {
      ease: updates.ease,
      interval_days: updates.interval_days,
      due_at: updates.due_at.toISOString(),
      lapses: updates.lapses,
    };
    await db.saveCardReview(supabase, userId, card.id, state);
    setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, ...state } : c)));
    if (correct) setSessionCorrect((n) => n + 1);
    setSessionTotal((n) => n + 1);
    const next = reviewIdx + 1;
    if (next >= reviewQueue.length) { setReviewDone(true); }
    else { setReviewIdx(next); setFlipped(false); }
  }

  async function handlePracticeAnswer(question: Question, chosenIdx: number) {
    if (chosen[question.id] !== undefined || !userId) return;
    const correct = chosenIdx === question.correct_index;
    setChosen((prev) => ({ ...prev, [question.id]: chosenIdx }));
    setRevealed((prev) => ({ ...prev, [question.id]: true }));
    await db.recordAttempt(supabase, { question_id: question.id, user_id: userId, chosen_index: chosenIdx, correct });
  }

  async function handleMarkComplete() {
    if (!lesson || !userId) return;
    await db.markLessonComplete(supabase, userId, lesson.id);
    setCompletedAt(new Date().toISOString());
  }

  async function handleGenerateDepth() {
    if (!lesson) return;
    setDepthState('working');
    setDepthError(null);
    try {
      const res = await fetch('/api/generate-depth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lessonId: lesson.id }),
      });
      const json = await res.json() as { ok?: boolean; error?: string; depth_content?: string };
      if (!res.ok || !json.depth_content) throw new Error(json.error ?? 'Generation failed');
      setLesson((prev) => prev ? { ...prev, depth_content: json.depth_content!, depth_generated_at: new Date().toISOString() } : prev);
      setDepthState('idle');
    } catch (err) {
      setDepthError(err instanceof Error ? err.message : 'Generation failed');
      setDepthState('error');
    }
  }

  // Admin: generate drills for a document example (opt-in for that kind).
  async function handleGenerateDrills() {
    if (!lesson) return;
    setDrillsRequested(true);
    setLesson((prev) => prev ? { ...prev, generated_at: null, generation_chunk: null } : prev);
    watchGeneration(lesson.id);
    fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId: lesson.id }),
    }).catch(() => {});
  }

  if (loading || !lesson) {
    return (
      <div className="min-h-dvh bg-bg pb-24">
        <AppNav />
        <div className="md:ml-56 max-w-2xl mx-auto px-5 py-20 space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg" style={{ background: 'var(--color-surface)' }} />
          ))}
        </div>
      </div>
    );
  }

  // Document examples read as 'ready' with no drills; once an admin requests
  // drills, track that generation like any other lesson's.
  const status: ContentStatus = drillsRequested && !lesson.generated_at
    ? (lesson.generation_chunk != null ? 'failed' : 'generating')
    : contentStatus(lesson);
  const dueCount = filterDue(cards).length;
  const number = displayLessonNumber(lesson);
  const filteredQuestions = typeFilter === 'all' ? questions : questions.filter((q) => q.question_type === typeFilter);
  const practiceAnswered = Object.keys(chosen).length;
  const practiceCorrect = Object.entries(chosen).filter(([qid, ci]) =>
    questions.find((q) => q.id === qid)?.correct_index === ci
  ).length;

  const drillMessage = (
    <DrillState
      status={status}
      kind={lesson.kind}
      generationError={generationError}
      isAdmin={isAdmin}
      lessonId={lesson.id}
      onGenerateDrills={lesson.kind === 'document' && isAdmin && lesson.has_source && !lesson.generated_at && !drillsRequested ? handleGenerateDrills : undefined}
    />
  );

  return (
    <div className="min-h-dvh bg-bg pb-24 md:pb-8">
      <AppNav />

      <div className="md:ml-56">
        {/* ── Header ── */}
        <header className="px-5 py-4 md:px-8" style={{ borderBottom: '1px solid var(--color-divider)' }}>
          {section && (
            <Link
              href={`/sections/${section.slug}`}
              className="inline-flex items-center gap-1.5 text-[13px] text-n500 hover:text-fg transition-colors mb-3"
            >
              <ArrowLeft size={14} />
              {sectionLabel(section)}
            </Link>
          )}
          <h1 className="text-[20px] font-medium text-fg leading-snug tracking-[-0.02em]">
            {number && <span className="tabular-nums text-n500 font-normal mr-2">{number}</span>}
            {lesson.title}
          </h1>
          {status !== 'empty' && (
            <p className="text-[13px] text-n600 mt-1 tabular-nums">
              {cards.length} cards · {questions.length} questions
              {dueCount > 0 && (
                <> · <span style={{ color: 'var(--color-accent-md)' }}>{dueCount} due</span></>
              )}
            </p>
          )}
        </header>

        {/* ── Segmented tab control ── */}
        <div className="px-5 py-3 md:px-8" style={{ borderBottom: '1px solid var(--color-divider)' }}>
          <div className="seg max-w-md">
            {(['read', 'cards', 'practice'] as Tab[]).map((t) => {
              const labels: Record<Tab, string> = {
                read: 'Read',
                cards: `Cards${cards.length ? ` · ${cards.length}` : ''}`,
                practice: `Practice${questions.length ? ` · ${questions.length}` : ''}`,
              };
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`seg-opt${tab === t ? ' active' : ''}`}
                >
                  {labels[t]}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Tab content ── */}
        <div className="max-w-2xl mx-auto px-5 py-6 md:px-8">

          {/* ── Read: course text, then the depth layer, as one page ── */}
          {tab === 'read' && (
            status === 'empty' ? (
              <div className="rounded-lg p-6 text-center space-y-3" style={{ background: 'var(--color-surface)' }}>
                <p className="text-[15px] font-medium text-fg">
                  {lesson.kind === 'infographic' ? 'Image-only lesson' : 'This lesson hasn’t been added yet'}
                </p>
                <p className="text-[14px] text-n500">
                  {isAdmin
                    ? 'Paste the lesson text to make it available to students.'
                    : lesson.kind === 'infographic'
                    ? 'This lesson is an image on the course platform.'
                    : 'It will appear here once your instructor adds it.'}
                </p>
                {isAdmin && (
                  <Link href={`/ingest?lesson=${lesson.id}`} className="btn btn-primary">Paste content</Link>
                )}
              </div>
            ) : (
              <div className="space-y-8" style={{ maxWidth: '62ch' }}>
                {anchorMiss && (
                  <div className="rounded-lg px-4 py-3 text-[13px] text-n400" style={{ background: 'var(--color-surface)' }}>
                    Couldn&rsquo;t locate this quote in the lesson text:{' '}
                    <span className="italic">&ldquo;{anchorMiss.slice(0, 120)}{anchorMiss.length > 120 ? '…' : ''}&rdquo;</span>
                  </div>
                )}

                {(status === 'generating' || status === 'failed') && (
                  <p className="text-[13px] text-n600">
                    {status === 'failed' || generationError
                      ? 'Cards and practice questions for this lesson aren’t ready yet.'
                      : 'Cards and practice questions are being generated…'}
                  </p>
                )}

                {lesson.why_it_matters && (
                  <div>
                    <p className="text-[11px] font-medium text-n600 uppercase tracking-wide mb-2">Why this matters</p>
                    <p className="text-[16px] text-n400 leading-[1.75]" style={{ textWrap: 'pretty' }}>{lesson.why_it_matters}</p>
                  </div>
                )}

                {/* Course text — the primary body and the only anchor target */}
                <div ref={sourceRef} className="space-y-4">
                  <SourceBlocks text={lesson.source_content} />
                </div>

                <DepthLayer
                  lesson={lesson}
                  section={section}
                  isAdmin={isAdmin}
                  state={depthState}
                  error={depthError}
                  onGenerate={handleGenerateDepth}
                />

                {!completedAt ? (
                  <div className="space-y-2">
                    <button
                      onClick={handleMarkComplete}
                      className="btn btn-secondary btn-block"
                      style={{ paddingTop: '10px', paddingBottom: '10px' }}
                    >
                      Mark as completed
                    </button>
                    {cards.length > 0 && (
                      <p className="text-[12px] text-n600 text-center">
                        Adds this lesson&rsquo;s cards to your review schedule.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-[12px] text-n600 text-center">
                    Completed {new Date(completedAt).toLocaleDateString()}
                  </p>
                )}
              </div>
            )
          )}

          {/* ── Cards tab ── */}
          {tab === 'cards' && (
            <div>
              {cards.length === 0 ? (
                drillMessage
              ) : (reviewDone || reviewQueue.length === 0) ? (
                <div className="rounded-lg p-6 space-y-4 text-center" style={{ background: 'var(--color-surface)' }}>
                  <p className="text-[20px] font-medium text-fg">
                    {reviewQueue.length === 0 ? 'All caught up' : 'Session done'}
                  </p>
                  {sessionTotal > 0 && (
                    <p className="text-[14px] text-n500">{sessionCorrect} / {sessionTotal} correct</p>
                  )}
                  <div className="space-y-2 pt-2">
                    <button
                      onClick={() => {
                        setReviewQueue(cards);
                        setReviewIdx(0); setFlipped(false);
                        setSessionCorrect(0); setSessionTotal(0); setReviewDone(false);
                      }}
                      className="btn btn-secondary btn-block"
                    >
                      Review all {cards.length} cards
                    </button>
                    {reviewDone && filterDue(cards).length > 0 && (
                      <button
                        onClick={() => {
                          setReviewQueue(filterDue(cards));
                          setReviewIdx(0); setFlipped(false);
                          setSessionCorrect(0); setSessionTotal(0); setReviewDone(false);
                        }}
                        className="btn btn-primary btn-block"
                      >
                        Review {filterDue(cards).length} due
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <CardReview
                  card={reviewQueue[reviewIdx]}
                  cardNum={reviewIdx + 1}
                  total={reviewQueue.length}
                  flipped={flipped}
                  onFlip={() => setFlipped((f) => !f)}
                  onCorrect={() => handleCardAnswer(true)}
                  onWrong={() => handleCardAnswer(false)}
                  onAnchorClick={jumpToSource}
                />
              )}
            </div>
          )}

          {/* ── Practice tab ── */}
          {tab === 'practice' && (
            <div className="space-y-5">
              {questions.length === 0 ? (
                drillMessage
              ) : (
                <>
                  {/* Filter pills */}
                  <div className="flex gap-2 flex-wrap">
                    {(['all', 'factual', 'scenario', 'calculation'] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTypeFilter(t)}
                        className="px-3 py-1 rounded-full text-[12px] font-medium transition-colors"
                        style={{
                          background: typeFilter === t ? 'var(--color-accent-dk)' : 'var(--color-surface)',
                          color: typeFilter === t ? 'var(--color-accent-md)' : 'var(--color-n500)',
                          border: typeFilter === t ? '1px solid var(--color-accent)' : '1px solid var(--color-divider)',
                        }}
                      >
                        {t === 'all'
                          ? `All (${questions.length})`
                          : `${TYPE_LABEL[t]} (${questions.filter((q) => q.question_type === t).length})`}
                      </button>
                    ))}
                  </div>

                  {practiceAnswered > 0 && (
                    <p className="text-[12px] text-n600 tabular-nums">
                      {practiceCorrect}/{practiceAnswered} correct
                    </p>
                  )}

                  <div className="space-y-4">
                    {filteredQuestions.map((q, qi) => {
                      const isRevealed = !!revealed[q.id];
                      const chosenIdx = chosen[q.id];

                      return (
                        <div key={q.id} className="rounded-lg overflow-hidden" style={{ background: 'var(--color-surface)' }}>
                          {/* Question stem */}
                          <div className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid var(--color-divider)' }}>
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-[12px] text-n700 tabular-nums">{qi + 1}.</span>
                              <span className="tag tag-neutral">{TYPE_LABEL[q.question_type]}</span>
                            </div>
                            <p className="text-[15px] text-fg leading-relaxed">{q.stem}</p>
                          </div>

                          {/* Options */}
                          <div>
                            {q.options.map((opt, ci) => {
                              const isChosen = chosenIdx === ci;
                              const isCorrect = q.correct_index === ci;
                              let optStyle: React.CSSProperties = {
                                background: 'transparent',
                                color: 'var(--color-fg)',
                              };
                              if (isRevealed) {
                                if (isCorrect) {
                                  optStyle = {
                                    background: 'color-mix(in srgb, var(--color-accent) 16%, transparent)',
                                    color: 'var(--color-accent-md)',
                                    boxShadow: 'inset 0 0 0 1px var(--color-accent)',
                                  };
                                } else if (isChosen) {
                                  optStyle = {
                                    background: 'transparent',
                                    color: 'var(--color-n700)',
                                    boxShadow: 'inset 0 0 0 1px var(--color-n800)',
                                  };
                                } else {
                                  optStyle = {
                                    background: 'var(--color-bg)',
                                    color: 'var(--color-n700)',
                                  };
                                }
                              }
                              return (
                                <button
                                  key={ci}
                                  disabled={isRevealed}
                                  onClick={() => handlePracticeAnswer(q, ci)}
                                  className="w-full text-left flex items-start gap-3 px-4 py-3 text-[14px] transition-colors"
                                  style={{
                                    ...optStyle,
                                    borderTop: '1px solid var(--color-divider)',
                                  }}
                                >
                                  <span className="font-medium text-n600 shrink-0 tabular-nums w-4">
                                    {String.fromCharCode(65 + ci)}.
                                  </span>
                                  <span className="flex-1">{opt}</span>
                                </button>
                              );
                            })}
                          </div>

                          {/* Explanation */}
                          {isRevealed && (
                            <div
                              className="px-4 py-3"
                              style={{
                                background: 'var(--color-bg)',
                                borderTop: '1px solid var(--color-divider)',
                              }}
                            >
                              <p className="text-[13px] text-n400 leading-relaxed">{q.explanation}</p>
                              {q.source_anchor && (
                                <button
                                  onClick={() => jumpToSource(q.source_anchor)}
                                  className="mt-2 text-[12px] text-n600 hover:text-n400 italic transition-colors text-left"
                                >
                                  &ldquo;{q.source_anchor}&rdquo; →
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SourceBlocks({ text }: { text: string }) {
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
function DepthLayer({
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

function DrillState({
  status, kind, generationError, isAdmin, lessonId, onGenerateDrills,
}: {
  status: ContentStatus;
  kind: Lesson['kind'];
  generationError: boolean;
  isAdmin: boolean;
  lessonId: string;
  onGenerateDrills?: () => void;
}) {
  const box = (title: string, body: string, action?: React.ReactNode) => (
    <div className="rounded-lg p-6 text-center space-y-2" style={{ background: 'var(--color-surface)' }}>
      <p className="text-[15px] font-medium text-fg">{title}</p>
      <p className="text-[14px] text-n500">{body}</p>
      {action}
    </div>
  );

  if (status === 'empty') {
    return box(
      'This lesson hasn’t been added yet',
      isAdmin ? 'Paste the lesson text to generate cards and questions.' : 'Cards and practice appear once it’s added.',
      isAdmin ? <Link href={`/ingest?lesson=${lessonId}`} className="btn btn-primary mt-2">Paste content</Link> : undefined
    );
  }
  if (onGenerateDrills) {
    return box(
      'Reading material',
      'Cards and questions aren’t generated for document examples by default.',
      <button onClick={onGenerateDrills} className="btn btn-secondary mt-2">Generate cards &amp; questions</button>
    );
  }
  if (kind === 'document' && status === 'ready') {
    return box('Reading material', 'This document example has no cards or questions. Study it on the Read tab.');
  }
  if (status === 'failed' || generationError) {
    return box(
      'Not ready yet',
      isAdmin ? 'Generation stopped partway. Resume it from the chapter page.' : 'Cards and questions for this lesson are still being prepared.'
    );
  }
  if (status === 'generating') {
    return (
      <div className="rounded-lg p-6 text-center space-y-3" style={{ background: 'var(--color-surface)' }}>
        <Spinner />
        <p className="text-[14px] text-n500">Generating cards and questions…</p>
      </div>
    );
  }
  return box('Nothing here', 'This lesson has no cards or questions.');
}

function CardReview({
  card, cardNum, total, flipped, onFlip, onCorrect, onWrong, onAnchorClick,
}: {
  card: StudyCard; cardNum: number; total: number; flipped: boolean;
  onFlip: () => void; onCorrect: () => void; onWrong: () => void;
  onAnchorClick: (anchor: string | null) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-n600 tabular-nums">{cardNum} of {total}</span>
        {card.lapses > 0 && (
          <span className="text-[11px] text-n700 tabular-nums">{card.lapses} lapses</span>
        )}
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={onFlip}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFlip(); } }}
        className="w-full text-left cursor-pointer rounded-lg transition-colors"
        style={{
          minHeight: '230px',
          padding: '28px 24px',
          background: 'var(--color-surface)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <p className="text-[11px] font-medium text-n600 uppercase tracking-wide mb-4">
          {flipped ? 'Answer' : 'Description'}
        </p>
        <p className="text-[20px] font-medium text-fg leading-relaxed flex-1">
          {flipped ? card.back : card.front}
        </p>
        {!flipped && (
          <p className="text-[12px] text-n700 mt-4">Tap to reveal</p>
        )}
        {flipped && card.source_anchor && (
          <button
            onClick={(e) => { e.stopPropagation(); onAnchorClick(card.source_anchor); }}
            className="mt-4 text-[12px] text-n600 hover:text-n400 italic transition-colors text-left"
          >
            &ldquo;{card.source_anchor.slice(0, 60)}&hellip;&rdquo; →
          </button>
        )}
      </div>

      <div className={`flex gap-3 transition-all duration-150 ${flipped ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <button
          onClick={onWrong}
          className="flex-1 py-3 rounded-lg text-[14px] font-medium text-n400 transition-colors"
          style={{ border: '1px solid var(--color-divider)' }}
        >
          Again
        </button>
        <button
          onClick={onCorrect}
          className="flex-1 py-3 rounded-lg text-[14px] font-medium transition-colors"
          style={{
            background: 'color-mix(in srgb, var(--color-accent) 16%, transparent)',
            color: 'var(--color-accent-md)',
            border: '1px solid var(--color-accent)',
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="w-5 h-5 animate-spin text-n600 mx-auto" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
