#!/usr/bin/env node
// Builds supabase/migrations/011_georgia_course_seed.sql from the RealEstateU
// course structure. Seeds every section and lesson with empty source_content;
// content is pasted lesson by lesson afterwards.
//
//   node scripts/build-course-seed.mjs <structure file> [--out <file.sql>]
//
// The input may mix two formats, read in document order:
//
// 1. Sidebar HTML (lines starting with '<'):
//   .navigation-chapter  → one section; title in `.chapter p`, sometimes split
//                          across several <p> ("Chapter 10" + "Georgia Residential
//                          Landlord" + "Tenant Act") — joined with spaces
//   .navigation-lesson   → one lesson; title in `.lesson-title`, numbered N.M,
//                          N.Ma, N.Mb …
// Lessons belong to the most recent chapter in document order, so this works
// whether lessons are nested inside their chapter element or follow it.
// Lock icons (fa-check / fa-lock-open / fa-lock) are ignored: that is progress
// on RealEstateU's platform, not ours. <sup> tails are stripped.
//
// 2. Outline lines, one chapter per line:
//      Chapter N — Title: N.0 First lesson / N.1 Second lesson / Chapter N - Quiz
//    Lessons are separated by " / ", but some titles contain " / " themselves
//    ("18.3 Tax Rates / Calculating Property Taxes"). Every real lesson is
//    numbered, so an unnumbered fragment (other than the chapter quiz) is
//    rejoined onto the previous title.
//    A trailing line such as "Final Exam Instructions (single lesson, …)" is a
//    one-lesson section; the parenthetical is dropped.
//
// Re-running is safe: inserts are ON CONFLICT DO NOTHING, so a newer sidebar
// adds missing rows without touching pasted content or edited weights.

import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'node-html-parser';

const EXPECTED_CHAPTERS = 35;

// Georgia statute chapters: depth comes from pasted primary source (Commission
// rules, O.C.G.A.), never from the model.
const STATUTE_CHAPTERS = new Set([2, 3, 10, 17, 24]);

// Document examples: forms, exhibits and sample documents with little prose.
// Generating drills from a blank deed form gives junk, so these are opt-in.
//   - "X Example" / "Example of a X" followed by "X Review" / "X Case Review"
//   - any "Example of …" or "… Example"
//   - named forms, exhibits and pamphlets
// A "… Review" lesson is always prose, even "FHA Loan Contingency Exhibit Review".
const DOCUMENT_TITLE = /\b(exhibit|pamphlet|form \d+|loan application|closing disclosure|loan estimate|disclosure of information|know your rights)\b/i;

