#!/usr/bin/env node
/**
 * retry-failed.mjs  — retry lessons where generated_at IS NULL
 *
 * Uses psql (DATABASE_PASSWORD) for all DB reads/writes, bypassing RLS.
 * Uses the Anthropic SDK directly for generation.
 *
 * Usage:
 *   node scripts/retry-failed.mjs             # all failed, small first
 *   node scripts/retry-failed.mjs --small-only # only lessons < 8k chars
 *   node scripts/retry-failed.mjs --large-only # only lessons >= 8k chars
 *   LESSON_ID=<uuid> node scripts/retry-failed.mjs  # single lesson
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

// ── Env ───────────────────────────────────────────────────────────────────────

const envRaw = readFileSync(
  new URL('../.env', import.meta.url).pathname, 'utf8'
);
const env = Object.fromEntries(
  envRaw.split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => {
      const eq = l.indexOf('=');
      return [l.slice(0, eq).trim(), l.slice(eq + 1).trim()];
    })
);

const DB_PASS = env.DATABASE_PASSWORD;
const PROJ = (env.NEXT_PUBLIC_SUPABASE_URL || '').match(/\/\/([^.]+)/)?.[1];
if (!PROJ) { console.error('Could not derive project ref from NEXT_PUBLIC_SUPABASE_URL'); process.exit(1); }
const PGURL = `postgres://postgres:${DB_PASS}@db.${PROJ}.supabase.co:5432/postgres`;

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const CHUNK_LIMIT = 8_000;

// ── DB helpers ────────────────────────────────────────────────────────────────

function psql(sql) {
  return execSync(`PGPASSWORD="${DB_PASS}" psql "${PGURL}" -t -A -c ${shellEscape(sql)}`, {
    encoding: 'utf8', timeout: 30_000,
  }).trim();
}

function psqlFile(sql) {
  const f = join(tmpdir(), `retry_${Date.now()}.sql`);
  writeFileSync(f, sql);
  try {
    return execSync(`PGPASSWORD="${DB_PASS}" psql "${PGURL}" -f ${shellEscape(f)}`, {
      encoding: 'utf8', timeout: 30_000,
    });
  } finally {
    try { unlinkSync(f); } catch {}
  }
}

function shellEscape(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function pgLiteral(s) {
  // Use dollar-quoting with a unique tag to safely embed arbitrary strings
  const tag = `$TAG${Date.now()}$`;
  return `${tag}${s}${tag}`;
}

// ── Core logic ────────────────────────────────────────────────────────────────

function splitOnParagraphs(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
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

function buildFirstChunkPrompt(mix, n) {
  const f = Math.round(n * mix.factual);
  const s = Math.round(n * mix.scenario);
  const c = n - f - s;
  return `You are building study material for the Georgia real estate salesperson pre-license course, preparing for the Georgia real estate salesperson licensing exam.

Given a lesson title and source text, produce:
1. A short "why it matters" paragraph (2–4 sentences) explaining, from the source, why this topic matters on the licensing exam and in a licensee's work.
2. Up to ${n} multiple-choice questions: ${f} factual, ${s} scenario, ${c} calculation.
3. 8–20 flashcards (description→term: front describes a concept/situation, back gives the precise term/rule/number).

Sourcing rules (these override everything else; see the note in app/api/generate/route.ts — drilled content must be verifiable):
- Use ONLY facts stated in the source text. Do not add facts, numbers, deadlines, rule citations or exceptions from general knowledge.
- Every answer and flashcard back must be directly supported by the source; source_anchor is a verbatim quote ≤30 words copied exactly from it.
- If the source supports fewer items than requested, return fewer.

Question requirements:
- Use named fictional buyers, sellers, tenants and licensees in scenario questions.
- All four options plausible; wrong answers = true facts about related topics (true-but-incomplete distractors).
- Vary qualifiers; avoid starting every stem with "Which of the following".
- Explanation: why correct AND why best distractor fails.
- Calculation questions: show full worked arithmetic in explanation.

Return strict JSON only — no markdown fences, no preamble:
{
  "whyItMatters": "string",
  "questions": [
    { "question_type": "factual"|"scenario"|"calculation", "stem": "string", "options": ["","","",""], "correct_index": 0, "explanation": "string", "source_anchor": "string" }
  ],
  "flashcards": [
    { "front": "string", "back": "string", "source_anchor": "string" }
  ]
}`;
}

function buildContinuationChunkPrompt(mix, n) {
  const f = Math.round(n * mix.factual);
  const s = Math.round(n * mix.scenario);
  const c = n - f - s;
  return `You are building additional study material for the Georgia real estate salesperson pre-license course, preparing for the Georgia real estate salesperson licensing exam, from a continuation of a longer source document.

Produce:
1. Up to ${n} multiple-choice questions: ${f} factual, ${s} scenario, ${c} calculation.
2. 6–14 flashcards (description→term direction).

Sourcing rules (these override everything else; see the note in app/api/generate/route.ts — drilled content must be verifiable):
- Use ONLY facts stated in the source text. Do not add facts, numbers, deadlines, rule citations or exceptions from general knowledge.
- Every answer and flashcard back must be directly supported by the source; source_anchor is a verbatim quote ≤30 words copied exactly from it.
- If the source supports fewer items than requested, return fewer.

Same quality requirements: named fictional buyers, sellers and licensees, plausible distractors, worked arithmetic.

Return strict JSON only — no markdown fences:
{
  "questions": [
    { "question_type": "factual"|"scenario"|"calculation", "stem": "string", "options": ["","","",""], "correct_index": 0, "explanation": "string", "source_anchor": "string" }
  ],
  "flashcards": [
    { "front": "string", "back": "string", "source_anchor": "string" }
  ]
}`;
}

function parseModelJSON(text) {
  const clean = text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

// ── Per-lesson generate ───────────────────────────────────────────────────────

async function generateLesson(lesson, chunkFrom = 0) {
  const { id, title, source_content, question_mix: mixRaw, generation_chunk: savedChunk } = lesson;
  const mix = typeof mixRaw === 'string' ? JSON.parse(mixRaw) : mixRaw;
  const resumeFrom = chunkFrom ?? savedChunk ?? 0;

  const source = source_content.trim();
  const chunks = splitOnParagraphs(source, CHUNK_LIMIT);
  const totalWords = source.split(/\s+/).length;
  const totalQ = Math.max(12, Math.min(30, Math.round(totalWords / 130)));
  const isMulti = chunks.length > 1;

  console.log(`\n── ${title} ──`);
  console.log(`   ${source.length} chars | ${chunks.length} chunk(s) | target ${totalQ} questions | resume from chunk ${resumeFrom}`);

  // Wipe previous content on fresh start
  if (resumeFrom === 0) {
    psql(`DELETE FROM flashcards WHERE lesson_id = '${id}'`);
    psql(`DELETE FROM questions  WHERE lesson_id = '${id}'`);
  }

  let whyItMatters = null;

  for (let i = resumeFrom; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkWords = chunk.split(/\s+/).length;
    const chunkQ = isMulti
      ? Math.max(6, Math.round(totalQ * (chunkWords / totalWords)))
      : totalQ;

    const isFirst = i === 0;
    const sysPrompt = (isFirst || !isMulti)
      ? buildFirstChunkPrompt(mix, isFirst && isMulti ? chunkQ : totalQ)
      : buildContinuationChunkPrompt(mix, chunkQ);

    const userMsg = isFirst
      ? `Lesson: ${title}\n\n${chunk}`
      : `Lesson (continued): ${title}\n\n${chunk}`;

    console.log(`   chunk ${i + 1}/${chunks.length}: ${chunk.length} chars, asking for ${chunkQ} questions…`);

    let parsed;
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: sysPrompt,
        messages: [{ role: 'user', content: userMsg }],
      });

      const { input_tokens, output_tokens } = msg.usage;
      console.log(`   chunk ${i + 1}/${chunks.length} tokens: input=${input_tokens} output=${output_tokens}`);

      const block = msg.content[0];
      if (block.type !== 'text') throw new Error('Unexpected response type');
      parsed = parseModelJSON(block.text);
    } catch (err) {
      // Record failed chunk index for resume
      psql(`UPDATE lessons SET generation_chunk = ${i} WHERE id = '${id}'`);
      console.error(`   ✗ chunk ${i + 1}/${chunks.length} failed:`, err.message);
      return false;
    }

    // Validate and extract
    if (isFirst || !isMulti) {
      if (!parsed.whyItMatters || !Array.isArray(parsed.questions) || !Array.isArray(parsed.flashcards)) {
        psql(`UPDATE lessons SET generation_chunk = ${i} WHERE id = '${id}'`);
        console.error(`   ✗ chunk ${i + 1} bad shape:`, JSON.stringify(parsed).slice(0, 200));
        return false;
      }
      whyItMatters = parsed.whyItMatters;
      // Save whyItMatters immediately in case later chunks fail
      const wim = whyItMatters.replace(/'/g, "''");
      psql(`UPDATE lessons SET why_it_matters = '${wim}' WHERE id = '${id}'`);
    } else {
      if (!Array.isArray(parsed.questions) || !Array.isArray(parsed.flashcards)) {
        psql(`UPDATE lessons SET generation_chunk = ${i} WHERE id = '${id}'`);
        console.error(`   ✗ chunk ${i + 1} bad shape (continuation)`);
        return false;
      }
    }

    const questions = parsed.questions ?? [];
    const flashcards = parsed.flashcards ?? [];
    console.log(`   chunk ${i + 1}: ${questions.length} questions, ${flashcards.length} flashcards`);

    // Insert flashcards for this chunk
    if (flashcards.length > 0) {
      const fcJson = JSON.stringify(flashcards);
      psqlFile(`
INSERT INTO flashcards (lesson_id, front, back, source_anchor)
SELECT
  '${id}'::uuid,
  fc->>'front',
  fc->>'back',
  NULLIF(fc->>'source_anchor', '')
FROM jsonb_array_elements(${pgLiteral(fcJson)}::jsonb) AS fc;
`);
    }

    // Insert questions for this chunk
    if (questions.length > 0) {
      const qJson = JSON.stringify(questions);
      psqlFile(`
INSERT INTO questions (lesson_id, question_type, stem, options, correct_index, explanation, source_anchor)
SELECT
  '${id}'::uuid,
  q->>'question_type',
  q->>'stem',
  (q->'options')::jsonb,
  (q->>'correct_index')::int,
  q->>'explanation',
  NULLIF(q->>'source_anchor', '')
FROM jsonb_array_elements(${pgLiteral(qJson)}::jsonb) AS q;
`);
    }
  }

  // All chunks done — mark complete
  const ts = new Date().toISOString();
  // On a resume chunk 0 didn't run, so keep the why_it_matters it already saved.
  const wimSet = whyItMatters ? `, why_it_matters = '${whyItMatters.replace(/'/g, "''")}'` : '';
  psql(`UPDATE lessons SET generated_at = '${ts}', generation_chunk = NULL${wimSet} WHERE id = '${id}'`);

  // Count what we inserted
  const qCount = psql(`SELECT COUNT(*) FROM questions  WHERE lesson_id = '${id}'`);
  const fcCount = psql(`SELECT COUNT(*) FROM flashcards WHERE lesson_id = '${id}'`);
  console.log(`   ✓ done — ${qCount} questions, ${fcCount} flashcards`);
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const smallOnly = args.includes('--small-only');
  const largeOnly = args.includes('--large-only');
  const singleId = process.env.LESSON_ID;

  // Find failed lessons — output as JSON to avoid delimiter collisions with source_content
  const jsonOut = psql(`
SELECT json_agg(row_to_json(t)) FROM (
  SELECT l.id, l.title, length(l.source_content) AS chars, l.generation_chunk,
         s.question_mix, l.source_content
  FROM lessons l
  JOIN sections s ON s.id = l.section_id
  WHERE l.generated_at IS NULL AND l.source_content != ''
    AND l.kind <> 'document'  -- drill generation is opt-in for document examples
    -- Never restart a lesson an admin deliberately stopped, or one with a live
    -- run (heartbeat within the 2-minute GENERATION_STALE window, migration 013).
    AND l.generation_cancelled_at IS NULL
    AND l.generation_cancel_requested_at IS NULL
    AND (l.generation_run_id IS NULL OR l.generation_heartbeat_at < now() - interval '2 minutes')
  ${singleId ? `AND l.id = '${singleId}'` : ''}
  ORDER BY length(l.source_content) ASC
) t
  `);

  if (!jsonOut || jsonOut === 'null') { console.log('No failed lessons found.'); return; }

  const lessons = JSON.parse(jsonOut).map(r => ({
    ...r,
    chars: Number(r.chars),
    generation_chunk: r.generation_chunk ?? null,
    question_mix: typeof r.question_mix === 'string' ? JSON.parse(r.question_mix) : r.question_mix,
  }));

  const small = lessons.filter(l => l.chars < CHUNK_LIMIT);
  const large = lessons.filter(l => l.chars >= CHUNK_LIMIT);

  console.log(`Found ${lessons.length} failed lessons: ${small.length} small (<${CHUNK_LIMIT} chars), ${large.length} large`);

  const toRun = largeOnly ? large : smallOnly ? small : [...small, ...large];

  let passed = 0, failed = 0;

  for (const lesson of toRun) {
    const ok = await generateLesson(lesson, lesson.generation_chunk ?? 0);
    if (ok) passed++; else failed++;
    // Brief pause between calls to avoid rate limits
    if (toRun.indexOf(lesson) < toRun.length - 1) await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n──────────────────────`);
  console.log(`Results: ${passed} succeeded, ${failed} failed`);

  // Final audit
  console.log('\n── Audit: lessons with source but no questions ──');
  const audit = psql(`
SELECT l.title, length(l.source_content) AS chars,
       COUNT(q.id) AS q_count
FROM lessons l
LEFT JOIN questions q ON q.lesson_id = l.id
WHERE l.source_content != ''
GROUP BY l.id, l.title
HAVING COUNT(q.id) = 0
ORDER BY chars DESC;
  `);
  if (audit) {
    console.log('STILL FAILING:');
    console.log(audit);
  } else {
    console.log('✓ All lessons with source content have questions.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
