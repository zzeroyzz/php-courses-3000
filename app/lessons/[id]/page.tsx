'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from '@phosphor-icons/react';
import { createClient } from '@/utils/supabase/client';
import { AppNav } from '@/components/AppNav';
import { StopGeneration, ClearLesson } from '@/components/GenerationControls';
import { DepthLayer, LessonSource, findInSource, revealRange } from '@/components/LessonReading';
import type { SourceLayout } from '@/components/LessonReading';
import { startGeneration } from '@/lib/generation-client';
import { useNow } from '@/lib/use-now';
import { getViewer } from '@/lib/viewer';
import * as db from '@/lib/db';
import { scheduleCard, filterDue } from '@/lib/srs';
import { contentStatus, displayLessonNumber, isResumable, sectionLabel } from '@/lib/db-types';
import type { ContentStatus, Lesson, Section, StudyCard, Question, QuestionType } from '@/lib/db-types';

// Reading is one scrolling page (course text, then the generated depth layer);
// Cards and Practice are drills, so they stay separate tabs.
type Tab = 'read' | 'cards' | 'practice';

const TYPE_LABEL: Record<QuestionType, string> = {
  factual: 'Factual',
  scenario: 'Scenario',
  calculation: 'Calc',
};

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

  // Anchor jump: switching to Read and locating the quote happen in separate
  // renders, because the source text only exists in the DOM once Read is shown.
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(searchParams.get('anchor'));
  const [anchorMiss, setAnchorMiss] = useState<string | null>(null);

  // How the course text is contained. 'box' unless ?source=collapse — a
  // temporary switch so both candidates can be compared on real lessons.
  const sourceLayout: SourceLayout = searchParams.get('source') === 'collapse' ? 'collapse' : 'box';
  // A collapsed preview has to be open before a jump can show the quote, so an
  // incoming ?anchor starts it expanded.
  const [sourceExpanded, setSourceExpanded] = useState(sourceLayout === 'collapse' && !!searchParams.get('anchor'));

  const sourceRef = useRef<HTMLDivElement>(null);
  const sourceScrollerRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

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

  // Follow this lesson's row for as long as the page is open: generation
  // progress, a Stop, or a Clear all arrive as updates to it. Status is
  // derived from the row (contentStatus), so no client-side timeout is needed
  // to notice a run that died.
  function watchLesson(lessonId: string) {
    if (channelRef.current) supabase.removeChannel(channelRef.current);
    channelRef.current = supabase
      .channel(`lesson-${lessonId}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'lessons', filter: `id=eq.${lessonId}` },
        (payload) => {
          const row = payload.new as Lesson;
          setLesson((prev) => {
            // Finished, or cleared: cards and questions changed, reload them.
            if (prev && ((row.generated_at && !prev.generated_at) || (!row.has_source && prev.has_source))) {
              reloadContent();
            }
            return prev ? { ...prev, ...row } : row;
          });
        }
      )
      .subscribe();
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

      watchLesson(lessonData.id);
    })();

    return () => {
      if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
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
      // In the box layout the quote can be inside the box's own scroll area.
      revealRange(range, sourceLayout === 'box' && !sourceExpanded ? sourceScrollerRef.current : null);
    } else {
      setAnchorMiss(pendingAnchor);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    setPendingAnchor(null);
  }, [pendingAnchor, tab, lesson, sourceExpanded, sourceLayout]);

  function jumpToSource(anchor: string | null) {
    if (!anchor) return;
    setPendingAnchor(anchor);
    setTab('read');
    if (sourceLayout === 'collapse') setSourceExpanded(true);
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

  // Admin: start drills for a document example (opt-in for that kind), or
  // resume a run that was stopped or failed partway.
  async function handleGenerate(reset: boolean) {
    if (!lesson) return;
    await startGeneration(supabase, lesson.id, { reset, chunkFrom: lesson.generation_chunk ?? 0 });
    const fresh = await db.getLessonById(supabase, lesson.id);
    if (fresh) setLesson(fresh);
  }

  const liveStatus = lesson ? contentStatus(lesson) : 'empty';
  const now = useNow(liveStatus === 'generating' || liveStatus === 'cancelling');

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

  const status: ContentStatus = contentStatus(lesson, now);
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
      isAdmin={isAdmin}
      lessonId={lesson.id}
      generationChunk={lesson.generation_chunk}
      sectionSlug={section?.slug ?? null}
      onGenerate={isAdmin ? handleGenerate : undefined}
      onStopped={() => {}}
      hasDrills={cards.length > 0 || questions.length > 0}
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

                {status !== 'ready' && (
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <p className="text-[13px] text-n600">
                      {status === 'generating'
                        ? 'Cards and practice questions are being generated…'
                        : status === 'cancelling'
                        ? 'Stopping generation…'
                        : 'Cards and practice questions for this lesson aren’t ready yet.'}
                    </p>
                    {isAdmin && status === 'generating' && (
                      <StopGeneration lessonId={lesson.id} onStopped={() => {}} />
                    )}
                  </div>
                )}

                {lesson.why_it_matters && (
                  <div>
                    <p className="text-[11px] font-medium text-n600 uppercase tracking-wide mb-2">Why this matters</p>
                    <p className="text-[16px] text-n400 leading-[1.75]" style={{ textWrap: 'pretty' }}>{lesson.why_it_matters}</p>
                  </div>
                )}

                {/* Course text — the primary body and the only anchor target */}
                <LessonSource
                  text={lesson.source_content}
                  layout={sourceLayout}
                  expanded={sourceExpanded}
                  onExpandedChange={setSourceExpanded}
                  contentRef={sourceRef}
                  scrollerRef={sourceScrollerRef}
                  hasDepth={!!lesson.depth_content}
                />

                <div id="going-deeper" style={{ scrollMarginTop: '16px' }}>
                  <DepthLayer
                    lesson={lesson}
                    section={section}
                    isAdmin={isAdmin}
                    state={depthState}
                    error={depthError}
                    onGenerate={handleGenerateDepth}
                  />
                </div>

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

                {isAdmin && (
                  <div className="pt-4 space-y-2" style={{ borderTop: '1px solid var(--color-divider)' }}>
                    <p className="text-[11px] font-medium text-n600 uppercase tracking-wide">Admin</p>
                    <p className="text-[12px] text-n600 leading-relaxed">
                      Pasted into the wrong lesson? Clearing returns it to &ldquo;not added&rdquo; so it can be pasted again.
                    </p>
                    <ClearLesson lessonId={lesson.id} onCleared={reloadContent} />
                  </div>
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

function DrillState({
  status, kind, isAdmin, lessonId, generationChunk, sectionSlug, onGenerate, onStopped, hasDrills,
}: {
  status: ContentStatus;
  kind: Lesson['kind'];
  isAdmin: boolean;
  lessonId: string;
  generationChunk: number | null;
  sectionSlug: string | null;
  onGenerate?: (reset: boolean) => void;
  onStopped: () => void;
  hasDrills: boolean;
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
      'This lesson hasn\u2019t been added yet',
      isAdmin ? 'Paste the lesson text to generate cards and questions.' : 'Cards and practice appear once it\u2019s added.',
      isAdmin ? <Link href={`/ingest?lesson=${lessonId}`} className="btn btn-primary mt-2">Paste content</Link> : undefined
    );
  }
  if (status === 'generating' || status === 'cancelling') {
    return (
      <div className="rounded-lg p-6 text-center space-y-3" style={{ background: 'var(--color-surface)' }}>
        <Spinner />
        <p className="text-[14px] text-n500">
          {status === 'cancelling' ? 'Stopping\u2026' : 'Generating cards and questions\u2026'}
        </p>
        {isAdmin && status === 'generating' && (
          <div className="flex justify-center"><StopGeneration lessonId={lessonId} onStopped={onStopped} /></div>
        )}
      </div>
    );
  }
  if (kind === 'document' && status === 'ready' && !hasDrills) {
    return box(
      'Reading material',
      isAdmin
        ? 'Cards and questions aren\u2019t generated for document examples by default.'
        : 'This document example has no cards or questions. Study it on the Read tab.',
      isAdmin && onGenerate
        ? <button onClick={() => onGenerate(true)} className="btn btn-secondary mt-2">Generate cards &amp; questions</button>
        : undefined
    );
  }
  if (isResumable(status) || status === 'stalled') {
    if (!isAdmin) return box('Not ready yet', 'Cards and questions for this lesson are still being prepared.');
    const where = generationChunk != null ? ` at part ${generationChunk + 1}` : '';
    const title =
      status === 'cancelled' ? `Generation was stopped${where}`
      : status === 'failed' ? `Generation failed${where}`
      : 'Generation isn\u2019t running';
    return box(
      title,
      status === 'stalled' ? 'It may have timed out. Start it again, or clear the lesson from the Read tab.' : 'What was generated so far is kept.',
      <div className="flex justify-center gap-4 pt-2 text-[13px]">
        {onGenerate && generationChunk != null && (
          <button onClick={() => onGenerate(false)} style={{ color: 'var(--color-accent-md)' }}>Resume</button>
        )}
        {onGenerate && generationChunk == null && (
          <button onClick={() => onGenerate(true)} style={{ color: 'var(--color-accent-md)' }}>Generate</button>
        )}
        {sectionSlug && <Link href={`/sections/${sectionSlug}`} className="text-n500 hover:text-fg">Start over from the chapter page</Link>}
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
