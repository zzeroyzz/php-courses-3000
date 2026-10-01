import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@/utils/supabase/server';
import * as db from '@/lib/db';
import { COURSE_CONTEXT } from '@/lib/course';
import { GENERATION_MODEL, requireAdmin } from '@/lib/generation';
import type { QuestionMix } from '@/lib/db-types';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Source chunks stay under this limit so the model can produce full JSON within 8192 output tokens
const CHUNK_LIMIT = 8_000;

// ── Chunk splitter ────────────────────────────────────────────────────────────

function splitOnParagraphs(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    // Prefer paragraph break, fall back to line break, then space
    let breakAt = window.lastIndexOf('\n\n');
    if (breakAt < limit / 4) breakAt = window.lastIndexOf('\n');
    if (breakAt < limit / 4) breakAt = window.lastIndexOf(' ');
    if (breakAt <= 0) breakAt = limit;

    chunks.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── Prompts ───────────────────────────────────────────────────────────────────
//
// Everything this route generates goes on the spaced-repetition schedule
// (flashcards) or into scored practice (questions), so it must come from the
// pasted source and nothing else, each item carrying a verbatim source_anchor.
//
// This is not caution for its own sake. Spaced repetition cements whatever it
// schedules: a wrong flashcard reviewed eight times over six weeks becomes a
// wrong answer the student trusts more than a right one they saw once. So the
// drilled set must be the verifiable set. Elaboration beyond the source belongs
// in the separate, visibly-marked depth layer (/api/generate-depth), which is a
// text column and can never enter the review queue. Do not loosen this prompt
// to "add helpful context".

const SOURCING_RULES = `Sourcing rules — these override everything else:
- Use ONLY facts stated in the source text. Do not add facts, numbers, deadlines, rule citations or exceptions from general knowledge, even if you believe them to be true.
- Every question's correct answer and every flashcard's back must be directly supported by the source.
- source_anchor: a short verbatim quote (≤30 words) copied exactly from the source that supports the answer.
- If the source can only support fewer items than requested, return fewer.`;

function firstChunkPrompt(mix: QuestionMix, n: number): string {
  const f = Math.round(n * mix.factual);
  const s = Math.round(n * mix.scenario);
  const c = n - f - s;
  return `You are building study material for ${COURSE_CONTEXT}.

Given a lesson title and source text, produce:
1. A short "why it matters" paragraph (2–4 sentences) explaining, from the source, why this topic matters on the licensing exam and in a licensee's work.
2. Up to ${n} multiple-choice questions: ${f} factual, ${s} scenario, ${c} calculation.
3. 8–20 flashcards (description→term: front describes a concept/situation, back gives the precise term/rule/number).

${SOURCING_RULES}

Question requirements:
- Use named fictional buyers, sellers, tenants and licensees in scenario questions.
- All four options must be plausible; wrong answers should be true facts about related topics (true-but-incomplete distractors).
- Avoid starting every stem with "Which of the following".
- Explanation must say why the correct answer is right AND why the best wrong answer fails.
- For calculation questions, show full worked arithmetic in the explanation.

Return strict JSON only — no markdown fences, no preamble:
{
  "whyItMatters": "string",
  "questions": [
    {
      "question_type": "factual"|"scenario"|"calculation",
      "stem": "string",
      "options": ["string","string","string","string"],
      "correct_index": 0,
      "explanation": "string",
      "source_anchor": "string"
    }
  ],
  "flashcards": [
    { "front": "string", "back": "string", "source_anchor": "string" }
  ]
}`;
}

function continuationChunkPrompt(mix: QuestionMix, n: number): string {
  const f = Math.round(n * mix.factual);
  const s = Math.round(n * mix.scenario);
  const c = n - f - s;
  return `You are building additional study material for ${COURSE_CONTEXT}, from a continuation of a longer source document.

Produce:
1. Up to ${n} multiple-choice questions: ${f} factual, ${s} scenario, ${c} calculation.
2. 6–14 flashcards (description→term direction).

${SOURCING_RULES}

Apply the same quality requirements: named fictional buyers, sellers and licensees in scenarios, plausible distractors, worked arithmetic.

Return strict JSON only — no markdown fences:
{
  "questions": [
    {
      "question_type": "factual"|"scenario"|"calculation",
      "stem": "string",
      "options": ["string","string","string","string"],
      "correct_index": 0,
      "explanation": "string",
      "source_anchor": "string"
    }
  ],
  "flashcards": [
    { "front": "string", "back": "string", "source_anchor": "string" }
  ]
}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type FirstChunkResponse = {
  whyItMatters: string;
  questions: QuestionRow[];
  flashcards: FlashcardRow[];
};

type ContinuationResponse = {
  questions: QuestionRow[];
  flashcards: FlashcardRow[];
};

type QuestionRow = {
  question_type: 'factual' | 'scenario' | 'calculation';
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string;
  source_anchor: string;
};

type FlashcardRow = {
  front: string;
  back: string;
  source_anchor: string;
};

function parseJSON<T>(text: string): T {
  const clean = text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean) as T;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    lessonId: string;
    chunkFrom?: number;   // resume point; default 0 (full restart)
  };

  const { lessonId } = body;
  const chunkFrom = body.chunkFrom ?? 0;

  if (!lessonId) {
    return NextResponse.json({ error: 'lessonId required' }, { status: 400 });
  }

  const supabase = await createClient();

  const auth = await requireAdmin(supabase);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Read title, source and question mix from the database rather than trusting
  // the request body.
  const lesson = await db.getLessonById(supabase, lessonId);
  if (!lesson) return NextResponse.json({ error: 'Lesson not found' }, { status: 404 });
  const section = await db.getSectionById(supabase, lesson.section_id);
  if (!section) return NextResponse.json({ error: 'Section not found' }, { status: 404 });

  const sourceContent = lesson.source_content;
  const title = lesson.title;
  const questionMix = section.question_mix;

  if (!sourceContent?.trim()) {
    return NextResponse.json({ error: 'Lesson has no source content' }, { status: 400 });
  }

  const chunks = splitOnParagraphs(sourceContent.trim(), CHUNK_LIMIT);
  const totalWords = sourceContent.trim().split(/\s+/).length;
  const isMultiChunk = chunks.length > 1;

  console.log(`[generate] lesson=${lessonId} chunks=${chunks.length} totalChars=${sourceContent.length} resumeFrom=${chunkFrom}`);

  // On a full restart (chunkFrom === 0), wipe any previous content and mark the
  // lesson as in progress so every viewer's status flips to 'generating'.
  // Deleting flashcards/questions cascades to every student's card_progress and
  // attempts for this lesson — the admin UI confirms that before calling here.
  if (chunkFrom === 0) {
    await db.deleteFlashcardsForLesson(supabase, lessonId);
    await db.deleteQuestionsForLesson(supabase, lessonId);
  }
  await supabase.from('lessons').update({ generated_at: null, generation_chunk: null }).eq('id', lessonId);

  let whyItMatters: string | null = null;

  for (let i = chunkFrom; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkWords = chunk.split(/\s+/).length;
    const chunkQuestions = Math.max(6, Math.round(Math.max(12, Math.min(30, Math.round(totalWords / 130))) * (chunkWords / totalWords)));

    const isFirst = i === 0;
    const systemPrompt = isFirst || !isMultiChunk
      ? firstChunkPrompt(questionMix, isMultiChunk ? chunkQuestions : Math.max(12, Math.min(30, Math.round(totalWords / 130))))
      : continuationChunkPrompt(questionMix, chunkQuestions);

    const userMessage = isFirst
      ? `Lesson: ${title}\n\n${chunk}`
      : `Lesson (continued): ${title}\n\n${chunk}`;

    console.log(`[generate] chunk ${i + 1}/${chunks.length} chars=${chunk.length} words=${chunkWords} targetQ=${chunkQuestions}`);

    let questions: QuestionRow[];
    let flashcards: FlashcardRow[];

    try {
      const message = await client.messages.create({
        model: GENERATION_MODEL,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      console.log(`[generate] chunk ${i + 1}/${chunks.length} tokens: input=${message.usage.input_tokens} output=${message.usage.output_tokens}`);

      const block = message.content[0];
      if (block.type !== 'text') throw new Error('Unexpected response type from model');

      if (isFirst || !isMultiChunk) {
        const parsed = parseJSON<FirstChunkResponse>(block.text);
        if (typeof parsed.whyItMatters !== 'string' || !Array.isArray(parsed.questions) || !Array.isArray(parsed.flashcards)) {
          throw new Error('Response JSON did not match expected shape (first chunk)');
        }
        whyItMatters = parsed.whyItMatters;
        questions = parsed.questions;
        flashcards = parsed.flashcards;

        // Persist whyItMatters immediately (so we have it even if later chunks fail)
        await supabase.from('lessons').update({ why_it_matters: whyItMatters }).eq('id', lessonId);
      } else {
        const parsed = parseJSON<ContinuationResponse>(block.text);
        if (!Array.isArray(parsed.questions) || !Array.isArray(parsed.flashcards)) {
          throw new Error('Response JSON did not match expected shape (continuation chunk)');
        }
        questions = parsed.questions;
        flashcards = parsed.flashcards;
      }
    } catch (err) {
      // Record which chunk failed so the next retry can resume
      await supabase.from('lessons').update({ generation_chunk: i }).eq('id', lessonId);
      console.error(`[generate] chunk ${i + 1}/${chunks.length} FAILED`, err);
      const msg = err instanceof Error ? err.message : 'Generation failed';
      return NextResponse.json({ error: msg, failedChunk: i }, { status: 500 });
    }

    // Insert this chunk's output
    await db.insertFlashcards(
      supabase,
      flashcards.map((c) => ({
        lesson_id: lessonId,
        front: c.front,
        back: c.back,
        source_anchor: c.source_anchor ?? null,
      }))
    );

    await db.insertQuestions(
      supabase,
      questions.map((q) => ({
        lesson_id: lessonId,
        question_type: q.question_type,
        stem: q.stem,
        options: q.options,
        correct_index: q.correct_index,
        explanation: q.explanation,
        source_anchor: q.source_anchor ?? null,
      }))
    );
  }

  // All chunks complete — mark lesson generated (clears the chunk cursor). On a
  // resume, chunk 0 didn't run, so keep the why_it_matters it already saved.
  await db.updateLessonGenerated(supabase, lessonId, {
    ...(whyItMatters !== null && { why_it_matters: whyItMatters }),
    generated_at: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true, chunks: chunks.length });
}