const DEFAULT_MIX = { factual: 0.6, scenario: 0.4, calculation: 0 };
const MATH_MIX = { factual: 0.15, scenario: 0.15, calculation: 0.7 };

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const htmlPath = args.find((a) => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : 'supabase/migrations/011_georgia_course_seed.sql';

if (!htmlPath) {
  console.error('usage: node scripts/build-course-seed.mjs <sidebar.html> [--out <file.sql>]');
  process.exit(1);
}

// ── Parse ─────────────────────────────────────────────────────────────────────

const clean = (s) => s.replace(/\s+/g, ' ').trim();
const slugify = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const chapters = [];
const problems = [];
const notes = [];   // non-fatal: printed for review

function parseHtml(html) {
  const root = parse(html);
  for (const sup of root.querySelectorAll('sup')) sup.remove();
  for (const el of root.querySelectorAll('.navigation-chapter, .navigation-lesson')) {
    if (el.classList.contains('navigation-chapter')) {
      const parts = el.querySelectorAll('.chapter p').map((p) => clean(p.text)).filter(Boolean);
      const raw = clean(parts.join(' '));
      chapters.push({ ...classifyChapter(raw), raw, lessons: [] });
    } else {
      const titleEl = el.querySelector('.lesson-title');
      const raw = titleEl ? clean(titleEl.text) : '';
      const current = chapters.at(-1);
      if (!raw) { problems.push('lesson with no .lesson-title'); continue; }
      if (!current) { problems.push(`lesson before any chapter: "${raw}"`); continue; }
      current.lessons.push(raw);
    }
  }
}

const OUTLINE_CHAPTER = /^Chapter\s+(\d+)\s+[—–-]\s+(.+?):\s+(?=\d+\.\d)(.*)$/;
const QUIZ_ITEM = /^Chapter\s+\d+\s*-\s*Quiz$/i;

function parseOutlineChapter(n, title, rest) {
  const lessons = [];
  for (const item of rest.split(' / ').map(clean).filter(Boolean)) {
    if (/^\d+\.\d/.test(item) || QUIZ_ITEM.test(item) || lessons.length === 0) {
      lessons.push(item);
    } else {
      const joined = `${lessons.pop()} / ${item}`;
      notes.push(`chapter ${n}: rejoined title "${joined}"`);
      lessons.push(joined);
    }
  }
  const raw = `Chapter ${n} ${title}`;
  chapters.push({ ...classifyChapter(raw), raw, lessons });
}

let htmlBuffer = [];
const flushHtml = () => { if (htmlBuffer.length) parseHtml(htmlBuffer.join('\n')); htmlBuffer = []; };

for (const line of readFileSync(htmlPath, 'utf8').split('\n')) {
  const t = line.trim();
  if (t.startsWith('<')) { htmlBuffer.push(t); continue; }
  flushHtml();
  if (!t) continue;
  const m = t.match(OUTLINE_CHAPTER);
  if (m) { parseOutlineChapter(Number(m[1]), clean(m[2]), m[3]); continue; }
  const single = t.match(/^(.+?)\s*(\(.*\))?$/);
  if (single && /final\s+exam/i.test(single[1])) {
    const name = clean(single[1]);
    chapters.push({ ...classifyChapter(name), raw: name, lessons: [name] });
    continue;
  }
  problems.push(`unrecognised line: "${t.slice(0, 80)}"`);
}
flushHtml();

function classifyChapter(raw) {
  const m = raw.match(/^Chapter\s+(\d+)\s*[:\-–—]?\s*(.*)$/i);
  if (m) {
    const n = Number(m[1]);
    return { kind: 'chapter', number: n, name: m[2] || `Chapter ${n}`, slug: `chapter-${n}`, sort: n };
  }
  if (/orientation/i.test(raw)) return { kind: 'orientation', number: null, name: raw, slug: 'orientation', sort: 0 };
  if (/final\s+exam/i.test(raw)) return { kind: 'final', number: null, name: raw, slug: 'final-exam', sort: 1000 };
  problems.push(`unrecognised chapter title: "${raw}"`);
  return { kind: 'unknown', number: null, name: raw, slug: slugify(raw), sort: 999 };
}

// ── Lessons: number, title, kind ──────────────────────────────────────────────

// Also accepts the occasional "28.3.a", normalised to "28.3a".
const LESSON_NUM = /^(\d+\.\d+)\.?([a-z])?(?![\w.])[\s.:\-–—]*(.*)$/i;

for (const ch of chapters) {
  const parsed = ch.lessons.map((raw) => {
    const m = raw.match(LESSON_NUM);
    if (!m) return { raw, number: null, title: raw };
    const number = `${m[1]}${m[2] ?? ''}`.toLowerCase();
    if (raw.startsWith(`${m[1]}.${m[2]}`)) notes.push(`normalised lesson number "${m[1]}.${m[2]}" -> "${number}"`);
    return { raw, number, title: m[3] || raw };
  });

  ch.rows = parsed.map((l, i) => {
    let kind = 'prose';
    if (/\b(infographic|diagram)\b/i.test(l.title)) kind = 'infographic';
    else if (/\bquiz\b/i.test(l.title)) kind = 'quiz';
    else if (isDocument(l, parsed[i + 1])) kind = 'document';

    // Unnumbered lessons get a stable synthetic key so re-runs stay idempotent
    // (UNIQUE (section_id, lesson_number) ignores NULLs). The UI only displays
    // lesson_number when it looks like N.M.
    let number = l.number;
    if (!number) {
      number = kind === 'quiz' && ch.number != null ? `${ch.number}.quiz` : `${ch.number ?? ch.slug}.${slugify(l.title)}`;
    }
    return { number, title: l.title, kind, sort: (i + 1) * 10 };
  });

  const seen = new Set();
  for (const r of ch.rows) {
    if (seen.has(r.number)) problems.push(`duplicate lesson number ${r.number} in ${ch.slug}`);
    seen.add(r.number);
  }
}

function normalise(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}


function documentBase(title) {
  return normalise(title).replace(/^example of (a |an )?/, '').replace(/ example$/, '');
}

function isDocument(lesson, next) {
  const t = lesson.title;
  if (/\breview$/i.test(t)) return false;   // the Review lesson after a document is prose
  if (/^example of\b/i.test(t) || /\bexample$/i.test(t) || DOCUMENT_TITLE.test(t)) return true;
  if (!next) return false;
  const nextBase = normalise(next.title).replace(/ (case )?review$/, '');
  return /\breview$/i.test(next.title) && nextBase === documentBase(t);
}

// ── Validate ──────────────────────────────────────────────────────────────────

const numbered = chapters.filter((c) => c.kind === 'chapter').map((c) => c.number);
for (let n = 1; n <= EXPECTED_CHAPTERS; n++) {
  if (!numbered.includes(n)) problems.push(`missing Chapter ${n}`);
}
const dupSlugs = chapters.map((c) => c.slug).filter((s, i, a) => a.indexOf(s) !== i);
for (const s of new Set(dupSlugs)) problems.push(`duplicate chapter ${s}`);
for (const c of chapters) if (c.rows.length === 0) problems.push(`${c.slug} has no lessons`);

// Every lesson in a numbered chapter is either numbered with that chapter's own
// N.M (N.Ma, N.Mb …) or is exactly that chapter's quiz. Anything else is a
// fragment that slipped through the " / " rejoin, or a misfiled lesson — a
// phantom row that would otherwise be buried in a ~400-row seed.
for (const c of chapters.filter((ch) => ch.kind === 'chapter')) {
  const quiz = new RegExp(`^Chapter\\s+${c.number}\\s*-\\s*Quiz$`, 'i');
  let quizzes = 0;
  for (const raw of c.lessons) {
    const m = raw.match(LESSON_NUM);
    if (m && Number(m[1].split('.')[0]) === c.number) continue;
    if (quiz.test(raw)) { quizzes++; continue; }
    problems.push(`${c.slug}: not numbered ${c.number}.M and not its quiz: "${raw}"`);
  }
  if (quizzes !== 1) problems.push(`${c.slug}: expected exactly 1 chapter quiz, found ${quizzes}`);
}

// ── Weights ───────────────────────────────────────────────────────────────────
// Course-completion weights: each chapter's share of the course's countable
// lessons. Infographics are image-only and don't count; Orientation and the
// Final Exam carry no weight.

const counts = (c) => c.rows.filter((r) => r.kind !== 'infographic').length;
const weighted = chapters.filter((c) => c.kind === 'chapter');
const totalCountable = weighted.reduce((s, c) => s + counts(c), 0);
for (const c of chapters) {
  c.weight = c.kind === 'chapter' && totalCountable > 0 ? counts(c) / totalCountable : 0;
  c.mix = /\bmath/i.test(c.name) ? MATH_MIX : DEFAULT_MIX;
  c.allowDepth = !(c.number != null && STATUTE_CHAPTERS.has(c.number));
}

// ── Report ────────────────────────────────────────────────────────────────────

const total = chapters.reduce((s, c) => s + c.rows.length, 0);
const byKind = {};
for (const c of chapters) for (const r of c.rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

console.log(`\n${chapters.length} sections, ${total} lessons  ${JSON.stringify(byKind)}\n`);
for (const c of chapters) {
  const k = {};
  for (const r of c.rows) if (r.kind !== 'prose') k[r.kind] = (k[r.kind] ?? 0) + 1;
  const flags = [
    !c.allowDepth && 'no-generated-depth',
    c.mix === MATH_MIX && 'math-mix',
  ].filter(Boolean).join(' ');
  console.log(
    `${c.slug.padEnd(13)} ${String(c.rows.length).padStart(3)} lessons  w=${c.weight.toFixed(4)}  ` +
    `${c.name.slice(0, 48).padEnd(48)} ${Object.entries(k).map(([a, b]) => `${a}:${b}`).join(' ')} ${flags}`
  );
}
const docs = chapters.flatMap((c) => c.rows.filter((r) => r.kind === 'document').map((r) => `${r.number} ${r.title}`));
if (docs.length) console.log(`\nDocument examples (generation off by default):\n  ${docs.join('\n  ')}`);
const images = chapters.flatMap((c) => c.rows.filter((r) => r.kind === 'infographic').map((r) => `${r.number} ${r.title}`));
console.log(`\n${images.length} image-only lessons (infographics / diagrams)`);
if (notes.length) console.log(`\nNotes:\n  ${notes.join('\n  ')}`);

if (!problems.length) {
  console.log(`\n✓ every lesson in Chapters 1–${EXPECTED_CHAPTERS} is numbered N.M or is its chapter quiz (one quiz each)`);
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s) — no SQL written:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// ── Emit SQL ──────────────────────────────────────────────────────────────────

const q = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);

const sectionValues = chapters.map((c) =>
  `  (${q(c.slug)}, ${q(c.name)}, ${c.number ?? 'NULL'}, ${c.sort}, ${c.weight.toFixed(6)}, ${q(JSON.stringify(c.mix))}::jsonb, ${c.allowDepth})`
).join(',\n');

const lessonValues = chapters.flatMap((c) => c.rows.map((r) =>
  `  (${q(c.slug)}, ${q(r.number)}, ${q(r.title)}, ${q(r.kind)}, ${r.sort})`
)).join(',\n');

const sql = `-- ════════════════════════════════════════════════════════════════════════
-- Migration 011: Georgia Real Estate Licensing Course (v.2) — structure seed
--
-- GENERATED by scripts/build-course-seed.mjs from the RealEstateU sidebar.
-- Do not hand-edit; re-run the script instead.
--
-- ${chapters.length} sections, ${total} lessons, all with empty source_content.
-- Content is pasted lesson by lesson through the admin UI.
--
-- exam_weight here is a COURSE-COMPLETION weight: each chapter's share of the
-- course's countable lessons (infographics excluded; Orientation and Final Exam
-- weighted 0). It is NOT the Georgia exam content outline. When the real
-- candidate-bulletin weights are available, replacing them is a data change:
--   UPDATE sections SET exam_weight = <share> WHERE slug = 'chapter-N';
-- and nothing else in the app needs to change.
--
-- Idempotent: ON CONFLICT DO NOTHING never overwrites pasted content or
-- edited weights.
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO public.sections
  (slug, name, chapter_number, sort_order, exam_weight, question_mix, allow_generated_depth)
VALUES
${sectionValues}
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.lessons (section_id, lesson_number, title, kind, sort_order)
SELECT s.id, v.lesson_number, v.title, v.kind, v.sort_order
FROM (VALUES
${lessonValues}
) AS v(section_slug, lesson_number, title, kind, sort_order)
JOIN public.sections s ON s.slug = v.section_slug
ON CONFLICT (section_id, lesson_number) DO NOTHING;
`;

writeFileSync(outPath, sql);
console.log(`\n✓ wrote ${outPath}`);
